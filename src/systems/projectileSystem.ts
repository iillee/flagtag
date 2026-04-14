import {
  engine,
  Transform,
  AudioSource,
  GltfContainer,
  inputSystem,
  InputAction,
  PointerEventType,
  InputModifier,
  Raycast,
  RaycastResult,
  RaycastQueryType,
  VisibilityComponent,
  AvatarEmoteCommand,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { Flag, Projectile, PROJECTILE_COOLDOWN_SEC, PROJECTILE_LIFETIME_SEC, PROJECTILE_SPEED, PROJECTILE_MAX_RANGE } from '../shared/components'

import { room } from '../shared/messages'
import { triggerEmote } from '~system/RestrictedActions'
import { isSpectatorMode } from './spectatorSystem'
import { isCinematicActive } from '../cinematicState'
import { isDrownRespawning } from './waterSystem'
import { showHitEffect, showMissEffect, playHitSound, playMissSound } from './combatSystem'
import { getBoomerangModelSrc, getBoomerangColor, onBoomerangColorChange } from '../gameState/boomerangColor'

// Hand boomerang visibility
let handBoomerangEntity: Entity | null = null
let emoteActive = false
let lastPlayerPos: Vector3 | null = null
const EMOTE_MOVE_THRESHOLD = 0.1 // player must move this far to cancel emote hide

// Track when the local player has an active throw (hide hand boomerang)
let localThrowActive = false
let localThrowSawVisual = false // set true once msgProjectileVisuals was non-empty after throw

export function setHandBoomerangEntity(e: Entity) {
  handBoomerangEntity = e
  // Listen for emotes on the local player
  AvatarEmoteCommand.onChange(engine.PlayerEntity, (cmd) => {
    if (cmd && !cmd.emoteUrn?.includes('getHit')) {
      emoteActive = true
      // Snapshot position so we detect when player moves to cancel
      if (Transform.has(engine.PlayerEntity)) {
        const p = Transform.get(engine.PlayerEntity).position
        lastPlayerPos = Vector3.create(p.x, p.y, p.z)
      }
      updateHandBoomerangVisibility()
    }
  })
}

const HAND_BOOMERANG_SCALE = Vector3.create(1, 1.5, 1)

function updateHandBoomerangVisibility(): void {
  if (handBoomerangEntity === null) return
  // Cancel emote hide once player moves
  if (emoteActive && Transform.has(engine.PlayerEntity) && lastPlayerPos) {
    const p = Transform.get(engine.PlayerEntity).position
    if (Vector3.distance(p, lastPlayerPos) > EMOTE_MOVE_THRESHOLD) {
      emoteActive = false
    }
  }
  const shouldShow = localProjectiles.length === 0 && !localThrowActive && !emoteActive && !isCinematicActive()
  // Use scale to hide/show — VisibilityComponent doesn't reliably work on AvatarAttach children
  if (Transform.has(handBoomerangEntity)) {
    const t = Transform.getMutable(handBoomerangEntity)
    const currentlyVisible = t.scale.x > 0
    if (currentlyVisible !== shouldShow) {
      console.log(`[HandBoomerang] ${shouldShow ? 'SHOW' : 'HIDE'} | localThrowActive=${localThrowActive} localProj=${localProjectiles.length} msgVis=${msgProjectileVisuals.length} emote=${emoteActive} cinematic=${isCinematicActive()}`)
    }
    t.scale = shouldShow ? HAND_BOOMERANG_SCALE : Vector3.Zero()
  }
}

function getProjectileModelSrc(): string {
  return getBoomerangModelSrc()
}
const PROJECTILE_SCALE = Vector3.create(2.5, 4.5, 2.5)
const PROJECTILE_STAGGER_MS = 800
const PROJECTILE_GRAVITY = 15  // m/s² — matches server FLAG_GRAVITY
const PROJECTILE_SPIN_SPEED = 720 // degrees per second
const PROJECTILE_CHEST_OFFSET = 0.8 // Y offset from player position to chest height
const PROJECTILE_GROUND_OFFSET = 0.35 // Raise projectile above ground so it doesn't clip terrain — matches server
const GROUND_RAY_INTERVAL = 0.05 // seconds between ground raycasts for moving projectiles

// Stagger state for projectile hits
let projectileStaggerUntil = 0

// ── Sound ──
const PROJECTILE_SOUND_SRC = 'assets/sounds/mk_shell_short.mp3'

/** Attach a looping spatial projectile sound directly to a projectile entity. */
function attachProjectileSound(entity: Entity): void {
  AudioSource.createOrReplace(entity, {
    audioClipUrl: PROJECTILE_SOUND_SRC,
    playing: true,
    loop: true,
    volume: 1.0,
    global: false
  })
}

/** Stop the projectile sound on an entity (before removal). */
function stopProjectileSound(entity: Entity): void {
  if (AudioSource.has(entity)) {
    const a = AudioSource.getMutable(entity)
    a.playing = false
    a.volume = 0
    a.loop = false
  }
}

// ── Error sound (cooldown denial) ──
let errorSoundEntity: Entity | null = null
function playErrorSound(): void {
  if (!errorSoundEntity) {
    errorSoundEntity = engine.addEntity()
    Transform.create(errorSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(errorSoundEntity, {
      audioClipUrl: 'assets/sounds/error.mp3',
      playing: false,
      loop: false,
      volume: 0.6,
      global: true
    })
  }
  const a = AudioSource.getMutable(errorSoundEntity)
  a.currentTime = 0
  a.playing = true
}

// ── Client cooldown tracking ──
let lastLocalProjectileFireTime = 0

/** Returns true if a boomerang is currently in flight (local or server-driven). */
export function isProjectileInFlight(): boolean {
  return localProjectiles.length > 0 || localThrowActive
}

/** Returns true if projectile is unavailable — either on cooldown or in flight (for UI). */
export function isProjectileOnCooldown(): boolean {
  // In flight = unavailable
  if (isProjectileInFlight()) return true
  // Time-based cooldown (if any)
  if (lastLocalProjectileFireTime === 0) return false
  const cooldown = PROJECTILE_COOLDOWN_SEC
  return (Date.now() - lastLocalProjectileFireTime) < cooldown * 1000
}

/** Returns cooldown remaining in seconds (0 if ready). -1 if boomerang is in flight. */
export function getProjectileCooldownRemaining(): number {
  if (isProjectileInFlight()) return -1
  if (lastLocalProjectileFireTime === 0) return 0
  const cooldown = PROJECTILE_COOLDOWN_SEC
  const elapsed = Date.now() - lastLocalProjectileFireTime
  const remaining = cooldown * 1000 - elapsed
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

// ── Wall distance raycast ──
interface PendingWallRay {
  entity: Entity
}
const pendingWallRays: PendingWallRay[] = []

function fireWallRaycast(pos: Vector3, dirX: number, dirZ: number): void {
  const rayEntity = engine.addEntity()
  Transform.create(rayEntity, { position: pos })
  Raycast.create(rayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(dirX, 0, dirZ) },
    maxDistance: PROJECTILE_MAX_RANGE,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })
  pendingWallRays.push({ entity: rayEntity })
}

function processWallRaycasts(): void {
  for (let i = pendingWallRays.length - 1; i >= 0; i--) {
    const ray = pendingWallRays[i]
    const result = RaycastResult.getOrNull(ray.entity)
    if (result) {
      if (result.hits.length > 0) {
        const hitDist = result.hits[0].length
        room.send('reportShellWallDist', { shellId: 0, maxDist: hitDist })
      }
      engine.removeEntity(ray.entity)
      pendingWallRays.splice(i, 1)
    }
  }
}

// ── Continuous ground raycasts for server-mode projectiles ──
// We track synced Projectile entities and periodically fire downward raycasts
// from their current position to report ground height to the server.
interface TrackedServerProjectile {
  rayEntity: Entity | null
  lastRayTime: number
}
const trackedServerProjectiles = new Map<number, TrackedServerProjectile>() // entity id -> tracking state

function updateServerProjectileGroundRaycasts(dt: number): void {
  const now = Date.now()

  for (const [entity, projectile] of engine.getEntitiesWith(Projectile, Transform)) {
    if (!projectile.active) continue

    const entityId = entity as number
    let tracked = trackedServerProjectiles.get(entityId)
    if (!tracked) {
      tracked = { rayEntity: null, lastRayTime: 0 }
      trackedServerProjectiles.set(entityId, tracked)
    }

    // Check pending raycast result
    if (tracked.rayEntity !== null) {
      const result = RaycastResult.getOrNull(tracked.rayEntity)
      if (result) {
        if (result.hits.length > 0) {
          const pos = Transform.get(entity).position
          room.send('reportShellGroundY', {
            shellX: pos.x,
            shellZ: pos.z,
            groundY: result.hits[0].position!.y
          })
        }
        engine.removeEntity(tracked.rayEntity)
        tracked.rayEntity = null
      }
    }

    // Fire new ground raycast periodically
    if (tracked.rayEntity === null && now - tracked.lastRayTime > GROUND_RAY_INTERVAL * 1000) {
      tracked.lastRayTime = now
      const pos = Transform.get(entity).position
      const rayEntity = engine.addEntity()
      Transform.create(rayEntity, {
        position: Vector3.create(pos.x, pos.y + 2, pos.z) // start above projectile
      })
      Raycast.create(rayEntity, {
        direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
        maxDistance: 200,
        queryType: RaycastQueryType.RQT_HIT_FIRST,
        continuous: false
      })
      tracked.rayEntity = rayEntity
    }
  }

  // Clean up tracking for projectiles that no longer exist
  for (const [entityId, tracked] of trackedServerProjectiles) {
    if (!Projectile.has(entityId as Entity)) {
      if (tracked.rayEntity !== null) {
        engine.removeEntity(tracked.rayEntity)
      }
      trackedServerProjectiles.delete(entityId)
    }
  }
}

// ── Message listeners (registered at module scope for reliable delivery) ──
room.onMessage('shellDropped', (data) => {
  // Create visual from message bus (instant, no CRDT dependency).
  // Mobile live CRDT sync is unreliable — this ensures the visual always appears.
  createMsgProjectileVisual(data.x, data.y, data.z, data.dirX, data.dirZ, data.color, data.firedBy)
})

// Listen for return position updates from the server
room.onMessage('shellReturnPos', (data) => {
  const firedBy = (data.firedBy || '').toLowerCase()
  // Find the returning projectile from this player
  for (const vis of msgProjectileVisuals) {
    if (vis.returning && vis.firedBy === firedBy) {
      vis.returnTargetX = data.x
      vis.returnTargetY = data.y
      vis.returnTargetZ = data.z
      break
    }
  }
})

room.onMessage('shellTriggered', (data) => {
  const pos = Vector3.create(data.x, data.y, data.z)
  // Remove the message-driven projectile visual closest to the hit position
  removeMsgProjectileVisualNear(data.x, data.y, data.z)

  // Hit a player: particles + hit sound + stagger. Hit a wall: miss sound.
  if (data.victimId && data.victimId !== '') {
    showHitEffect(pos)
    playHitSound(pos)

    // Stagger the victim if it's the local player
    const me = getPlayerData()?.userId?.toLowerCase()
    if (me && data.victimId === me) {
      triggerEmote({ predefinedEmote: 'getHit' })
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: true, disableGliding: true, disableDoubleJump: true })
      })
      projectileStaggerUntil = Date.now() + PROJECTILE_STAGGER_MS
    }
  } else if (!data.peak) {
    // Projectile hit banana, wall, or shield — show miss cloud + sound
    // Skip if peak=true (boomerang just reached max range and is returning)
    showMissEffect(pos)
    const playerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : pos
    playMissSound(playerPos)
  }
})

