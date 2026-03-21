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
import { Flag, Banana, BANANA_COOLDOWN_SEC, BANANA_LIFETIME_SEC, BANANA_TRIGGER_RADIUS } from '../shared/components'
import { room } from '../shared/messages'

import { triggerEmote } from '~system/RestrictedActions'

const BANANA_MODEL_SRC = 'assets/scene/Models/banana.glb'
const BANANA_SCALE = Vector3.create(0.02, 0.02, 0.02)
const BANANA_STAGGER_MS = 800 // Same duration as combat stagger

// Stagger state for banana hits
let bananaStaggerUntil = 0

// ── Sound ──
let bananaDropSoundEntity: Entity | null = null
let bananaSplatSoundEntity: Entity | null = null

function playBananaDropSound(position: Vector3): void {
  if (!bananaDropSoundEntity) {
    bananaDropSoundEntity = engine.addEntity()
    Transform.create(bananaDropSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(bananaDropSoundEntity, {
      audioClipUrl: 'assets/sounds/rs-banana.ogg',
      playing: false,
      loop: false,
      volume: 0.8,
      global: false
    })
  }
  const t = Transform.getMutable(bananaDropSoundEntity)
  t.position = position
  const a = AudioSource.getMutable(bananaDropSoundEntity)
  a.currentTime = 0
  a.playing = true
}

function playBananaSplatSound(position: Vector3): void {
  if (!bananaSplatSoundEntity) {
    bananaSplatSoundEntity = engine.addEntity()
    Transform.create(bananaSplatSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(bananaSplatSoundEntity, {
      audioClipUrl: 'assets/sounds/rs-hit.mp3',  // TODO: replace with banana splat sound
      playing: false,
      loop: false,
      volume: 1.0,
      global: false
    })
  }
  const t = Transform.getMutable(bananaSplatSoundEntity)
  t.position = position
  const a = AudioSource.getMutable(bananaSplatSoundEntity)
  a.currentTime = 0
  a.playing = true
}

// ── Splat VFX pool ──
const SPLAT_POOL_SIZE = 6
const SPLAT_DURATION_MS = 500
const splatPool: Entity[] = []
let splatPoolIdx = 0
let splatPoolReady = false
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
  if (splatPoolReady) return
  splatPoolReady = true
  for (let i = 0; i < SPLAT_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, SPLAT_MATERIAL)
    splatPool.push(e)
  }
}

function showSplatEffect(position: Vector3): void {
  initSplatPool()
  const expiresAt = Date.now() + SPLAT_DURATION_MS + 50

  // Spawn a few expanding yellow spheres at the banana position
  for (let i = 0; i < 3; i++) {
    const sphere = splatPool[splatPoolIdx % SPLAT_POOL_SIZE]
    splatPoolIdx++

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
let lastLocalBananaDropTime = 0

/** Returns true if banana is on cooldown (for UI). */
export function isBananaOnCooldown(): boolean {
  if (lastLocalBananaDropTime === 0) return false
  return (Date.now() - lastLocalBananaDropTime) < BANANA_COOLDOWN_SEC * 1000
}

/** Returns cooldown remaining in seconds (0 if ready). */
export function getBananaCooldownRemaining(): number {
  if (lastLocalBananaDropTime === 0) return 0
  const elapsed = Date.now() - lastLocalBananaDropTime
  const remaining = BANANA_COOLDOWN_SEC * 1000 - elapsed
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

// ── Banana ground raycasts ──
// When the server drops a banana, the client fires a downward raycast to find the
// actual ground height and reports it back so the server can land the banana properly.
interface PendingBananaRay {
  entity: Entity
  bananaX: number
  bananaZ: number
}
const pendingBananaRays: PendingBananaRay[] = []

function fireBananaGroundRaycast(x: number, y: number, z: number): void {
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
  pendingBananaRays.push({ entity: rayEntity, bananaX: x, bananaZ: z })
}

function processBananaRaycasts(): void {
  for (let i = pendingBananaRays.length - 1; i >= 0; i--) {
    const ray = pendingBananaRays[i]
    const result = RaycastResult.getOrNull(ray.entity)
    if (result) {
      const groundY = result.hits.length > 0 ? result.hits[0].position!.y : 0
      room.send('reportBananaGroundY', { bananaX: ray.bananaX, bananaZ: ray.bananaZ, groundY })
      engine.removeEntity(ray.entity)
      pendingBananaRays.splice(i, 1)
    }
  }
}

// ── Banana drop position cache ──
// Store positions from 'bananaDropped' messages so we can use them as fallback
// if the CRDT Transform sync is slow/incomplete.
const recentBananaDropPositions: { x: number; y: number; z: number; timestamp: number }[] = []
const MAX_RECENT_DROPS = 20

// ── Message listeners ──
let messagesRegistered = false

function registerBananaMessages(): void {
  if (messagesRegistered) return
  messagesRegistered = true

  room.onMessage('bananaDropped', (data) => {
    playBananaDropSound(Vector3.create(data.x, data.y, data.z))
    // Cache the drop position for fallback model attachment
    recentBananaDropPositions.push({ x: data.x, y: data.y, z: data.z, timestamp: Date.now() })
    if (recentBananaDropPositions.length > MAX_RECENT_DROPS) recentBananaDropPositions.shift()
    // Fire ground raycast so server knows where to land this banana
    fireBananaGroundRaycast(data.x, data.y, data.z)
  })

  room.onMessage('bananaTriggered', (data) => {
    const pos = Vector3.create(data.x, data.y, data.z)

    // All effects in one frame for clean sync
    showSplatEffect(pos)
    playBananaSplatSound(pos)

    // Stagger the victim if it's the local player
    const me = getPlayerData()?.userId
    if (me && data.victimId === me.toLowerCase()) {
      triggerEmote({ predefinedEmote: 'getHit' })
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: true })
      })
      bananaStaggerUntil = Date.now() + BANANA_STAGGER_MS
    }
  })
}

