import {
  engine,
  Transform,
  PlayerIdentityData,
  inputSystem,
  InputAction,
  PointerEventType,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Tween,
  EasingFunction,
  Raycast,
  RaycastResult,
  RaycastQueryType,
  AvatarAttach,
  AvatarAnchorPointType,
  VisibilityComponent,
  GltfContainer,
  AudioSource,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { Flag, FlagState } from '../shared/components'
import { room } from '../shared/messages'
import { predictAttackLocally } from './combatSystem'

// Visual clone system for smooth flag carrying
// Two-entity approach: anchor (AvatarAttach AAPT_POSITION) → child (GltfContainer with Y offset)
// Uses AAPT_POSITION because AAPT_NAME_TAG is broken on mobile client.
let carryCloneEntity: Entity | null = null
let attachAnchorEntity: Entity | null = null

const CARRY_BASE_Y = 3.0  // base Y offset above AAPT_POSITION (feet) — mobile only

/**
 * Create the visual clone that follows the flag carrier.
 * - Desktop: single entity with AAPT_NAME_TAG (parent/child breaks rendering)
 * - Mobile: two-entity anchor (AAPT_POSITION) → child (Y offset) because AAPT_NAME_TAG is broken on mobile
 */
function createCarryClone(carrierId: string): void {
  cleanupClone()

  if (isMobile()) {
    // Mobile: two-entity approach with AAPT_POSITION + Y offset
    const anchor = engine.addEntity()
    Transform.create(anchor, {
      position: Vector3.Zero(),
      scale: Vector3.One()
    })
    AvatarAttach.create(anchor, {
      avatarId: carrierId,
      anchorPointId: AvatarAnchorPointType.AAPT_POSITION
    })
    attachAnchorEntity = anchor

    carryCloneEntity = engine.addEntity()
    Transform.create(carryCloneEntity, {
      parent: anchor,
      position: Vector3.create(0, CARRY_BASE_Y, 0),
      scale: Vector3.One()
    })
    GltfContainer.create(carryCloneEntity, {
      src: BANNER_SRC,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    console.log('[Flag] Clone created (mobile: AAPT_POSITION + Y offset)')
  } else {
    // Desktop: single entity with AAPT_NAME_TAG (reliable on desktop)
    carryCloneEntity = engine.addEntity()
    AvatarAttach.create(carryCloneEntity, {
      avatarId: carrierId,
      anchorPointId: AvatarAnchorPointType.AAPT_NAME_TAG
    })
    GltfContainer.create(carryCloneEntity, {
      src: BANNER_SRC,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    console.log('[Flag] Clone created (desktop: AAPT_NAME_TAG)')
  }
}
const BANNER_SRC = 'assets/asset-packs/small_red_banner/Banner_Red_02/Banner_Red_02.glb'

// ── Trail pool (horizontal particles when carried) ──
const TRAIL_SPAWN_INTERVAL = 0.08
const TRAIL_LIFETIME_MS = 600
const TRAIL_START_SCALE = 0.18
const TRAIL_POOL_SIZE = 15
const TRAIL_MIN_MOVE_DIST = 0.05
const TRAIL_MATERIAL = {
  albedoColor: Color4.create(1.0, 0.82, 0.2, 0.55),
  emissiveColor: Color4.create(1.0, 0.75, 0.1, 1),
  emissiveIntensity: 2.5,
  roughness: 1.0,
  metallic: 0.0,
  specularIntensity: 0.0,
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
}
const trailPool: Entity[] = []
let trailPoolIdx = 0
let trailPoolReady = false
let trailSpawnAccum = 0
let lastCarrierPos: Vector3 | null = null
const activeTrailPuffs: { entity: Entity; expiresAt: number }[] = []
const TRAIL_HIDDEN_POS = Vector3.create(0, -100, 0)

// ── Beacon pool (vertical particles when idle) - upgraded from v1 project ──
const BEACON_SPAWN_INTERVAL = 0.35
const BEACON_LIFETIME_MS = 6600  // Much longer floating (was 2200)
const BEACON_FLOAT_HEIGHT = 21   // Float much higher (was 7)
const BEACON_START_SCALE = 0.2
const BEACON_POOL_SIZE = 22      // Larger pool for more particles (was 12)
const BEACON_MATERIAL = {
  albedoColor: Color4.create(1.0, 0.82, 0.2, 0.85),
  emissiveColor: Color4.create(1.0, 0.75, 0.1, 1),
  emissiveIntensity: 3.0,
  roughness: 1.0,
  metallic: 0.0,
  specularIntensity: 0.0,
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
}
const beaconPool: Entity[] = []
let beaconPoolIdx = 0
let beaconPoolReady = false
let beaconSpawnAccum = 0
interface BeaconPuff {
  entity: Entity
  startPos: Vector3
  endPos: Vector3
  startScale: number
  spawnTime: number
}
const activeBeaconPuffs: BeaconPuff[] = []

function initTrailPool(): void {
  if (trailPoolReady) return
  trailPoolReady = true
  for (let i = 0; i < TRAIL_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: TRAIL_HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, TRAIL_MATERIAL)
    trailPool.push(e)
  }
}

function spawnTrailPuff(position: Vector3): void {
  initTrailPool()
  const puff = trailPool[trailPoolIdx % TRAIL_POOL_SIZE]
  trailPoolIdx++
  const jitteredPos = Vector3.create(
    position.x + (Math.random() - 0.5) * 0.25,
    position.y + (Math.random() - 0.5) * 0.15,
    position.z + (Math.random() - 0.5) * 0.25,
  )
  const s = TRAIL_START_SCALE * (0.8 + Math.random() * 0.4)
  const t = Transform.getMutable(puff)
  t.position = jitteredPos
  t.scale = Vector3.create(s, s, s)
  Tween.createOrReplace(puff, {
    mode: Tween.Mode.Scale({ start: Vector3.create(s, s, s), end: Vector3.Zero() }),
    duration: TRAIL_LIFETIME_MS,
    easingFunction: EasingFunction.EF_EASEINQUAD,
  })
  activeTrailPuffs.push({ entity: puff, expiresAt: Date.now() + TRAIL_LIFETIME_MS + 50 })
}

function hideTrailPuff(entity: Entity): void {
  const t = Transform.getMutable(entity)
  t.position = TRAIL_HIDDEN_POS
  t.scale = Vector3.Zero()
  if (Tween.has(entity)) Tween.deleteFrom(entity)
}

function initBeaconPool(): void {
  if (beaconPoolReady) return
  beaconPoolReady = true
  for (let i = 0; i < BEACON_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: TRAIL_HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, BEACON_MATERIAL)
    beaconPool.push(e)
  }
}

function spawnBeaconPuff(position: Vector3): void {
  initBeaconPool()
  const puff = beaconPool[beaconPoolIdx % BEACON_POOL_SIZE]
  beaconPoolIdx++
  const jitteredPos = Vector3.create(
    position.x + (Math.random() - 0.5) * 0.6,
    position.y + Math.random() * 0.2,
    position.z + (Math.random() - 0.5) * 0.6,
  )
  const s = BEACON_START_SCALE * (0.7 + Math.random() * 0.6)
  const endPos = Vector3.create(
    jitteredPos.x + (Math.random() - 0.5) * 0.5,
    jitteredPos.y + BEACON_FLOAT_HEIGHT,
    jitteredPos.z + (Math.random() - 0.5) * 0.5
  )
  const t = Transform.getMutable(puff)
  t.position = jitteredPos
  t.scale = Vector3.create(s, s, s)
  if (Tween.has(puff)) Tween.deleteFrom(puff)
  activeBeaconPuffs.push({ entity: puff, startPos: jitteredPos, endPos, startScale: s, spawnTime: Date.now() })
}

function hideBeaconPuff(entity: Entity): void {
  const t = Transform.getMutable(entity)
  t.position = TRAIL_HIDDEN_POS
  t.scale = Vector3.Zero()
}

// Helper to find player entity by ID
function getCarrierEntity(carrierPlayerId: string): Entity | null {
  if (!carrierPlayerId) return null
  const needle = carrierPlayerId.toLowerCase()
  
  const local = getPlayerData()
  if (local) {
    const localIdentity = PlayerIdentityData.getOrNull(engine.PlayerEntity)
    if (localIdentity && localIdentity.address.toLowerCase() === needle) {
      return engine.PlayerEntity
    }
    if (local.userId?.toLowerCase() === needle) {
      return engine.PlayerEntity
    }
  }
  
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address.toLowerCase() === needle) {
      return entity as Entity
    }
  }
  
  return null
}

// State tracking
let prevFlagState: FlagState | null = null
let prevCarrierId: string = ''

// Auto-pickup proximity
const AUTO_PICKUP_RADIUS = 3
const AUTO_PICKUP_COOLDOWN_MS = 500 // don't spam server
let lastAutoPickupRequestMs = 0
const DROP_PICKUP_COOLDOWN_MS = 3000 // after dropping, can't auto-pickup for 3s
let lastDropTimeMs = 0

// Sound entities
let pickupSoundEntity: Entity | null = null
let dropSoundEntity: Entity | null = null

// Optimistic sound tracking — prevent duplicate plays when CRDT state catches up
let skipNextPickupSound = false
let skipNextDropSound = false

// Cleanup function to prevent clone duplication
function cleanupClone(): void {
  if (carryCloneEntity !== null) { 
    console.log('[Flag] Cleaning up existing clone entity')
    engine.removeEntity(carryCloneEntity)
    carryCloneEntity = null 
  }
  if (attachAnchorEntity !== null) {
    console.log('[Flag] Cleaning up existing anchor entity')
    engine.removeEntity(attachAnchorEntity)
    attachAnchorEntity = null
  }
}

function playPickupSound(): void {
  if (!pickupSoundEntity) {
    pickupSoundEntity = engine.addEntity()
    Transform.create(pickupSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(pickupSoundEntity, { audioClipUrl: 'assets/sounds/rs-pickup.ogg', playing: false, loop: false, volume: 1, global: true })
  }
  const a = AudioSource.getMutable(pickupSoundEntity)
  a.currentTime = 0
  a.playing = true
}

function playDropSound(): void {
  if (!dropSoundEntity) {
    dropSoundEntity = engine.addEntity()
    Transform.create(dropSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(dropSoundEntity, { audioClipUrl: 'assets/sounds/rs-drop.mp3', playing: false, loop: false, volume: 1, global: true })
  }
  const a = AudioSource.getMutable(dropSoundEntity)
  a.currentTime = 0
  a.playing = true
}

// Ground raycast for server
let groundRayEntity: Entity | null = null

function fireGroundRaycastForServer(dropPos: Vector3): void {
  if (groundRayEntity !== null) {
    engine.removeEntity(groundRayEntity)
    groundRayEntity = null
  }
  groundRayEntity = engine.addEntity()
  Transform.create(groundRayEntity, {
    position: Vector3.create(dropPos.x, dropPos.y + 0.3, dropPos.z)
  })
  Raycast.create(groundRayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
    maxDistance: 200,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })
}

// ── Client-side GltfContainer attachment for the synced flag entity ──
// The server no longer syncs GltfContainer — the client attaches the visual mesh locally
// to avoid a Bevy renderer issue where server-synced GltfContainer sometimes fails to load.
let flagModelAttached = false

function ensureFlagModel(): void {
  if (flagModelAttached) return
  for (const [entity] of engine.getEntitiesWith(Flag, Transform)) {
    if (!GltfContainer.has(entity)) {
      GltfContainer.create(entity, {
        src: BANNER_SRC,
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })
      console.log('[Flag] 🚩 Attached local GltfContainer to synced flag entity')
    }
    flagModelAttached = true
    break
  }
}

export function flagClientSystem(dt: number): void {
  // Ensure the synced flag entity has a GltfContainer (attached locally, not synced from server)
  ensureFlagModel()

  const userId = getPlayerData()?.userId?.toLowerCase()

  // Apply drop cooldown as soon as we see we're no longer carrying (before auto-pickup check).
  // This fixes same-frame re-pickup when shell/banana forces a drop.
  if (userId) {
    for (const [, flag] of engine.getEntitiesWith(Flag)) {
      if (flag.state !== FlagState.Carried && prevFlagState === FlagState.Carried && prevCarrierId === userId) {
        lastDropTimeMs = Date.now()
      }
      break
    }
  }

  // Auto-pickup: if the flag is on the ground and we're close enough, pick it up automatically
  if (userId && Transform.has(engine.PlayerEntity)) {
    const now = Date.now()
    let amCarrying = false
    for (const [, flag] of engine.getEntitiesWith(Flag)) {
      if (flag.state === FlagState.Carried && flag.carrierPlayerId === userId) {
        amCarrying = true
        break
      }
    }

    if (!amCarrying && now - lastAutoPickupRequestMs >= AUTO_PICKUP_COOLDOWN_MS && now - lastDropTimeMs >= DROP_PICKUP_COOLDOWN_MS) {
      const myPos = Transform.get(engine.PlayerEntity).position
      for (const [flagEnt, flag] of engine.getEntitiesWith(Flag, Transform)) {
        if (flag.state === FlagState.Carried) continue
        const dist = Vector3.distance(myPos, Transform.get(flagEnt).position)
        if (dist <= AUTO_PICKUP_RADIUS) {
          console.log('[C.4] Auto-pickup — flag nearby, distance:', dist.toFixed(2))
          playPickupSound()
          skipNextPickupSound = true
          room.send('requestPickup', { t: 0 })
          lastAutoPickupRequestMs = now
          break
        }
      }
    }
  }

  // E key — attack only
  if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN) && userId) {
    console.log('[C.5] E pressed - sending requestAttack')
    predictAttackLocally()
    room.send('requestAttack', { t: 0 })
  }

  // ── Manual drop (F key) ──
  if (inputSystem.isTriggered(InputAction.IA_SECONDARY, PointerEventType.PET_DOWN) && userId) {
    let amCarrying = false
    for (const [, flag] of engine.getEntitiesWith(Flag)) {
      if (flag.state === FlagState.Carried && flag.carrierPlayerId === userId) {
        amCarrying = true
        break
      }
    }
    if (amCarrying) {
      console.log('[C.1] F pressed - sending requestDrop')
      playDropSound()
      skipNextDropSound = true
      lastDropTimeMs = Date.now()
      room.send('requestDrop', { t: 0 })
    }
  }

  // Handle flag state changes with clone system
  for (const [flagEntity, flag] of engine.getEntitiesWith(Flag)) {
    const stateChanged = prevFlagState !== null && prevFlagState !== flag.state
    const carrierChanged = flag.state === FlagState.Carried && flag.carrierPlayerId !== prevCarrierId && prevCarrierId !== ''

    // Determine what changed
    const isFirstFrame = prevFlagState === null
    const needsCloneCreate = flag.state === FlagState.Carried && (
      isFirstFrame ||                          // Just loaded the scene
      stateChanged ||                          // State changed to Carried
      carrierChanged ||                        // Carrier swapped (steal)
      (carryCloneEntity === null && !stateChanged)  // Clone missing (safety net)
    )
    const needsCloneRemove = flag.state !== FlagState.Carried && (
      isFirstFrame ||
      stateChanged
    )

    if (needsCloneCreate) {
      // Play pickup sound (skip if we already played it optimistically)
      if (!isFirstFrame) {
        if (skipNextPickupSound) {
          skipNextPickupSound = false
        } else {
          playPickupSound()
        }
      }
      
      console.log('[C.11] Creating clone for carrier:', flag.carrierPlayerId.slice(0, 8), 
        '(reason:', isFirstFrame ? 'firstFrame' : stateChanged ? 'stateChanged' : carrierChanged ? 'carrierChanged' : 'missingClone', ')')
      
      // Hide server flag with visibility (don't move it — avoids CRDT conflicts)
      VisibilityComponent.createOrReplace(flagEntity, { visible: false })
      
      // Create platform-specific clone
      createCarryClone(flag.carrierPlayerId)
      console.log('[C.12] Clone created for carrier:', flag.carrierPlayerId.slice(0, 8))

    } else if (needsCloneRemove) {
      if (!isFirstFrame) {
        if (skipNextDropSound) {
          skipNextDropSound = false
        } else {
          playDropSound()
        }
      }
      console.log('[C.15] STATE CHANGED to', flag.state === FlagState.Dropped ? 'Dropped' : 'AtBase', '- cleaning up clone')
      
      // If we were the carrier, apply drop pickup cooldown (covers forced drops from banana/shell hits)
      if (userId && prevCarrierId === userId) {
        lastDropTimeMs = Date.now()
      }

      // Clean up all clones
      cleanupClone()
      
      // Restore server flag visibility (server controls position via CRDT)
      VisibilityComponent.createOrReplace(flagEntity, { visible: true })

      if (flag.state === FlagState.Dropped) {
        fireGroundRaycastForServer(Vector3.create(flag.dropAnchorX, flag.dropAnchorY, flag.dropAnchorZ))
      }
    }

    // Safety nets
    // 1. Flag is carried but clone is missing or broken — recreate it
    // Only check GltfContainer — desktop clone has no Transform (AvatarAttach controls position)
    const cloneMissing = carryCloneEntity === null
    const cloneBroken = carryCloneEntity !== null && !GltfContainer.has(carryCloneEntity)
    if (flag.state === FlagState.Carried && (cloneMissing || cloneBroken) && !needsCloneCreate) {
      console.log('[C.16] SAFETY NET: Flag is carried but clone is', cloneMissing ? 'missing' : 'broken', '! Recreating...')
      VisibilityComponent.createOrReplace(flagEntity, { visible: false })
      createCarryClone(flag.carrierPlayerId)
    }
    
    // 2. Flag is NOT carried — ensure server flag is visible
    if (flag.state !== FlagState.Carried) {
      if (!VisibilityComponent.has(flagEntity)) {
        VisibilityComponent.create(flagEntity, { visible: true })
      } else if (!VisibilityComponent.get(flagEntity).visible) {
        VisibilityComponent.createOrReplace(flagEntity, { visible: true })
      }
    }

    prevFlagState = flag.state
    prevCarrierId = flag.carrierPlayerId
    break
  }

  const clampedDt = Math.min(dt, 0.1)

  // No per-frame animation on the carried clone — mutating Transform on AvatarAttach children
  // causes the flag to disappear on the desktop client.



  // Handle ground raycast response
  if (groundRayEntity !== null) {
    const rayResult = RaycastResult.getOrNull(groundRayEntity)
    if (rayResult) {
      if (rayResult.hits.length > 0) {
        const groundY = rayResult.hits[0].position!.y
        room.send('reportGroundY', { y: groundY })
      } else {
        room.send('reportGroundY', { y: 0 })
      }
      engine.removeEntity(groundRayEntity)
      groundRayEntity = null
    }
  }

  // Cleanup expired effects
  const now = Date.now()
  for (let i = activeTrailPuffs.length - 1; i >= 0; i--) {
    if (now >= activeTrailPuffs[i].expiresAt) {
      hideTrailPuff(activeTrailPuffs[i].entity)
      activeTrailPuffs.splice(i, 1)
    }
  }
  for (let i = activeBeaconPuffs.length - 1; i >= 0; i--) {
    const bp = activeBeaconPuffs[i]
    const elapsed = now - bp.spawnTime
    const progress = Math.min(1, elapsed / BEACON_LIFETIME_MS)
    if (progress >= 1) {
      hideBeaconPuff(bp.entity)
      activeBeaconPuffs.splice(i, 1)
      continue
    }
    const easedPos = 1 - Math.pow(1 - progress, 2)
    const bt = Transform.getMutable(bp.entity)
    bt.position = Vector3.lerp(bp.startPos, bp.endPos, easedPos)
    const scale = bp.startScale * (1 - progress)
    bt.scale = Vector3.create(scale, scale, scale)
  }

  // Particle effects based on flag state and movement
  for (const [flagEntity, flag] of engine.getEntitiesWith(Flag, Transform)) {
    if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
      // Trail particles at player's feet ONLY when actually moving
      const carrierEntity = getCarrierEntity(flag.carrierPlayerId)
      if (carrierEntity && Transform.has(carrierEntity)) {
        const carrierPos = Transform.get(carrierEntity).position
        
        // Check if carrier is actually moving
        let isCarrierMoving = false
        if (lastCarrierPos !== null) {
          const distanceMoved = Vector3.distance(carrierPos, lastCarrierPos)
          isCarrierMoving = distanceMoved > TRAIL_MIN_MOVE_DIST
        }
        
        // Update position tracking
        lastCarrierPos = Vector3.create(carrierPos.x, carrierPos.y, carrierPos.z)
        
        // Only spawn trail particles if actually moving
        if (isCarrierMoving) {
          const groundParticlePos = Vector3.create(carrierPos.x, carrierPos.y + 0.1, carrierPos.z)
          trailSpawnAccum += clampedDt
          while (trailSpawnAccum >= TRAIL_SPAWN_INTERVAL) {
            trailSpawnAccum -= TRAIL_SPAWN_INTERVAL
            spawnTrailPuff(groundParticlePos)
          }
        } else {
          // Reset trail accumulator when not moving
          trailSpawnAccum = 0
        }
      } else {
        // Reset position tracking if carrier not found
        lastCarrierPos = null
        trailSpawnAccum = 0
      }
      
      beaconSpawnAccum = 0 // No beacon particles when carried
      
    } else if (flag.state === FlagState.AtBase || flag.state === FlagState.Dropped) {
      // Beacon particles floating up from flag when idle
      const flagPos = Transform.get(flagEntity).position
      beaconSpawnAccum += clampedDt
      while (beaconSpawnAccum >= BEACON_SPAWN_INTERVAL) {
        beaconSpawnAccum -= BEACON_SPAWN_INTERVAL
        spawnBeaconPuff(flagPos)
      }
      
      // Reset carrier tracking when flag not carried
      lastCarrierPos = null
      trailSpawnAccum = 0
      
    } else {
      // Reset all tracking
      lastCarrierPos = null
      trailSpawnAccum = 0
      beaconSpawnAccum = 0
    }
    break
  }
}