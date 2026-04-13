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
import { Flag, Shell, SHELL_COOLDOWN_SEC, SHELL_LIFETIME_SEC, SHELL_SPEED, SHELL_MAX_RANGE } from '../shared/components'

import { room } from '../shared/messages'
import { triggerEmote } from '~system/RestrictedActions'
import { isSpectatorMode } from './spectatorSystem'
import { isCinematicActive } from '../cinematicState'
import { isDrownRespawning } from './waterSystem'
import { showHitEffect, showMissEffect, playHitSound, playMissSound } from './combatSystem'

// Hand boomerang visibility
let handBoomerangEntity: Entity | null = null
let emoteActive = false
let lastPlayerPos: Vector3 | null = null
const EMOTE_MOVE_THRESHOLD = 0.1 // player must move this far to cancel emote hide

export function setHandBoomerangEntity(e: Entity) {
  handBoomerangEntity = e
  // Listen for emotes on the local player
  AvatarEmoteCommand.onChange(engine.PlayerEntity, (cmd) => {
    if (cmd) {
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

function updateHandBoomerangVisibility(): void {
  if (handBoomerangEntity === null) return
  // Cancel emote hide once player moves
  if (emoteActive && Transform.has(engine.PlayerEntity) && lastPlayerPos) {
    const p = Transform.get(engine.PlayerEntity).position
    if (Vector3.distance(p, lastPlayerPos) > EMOTE_MOVE_THRESHOLD) {
      emoteActive = false
    }
  }
  const shouldShow = localShells.length === 0 && !emoteActive && !isCinematicActive()
  VisibilityComponent.createOrReplace(handBoomerangEntity, { visible: shouldShow })
}

const SHELL_MODEL_SRC = 'assets/scene/Models/boomerang.g.glb'
const SHELL_SCALE = Vector3.create(2.5, 3, 2.5)
const SHELL_STAGGER_MS = 800
const SHELL_GRAVITY = 15  // m/s² — matches server FLAG_GRAVITY
const SHELL_SPIN_SPEED = 720 // degrees per second
const SHELL_CHEST_OFFSET = 0.8 // Y offset from player position to chest height
const SHELL_GROUND_OFFSET = 0.35 // Raise shell above ground so it doesn't clip terrain — matches server
const GROUND_RAY_INTERVAL = 0.05 // seconds between ground raycasts for moving shells

// Stagger state for shell hits
let shellStaggerUntil = 0

// ── Sound ──
const SHELL_SOUND_SRC = 'assets/sounds/mk_shell_short.mp3'

/** Attach a looping spatial shell sound directly to a shell entity. */
function attachShellSound(entity: Entity): void {
  AudioSource.createOrReplace(entity, {
    audioClipUrl: SHELL_SOUND_SRC,
    playing: true,
    loop: true,
    volume: 1.0,
    global: false
  })
}

/** Stop the shell sound on an entity (before removal). */
function stopShellSound(entity: Entity): void {
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
let lastLocalShellFireTime = 0

/** Returns true if shell is on cooldown (for UI). */
export function isShellOnCooldown(): boolean {
  if (lastLocalShellFireTime === 0) return false
  const cooldown = SHELL_COOLDOWN_SEC
  return (Date.now() - lastLocalShellFireTime) < cooldown * 1000
}

/** Returns cooldown remaining in seconds (0 if ready). */
export function getShellCooldownRemaining(): number {
  if (lastLocalShellFireTime === 0) return 0
  const cooldown = SHELL_COOLDOWN_SEC
  const elapsed = Date.now() - lastLocalShellFireTime
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
    maxDistance: SHELL_MAX_RANGE,
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

// ── Continuous ground raycasts for server-mode shells ──
// We track synced Shell entities and periodically fire downward raycasts
// from their current position to report ground height to the server.
interface TrackedServerShell {
  rayEntity: Entity | null
  lastRayTime: number
}
const trackedServerShells = new Map<number, TrackedServerShell>() // entity id -> tracking state

function updateServerShellGroundRaycasts(dt: number): void {
  const now = Date.now()

  for (const [entity, shell] of engine.getEntitiesWith(Shell, Transform)) {
    if (!shell.active) continue

    const entityId = entity as number
    let tracked = trackedServerShells.get(entityId)
    if (!tracked) {
      tracked = { rayEntity: null, lastRayTime: 0 }
      trackedServerShells.set(entityId, tracked)
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
        position: Vector3.create(pos.x, pos.y + 2, pos.z) // start above shell
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

  // Clean up tracking for shells that no longer exist
  for (const [entityId, tracked] of trackedServerShells) {
    if (!Shell.has(entityId as Entity)) {
      if (tracked.rayEntity !== null) {
        engine.removeEntity(tracked.rayEntity)
      }
      trackedServerShells.delete(entityId)
    }
  }
}

// ── Message listeners (registered at module scope for reliable delivery) ──
room.onMessage('shellDropped', (data) => {
  // Create visual from message bus (instant, no CRDT dependency).
  // Mobile live CRDT sync is unreliable — this ensures the visual always appears.
  createMsgShellVisual(data.x, data.y, data.z, data.dirX, data.dirZ)
})

room.onMessage('shellTriggered', (data) => {
  const pos = Vector3.create(data.x, data.y, data.z)
  // Remove the message-driven shell visual closest to the hit position
  removeMsgShellVisualNear(data.x, data.y, data.z)

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
      shellStaggerUntil = Date.now() + SHELL_STAGGER_MS
    }
  } else {
    // Shell hit banana or wall — show miss cloud + sound
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

interface LocalShell {
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
const localShells: LocalShell[] = []

function fireShellLocally(): void {
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
    scale: SHELL_SCALE,
    rotation: Quaternion.fromEulerDegrees(0, Math.atan2(dirX, dirZ) * (180 / Math.PI), 0)
  })
  GltfContainer.create(shellEntity, {
    src: SHELL_MODEL_SRC,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  // Fire wall raycast (forward)
  const wallRayEntity = engine.addEntity()
  Transform.create(wallRayEntity, { position: spawnPos })
  Raycast.create(wallRayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(dirX, 0, dirZ) },
    maxDistance: SHELL_MAX_RANGE,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })

  // Attach looping spatial sound to the shell entity
  attachShellSound(shellEntity)

  localShells.push({
    entity: shellEntity,
    firedAtMs: Date.now(),
    startX: spawnPos.x,
    startY: spawnPos.y,
    startZ: spawnPos.z,
    dirX,
    dirZ,
    distanceTraveled: 0,
    maxDistance: SHELL_MAX_RANGE,
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
  console.log('[Shell] 🐚 LOCAL shell fired dir:', dirX.toFixed(2), dirZ.toFixed(2))
  updateHandBoomerangVisibility()
}

function removeLocalShell(index: number): void {
  const shell = localShells[index]
  stopShellSound(shell.entity)
  if (shell.wallRayEntity !== null) engine.removeEntity(shell.wallRayEntity)
  if (shell.groundRayEntity !== null) engine.removeEntity(shell.groundRayEntity)
  engine.removeEntity(shell.entity)
  localShells.splice(index, 1)
  updateHandBoomerangVisibility()
}

function updateLocalShells(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = localShells.length - 1; i >= 0; i--) {
    const shell = localShells[i]

    // Check wall raycast result
    if (shell.wallRayEntity !== null) {
      const result = RaycastResult.getOrNull(shell.wallRayEntity)
      if (result) {
        if (result.hits.length > 0) {
          shell.maxDistance = Math.min(shell.maxDistance, result.hits[0].length)
        }
        engine.removeEntity(shell.wallRayEntity)
        shell.wallRayEntity = null
      }
    }

    // Safety expiry
    if (now - shell.firedAtMs > SHELL_LIFETIME_SEC * 1000) {
      console.log('[Shell] 🐚 LOCAL shell expired')
      removeLocalShell(i)
      continue
    }

    // Move forward or return to player's current position
    const moveDistance = SHELL_SPEED * clampedDt
    if (!shell.returning) {
      shell.distanceTraveled += moveDistance
      if (shell.distanceTraveled >= shell.maxDistance) {
        shell.returning = true
        shell.returnDistance = 0
        console.log('[Shell] 🐚 LOCAL shell reached max range, returning')
      }
    }

    // Spin the boomerang
    shell.spinAngle += SHELL_SPIN_SPEED * clampedDt

    if (!shell.returning) {
      // Outbound — straight line from start
      const headingDeg = Math.atan2(shell.dirX, shell.dirZ) * (180 / Math.PI)
      const newX = shell.startX + shell.dirX * shell.distanceTraveled
      const newZ = shell.startZ + shell.dirZ * shell.distanceTraveled
      const t = Transform.getMutable(shell.entity)
      t.position = Vector3.create(newX, shell.startY, newZ)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + shell.spinAngle, 0)
    } else {
      // Returning — home in on player's chest height
      const shellPos = Transform.get(shell.entity).position
      const rawPlayerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : Vector3.create(shell.startX, shell.startY, shell.startZ)
      const playerPos = Vector3.create(rawPlayerPos.x, rawPlayerPos.y + SHELL_CHEST_OFFSET, rawPlayerPos.z)
      const dx = playerPos.x - shellPos.x
      const dy = playerPos.y - shellPos.y
      const dz = playerPos.z - shellPos.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (dist < 2.0) {
        console.log('[Shell] 🐚 LOCAL shell returned to player')
        removeLocalShell(i)
        continue
      }

      const nx = dx / dist, ny = dy / dist, nz = dz / dist
      const headingDeg = Math.atan2(nx, nz) * (180 / Math.PI)
      const t = Transform.getMutable(shell.entity)
      t.position = Vector3.create(shellPos.x + nx * moveDistance, shellPos.y + ny * moveDistance, shellPos.z + nz * moveDistance)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + shell.spinAngle, 0)
    }
  }
}

// ── Shell visual entity pool ──
// Pre-create a fixed pool of entities with GltfContainer already loaded.
// Show/hide by moving position + scale instead of create/destroy to avoid
// the Decentraland engine bug where rapid GltfContainer create/destroy
// causes models to stop rendering.
const SHELL_POOL_SIZE = 10
const shellPool: Entity[] = []
let shellPoolReady = false
const SHELL_HIDDEN_POS = Vector3.create(0, -200, 0)

function initShellPool(): void {
  if (shellPoolReady) return
  shellPoolReady = true
  for (let i = 0; i < SHELL_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: SHELL_HIDDEN_POS, scale: Vector3.Zero() })
    GltfContainer.create(e, {
      src: SHELL_MODEL_SRC,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    shellPool.push(e)
  }
  console.log('[Shell] 🐚 Pre-created shell visual pool of', SHELL_POOL_SIZE)
}

function acquireShellFromPool(): Entity | null {
  initShellPool()
  for (const e of shellPool) {
    const t = Transform.get(e)
    if (t.position.y < -100) return e
  }
  console.error('[Shell] 🐚 Pool exhausted! All', SHELL_POOL_SIZE, 'shell visuals in use.')
  return null
}

function releaseShellToPool(entity: Entity): void {
  stopShellSound(entity)
  const t = Transform.getMutable(entity)
  t.position = SHELL_HIDDEN_POS
  t.scale = Vector3.Zero()
}

// ── Message-driven visual entities for shells ──
// Visuals are created from the 'shellDropped' message (WebSocket, instant) rather than
// from CRDT-synced Shell entities. Mobile live CRDT sync is unreliable — shells expire
// before entities arrive. The message bus delivers position + direction instantly.
// 'shellTriggered' message or time-based safety expiry removes the visual.
interface MsgShellVisual {
  entity: Entity
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
}
const msgShellVisuals: MsgShellVisual[] = []

function createMsgShellVisual(x: number, y: number, z: number, dirX: number, dirZ: number): void {
  const localEntity = acquireShellFromPool()
  if (!localEntity) return

  const t = Transform.getMutable(localEntity)
  t.position = Vector3.create(x, y, z)
  t.scale = SHELL_SCALE
  t.rotation = Quaternion.fromEulerDegrees(0, Math.atan2(dirX, dirZ) * (180 / Math.PI), 0)

  attachShellSound(localEntity)

  msgShellVisuals.push({
    entity: localEntity,
    startX: x, startY: y, startZ: z,
    dirX, dirZ,
    createdAtMs: Date.now(),
    distanceTraveled: 0,
    maxDistance: SHELL_MAX_RANGE,
    currentY: y,
    fallVelocity: 0,
    groundY: 0,
    onGround: false,
    groundRayEntity: null,
    lastGroundRayTime: 0,
    spinAngle: 0,
    returning: false,
    returnDistance: 0,
  })
  console.log('[Shell] 🐚 Created message-driven shell visual at:', x.toFixed(1), y.toFixed(1), z.toFixed(1))
}

function removeMsgShellVisualNear(x: number, y: number, z: number): void {
  // Find the closest shell visual
  let closestIdx = -1
  let closestDist = Infinity
  for (let i = 0; i < msgShellVisuals.length; i++) {
    const vis = msgShellVisuals[i]
    const pos = Transform.get(vis.entity).position
    const dx = pos.x - x, dy = pos.y - y, dz = pos.z - z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dist < closestDist) { closestDist = dist; closestIdx = i }
  }
  if (closestIdx === -1) return

  const vis = msgShellVisuals[closestIdx]
  if (vis.returning) {
    // Already returning — this is a hit on the return trip, actually remove it
    if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
    releaseShellToPool(vis.entity)
    msgShellVisuals.splice(closestIdx, 1)
  } else {
    // Outbound hit — start returning
    vis.returning = true
    vis.returnDistance = 0
  }
}

function updateMsgShellVisuals(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = msgShellVisuals.length - 1; i >= 0; i--) {
    const vis = msgShellVisuals[i]

    // Safety expiry
    if (now - vis.createdAtMs > SHELL_LIFETIME_SEC * 1000) {
      if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
      releaseShellToPool(vis.entity)
      msgShellVisuals.splice(i, 1)
      continue
    }

    // Move forward or return to player's CURRENT position
    const moveDist = SHELL_SPEED * clampedDt
    if (!vis.returning) {
      vis.distanceTraveled += moveDist
      if (vis.distanceTraveled >= vis.maxDistance) {
        vis.returning = true
        vis.returnDistance = 0
      }
    }

    // Spin the boomerang
    vis.spinAngle += SHELL_SPIN_SPEED * clampedDt

    if (!vis.returning) {
      // Outbound — straight line from start
      const headingDeg = Math.atan2(vis.dirX, vis.dirZ) * (180 / Math.PI)
      const t = Transform.getMutable(vis.entity)
      t.position = Vector3.create(vis.startX + vis.dirX * vis.distanceTraveled, vis.startY, vis.startZ + vis.dirZ * vis.distanceTraveled)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + vis.spinAngle, 0)
    } else {
      // Returning — lerp toward player's chest height
      const shellPos = Transform.get(vis.entity).position
      const rawPlayerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : Vector3.create(vis.startX, vis.startY, vis.startZ)
      const playerPos = Vector3.create(rawPlayerPos.x, rawPlayerPos.y + SHELL_CHEST_OFFSET, rawPlayerPos.z)
      const dx = playerPos.x - shellPos.x
      const dy = playerPos.y - shellPos.y
      const dz = playerPos.z - shellPos.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (dist < 2.0) {
        // Close enough — disappear
        if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
        releaseShellToPool(vis.entity)
        msgShellVisuals.splice(i, 1)
        continue
      }

      // Move toward player at shell speed
      const nx = dx / dist, ny = dy / dist, nz = dz / dist
      const headingDeg = Math.atan2(nx, nz) * (180 / Math.PI)
      const t = Transform.getMutable(vis.entity)
      t.position = Vector3.create(shellPos.x + nx * moveDist, shellPos.y + ny * moveDist, shellPos.z + nz * moveDist)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + vis.spinAngle, 0)
    }
  }
}

/** Fire a shell from the UI (mobile tap). Same logic as E key press. */
export function triggerShellFromUI(): void {
  if (isDrownRespawning()) return
  const now = Date.now()
  const userId = getPlayerData()?.userId
  if (!userId) return

  if (now - lastLocalShellFireTime < SHELL_COOLDOWN_SEC * 1000) { playErrorSound(); return }

  lastLocalShellFireTime = now
  const { dirX, dirZ } = getPlayerForward()
  const serverUp = isServerConnected()

  if (serverUp) {
    console.log('[Shell] 🐚 UI tap — requesting shell fire (server)')
    room.send('requestShell', { dirX, dirZ })
    if (Transform.has(engine.PlayerEntity)) {
      const playerPos = Transform.get(engine.PlayerEntity).position
      const spawnPos = Vector3.create(playerPos.x + dirX * 1.0, playerPos.y + 0.8, playerPos.z + dirZ * 1.0)
      fireWallRaycast(spawnPos, dirX, dirZ)
    }
  } else {
    console.log('[Shell] 🐚 UI tap — firing shell locally (no server)')
    fireShellLocally()
  }
}

// ── Main client system ──
export function shellClientSystem(dt: number): void {
  updateHandBoomerangVisibility()
  const now = Date.now()
  const serverUp = isServerConnected()

  // Release shell stagger freeze
  if (shellStaggerUntil > 0 && now >= shellStaggerUntil) {
    shellStaggerUntil = 0
    if (InputModifier.has(engine.PlayerEntity)) {
      InputModifier.deleteFrom(engine.PlayerEntity)
    }
  }

  if (serverUp) {
    // Process wall raycasts
    processWallRaycasts()
    // Continuously report ground Y for moving shells
    updateServerShellGroundRaycasts(dt)

    // Animate message-driven shell visuals (movement, expiry)
    updateMsgShellVisuals(dt)
  } else {
    // Local test mode
    updateLocalShells(dt)
  }



  // E key — fire shell (disabled in spectator mode)
  if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN) && !isSpectatorMode() && !isCinematicActive() && !isDrownRespawning()) {
    const userId = getPlayerData()?.userId
    if (!userId) return

    // Client-side cooldown check
    const shellCd = SHELL_COOLDOWN_SEC
    if (now - lastLocalShellFireTime < shellCd * 1000) {
      const remaining = ((shellCd * 1000 - (now - lastLocalShellFireTime)) / 1000).toFixed(1)
      console.log('[Shell] E pressed but cooldown active —', remaining, 's remaining')
      playErrorSound()
      return
    }

    lastLocalShellFireTime = now
    const { dirX, dirZ } = getPlayerForward()

    if (serverUp) {
      console.log('[Shell] 🐚 E pressed — requesting shell fire (server)')
      room.send('requestShell', { dirX, dirZ })

      if (Transform.has(engine.PlayerEntity)) {
        const playerPos = Transform.get(engine.PlayerEntity).position
        const spawnPos = Vector3.create(playerPos.x + dirX * 1.0, playerPos.y + 0.8, playerPos.z + dirZ * 1.0)
        fireWallRaycast(spawnPos, dirX, dirZ)
      }
    } else {
      console.log('[Shell] 🐚 E pressed — firing shell locally (no server)')
      fireShellLocally()
    }
  }
}