// ── Local test mode (no server) ──
function isServerConnected(): boolean {
  return [...engine.getEntitiesWith(Flag)].length > 0
}

function getPlayerForward(): { dirX: number; dirZ: number } {
  if (!Transform.has(engine.PlayerEntity)) return { dirX: 0, dirZ: 1 }
  const rot = Transform.get(engine.PlayerEntity).rotation
  const forward = Vector3.rotate(Vector3.Forward(), rot)
  const len = Math.sqrt(forward.x * forward.x + forward.z * forward.z)
  if (len < 0.01) return { dirX: 0, dirZ: 1 }
  return { dirX: forward.x / len, dirZ: forward.z / len }
}

interface LocalProjectile {
  entity: Entity
  firedAtMs: number
  startX: number
  startY: number
  startZ: number
  dirX: number
  dirZ: number
  distanceTraveled: number
  maxDistance: number
  // Wall raycast
  wallRayEntity: Entity | null
  // Gravity + ground tracking
  currentY: number
  fallVelocity: number
  groundY: number
  onGround: boolean
  groundRayEntity: Entity | null
  lastGroundRayTime: number
  spinAngle: number
  returning: boolean
  returnDistance: number
}
const localProjectiles: LocalProjectile[] = []

function fireProjectileLocally(): void {
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position
  const { dirX, dirZ } = getPlayerForward()

  const spawnPos = Vector3.create(
    playerPos.x + dirX * 1.0,
    playerPos.y + 0.8,
    playerPos.z + dirZ * 1.0
  )

  const shellEntity = engine.addEntity()
  Transform.create(shellEntity, {
    position: spawnPos,
    scale: PROJECTILE_SCALE,
    rotation: Quaternion.fromEulerDegrees(0, Math.atan2(dirX, dirZ) * (180 / Math.PI), 0)
  })
  GltfContainer.create(shellEntity, {
    src: getProjectileModelSrc(),
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  // Fire wall raycast (forward)
  const wallRayEntity = engine.addEntity()
  Transform.create(wallRayEntity, { position: spawnPos })
  Raycast.create(wallRayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(dirX, 0, dirZ) },
    maxDistance: PROJECTILE_MAX_RANGE,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })

  // Attach looping spatial sound to the projectile entity
  attachProjectileSound(shellEntity)

  localProjectiles.push({
    entity: shellEntity,
    firedAtMs: Date.now(),
    startX: spawnPos.x,
    startY: spawnPos.y,
    startZ: spawnPos.z,
    dirX,
    dirZ,
    distanceTraveled: 0,
    maxDistance: PROJECTILE_MAX_RANGE,
    wallRayEntity,
    currentY: spawnPos.y,
    fallVelocity: 0,
    groundY: 0,
    onGround: false,
    groundRayEntity: null,
    lastGroundRayTime: 0,
    spinAngle: 0,
    returning: false,
    returnDistance: 0,
  })
  console.log('[Projectile] 🎯 LOCAL projectile fired dir:', dirX.toFixed(2), dirZ.toFixed(2))
  updateHandBoomerangVisibility()
}

