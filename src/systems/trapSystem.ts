import {
  engine,
  Transform,
  AudioSource,
  GltfContainer,
  inputSystem,
  InputAction,
  PointerEventType,
  InputModifier,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Tween,
  TweenSequence,
  EasingFunction,
  Raycast,
  RaycastResult,
  RaycastQueryType,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { TRAP_COOLDOWN_SEC, TRAP_LIFETIME_SEC, TRAP_TRIGGER_RADIUS } from '../shared/components'

import { room } from '../shared/messages'
import { playErrorSound, isServerConnected } from './clientUtils'

import { triggerEmote } from '~system/RestrictedActions'
import { isSpectatorMode } from './spectatorSystem'
import { isCinematicActive } from '../cinematicState'
import { isDrownRespawning } from './waterSystem'
import { showHitEffect } from './combatSystem'

const TRAP_MODEL_SRC = 'assets/models/banana_scaled.glb'
const TRAP_SCALE = Vector3.create(1, 1, 1)
const TRAP_STAGGER_MS = 1000 // Duration when hitting own trap

// Stagger state for trap hits
let trapStaggerUntil = 0

// playErrorSound imported from clientUtils

let trapDropSoundEntity: Entity | null = null
let trapSplatSoundEntity: Entity | null = null

function playTrapDropSound(position: Vector3): void {
  if (!trapDropSoundEntity) {
    trapDropSoundEntity = engine.addEntity()
    Transform.create(trapDropSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(trapDropSoundEntity, {
      audioClipUrl: 'assets/sounds/trap.mp3',
      playing: false,
      loop: false,
      volume: 0.8,
      global: false
    })
  }
  const t = Transform.getMutable(trapDropSoundEntity)
  t.position = position
  const a = AudioSource.getMutable(trapDropSoundEntity)
  a.currentTime = 0
  a.playing = true
}

function playTrapSplatSound(position: Vector3): void {
  if (!trapSplatSoundEntity) {
    trapSplatSoundEntity = engine.addEntity()
    Transform.create(trapSplatSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(trapSplatSoundEntity, {
      audioClipUrl: 'assets/sounds/hit.mp3',
      playing: false,
      loop: false,
      volume: 1.0,
      global: false
    })
  }
  const t = Transform.getMutable(trapSplatSoundEntity)
  t.position = position
  const a = AudioSource.getMutable(trapSplatSoundEntity)
  a.currentTime = 0
  a.playing = true
}

// ── Splat VFX pool ──
const SPLAT_POOL_SIZE = 6
const SPLAT_DURATION_MS = 500
const trapSplatPool: Entity[] = []
let trapSplatPoolIdx = 0
let trapSplatPoolReady = false
const HIDDEN_POS = Vector3.create(0, -100, 0)
const activeSplats: { entity: Entity; expiresAt: number }[] = []

const SPLAT_MATERIAL = {
  albedoColor: Color4.create(1.0, 0.95, 0.2, 0.7),
  emissiveColor: Color4.create(1.0, 0.9, 0.1, 1),
  emissiveIntensity: 2.0,
  roughness: 1.0,
  metallic: 0.0,
  specularIntensity: 0.0,
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
}

function initSplatPool(): void {
  if (trapSplatPoolReady) return
  trapSplatPoolReady = true
  for (let i = 0; i < SPLAT_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, SPLAT_MATERIAL)
    trapSplatPool.push(e)
  }
}

function _showSplatEffect(position: Vector3): void {
  initSplatPool()
  const expiresAt = Date.now() + SPLAT_DURATION_MS + 50

  // Spawn a few expanding yellow spheres at the trap position
  for (let i = 0; i < 3; i++) {
    const sphere = trapSplatPool[trapSplatPoolIdx % SPLAT_POOL_SIZE]
    trapSplatPoolIdx++

    const jitter = Vector3.create(
      (Math.random() - 0.5) * 0.8,
      Math.random() * 0.3,
      (Math.random() - 0.5) * 0.8
    )
    const pos = Vector3.add(position, jitter)
    const startScale = 0.1 + Math.random() * 0.1
    const endScale = 0.4 + Math.random() * 0.3

    const t = Transform.getMutable(sphere)
    t.position = pos
    t.scale = Vector3.create(startScale, startScale, startScale)

    const endVec = Vector3.create(endScale, endScale * 0.3, endScale)
    Tween.createOrReplace(sphere, {
      mode: Tween.Mode.Scale({
        start: Vector3.create(startScale, startScale, startScale),
        end: endVec // Flatten vertically for "splat"
      }),
      duration: SPLAT_DURATION_MS,
      easingFunction: EasingFunction.EF_EASEOUTQUAD,
    })
    // Chain a shrink-to-zero so the splat disappears even if the timer cleanup doesn't fire (mobile bug)
    TweenSequence.createOrReplace(sphere, {
      sequence: [{
        mode: Tween.Mode.Scale({ start: endVec, end: Vector3.Zero() }),
        duration: SPLAT_DURATION_MS * 0.3,
        easingFunction: EasingFunction.EF_EASEINQUAD,
      }]
    })

    activeSplats.push({ entity: sphere, expiresAt })
  }
}

function hideSplat(entity: Entity): void {
  const t = Transform.getMutable(entity)
  t.position = HIDDEN_POS
  t.scale = Vector3.Zero()
  if (TweenSequence.has(entity)) TweenSequence.deleteFrom(entity)
  if (Tween.has(entity)) Tween.deleteFrom(entity)
}

// ── Client cooldown tracking ──
let lastLocalTrapDropTime = 0

/** Returns true if trap is on cooldown (for UI). */
export function isTrapOnCooldown(): boolean {
  if (lastLocalTrapDropTime === 0) return false
  const cooldown = TRAP_COOLDOWN_SEC
  return (Date.now() - lastLocalTrapDropTime) < cooldown * 1000
}

/** Returns cooldown remaining in seconds (0 if ready). */
export function getTrapCooldownRemaining(): number {
  if (lastLocalTrapDropTime === 0) return 0
  const cooldown = TRAP_COOLDOWN_SEC
  const elapsed = Date.now() - lastLocalTrapDropTime
  const remaining = cooldown * 1000 - elapsed
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

// ── Trap ground raycasts ──
// When the server drops a trap, the client fires a downward raycast to find the
// actual ground height and reports it back so the server can land the trap properly.
interface PendingTrapRay {
  entity: Entity
  bananaX: number
  bananaZ: number
}
const pendingTrapRays: PendingTrapRay[] = []

function fireTrapGroundRaycast(x: number, y: number, z: number): void {
  const rayEntity = engine.addEntity()
  Transform.create(rayEntity, {
    position: Vector3.create(x, y + 0.5, z) // start slightly above drop point
  })
  Raycast.create(rayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
    maxDistance: 200,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })
  pendingTrapRays.push({ entity: rayEntity, bananaX: x, bananaZ: z })
}

function processTrapRaycasts(): void {
  for (let i = pendingTrapRays.length - 1; i >= 0; i--) {
    const ray = pendingTrapRays[i]
    const result = RaycastResult.getOrNull(ray.entity)
    if (result) {
      const groundY = result.hits.length > 0 ? result.hits[0].position!.y : 0
      room.send('reportBananaGroundY', { bananaX: ray.bananaX, bananaZ: ray.bananaZ, groundY })
      engine.removeEntity(ray.entity)
      pendingTrapRays.splice(i, 1)
    }
  }
}

// ── Message listeners ──
// ── Message listeners (registered at module scope for reliable delivery) ──
room.onMessage('bananaDropped', (data) => {
  console.log('[Trap] bananaDropped msg:', JSON.stringify(data))
  playTrapDropSound(Vector3.create(data.x, data.y, data.z))
  // Create visual from message bus (instant, no CRDT dependency)
  createMsgTrapVisual(data.x, data.y, data.z, data.ownerId || '')
  // Fire ground raycast so server knows where to land this trap
  fireTrapGroundRaycast(data.x, data.y, data.z)
})

room.onMessage('bananaTriggered', (data) => {
  const pos = Vector3.create(data.x, data.y, data.z)

  // Remove the message-driven trap visual
  removeMsgTrapVisualNear(data.x, data.y, data.z)

  // Hit by boomerang (no victim): skip sound here — shellTriggered already plays the miss sound
  // Stepped on by player: play hit sound + hit VFX (only if prediction didn't already handle it)
  // Boomerang destroyed banana: smoke puff
  if (data.victimId && data.victimId !== '') {
    const me = getPlayerData()?.userId
    const isMe = me && data.victimId === me.toLowerCase()
    // If it's us and we're already staggered, prediction already played the VFX
    if (!isMe || trapStaggerUntil <= Date.now()) {
      playTrapSplatSound(pos)
      showHitEffect(pos)
    }
  }
  // Boomerang hits: smoke puff already handled by shellTriggered handler

  // Stagger the victim if it's the local player
  const me = getPlayerData()?.userId
  if (me && data.victimId === me.toLowerCase() && !isCinematicActive()) {
    // Only apply if not already staggered (client-side prediction may have already triggered it)
    const now = Date.now()
    if (trapStaggerUntil <= now) {
      triggerEmote({ predefinedEmote: 'getHit' })
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: true, disableGliding: true, disableDoubleJump: true })
      })
      trapStaggerUntil = now + TRAP_STAGGER_MS
    } else {
      console.log('[Trap] bananaTriggered skipped — already staggered, remaining:', trapStaggerUntil - now, 'ms')
    }
  }
})