// ── Local test mode (no server) ──
function isServerConnected(): boolean {
  return [...engine.getEntitiesWith(Flag)].length > 0
}

const LOCAL_GRAVITY = 15 // m/s² — matches server FLAG_GRAVITY
const LOCAL_MIN_Y = 0  // Bananas sit on the actual ground surface

interface LocalBanana {
  entity: Entity
  droppedAtMs: number
  falling: boolean
  fallVelocity: number
  targetY: number
  rayEntity: Entity | null
}
const localBananas: LocalBanana[] = []

function dropBananaLocally(): void {
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position
  const dropPos = Vector3.create(playerPos.x, playerPos.y - 0.2, playerPos.z)

  const bananaEntity = engine.addEntity()
  Transform.create(bananaEntity, {
    position: dropPos,
    scale: BANANA_SCALE
  })
  GltfContainer.create(bananaEntity, {
    src: BANANA_MODEL_SRC,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  // Fire a ground raycast for this banana
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

  localBananas.push({
    entity: bananaEntity,
    droppedAtMs: Date.now(),
    falling: true,
    fallVelocity: 0,
    targetY: LOCAL_MIN_Y,
    rayEntity,
  })
  playBananaDropSound(dropPos)
  console.log('[Banana] 🍌 LOCAL test banana dropped at', dropPos.x.toFixed(1), dropPos.y.toFixed(1), dropPos.z.toFixed(1))
}

function removeLocalBanana(index: number): void {
  const banana = localBananas[index]
  if (banana.rayEntity !== null) {
    engine.removeEntity(banana.rayEntity)
  }
  engine.removeEntity(banana.entity)
  localBananas.splice(index, 1)
}

function updateLocalBananas(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position

  for (let i = localBananas.length - 1; i >= 0; i--) {
    const banana = localBananas[i]

    // Check raycast result for ground Y
    if (banana.rayEntity !== null) {
      const result = RaycastResult.getOrNull(banana.rayEntity)
      if (result) {
        const groundY = result.hits.length > 0 ? result.hits[0].position!.y : 0
        banana.targetY = Math.max(LOCAL_MIN_Y, groundY)
        engine.removeEntity(banana.rayEntity)
        banana.rayEntity = null

        // If already at or below target, snap
        const currentY = Transform.get(banana.entity).position.y
        if (currentY <= banana.targetY) {
          const t = Transform.getMutable(banana.entity)
          t.position = Vector3.create(t.position.x, banana.targetY, t.position.z)
          banana.falling = false
          banana.fallVelocity = 0
        }
      }
    }

    // Gravity
    if (banana.falling) {
      banana.fallVelocity += LOCAL_GRAVITY * clampedDt
      const pos = Transform.get(banana.entity).position
      let newY = pos.y - banana.fallVelocity * clampedDt
      if (newY <= banana.targetY) {
        newY = banana.targetY
        banana.falling = false
        banana.fallVelocity = 0
      }
      const t = Transform.getMutable(banana.entity)
      t.position = Vector3.create(pos.x, newY, pos.z)
    }

    // Expiry
    if (now - banana.droppedAtMs > BANANA_LIFETIME_SEC * 1000) {
      console.log('[Banana] 🍌 LOCAL banana expired')
      removeLocalBanana(i)
      continue
    }

    // Self-trigger test: walk back over your own banana after 1 second grace period
    if (now - banana.droppedAtMs > 1000) {
      const bananaPos = Transform.get(banana.entity).position
      const dist = Vector3.distance(playerPos, bananaPos)
      if (dist < BANANA_TRIGGER_RADIUS) {
        console.log('[Banana] 🍌 LOCAL banana triggered!')
        showSplatEffect(bananaPos)
        playBananaSplatSound(bananaPos)
        triggerEmote({ predefinedEmote: 'getHit' })
        removeLocalBanana(i)
      }
    }
  }
}

// ── Client-side visual entities for synced bananas ──
// IMPORTANT: We NEVER modify the synced entity (Transform, GltfContainer, etc.)
// because client writes to server-synced entities create CRDT conflicts that
// break the authoritative server in deployed environments.
//
// Instead, for each synced Banana entity we create a LOCAL-ONLY visual entity
// with the GltfContainer, and update its position from the server's synced Transform.
interface BananaVisual {
  localEntity: Entity
}
const bananaVisuals = new Map<number, BananaVisual>() // synced entity id -> local visual

function updateBananaVisuals(): void {
  // Create/update local visual entities for synced bananas
  for (const [entity] of engine.getEntitiesWith(Banana)) {
    const eid = entity as number

    // Get position — prefer synced Transform, fall back to cached drop position
    let posX = 0, posY = 0, posZ = 0
    let hasPosition = false

    if (Transform.has(entity)) {
      const t = Transform.get(entity)
      // Check if Transform has actually synced (not default 0,0,0 with scale 1,1,1)
      const looksReal = t.scale.x < 0.5 && !(Math.abs(t.position.x) < 0.001 && Math.abs(t.position.y) < 0.001 && Math.abs(t.position.z) < 0.001)
      if (looksReal) {
        posX = t.position.x
        posY = t.position.y
        posZ = t.position.z
        hasPosition = true
      }
    }

    // Fallback: use the most recent UNCONSUMED cached drop position
    // (shift from the front so each banana entity gets its own unique position)
    if (!hasPosition && recentBananaDropPositions.length > 0) {
      const now = Date.now()
      // Find the oldest still-valid cached position (FIFO order matches entity creation order)
      const idx = recentBananaDropPositions.findIndex(d => now - d.timestamp < 30000)
      if (idx !== -1) {
        const drop = recentBananaDropPositions[idx]
        posX = drop.x
        posY = drop.y
        posZ = drop.z
        hasPosition = true
        // Consume this cached position so the next banana gets the next one
        recentBananaDropPositions.splice(idx, 1)
      }
    }

    // No position data yet — keep waiting (will retry next frame)
    if (!hasPosition) continue

    let visual = bananaVisuals.get(eid)
    if (!visual) {
      // Create local-only visual entity
      const localEntity = engine.addEntity()
      Transform.create(localEntity, {
        position: Vector3.create(posX, posY, posZ),
        scale: Vector3.create(0.02, 0.02, 0.02)
      })
      GltfContainer.create(localEntity, {
        src: BANANA_MODEL_SRC,
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })
      visual = { localEntity }
      bananaVisuals.set(eid, visual)
      console.log('[Banana] 🍌 Created local visual for synced banana', eid,
        'at:', posX.toFixed(1), posY.toFixed(1), posZ.toFixed(1))
    } else if (hasPosition) {
      // Update position from synced Transform (banana may still be falling via server gravity)
      // Only update from synced Transform, not from cached position (which was the initial drop point)
      if (Transform.has(entity)) {
        const t = Transform.get(entity)
        if (t.scale.x < 0.5 && !(Math.abs(t.position.x) < 0.001 && Math.abs(t.position.y) < 0.001 && Math.abs(t.position.z) < 0.001)) {
          const lt = Transform.getMutable(visual.localEntity)
          lt.position = Vector3.create(t.position.x, t.position.y, t.position.z)
        }
      }
    }
  }

  // Clean up visuals for bananas that no longer exist
  for (const [eid, visual] of bananaVisuals) {
    if (!Banana.has(eid as Entity)) {
      engine.removeEntity(visual.localEntity)
      bananaVisuals.delete(eid)
    }
  }
}

// ── Main client system ──
export function bananaClientSystem(dt: number): void {
  registerBananaMessages()

  const now = Date.now()
  const serverUp = isServerConnected()

  // Update local visual entities for synced bananas (creates, positions, and cleans up)
  if (serverUp) {
    updateBananaVisuals()
  }

  // Release banana stagger freeze
  if (bananaStaggerUntil > 0 && now >= bananaStaggerUntil) {
    bananaStaggerUntil = 0
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

  // Process banana ground raycasts (server mode)
  if (serverUp) {
    processBananaRaycasts()
  }

  // Update local bananas (gravity + expiry + trigger) when in local test mode
  if (!serverUp) {
    updateLocalBananas(dt)
  }

  // F key — drop banana
  // Key 4 — drop banana
  if (inputSystem.isTriggered(InputAction.IA_ACTION_6, PointerEventType.PET_DOWN)) {
    const userId = getPlayerData()?.userId
    if (!userId) return

    // Client-side cooldown check (prevents spamming server)
    if (now - lastLocalBananaDropTime < BANANA_COOLDOWN_SEC * 1000) {
      const remaining = ((BANANA_COOLDOWN_SEC * 1000 - (now - lastLocalBananaDropTime)) / 1000).toFixed(1)
      console.log('[Banana] F pressed but cooldown active —', remaining, 's remaining')
      return
    }

    lastLocalBananaDropTime = now

    if (serverUp) {
      // Production: send to server
      console.log('[Banana] 🍌 F pressed — requesting banana drop (server)')
      room.send('requestBanana', { t: 0 })
    } else {
      // Local test: create banana client-side
      console.log('[Banana] 🍌 F pressed — dropping banana locally (no server)')
      dropBananaLocally()
    }
  }
}