function removeLocalProjectile(index: number): void {
  const projectile = localProjectiles[index]
  stopProjectileSound(projectile.entity)
  if (projectile.wallRayEntity !== null) engine.removeEntity(projectile.wallRayEntity)
  if (projectile.groundRayEntity !== null) engine.removeEntity(projectile.groundRayEntity)
  engine.removeEntity(projectile.entity)
  localProjectiles.splice(index, 1)
  if (localProjectiles.length === 0) localThrowActive = false
  updateHandBoomerangVisibility()
}

function updateLocalProjectiles(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = localProjectiles.length - 1; i >= 0; i--) {
    const projectile = localProjectiles[i]

    // Check wall raycast result
    if (projectile.wallRayEntity !== null) {
      const result = RaycastResult.getOrNull(projectile.wallRayEntity)
      if (result) {
        if (result.hits.length > 0) {
          projectile.maxDistance = Math.min(projectile.maxDistance, result.hits[0].length)
        }
        engine.removeEntity(projectile.wallRayEntity)
        projectile.wallRayEntity = null
      }
    }

    // Safety expiry
    if (now - projectile.firedAtMs > PROJECTILE_LIFETIME_SEC * 1000) {
      console.log('[Projectile] 🎯 LOCAL projectile expired')
      removeLocalProjectile(i)
      continue
    }

    // Move forward or return to player's current position
    const moveDistance = PROJECTILE_SPEED * clampedDt
    if (!projectile.returning) {
      projectile.distanceTraveled += moveDistance
      if (projectile.distanceTraveled >= projectile.maxDistance) {
        projectile.returning = true
        projectile.returnDistance = 0
        console.log('[Projectile] 🎯 LOCAL projectile reached max range, returning')
      }
    }

    // Spin the boomerang
    projectile.spinAngle += PROJECTILE_SPIN_SPEED * clampedDt

    if (!projectile.returning) {
      // Outbound — straight line from start
      const headingDeg = Math.atan2(projectile.dirX, projectile.dirZ) * (180 / Math.PI)
      const newX = projectile.startX + projectile.dirX * projectile.distanceTraveled
      const newZ = projectile.startZ + projectile.dirZ * projectile.distanceTraveled
      const t = Transform.getMutable(projectile.entity)
      t.position = Vector3.create(newX, projectile.startY, newZ)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + projectile.spinAngle, 0)
    } else {
      // Returning — home in on player's chest height
      const shellPos = Transform.get(projectile.entity).position
      const rawPlayerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : Vector3.create(projectile.startX, projectile.startY, projectile.startZ)
      const playerPos = Vector3.create(rawPlayerPos.x, rawPlayerPos.y + PROJECTILE_CHEST_OFFSET, rawPlayerPos.z)
      const dx = playerPos.x - shellPos.x
      const dy = playerPos.y - shellPos.y
      const dz = playerPos.z - shellPos.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (dist < 2.0) {
        console.log('[Projectile] 🎯 LOCAL projectile returned to player')
        removeLocalProjectile(i)
        continue
      }

      const nx = dx / dist, ny = dy / dist, nz = dz / dist
      const headingDeg = Math.atan2(nx, nz) * (180 / Math.PI)
      const t = Transform.getMutable(projectile.entity)
      t.position = Vector3.create(shellPos.x + nx * moveDistance, shellPos.y + ny * moveDistance, shellPos.z + nz * moveDistance)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + projectile.spinAngle, 0)
    }
  }
}