// isServerConnected imported from clientUtils

const LOCAL_GRAVITY = 15 // m/s² — matches server FLAG_GRAVITY
const LOCAL_MIN_Y = 1  // Traps sit on the actual ground surface

interface LocalTrap {
  entity: Entity
  droppedAtMs: number
  falling: boolean
  fallVelocity: number
  targetY: number
  rayEntity: Entity | null
}
const localTraps: LocalTrap[] = []

function dropTrapLocally(): void {
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position
  const dropPos = Vector3.create(playerPos.x, playerPos.y - 0.2, playerPos.z)

  const bananaEntity = engine.addEntity()
  Transform.create(bananaEntity, {
    position: dropPos,
    scale: TRAP_SCALE
  })
  GltfContainer.create(bananaEntity, {
    src: TRAP_MODEL_SRC,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  // Fire a ground raycast for this trap
  const rayEntity = engine.addEntity()
  Transform.create(rayEntity, {
    position: Vector3.create(dropPos.x, dropPos.y + 0.5, dropPos.z)
  })
  Raycast.create(rayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
    maxDistance: 200,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })

  localTraps.push({
    entity: bananaEntity,
    droppedAtMs: Date.now(),
    falling: true,
    fallVelocity: 0,
    targetY: LOCAL_MIN_Y,
    rayEntity,
  })
  playTrapDropSound(dropPos)
  console.log('[Trap] 🪤 LOCAL test trap dropped at', dropPos.x.toFixed(1), dropPos.y.toFixed(1), dropPos.z.toFixed(1))
}

function removeLocalTrap(index: number): void {
  const trap = localTraps[index]
  if (trap.rayEntity !== null) {
    engine.removeEntity(trap.rayEntity)
  }
  engine.removeEntity(trap.entity)
  localTraps.splice(index, 1)
}

function updateLocalTraps(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position

  for (let i = localTraps.length - 1; i >= 0; i--) {
    const trap = localTraps[i]

    // Check raycast result for ground Y
    if (trap.rayEntity !== null) {
      const result = RaycastResult.getOrNull(trap.rayEntity)
      if (result) {
        const groundY = result.hits.length > 0 ? result.hits[0].position!.y : 0
        trap.targetY = Math.max(LOCAL_MIN_Y, groundY)
        engine.removeEntity(trap.rayEntity)
        trap.rayEntity = null

        // If already at or below target, snap
        const currentY = Transform.get(trap.entity).position.y
        if (currentY <= trap.targetY) {
          const t = Transform.getMutable(trap.entity)
          t.position = Vector3.create(t.position.x, trap.targetY, t.position.z)
          trap.falling = false
          trap.fallVelocity = 0
        }
      }
    }

    // Gravity
    if (trap.falling) {
      trap.fallVelocity += LOCAL_GRAVITY * clampedDt
      const pos = Transform.get(trap.entity).position
      let newY = pos.y - trap.fallVelocity * clampedDt
      if (newY <= trap.targetY) {
        newY = trap.targetY
        trap.falling = false
        trap.fallVelocity = 0
      }
      const t = Transform.getMutable(trap.entity)
      t.position = Vector3.create(pos.x, newY, pos.z)
    }

    // Expiry
    if (now - trap.droppedAtMs > TRAP_LIFETIME_SEC * 1000) {
      console.log('[Trap] 🪤 LOCAL trap expired')
      removeLocalTrap(i)
      continue
    }

    // Self-trigger test: walk back over your own trap after 1 second grace period
    if (now - trap.droppedAtMs > 1000) {
      const bananaPos = Transform.get(trap.entity).position
      const dist = Vector3.distance(playerPos, bananaPos)
      if (dist < TRAP_TRIGGER_RADIUS) {
        console.log('[Trap] 🪤 LOCAL trap triggered!')
        playTrapSplatSound(bananaPos)
        showHitEffect(bananaPos)
        triggerEmote({ predefinedEmote: 'getHit' })
        removeLocalTrap(i)
      }
    }
  }
}

// ── Client-side visual entities for synced traps ──
// IMPORTANT: We NEVER modify the synced entity (Transform, GltfContainer, etc.)
// because client writes to server-synced entities create CRDT conflicts that
// break the authoritative server in deployed environments.
//
// Instead, for each synced Trap entity we create a LOCAL-ONLY visual entity
// ── Trap visual entity pool ──
// Pre-create a fixed pool of entities with GltfContainer already loaded.
// Show/hide by moving position + scale instead of create/destroy to avoid
// the Decentraland engine bug where rapid GltfContainer create/destroy
// causes models to stop rendering.
const TRAP_POOL_SIZE = 10
const trapPool: Entity[] = []
let trapPoolReady = false
const TRAP_HIDDEN_POS = Vector3.create(0, -200, 0)

export function initTrapPool(): void {
  if (trapPoolReady) return
  trapPoolReady = true
  for (let i = 0; i < TRAP_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: TRAP_HIDDEN_POS, scale: Vector3.Zero() })
    GltfContainer.create(e, {
      src: TRAP_MODEL_SRC,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    trapPool.push(e)
  }
  console.log('[Trap] 🪤 Pre-created trap visual pool of', TRAP_POOL_SIZE)
}

function acquireTrapFromPool(): Entity | null {
  initTrapPool()
  // Find a pool entity that is currently hidden (at hidden pos)
  for (const e of trapPool) {
    const t = Transform.get(e)
    if (t.position.y < -100) return e
  }
  console.error('[Trap] 🪤 Pool exhausted! All', TRAP_POOL_SIZE, 'trap visuals in use.')
  return null
}

function releaseTrapToPool(entity: Entity): void {
  const t = Transform.getMutable(entity)
  t.position = TRAP_HIDDEN_POS
  t.scale = Vector3.Zero()
}

// ── Message-driven visual entities for traps ──
// Visuals are created from the 'bananaDropped' message (WebSocket, instant) rather than
// from CRDT-synced Trap entities. Mobile live CRDT sync is unreliable.
interface MsgTrapVisual {
  entity: Entity
  x: number
  z: number
  ownerId: string
  createdAtMs: number
  falling: boolean
  fallVelocity: number
  currentY: number
  targetY: number
  groundResolved: boolean
  groundRayEntity: Entity | null
}
const msgTrapVisuals: MsgTrapVisual[] = []

function createMsgTrapVisual(x: number, y: number, z: number, ownerId: string = ''): void {
  const localEntity = acquireTrapFromPool()
  if (!localEntity) return

  const t = Transform.getMutable(localEntity)
  t.position = Vector3.create(x, y, z)
  t.scale = TRAP_SCALE

  // Fire ground raycast for this visual
  const groundRayEntity = engine.addEntity()
  Transform.create(groundRayEntity, { position: Vector3.create(x, y + 0.5, z) })
  Raycast.create(groundRayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
    maxDistance: 200, queryType: RaycastQueryType.RQT_HIT_FIRST, continuous: false
  })

  msgTrapVisuals.push({
    entity: localEntity, x, z,
    ownerId,
    createdAtMs: Date.now(),
    falling: true, fallVelocity: 0, currentY: y, targetY: 0,
    groundResolved: false, groundRayEntity,
  })
  console.log('[Trap] 🪤 Created message-driven trap visual at:', x.toFixed(1), y.toFixed(1), z.toFixed(1))
}

