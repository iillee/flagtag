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

  Raycast,
  RaycastResult,
  RaycastQueryType,
  AvatarAttach,
  AvatarAnchorPointType,
  VisibilityComponent,
  GltfContainer,
  AudioSource,
  PointerEvents,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color4, Quaternion } from '@dcl/sdk/math'
// import { isMobile } from '@dcl/sdk/platform'  // disabled — causes crashes
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { Flag, FlagState, CountdownTimer } from '../shared/components'
import { room } from '../shared/messages'
import { predictAttackLocally } from './combatSystem'
import { isAnyOverlayOpen } from '../ui'
import { isCinematicActive } from '../cinematicState'
import { isSpectatorMode } from './spectatorSystem'
import { isDrownRespawning } from './waterSystem'

// Visual clone system for smooth flag carrying
let carryCloneEntity: Entity | null = null

/**
 * Create the visual clone that follows the flag carrier.
 * Uses AAPT_NAME_TAG anchor with a child entity for bob/spin animation.
 */
let carryCloneVisual: Entity | null = null  // Child entity with model + bob/spin

function createCarryClone(carrierId: string): void {
  cleanupClone()

  // Anchor entity attached to player's name tag
  carryCloneEntity = engine.addEntity()
  AvatarAttach.create(carryCloneEntity, {
    avatarId: carrierId,
    anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND
  })
  Transform.create(carryCloneEntity, {
    position: Vector3.Zero(),
    scale: Vector3.One()
  })

  // Child entity with model — attached to right hand
  carryCloneVisual = engine.addEntity()
  Transform.create(carryCloneVisual, {
    parent: carryCloneEntity,
    position: Vector3.create(0, 0.1, 0),
    scale: Vector3.create(0.5, 0.5, 0.5)
  })
  GltfContainer.create(carryCloneVisual, {
    src: BANNER_SRC,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })
  console.log('[Flag] Clone created (AAPT_RIGHT_HAND)')
}
const BANNER_SRC = 'models/Banner_Red_02/Banner_Red_02.glb'

const HIDDEN_POS = Vector3.create(0, -100, 0)

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