// ── Projectile visual entity pool ──
// Pre-create a fixed pool of entities with GltfContainer already loaded.
// Show/hide by moving position + scale instead of create/destroy to avoid
// the Decentraland engine bug where rapid GltfContainer create/destroy
// causes models to stop rendering.
const PROJECTILE_POOL_SIZE = 10
const projectilePool: Entity[] = []
let projectilePoolReady = false
const PROJECTILE_HIDDEN_POS = Vector3.create(0, -200, 0)

export function initProjectilePool(): void {
  if (projectilePoolReady) return
  projectilePoolReady = true
  for (let i = 0; i < PROJECTILE_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: PROJECTILE_HIDDEN_POS, scale: Vector3.Zero() })
    GltfContainer.create(e, {
      src: getProjectileModelSrc(),
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    projectilePool.push(e)
  }
  console.log('[Projectile] 🎯 Pre-created projectile visual pool of', PROJECTILE_POOL_SIZE)
}

// Update pool + hand boomerang when color changes
onBoomerangColorChange((color) => {
  const newSrc = getProjectileModelSrc()
  // Update all pooled entities
  for (const e of projectilePool) {
    if (GltfContainer.has(e)) {
      const gltf = GltfContainer.getMutable(e)
      gltf.src = newSrc
    }
  }
  // Update hand boomerang
  if (handBoomerangEntity !== null && GltfContainer.has(handBoomerangEntity)) {
    const gltf = GltfContainer.getMutable(handBoomerangEntity)
    gltf.src = newSrc
  }
  console.log('[Projectile] Updated pool + hand model to', newSrc)
})