function removeMsgTrapVisualNear(x: number, y: number, z: number): void {
  let closestIdx = -1
  let closestDist = 5
  for (let i = 0; i < msgTrapVisuals.length; i++) {
    const vis = msgTrapVisuals[i]
    const pos = Transform.get(vis.entity).position
    const dx = pos.x - x, dy = pos.y - y, dz = pos.z - z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dist < closestDist) { closestDist = dist; closestIdx = i }
  }
  if (closestIdx !== -1) {
    const vis = msgTrapVisuals[closestIdx]
    if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
    releaseTrapToPool(vis.entity)
    msgTrapVisuals.splice(closestIdx, 1)
  }
}

function updateMsgTrapVisuals(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = msgTrapVisuals.length - 1; i >= 0; i--) {
    const vis = msgTrapVisuals[i]

    // Safety expiry
    if (now - vis.createdAtMs > TRAP_LIFETIME_SEC * 1000) {
      if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
      releaseTrapToPool(vis.entity)
      msgTrapVisuals.splice(i, 1)
      continue
    }

    // Ground raycast result
    if (vis.groundRayEntity !== null) {
      const result = RaycastResult.getOrNull(vis.groundRayEntity)
      if (result) {
        if (result.hits.length > 0) vis.targetY = Math.max(0, result.hits[0].position!.y)
        vis.groundResolved = true
        engine.removeEntity(vis.groundRayEntity)
        vis.groundRayEntity = null
        if (vis.currentY <= vis.targetY) { vis.currentY = vis.targetY; vis.falling = false; vis.fallVelocity = 0 }
      }
    }

    // Gravity
    if (vis.falling) {
      vis.fallVelocity += LOCAL_GRAVITY * clampedDt
      vis.currentY -= vis.fallVelocity * clampedDt
      if (vis.currentY <= vis.targetY) { vis.currentY = vis.targetY; vis.falling = false; vis.fallVelocity = 0 }
    }

    const t = Transform.getMutable(vis.entity)
    t.position = Vector3.create(vis.x, vis.currentY, vis.z)

    // Client-side prediction: trigger stagger immediately on proximity
    if (!vis.falling && !isCinematicActive() && !isDrownRespawning() && Transform.has(engine.PlayerEntity)) {
      // Skip own banana during 2-second grace period (matches server logic)
      const me = getPlayerData()?.userId?.toLowerCase() || ''
      const isOwn = vis.ownerId !== '' && vis.ownerId === me
      if (isOwn && (now - vis.createdAtMs) < 2000) {
        console.log('[Trap] Skipping own banana prediction — owner:', vis.ownerId, 'me:', me, 'age:', now - vis.createdAtMs)
        continue
      }

      const playerPos = Transform.get(engine.PlayerEntity).position
      const dx = playerPos.x - vis.x
      const dz = playerPos.z - vis.z
      const dy = playerPos.y - vis.currentY
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < TRAP_TRIGGER_RADIUS && trapStaggerUntil <= now) {
        // Predict the stagger locally — server will confirm and remove the trap
        triggerEmote({ predefinedEmote: 'getHit' })
        const trapPos = Vector3.create(vis.x, vis.currentY, vis.z)
        playTrapSplatSound(trapPos)
        showHitEffect(trapPos)
        InputModifier.createOrReplace(engine.PlayerEntity, {
          mode: InputModifier.Mode.Standard({ disableAll: true, disableGliding: true, disableDoubleJump: true })
        })
        trapStaggerUntil = now + TRAP_STAGGER_MS
      }
    }
  }
}

