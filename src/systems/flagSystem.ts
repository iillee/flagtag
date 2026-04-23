import {
  engine,
  Transform,
  inputSystem,
  InputAction,
  PointerEventType,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Tween,
  TweenSequence,
  TweenLoop,
  EasingFunction,

  Raycast,
  RaycastResult,
  RaycastQueryType,
  AvatarAttach,
  AvatarAnchorPointType,
  VisibilityComponent,
  GltfContainer,
  AudioSource,
  PlayerIdentityData,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color4, Quaternion } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { Flag, FlagState, CountdownTimer } from '../shared/components'
import { room } from '../shared/messages'
import { showShieldForPlayer, setShieldAlpha, hideShieldForPlayer, hideAllShields } from './shieldSystem'
import { isLightningRespawning } from '../gameState/lightningState'

// Visual clone system for smooth flag carrying
let carryCloneEntity: Entity | null = null

/**
 * Create the visual clone that follows the flag carrier.
 * Desktop: AvatarAttach + Tween bob/spin (no per-frame Transform writes)
 * Mobile: standalone entity, positioned per-frame via PlayerIdentityData lookup
 */
let carryCloneBob: Entity | null = null      // Intermediate entity for bob tween (desktop only)
let carryCloneVisual: Entity | null = null    // Child entity with model + spin tween

const BANNER_SRC = 'assets/models/Banner_Red_02/Banner_Red_02.glb'

// Pre-warm the flag model so the first clone appears instantly
let preWarmEntity: Entity | null = null
function preWarmFlagModel(): void {
  if (preWarmEntity !== null) return
  preWarmEntity = engine.addEntity()
  Transform.create(preWarmEntity, { position: Vector3.create(0, -200, 0), scale: Vector3.Zero() })
  GltfContainer.create(preWarmEntity, { src: BANNER_SRC, visibleMeshesCollisionMask: 0, invisibleMeshesCollisionMask: 0 })
}