function acquireProjectileFromPool(): Entity | null {
  initProjectilePool()
  for (const e of projectilePool) {
    const t = Transform.get(e)
    if (t.position.y < -100) return e
  }
  console.error('[Projectile] 🎯 Pool exhausted! All', PROJECTILE_POOL_SIZE, 'projectile visuals in use.')
  return null
}

function releaseProjectileToPool(entity: Entity): void {
  stopProjectileSound(entity)
  const t = Transform.getMutable(entity)
  t.position = PROJECTILE_HIDDEN_POS
  t.scale = Vector3.Zero()
}

// ── Message-driven visual entities for projectiles ──
// Visuals are created from the 'shellDropped' message (WebSocket, instant) rather than
// from CRDT-synced Projectile entities. Mobile live CRDT sync is unreliable — projectiles expire
// before entities arrive. The message bus delivers position + direction instantly.
// 'shellTriggered' message or time-based safety expiry removes the visual.
interface MsgProjectileVisual {
  entity: Entity
  firedBy: string  // userId of the thrower
  startX: number
  startY: number
  startZ: number
  dirX: number
  dirZ: number
  createdAtMs: number
  distanceTraveled: number
  maxDistance: number
  currentY: number
  fallVelocity: number
  groundY: number
  onGround: boolean
  groundRayEntity: Entity | null
  lastGroundRayTime: number
  spinAngle: number
  returning: boolean
  returnDistance: number
  // Server-driven return target (updated via shellReturnPos messages)
  returnTargetX: number
  returnTargetY: number
  returnTargetZ: number
}
const msgProjectileVisuals: MsgProjectileVisual[] = []

