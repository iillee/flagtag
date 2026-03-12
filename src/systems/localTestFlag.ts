/**
 * LOCAL-ONLY test flag — blue banner for previewing without the authoritative server.
 * Handles pickup (E), drop (E), carry-follow, idle bob, and gravity entirely client-side.
 * This file is only loaded when NOT connected to the server (local preview).
 */
import {
  engine, Transform, GltfContainer, MeshCollider,
  inputSystem, InputAction, PointerEventType,
  AudioSource, Raycast, RaycastResult, RaycastQueryType,
  Material, MaterialTransparencyMode, MeshRenderer,
  Tween, EasingFunction,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { FLAG_BASE_POSITION, FLAG_CARRY_OFFSET } from '../shared/components'

const BLUE_BANNER_SRC = 'assets/asset-packs/small_blue_banner/Banner_Blue_02/Banner_Blue_02.glb'
const PICKUP_RADIUS = 3.5
const DROP_BEHIND_DISTANCE = 1.4
const IDLE_BOB_AMPLITUDE = 0.15
const IDLE_BOB_SPEED = 2
const IDLE_ROT_SPEED_DEG_PER_SEC = 25
const FLAG_FOLLOW_SPEED = 8
const FLAG_CARRY_ROTATION = Quaternion.fromEulerDegrees(0, 90, 0)

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
let lastFlagPos: Vector3 | null = null
const activeTrailPuffs: { entity: Entity; expiresAt: number }[] = []

// ── Beacon pool (idle floating bubbles) ──
const BEACON_SPAWN_INTERVAL = 0.35
const BEACON_LIFETIME_MS = 2200
const BEACON_FLOAT_HEIGHT = 7
const BEACON_START_SCALE = 0.2
const BEACON_POOL_SIZE = 12
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

/** Fire a one-shot downward raycast from the drop position to find the ground. */
function fireGroundRaycast(dropPos: Vector3): void {
  // Clean up any previous raycast
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

  // Start falling immediately toward absolute minimum; raycast will refine the target
  flagGravityTargetY = FLAG_MIN_Y
  flagFalling = true
  flagFallVelocity = 0
}

/** Call once from main() to spawn the blue test flag and register the system. */
export function setupLocalTestFlag(): void {
  console.log('[LocalTest] Creating blue test flag at base position')

  testFlagEntity = engine.addEntity()
  Transform.create(testFlagEntity, {
    position: Vector3.create(FLAG_BASE_POSITION.x + 8, FLAG_BASE_POSITION.y, FLAG_BASE_POSITION.z),
    rotation: Quaternion.fromEulerDegrees(0, 0, 0),
    scale: Vector3.create(1, 1, 1)
  })
  GltfContainer.create(testFlagEntity, { src: BLUE_BANNER_SRC })
  MeshCollider.setBox(testFlagEntity)

  engine.addSystem(localTestFlagSystem)
}

function localTestFlagSystem(dt: number): void {
  const clampedDt = Math.min(dt, 0.1)
  idleTime += clampedDt

  const myPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : null
  const myRot = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).rotation : null

  // ── E key: pickup / drop ──
  if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN)) {
    if (state === 'carried') {
      // Drop
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

      const t = Transform.getMutable(testFlagEntity)
      t.position = dropPos
      if (!MeshCollider.has(testFlagEntity)) MeshCollider.setBox(testFlagEntity)

      fireGroundRaycast(dropPos)
      playDrop()
      console.log('[LocalTest] Dropped flag at', dropPos.x.toFixed(1), dropPos.y.toFixed(1), dropPos.z.toFixed(1),
        '— raycasting for ground...')
    } else {
      // Try pickup
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
          if (MeshCollider.has(testFlagEntity)) MeshCollider.deleteFrom(testFlagEntity)
          playPickup()
          console.log('[LocalTest] Picked up flag! dist:', dist.toFixed(2))
        } else {
          console.log('[LocalTest] Too far to pick up — dist:', dist.toFixed(2))
        }
      }
    }
  }

  // ── Raycast result — update gravity target when ground is found ──
  if (pendingRaycastEntity !== null) {
    const result = RaycastResult.getOrNull(pendingRaycastEntity)
    if (result) {
      if (result.hits.length > 0) {
        const groundY = result.hits[0].position!.y
        flagGravityTargetY = Math.max(FLAG_MIN_Y, groundY + 0.5)
        console.log('[LocalTest] Raycast hit ground at Y:', groundY.toFixed(2), '→ landing target:', flagGravityTargetY.toFixed(2))
        // If flag already fell past the target, snap it
        if (anchorY < flagGravityTargetY) {
          anchorY = flagGravityTargetY
          flagFalling = false
          flagFallVelocity = 0
        }
      } else {
        // No collider found — assume default DCL ground plane at y=0
        flagGravityTargetY = Math.max(FLAG_MIN_Y, 0 + 0.5)
      }
      engine.removeEntity(pendingRaycastEntity)
      pendingRaycastEntity = null
    }
  }

  // ── Gravity ──
  if (state === 'dropped' && flagFalling) {
    flagFallVelocity += FLAG_GRAVITY * clampedDt
    let newY = anchorY - flagFallVelocity * clampedDt
    if (newY <= flagGravityTargetY) {
      newY = flagGravityTargetY
      flagFalling = false
      flagFallVelocity = 0
      console.log('[LocalTest] Flag landed at Y:', newY.toFixed(2))
    }
    anchorY = newY
  }

  // ── Carry follow ──
  if (state === 'carried' && myPos && myRot) {
    const smoothFactor = 1 - Math.exp(-FLAG_FOLLOW_SPEED * clampedDt)
    const offset = Vector3.create(FLAG_CARRY_OFFSET.x, FLAG_CARRY_OFFSET.y, FLAG_CARRY_OFFSET.z)
    const targetPos = Vector3.add(myPos, offset)
    const targetRot = Quaternion.multiply(myRot, FLAG_CARRY_ROTATION)
    const ct = Transform.getMutable(testFlagEntity)
    ct.position = Vector3.lerp(ct.position, targetPos, smoothFactor)
    ct.rotation = Quaternion.slerp(ct.rotation, targetRot, smoothFactor)
  } else {
  // ── Idle bob (base or dropped) ──
    const restX = state === 'base' ? FLAG_BASE_POSITION.x + 8 : anchorX
    const restY = state === 'base' ? FLAG_BASE_POSITION.y : anchorY
    const restZ = state === 'base' ? FLAG_BASE_POSITION.z : anchorZ
    const bobY = flagFalling ? 0 : IDLE_BOB_AMPLITUDE * Math.sin(idleTime * IDLE_BOB_SPEED)
    const angleDeg = (idleTime * IDLE_ROT_SPEED_DEG_PER_SEC) % 360
    const t = Transform.getMutable(testFlagEntity)
    t.position = Vector3.create(restX, restY + bobY, restZ)
    t.rotation = Quaternion.fromEulerDegrees(0, angleDeg, 0)
  }

  // ── Cleanup expired effects ──
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

  // ── Trail (moving) + Beacon (idle) effects ──
  const flagPos = Transform.get(testFlagEntity).position
  const isMoving = lastFlagPos != null &&
    Vector3.distance(flagPos, lastFlagPos) > TRAIL_MIN_MOVE_DIST
  lastFlagPos = Vector3.create(flagPos.x, flagPos.y, flagPos.z)

  if (isMoving) {
    trailSpawnAccum += clampedDt
    while (trailSpawnAccum >= TRAIL_SPAWN_INTERVAL) {
      trailSpawnAccum -= TRAIL_SPAWN_INTERVAL
      spawnTrailPuff(flagPos)
    }
    beaconSpawnAccum = 0
  } else {
    beaconSpawnAccum += clampedDt
    while (beaconSpawnAccum >= BEACON_SPAWN_INTERVAL) {
      beaconSpawnAccum -= BEACON_SPAWN_INTERVAL
      spawnBeaconPuff(flagPos)
    }
    trailSpawnAccum = 0
  }
}