function createCarryClone(carrierId: string): void {
  cleanupClone()

  const mobile = isMobile()
  console.log(`[Flag] createCarryClone — isMobile=${mobile}, carrierId=${carrierId}`)

  // Anchor entity attached to player's name tag
  carryCloneEntity = engine.addEntity()
  AvatarAttach.create(carryCloneEntity, {
    avatarId: carrierId,
    anchorPointId: AvatarAnchorPointType.AAPT_NAME_TAG
  })
  Transform.create(carryCloneEntity, {
    position: Vector3.Zero(),
    scale: Vector3.One()
  })

  if (mobile) {
    // ── Mobile path: AAPT_POSITION (only RIGHT_FOREARM, LEFT_FOREARM, POSITION work on mobile) ──
    // Use POSITION anchor + child entity with Y offset to place flag above head
    engine.removeEntity(carryCloneEntity)
    carryCloneEntity = engine.addEntity()
    AvatarAttach.create(carryCloneEntity, {
      avatarId: carrierId,
      anchorPointId: AvatarAnchorPointType.AAPT_POSITION
    })
    Transform.create(carryCloneEntity, {
      position: Vector3.Zero(),
      scale: Vector3.One()
    })
    carryCloneVisual = engine.addEntity()
    Transform.create(carryCloneVisual, {
      parent: carryCloneEntity,
      position: Vector3.create(0, 2.2, 0)
    })
    GltfContainer.create(carryCloneVisual, {
      src: BANNER_SRC,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    console.log('[Flag] Clone created (MOBILE — AAPT_POSITION + child offset)')
  } else {
    // ── Desktop path: AvatarAttach + Tween bob/spin ──
    const BOB_BASE = 0.85
    const BOB_AMP = 0.15
    carryCloneBob = engine.addEntity()
    Transform.create(carryCloneBob, {
      parent: carryCloneEntity,
      position: Vector3.create(0, BOB_BASE, 0)
    })
    Tween.create(carryCloneBob, {
      mode: Tween.Mode.Move({
        start: Vector3.create(0, BOB_BASE - BOB_AMP, 0),
        end: Vector3.create(0, BOB_BASE + BOB_AMP, 0)
      }),
      duration: 3000,
      easingFunction: EasingFunction.EF_EASESINE
    })
    TweenSequence.create(carryCloneBob, {
      sequence: [],
      loop: TweenLoop.TL_YOYO
    })

    carryCloneVisual = engine.addEntity()
    Transform.create(carryCloneVisual, {
      parent: carryCloneBob,
      position: Vector3.Zero()
    })
    GltfContainer.create(carryCloneVisual, {
      src: BANNER_SRC,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    Tween.create(carryCloneVisual, {
      mode: Tween.Mode.Rotate({
        start: Quaternion.fromEulerDegrees(0, 0, 0),
        end: Quaternion.fromEulerDegrees(0, 180, 0)
      }),
      duration: 7200,
      easingFunction: EasingFunction.EF_LINEAR
    })
    TweenSequence.create(carryCloneVisual, {
      sequence: [
        {
          mode: Tween.Mode.Rotate({
            start: Quaternion.fromEulerDegrees(0, 180, 0),
            end: Quaternion.fromEulerDegrees(0, 360, 0)
          }),
          duration: 7200,
          easingFunction: EasingFunction.EF_LINEAR
        }
      ],
      loop: TweenLoop.TL_RESTART
    })
    console.log('[Flag] Clone created (AAPT_NAME_TAG) with tween bob/spin')
  }
}

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

// Optimistic prediction — create clone immediately on pickup request, before server confirms
let optimisticCarrierId: string | null = null   // Who we optimistically predicted as carrier
let optimisticTimestamp: number = 0              // When we made the prediction
const OPTIMISTIC_ROLLBACK_MS = 1500             // If server hasn't confirmed in 1.5s, roll back

// Cleanup function to prevent clone duplication
function cleanupClone(): void {
  if (carryCloneVisual !== null) {
    engine.removeEntity(carryCloneVisual)
    carryCloneVisual = null
  }
  if (carryCloneBob !== null) {
    engine.removeEntity(carryCloneBob)
    carryCloneBob = null
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
export let flagSyncedEntity: Entity | null = null
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

  // Carried flag bob/spin is handled by Tweens (renderer-side), not per-frame
  // Transform writes — mutating Transform on AvatarAttach children causes
  // the flag to disappear on the desktop client.
}

export function flagClientSystem(dt: number): void {
  // Ensure the synced flag entity has a local visual child (GltfContainer + bob/spin)
  ensureFlagModel()
  preWarmFlagModel()
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

    if (!amCarrying && !isLightningRespawning() && now - lastAutoPickupRequestMs >= AUTO_PICKUP_COOLDOWN_MS && now - lastDropTimeMs >= DROP_PICKUP_COOLDOWN_MS) {
      const myPos = Transform.get(engine.PlayerEntity).position
      for (const [flagEnt, flag] of engine.getEntitiesWith(Flag, Transform)) {
        if (flag.state === FlagState.Carried) continue
        const dist = Vector3.distance(myPos, Transform.get(flagEnt).position)
        if (dist <= AUTO_PICKUP_RADIUS) {
          playPickupSound()
          skipNextPickupSound = true
          
          // Optimistic prediction: immediately show clone above our head + shield
          if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: false })
          createCarryClone(userId)
          optimisticCarrierId = userId
          optimisticTimestamp = now
          hideAllShields()  // Only one shield at a time
          showShieldForPlayer(userId)
          setShieldAlpha(userId, 1.0)
          
          room.send('requestPickup', { t: 0 })
          lastAutoPickupRequestMs = now
          break
        }
      }
    }
  }

  // Left click — melee attack removed (proximity steal replaces it)

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
      hideShieldForPlayer(userId)
      room.send('requestDrop', { t: 0 })
    }
  }

  // Handle flag state changes with clone system
  for (const [, flag] of engine.getEntitiesWith(Flag)) {
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
      
      // If optimistic prediction already created the clone for the correct carrier, just confirm it
      if (optimisticCarrierId && optimisticCarrierId === flag.carrierPlayerId && carryCloneEntity !== null) {
        // Prediction was correct — just clear the optimistic state
        optimisticCarrierId = null
        optimisticTimestamp = 0
      } else {
        // Different carrier or no prediction — create clone normally
        if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: false })
        createCarryClone(flag.carrierPlayerId)
        // Don't show shield here — the server's flagImmunity message handles it with proper fade timer
        optimisticCarrierId = null
        optimisticTimestamp = 0
      }

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

      // Clean up all clones + clear optimistic state + hide stale shields
      // Skip hideAllShields if we just made an optimistic pickup this frame
      // (the optimistic pickup already called hideAllShields before showing the new shield)
      const skipShieldClear = !!optimisticCarrierId
      optimisticCarrierId = null
      optimisticTimestamp = 0
      if (!skipShieldClear) hideAllShields()
      cleanupClone()
      
      // Restore flag visual visibility (server controls position via CRDT)
      if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: true })

      if (flag.state === FlagState.Dropped) {
        fireGroundRaycastForServer(Vector3.create(flag.dropAnchorX, flag.dropAnchorY, flag.dropAnchorZ))
      }
    }

    // Optimistic rollback: if we predicted a pickup but server never confirmed, undo it
    if (optimisticCarrierId && flag.state !== FlagState.Carried && Date.now() - optimisticTimestamp > OPTIMISTIC_ROLLBACK_MS) {
      console.log('[Flag] ⏪ Optimistic prediction rolled back (server rejected)')
      hideShieldForPlayer(optimisticCarrierId)
      cleanupClone()
      if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: true })
      optimisticCarrierId = null
      optimisticTimestamp = 0
    }
    // Also roll back immediately if server says someone ELSE is carrying (steal denied, etc.)
    if (optimisticCarrierId && flag.state === FlagState.Carried && flag.carrierPlayerId !== optimisticCarrierId) {
      hideShieldForPlayer(optimisticCarrierId)
      cleanupClone()
      createCarryClone(flag.carrierPlayerId)
      if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: false })
      // Don't show shield here — server's flagImmunity message handles it with proper fade timer
      optimisticCarrierId = null
      optimisticTimestamp = 0
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
    
    // 2. Flag is NOT carried — ensure flag visual is visible (skip if optimistic pickup is pending)
    if (flag.state !== FlagState.Carried && flagVisualEntity && !optimisticCarrierId) {
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