function createMsgProjectileVisual(x: number, y: number, z: number, dirX: number, dirZ: number, color?: string, firedBy?: string): void {
  const localEntity = acquireProjectileFromPool()
  if (!localEntity) return

  const t = Transform.getMutable(localEntity)
  t.position = Vector3.create(x, y, z)
  t.scale = PROJECTILE_SCALE
  t.rotation = Quaternion.fromEulerDegrees(0, Math.atan2(dirX, dirZ) * (180 / Math.PI), 0)

  // Set the correct color model for this projectile
  if (color && GltfContainer.has(localEntity)) {
    const validColors = ['r', 'y', 'b', 'g']
    const c = validColors.includes(color) ? color : 'r'
    GltfContainer.getMutable(localEntity).src = `models/boomerang.${c}.glb`
  }

  attachProjectileSound(localEntity)

  msgProjectileVisuals.push({
    entity: localEntity,
    firedBy: firedBy?.toLowerCase() || '',
    startX: x, startY: y, startZ: z,
    dirX, dirZ,
    createdAtMs: Date.now(),
    distanceTraveled: 0,
    maxDistance: PROJECTILE_MAX_RANGE,
    currentY: y,
    fallVelocity: 0,
    groundY: 0,
    onGround: false,
    groundRayEntity: null,
    lastGroundRayTime: 0,
    spinAngle: 0,
    returning: false,
    returnDistance: 0,
    returnTargetX: x,
    returnTargetY: y,
    returnTargetZ: z,
  })
  console.log('[Projectile] 🎯 Created message-driven projectile visual at:', x.toFixed(1), y.toFixed(1), z.toFixed(1))
}

