/**
 * LOCAL-ONLY test flag — blue banner for previewing without the authoritative server.
 * Uses the same clone system as the online flag for consistent behavior.
 */
import {
  engine, Transform, GltfContainer,
  inputSystem, InputAction, PointerEventType,
  AudioSource, Raycast, RaycastResult, RaycastQueryType,
  Material, MaterialTransparencyMode, MeshRenderer,
  Tween, EasingFunction, AvatarAttach, AvatarAnchorPointType,
  VisibilityComponent, RealmInfo,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { FLAG_BASE_POSITION } from '../shared/components'
import { setLocalTestFlagState } from './beaconSystem'

const BLUE_BANNER_SRC = 'assets/asset-packs/small_blue_banner/Banner_Blue_02/Banner_Blue_02.glb'
const PICKUP_RADIUS = 3.5
const DROP_BEHIND_DISTANCE = 1.4

// Visual clone system (same as online flag)
let carryCloneEntity: Entity | null = null
let attachAnchorEntity: Entity | null = null

// Animation constants - match idle ground animation exactly
const CARRY_BOB_AMPLITUDE = 0.15      // Same as idle
const CARRY_BOB_SPEED = 2              // Same as idle
const CARRY_ROT_SPEED_DEG_PER_SEC = 25 // Same as idle
let carryAnimTime = 0
const FLAG_CARRY_OFFSET = { x: 0, y: 0.4, z: 0 } // Directly above avatar, comfortable height

// Idle animation constants - match server exactly  
const IDLE_BOB_AMPLITUDE = 0.15      // Matches server
const IDLE_BOB_SPEED = 2              // Matches server
const IDLE_ROT_SPEED_DEG_PER_SEC = 25 // Matches server

// Gravity
const FLAG_GRAVITY = 15
const FLAG_MIN_Y = 0.5

// State
let testFlagEntity: Entity
let state: 'base' | 'carried' | 'dropped' = 'base'
let anchorX = FLAG_BASE_POSITION.x
let anchorY = FLAG_BASE_POSITION.y
let anchorZ = FLAG_BASE_POSITION.z
let idleTime = 0

// Gravity state
let flagFalling = false
let flagFallVelocity = 0
let flagGravityTargetY = FLAG_MIN_Y
let pendingRaycastEntity: Entity | null = null

// Sound
let pickupSoundEntity: Entity | null = null
let dropSoundEntity: Entity | null = null

// Cleanup function to prevent clone duplication
function cleanupClone(): void {
  if (carryCloneEntity !== null) { 
    console.log('[LocalTest] Cleaning up existing clone entity')
    engine.removeEntity(carryCloneEntity)
    carryCloneEntity = null 
  }
  if (attachAnchorEntity !== null) { 
    console.log('[LocalTest] Cleaning up existing anchor entity')
    engine.removeEntity(attachAnchorEntity)
    attachAnchorEntity = null 
  }
}

function playPickup(): void {
  if (!pickupSoundEntity) {
    pickupSoundEntity = engine.addEntity()
    Transform.create(pickupSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(pickupSoundEntity, { audioClipUrl: 'assets/sounds/rs-pickup.ogg', playing: false, loop: false, volume: 1, global: true })
  }
  const a = AudioSource.getMutable(pickupSoundEntity)
  a.currentTime = 0
  a.playing = true
}

function playDrop(): void {
  if (!dropSoundEntity) {
    dropSoundEntity = engine.addEntity()
    Transform.create(dropSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(dropSoundEntity, { audioClipUrl: 'assets/sounds/rs-drop.mp3', playing: false, loop: false, volume: 1, global: true })
  }
  const a = AudioSource.getMutable(dropSoundEntity)
  a.currentTime = 0
  a.playing = true
}

// ── Trail pool (movement puffs) ──
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
const HIDDEN_POS = Vector3.create(0, -100, 0)
const trailPool: Entity[] = []
let trailPoolIdx = 0
let trailPoolReady = false
let trailSpawnAccum = 0
let lastPlayerPos: Vector3 | null = null
const activeTrailPuffs: { entity: Entity; expiresAt: number }[] = []

// ── Beacon pool (idle floating bubbles) - upgraded from v1 project ──
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
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
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
  t.position = HIDDEN_POS
  t.scale = Vector3.Zero()
  if (Tween.has(entity)) Tween.deleteFrom(entity)
}

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

function fireGroundRaycast(dropPos: Vector3): void {
  if (pendingRaycastEntity !== null) {
    engine.removeEntity(pendingRaycastEntity)
    pendingRaycastEntity = null
  }
  pendingRaycastEntity = engine.addEntity()
  Transform.create(pendingRaycastEntity, {
    position: Vector3.create(dropPos.x, dropPos.y + 0.3, dropPos.z)
  })
  Raycast.create(pendingRaycastEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
    maxDistance: 200,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })
  flagGravityTargetY = FLAG_MIN_Y
  flagFalling = true
  flagFallVelocity = 0
}

export function setupLocalTestFlag(): void {
  console.log('[LocalTest] Creating blue test flag with clone system')

  testFlagEntity = engine.addEntity()
  Transform.create(testFlagEntity, {
    position: Vector3.create(FLAG_BASE_POSITION.x + 8, FLAG_BASE_POSITION.y, FLAG_BASE_POSITION.z),
    rotation: Quaternion.fromEulerDegrees(0, 0, 0),
    scale: Vector3.create(1, 1, 1)
  })
  GltfContainer.create(testFlagEntity, { src: BLUE_BANNER_SRC })

  // Notify beacon system about initial state
  setLocalTestFlagState(false, testFlagEntity)

  engine.addSystem(localTestFlagSystem)
}

function localTestFlagSystem(dt: number): void {
  // Only run when not connected to server
  const realm = RealmInfo.getOrNull(engine.RootEntity)
  if (realm?.isConnectedSceneRoom) {
    return
  }

  const clampedDt = Math.min(dt, 0.1)
  idleTime += clampedDt
  carryAnimTime += clampedDt

  const myPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : null
  const myRot = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).rotation : null

  // E key: pickup / drop
  if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN)) {
    if (state === 'carried') {
      // Drop using clone system
      let dropPos: Vector3
      if (myPos && myRot) {
        const behind = Vector3.rotate(Vector3.Backward(), myRot)
        const offsetBehind = Vector3.scale(behind, DROP_BEHIND_DISTANCE)
        dropPos = Vector3.add(Vector3.add(myPos, Vector3.create(0, 0.5, 0)), offsetBehind)
      } else if (myPos) {
        dropPos = Vector3.add(myPos, Vector3.create(0, 0.5, 0))
      } else {
        dropPos = Transform.get(testFlagEntity).position
      }

      state = 'dropped'
      anchorX = dropPos.x
      anchorY = dropPos.y
      anchorZ = dropPos.z

      // Notify beacon system
      setLocalTestFlagState(false, testFlagEntity)

      // Clean up clone system
      cleanupClone()
      console.log('[LocalTest] Clone cleaned up, showing original flag')

      // Show original flag at drop position
      VisibilityComponent.createOrReplace(testFlagEntity, { visible: true })
      const t = Transform.getMutable(testFlagEntity)
      t.position = dropPos

      fireGroundRaycast(dropPos)
      playDrop()
      console.log('[LocalTest] Dropped flag using clone system')
      
    } else {
      // Try pickup using clone system
      if (myPos) {
        const flagPos = Transform.get(testFlagEntity).position
        const dist = Vector3.distance(myPos, flagPos)
        if (dist <= PICKUP_RADIUS) {
          state = 'carried'
          flagFalling = false
          flagFallVelocity = 0
          if (pendingRaycastEntity !== null) {
            engine.removeEntity(pendingRaycastEntity)
            pendingRaycastEntity = null
          }

          // Notify beacon system
          setLocalTestFlagState(true, testFlagEntity)

          // ALWAYS clean up existing clone first to prevent duplicates
          cleanupClone()

          // Create clone system
          const player = getPlayer()
          if (player) {
            // IMMEDIATELY hide original flag before creating clone
            VisibilityComponent.createOrReplace(testFlagEntity, { visible: false })
            console.log('[LocalTest] Hidden original flag, creating clone')

            // Create AvatarAttach anchor
            attachAnchorEntity = engine.addEntity()
            Transform.create(attachAnchorEntity, { position: Vector3.Zero() })
            AvatarAttach.create(attachAnchorEntity, {
              avatarId: player.userId,
              anchorPointId: AvatarAnchorPointType.AAPT_NAME_TAG
            })

            // Create visual clone
            carryCloneEntity = engine.addEntity()
            Transform.create(carryCloneEntity, {
              parent: attachAnchorEntity,
              position: Vector3.create(FLAG_CARRY_OFFSET.x, FLAG_CARRY_OFFSET.y, FLAG_CARRY_OFFSET.z),
              rotation: Quaternion.Identity(),
              scale: Vector3.One()
            })
            GltfContainer.create(carryCloneEntity, { 
              src: BLUE_BANNER_SRC,
              visibleMeshesCollisionMask: 0,
              invisibleMeshesCollisionMask: 0
            })

            console.log('[LocalTest] Clone system created successfully')
          }

          playPickup()
          console.log('[LocalTest] Picked up flag using clone system')
        } else {
          console.log('[LocalTest] Too far to pick up — dist:', dist.toFixed(2))
        }
      }
    }
  }

  // Handle raycast results
  if (pendingRaycastEntity !== null) {
    const result = RaycastResult.getOrNull(pendingRaycastEntity)
    if (result) {
      if (result.hits.length > 0) {
        const groundY = result.hits[0].position!.y
        flagGravityTargetY = Math.max(FLAG_MIN_Y, groundY + 0.5)
        if (anchorY < flagGravityTargetY) {
          anchorY = flagGravityTargetY
          flagFalling = false
          flagFallVelocity = 0
        }
      } else {
        flagGravityTargetY = Math.max(FLAG_MIN_Y, 0 + 0.5)
      }
      engine.removeEntity(pendingRaycastEntity)
      pendingRaycastEntity = null
    }
  }

  // Gravity for dropped flag
  if (state === 'dropped' && flagFalling) {
    flagFallVelocity += FLAG_GRAVITY * clampedDt
    let newY = anchorY - flagFallVelocity * clampedDt
    if (newY <= flagGravityTargetY) {
      newY = flagGravityTargetY
      flagFalling = false
      flagFallVelocity = 0
    }
    anchorY = newY
  }

  // Animate visual clone (same as online flag)
  if (state === 'carried' && carryCloneEntity !== null && Transform.has(carryCloneEntity)) {
    const bobY = CARRY_BOB_AMPLITUDE * Math.sin(carryAnimTime * CARRY_BOB_SPEED)
    const angleDeg = (carryAnimTime * CARRY_ROT_SPEED_DEG_PER_SEC) % 360
    const ct = Transform.getMutable(carryCloneEntity)
    ct.position = Vector3.create(FLAG_CARRY_OFFSET.x, FLAG_CARRY_OFFSET.y + bobY, FLAG_CARRY_OFFSET.z)
    ct.rotation = Quaternion.fromEulerDegrees(0, angleDeg, 0)
  } 

  // Defensive programming: ensure original flag is visible when not carried
  if (state !== 'carried') {
    if (!VisibilityComponent.has(testFlagEntity) || !VisibilityComponent.get(testFlagEntity).visible) {
      console.log('[LocalTest] Defensive: ensuring original flag is visible when not carried')
      VisibilityComponent.createOrReplace(testFlagEntity, { visible: true })
    }
  } else {
    // Defensive programming: ensure original flag is hidden when carried
    if (!VisibilityComponent.has(testFlagEntity) || VisibilityComponent.get(testFlagEntity).visible) {
      console.log('[LocalTest] Defensive: ensuring original flag is hidden when carried')
      VisibilityComponent.createOrReplace(testFlagEntity, { visible: false })
    }
  }

  // Animate original flag when not carried (idle at base/dropped)
  if (state !== 'carried') {
    const restX = state === 'base' ? FLAG_BASE_POSITION.x + 8 : anchorX
    const restY = state === 'base' ? FLAG_BASE_POSITION.y : anchorY
    const restZ = state === 'base' ? FLAG_BASE_POSITION.z : anchorZ
    const bobY = flagFalling ? 0 : IDLE_BOB_AMPLITUDE * Math.sin(idleTime * IDLE_BOB_SPEED)
    const angleDeg = (idleTime * IDLE_ROT_SPEED_DEG_PER_SEC) % 360
    const t = Transform.getMutable(testFlagEntity)
    t.position = Vector3.create(restX, restY + bobY, restZ)
    t.rotation = Quaternion.fromEulerDegrees(0, angleDeg, 0)
  }

  // Particle effects - trail particles only when actually moving
  if (state === 'carried' && myPos) {
    // Check if player is actually moving
    let isPlayerMoving = false
    if (lastPlayerPos !== null) {
      const distanceMoved = Vector3.distance(myPos, lastPlayerPos)
      isPlayerMoving = distanceMoved > TRAIL_MIN_MOVE_DIST
    }
    
    // Update position tracking
    lastPlayerPos = Vector3.create(myPos.x, myPos.y, myPos.z)
    
    // Only spawn trail particles if actually moving
    if (isPlayerMoving) {
      const groundParticlePos = Vector3.create(myPos.x, myPos.y + 0.1, myPos.z)
      trailSpawnAccum += clampedDt
      while (trailSpawnAccum >= TRAIL_SPAWN_INTERVAL) {
        trailSpawnAccum -= TRAIL_SPAWN_INTERVAL
        spawnTrailPuff(groundParticlePos)
      }
    } else {
      // Reset trail accumulator when not moving
      trailSpawnAccum = 0
    }
    
    beaconSpawnAccum = 0 // No beacon particles when carried
    
  } else if (state === 'base' || state === 'dropped') {
    // Beacon particles floating up from flag when idle
    const flagPos = Transform.get(testFlagEntity).position
    beaconSpawnAccum += clampedDt
    while (beaconSpawnAccum >= BEACON_SPAWN_INTERVAL) {
      beaconSpawnAccum -= BEACON_SPAWN_INTERVAL
      spawnBeaconPuff(flagPos)
    }
    
    // Reset player tracking when flag not carried
    lastPlayerPos = null
    trailSpawnAccum = 0
    
  } else {
    // Reset all tracking
    lastPlayerPos = null
    trailSpawnAccum = 0
    beaconSpawnAccum = 0
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
}