function initBeaconPool(): void {
  if (beaconPoolReady) return
  beaconPoolReady = true
  for (let i = 0; i < BEACON_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
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
  t.position = HIDDEN_POS
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
const DROP_PICKUP_COOLDOWN_MS = 2000 // after dropping, can't auto-pickup for 2s
let lastDropTimeMs = 0

// Sound entities
let pickupSoundEntity: Entity | null = null
let dropSoundEntity: Entity | null = null

// Optimistic sound tracking — prevent duplicate plays when CRDT state catches up
let skipNextPickupSound = false
let skipNextDropSound = false

// Cleanup function to prevent clone duplication
function cleanupClone(): void {
  if (carryCloneVisual !== null) {
    engine.removeEntity(carryCloneVisual)
    carryCloneVisual = null
  }
  if (carryCloneEntity !== null) { 
    engine.removeEntity(carryCloneEntity)
    carryCloneEntity = null 
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

// ── Client-side visual flag with local bob/spin ──
// The synced flag entity is a plain Transform anchor (position only, no model).
// We create a LOCAL child entity that holds the GltfContainer and animates bob/spin
// every frame — zero CRDT writes, smooth on every client.
const IDLE_BOB_AMPLITUDE = 0.15
const IDLE_BOB_SPEED = 2
const IDLE_ROT_SPEED_DEG_PER_SEC = 25
let flagVisualEntity: Entity | null = null
let flagSyncedEntity: Entity | null = null
let flagBobTime = 0
let flagModelAttached = false

function ensureFlagModel(): void {
  if (flagModelAttached) return
  for (const [entity] of engine.getEntitiesWith(Flag, Transform)) {
    // Create a local child entity for the visual model + bob/spin
    flagVisualEntity = engine.addEntity()
    Transform.create(flagVisualEntity, {
      parent: entity,
      position: Vector3.create(0, 0, 0)
    })
    GltfContainer.create(flagVisualEntity, {
      src: BANNER_SRC,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    flagSyncedEntity = entity
    flagModelAttached = true
    console.log('[Flag] 🚩 Created local visual child with bob/spin')
    break
  }
}

/** Animate the flag bob/spin locally — runs every frame, no CRDT writes. */
function updateFlagBob(dt: number): void {
  flagBobTime += dt
  const bobY = IDLE_BOB_AMPLITUDE * Math.sin(flagBobTime * IDLE_BOB_SPEED)
  const angleDeg = (flagBobTime * IDLE_ROT_SPEED_DEG_PER_SEC) % 360

  // Animate the idle flag visual (at base or dropped)
  if (flagVisualEntity && Transform.has(flagVisualEntity)) {
    const flag = flagSyncedEntity ? Flag.getOrNull(flagSyncedEntity) : null
    if (flag && flag.state !== FlagState.Carried) {
      const t = Transform.getMutable(flagVisualEntity)
      t.position = Vector3.create(0, bobY, 0)
      t.rotation = Quaternion.fromEulerDegrees(0, angleDeg, 0)
    }
  }

  // Animate the carried flag visual (above player's head, offset 0.85m above name tag)
  if (carryCloneVisual && Transform.has(carryCloneVisual)) {
    const t = Transform.getMutable(carryCloneVisual)
    t.position = Vector3.create(0, 0.425 + bobY, 0)
    t.rotation = Quaternion.fromEulerDegrees(0, angleDeg, 0)
  }
}

export function flagClientSystem(dt: number): void {
  // Ensure the synced flag entity has a local visual child (GltfContainer + bob/spin)
  ensureFlagModel()
  updateFlagBob(dt)

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
          playPickupSound()
          skipNextPickupSound = true
          room.send('requestPickup', { t: 0 })
          lastAutoPickupRequestMs = now
          break
        }
      }
    }
  }

  // Left click — attack only (skip if a UI overlay is open, clicking an interactive object, or cinematic is active)
  if (inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_DOWN) && userId && !isAnyOverlayOpen() && !isSpectatorMode() && !isCinematicActive() && !isDrownRespawning()) {
    const cmd = inputSystem.getInputCommand(InputAction.IA_POINTER, PointerEventType.PET_DOWN)
    const hitEntity = cmd?.hit?.entityId
    // Skip attack if the click landed on an entity with pointer events (bench, scope, etc.)
    if (!hitEntity || !PointerEvents.has(hitEntity as Entity)) {
      predictAttackLocally()
      room.send('requestAttack', { t: 0 })
    }
  }

  // ── Manual drop (3 key) ──
  if (inputSystem.isTriggered(InputAction.IA_ACTION_5, PointerEventType.PET_DOWN) && userId) {
    let amCarrying = false
    for (const [, flag] of engine.getEntitiesWith(Flag)) {
      if (flag.state === FlagState.Carried && flag.carrierPlayerId === userId) {
        amCarrying = true
        break
      }
    }
    if (amCarrying) {
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
      
      // Hide flag visual (don't move synced entity — avoids CRDT conflicts)
      if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: false })
      
      // Create platform-specific clone
      createCarryClone(flag.carrierPlayerId)

    } else if (needsCloneRemove) {
      if (!isFirstFrame) {
        // Check if this drop is caused by round end (flag forced back from carrier)
        let isRoundEndDrop = false
        for (const [, timer] of engine.getEntitiesWith(CountdownTimer)) {
          if (timer.roundEndTriggered) { isRoundEndDrop = true }
          break
        }

        if (skipNextDropSound) {
          skipNextDropSound = false
        } else if (!isRoundEndDrop) {
          playDropSound()
        }
      }
      
      // If we were the carrier, apply drop pickup cooldown (covers forced drops from banana/shell hits)
      if (userId && prevCarrierId === userId) {
        lastDropTimeMs = Date.now()
      }

      // Clean up all clones
      cleanupClone()
      
      // Restore flag visual visibility (server controls position via CRDT)
      if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: true })

      if (flag.state === FlagState.Dropped) {
        fireGroundRaycastForServer(Vector3.create(flag.dropAnchorX, flag.dropAnchorY, flag.dropAnchorZ))
      }
    }

    // Safety nets
    // 1. Flag is carried but clone is missing or broken — recreate it
    // Only check GltfContainer — desktop clone has no Transform (AvatarAttach controls position)
    const cloneMissing = carryCloneEntity === null
    const cloneBroken = carryCloneEntity !== null && (carryCloneVisual === null || !GltfContainer.has(carryCloneVisual))
    if (flag.state === FlagState.Carried && (cloneMissing || cloneBroken) && !needsCloneCreate) {
      if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: false })
      createCarryClone(flag.carrierPlayerId)
    }
    
    // 2. Flag is NOT carried — ensure flag visual is visible
    if (flag.state !== FlagState.Carried && flagVisualEntity) {
      if (!VisibilityComponent.has(flagVisualEntity)) {
        VisibilityComponent.create(flagVisualEntity, { visible: true })
      } else if (!VisibilityComponent.get(flagVisualEntity).visible) {
        VisibilityComponent.createOrReplace(flagVisualEntity, { visible: true })
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
      beaconSpawnAccum = 0 // No beacon particles when carried
      
    } else if (flag.state === FlagState.AtBase || flag.state === FlagState.Dropped) {
      // Beacon particles floating up from flag when idle
      const flagPos = Transform.get(flagEntity).position
      beaconSpawnAccum += clampedDt
      while (beaconSpawnAccum >= BEACON_SPAWN_INTERVAL) {
        beaconSpawnAccum -= BEACON_SPAWN_INTERVAL
        spawnBeaconPuff(flagPos)
      }
      
    } else {
      beaconSpawnAccum = 0
    }
    break
  }
}