function removeMsgProjectileVisualNear(x: number, y: number, z: number): void {
  // Find the closest projectile visual
  let closestIdx = -1
  let closestDist = Infinity
  for (let i = 0; i < msgProjectileVisuals.length; i++) {
    const vis = msgProjectileVisuals[i]
    const pos = Transform.get(vis.entity).position
    const dx = pos.x - x, dy = pos.y - y, dz = pos.z - z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dist < closestDist) { closestDist = dist; closestIdx = i }
  }
  if (closestIdx === -1) return

  const vis = msgProjectileVisuals[closestIdx]
  if (vis.returning) {
    // Already returning — this is a hit on the return trip, actually remove it
    if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
    releaseProjectileToPool(vis.entity)
    msgProjectileVisuals.splice(closestIdx, 1)
  } else {
    // Outbound hit — start returning
    vis.returning = true
    vis.returnDistance = 0
  }
}

function updateMsgProjectileVisuals(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = msgProjectileVisuals.length - 1; i >= 0; i--) {
    const vis = msgProjectileVisuals[i]

    // Safety expiry
    if (now - vis.createdAtMs > PROJECTILE_LIFETIME_SEC * 1000) {
      if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
      releaseProjectileToPool(vis.entity)
      msgProjectileVisuals.splice(i, 1)
      continue
    }

    // Move forward or return to player's CURRENT position
    const moveDist = PROJECTILE_SPEED * clampedDt
    if (!vis.returning) {
      vis.distanceTraveled += moveDist
      if (vis.distanceTraveled >= vis.maxDistance) {
        vis.returning = true
        vis.returnDistance = 0
      }
    }

    // Spin the boomerang
    vis.spinAngle += PROJECTILE_SPIN_SPEED * clampedDt

    if (!vis.returning) {
      // Outbound — straight line from start
      const headingDeg = Math.atan2(vis.dirX, vis.dirZ) * (180 / Math.PI)
      const t = Transform.getMutable(vis.entity)
      t.position = Vector3.create(vis.startX + vis.dirX * vis.distanceTraveled, vis.startY, vis.startZ + vis.dirZ * vis.distanceTraveled)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + vis.spinAngle, 0)
    } else {
      // Returning — use server-broadcast position for remote throwers, local PlayerEntity for self
      const shellPos = Transform.get(vis.entity).position
      const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
      const isLocalThrower = vis.firedBy === localUserId || vis.firedBy === ''

      let targetPos: Vector3
      if (isLocalThrower) {
        // Local player's boomerang — use own position (accurate, no lag)
        const rawPlayerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : Vector3.create(vis.startX, vis.startY, vis.startZ)
        targetPos = Vector3.create(rawPlayerPos.x, rawPlayerPos.y + PROJECTILE_CHEST_OFFSET, rawPlayerPos.z)
      } else {
        // Remote player's boomerang — use server-provided return target
        targetPos = Vector3.create(vis.returnTargetX, vis.returnTargetY, vis.returnTargetZ)
      }

      const dx = targetPos.x - shellPos.x
      const dy = targetPos.y - shellPos.y
      const dz = targetPos.z - shellPos.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (dist < 2.0) {
        // Close enough — disappear
        if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
        releaseProjectileToPool(vis.entity)
        msgProjectileVisuals.splice(i, 1)
        continue
      }

      // Move toward target at projectile speed
      const nx = dx / dist, ny = dy / dist, nz = dz / dist
      const headingDeg = Math.atan2(nx, nz) * (180 / Math.PI)
      const t = Transform.getMutable(vis.entity)
      t.position = Vector3.create(shellPos.x + nx * moveDist, shellPos.y + ny * moveDist, shellPos.z + nz * moveDist)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + vis.spinAngle, 0)
    }
  }
}