/** Drop a trap from the UI (mobile tap). Same logic as F key press. */
export function triggerTrapFromUI(): void {
  if (isDrownRespawning()) return
  const now = Date.now()
  const userId = getPlayerData()?.userId
  if (!userId) return

  if (now - lastLocalTrapDropTime < TRAP_COOLDOWN_SEC * 1000) { playErrorSound(); return }

  lastLocalTrapDropTime = now
  const serverUp = isServerConnected()

  if (serverUp) {
    console.log('[Trap] 🪤 UI tap — requesting trap drop (server)')
    room.send('requestBanana', { t: 0 })
  } else {
    console.log('[Trap] 🪤 UI tap — dropping trap locally (no server)')
    dropTrapLocally()
  }
}

// ── Main client system ──
export function trapClientSystem(dt: number): void {
  const now = Date.now()
  const serverUp = isServerConnected()

  // Update local visual entities for synced traps (creates, positions, and cleans up)
  if (serverUp) {
    updateMsgTrapVisuals(dt)
  }

  // Release trap stagger freeze
  if (isCinematicActive() && trapStaggerUntil > 0) {
    trapStaggerUntil = 0
    if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
  }
  if (trapStaggerUntil > 0 && now >= trapStaggerUntil) {
    trapStaggerUntil = 0
    if (InputModifier.has(engine.PlayerEntity)) {
      InputModifier.deleteFrom(engine.PlayerEntity)
    }
  }

  // Clean up expired splat VFX
  for (let i = activeSplats.length - 1; i >= 0; i--) {
    if (now >= activeSplats[i].expiresAt) {
      hideSplat(activeSplats[i].entity)
      activeSplats.splice(i, 1)
    }
  }

  // Process trap ground raycasts (server mode)
  if (serverUp) {
    processTrapRaycasts()
  }

  // Update local traps (gravity + expiry + trigger) when in local test mode
  if (!serverUp) {
    updateLocalTraps(dt)
  }

  // F key — drop trap (disabled in spectator mode)
  if (inputSystem.isTriggered(InputAction.IA_SECONDARY, PointerEventType.PET_DOWN) && !isSpectatorMode() && !isCinematicActive() && !isDrownRespawning()) {
    const userId = getPlayerData()?.userId
    if (!userId) return

    // Client-side cooldown check (prevents spamming server)
    const trapCd = TRAP_COOLDOWN_SEC
    if (now - lastLocalTrapDropTime < trapCd * 1000) {
      const remaining = ((trapCd * 1000 - (now - lastLocalTrapDropTime)) / 1000).toFixed(1)
      console.log('[Trap] F pressed but cooldown active —', remaining, 's remaining')
      playErrorSound()
      return
    }

    lastLocalTrapDropTime = now

    if (serverUp) {
      // Production: send to server
      console.log('[Trap] 🪤 F pressed — requesting trap drop (server)')
      room.send('requestBanana', { t: 0 })
    } else {
      // Local test: create trap client-side
      console.log('[Trap] 🪤 F pressed — dropping trap locally (no server)')
      dropTrapLocally()
    }
  }
}