/** Fire a projectile from the UI (mobile tap). Same logic as E key press. */
export function triggerProjectileFromUI(): void {
  if (isDrownRespawning()) return
  const now = Date.now()
  const userId = getPlayerData()?.userId
  if (!userId) return

  if (now - lastLocalProjectileFireTime < PROJECTILE_COOLDOWN_SEC * 1000) { playErrorSound(); return }

  lastLocalProjectileFireTime = now
  const { dirX, dirZ } = getPlayerForward()
  const serverUp = isServerConnected()

  if (serverUp) {
    console.log('[Projectile] 🎯 UI tap — requesting projectile fire (server)')
    localThrowActive = true; localThrowSawVisual = false
    updateHandBoomerangVisibility()
    room.send('requestShell', { dirX, dirZ, color: getBoomerangColor() })
    if (Transform.has(engine.PlayerEntity)) {
      const playerPos = Transform.get(engine.PlayerEntity).position
      const spawnPos = Vector3.create(playerPos.x + dirX * 1.0, playerPos.y + 0.8, playerPos.z + dirZ * 1.0)
      fireWallRaycast(spawnPos, dirX, dirZ)
    }
  } else {
    console.log('[Projectile] 🎯 UI tap — firing projectile locally (no server)')
    localThrowActive = true; localThrowSawVisual = false
    updateHandBoomerangVisibility()
    fireProjectileLocally()
  }
}

// ── Main client system ──
export function projectileClientSystem(dt: number): void {
  updateHandBoomerangVisibility()
  const now = Date.now()
  const serverUp = isServerConnected()

  // Release projectile stagger freeze
  if (projectileStaggerUntil > 0 && now >= projectileStaggerUntil) {
    projectileStaggerUntil = 0
    if (InputModifier.has(engine.PlayerEntity)) {
      InputModifier.deleteFrom(engine.PlayerEntity)
    }
  }

  if (serverUp) {
    // Process wall raycasts
    processWallRaycasts()
    // Continuously report ground Y for moving projectiles
    updateServerProjectileGroundRaycasts(dt)

    // Animate message-driven projectile visuals (movement, expiry)
    updateMsgProjectileVisuals(dt)

    // Clear local throw flag when projectile visual has appeared and then gone
    if (localThrowActive) {
      if (msgProjectileVisuals.length > 0) {
        localThrowSawVisual = true
      } else if (localThrowSawVisual) {
        // Visual existed and is now gone — boomerang returned
        localThrowActive = false
        localThrowSawVisual = false
      } else if (now - lastLocalProjectileFireTime > PROJECTILE_LIFETIME_SEC * 1000) {
        // Safety: message never arrived
        localThrowActive = false
        localThrowSawVisual = false
      }
    }
  } else {
    // Local test mode
    updateLocalProjectiles(dt)
  }



  // E key — fire projectile (disabled in spectator mode)
  if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN) && !isSpectatorMode() && !isCinematicActive() && !isDrownRespawning()) {
    const userId = getPlayerData()?.userId
    if (!userId) return

    // Client-side cooldown check
    const projectileCd = PROJECTILE_COOLDOWN_SEC
    if (now - lastLocalProjectileFireTime < projectileCd * 1000) {
      const remaining = ((projectileCd * 1000 - (now - lastLocalProjectileFireTime)) / 1000).toFixed(1)
      console.log('[Projectile] E pressed but cooldown active —', remaining, 's remaining')
      playErrorSound()
      return
    }

    lastLocalProjectileFireTime = now
    const { dirX, dirZ } = getPlayerForward()

    if (serverUp) {
      console.log('[Projectile] 🎯 E pressed — requesting projectile fire (server)')
      localThrowActive = true; localThrowSawVisual = false
      updateHandBoomerangVisibility()
      room.send('requestShell', { dirX, dirZ, color: getBoomerangColor() })

      if (Transform.has(engine.PlayerEntity)) {
        const playerPos = Transform.get(engine.PlayerEntity).position
        const spawnPos = Vector3.create(playerPos.x + dirX * 1.0, playerPos.y + 0.8, playerPos.z + dirZ * 1.0)
        fireWallRaycast(spawnPos, dirX, dirZ)
      }
    } else {
      console.log('[Projectile] 🎯 E pressed — firing projectile locally (no server)')
      localThrowActive = true; localThrowSawVisual = false
      updateHandBoomerangVisibility()
      fireProjectileLocally()
    }
  }
}
