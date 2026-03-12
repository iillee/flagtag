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
  RealmInfo,
  MeshCollider,
  Raycast,
  RaycastResult,
  RaycastQueryType,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { Flag, FlagState, FLAG_CARRY_OFFSET } from '../shared/components'
import { room } from '../shared/messages'

const FLAG_FOLLOW_SPEED = 8
const FLAG_CARRY_ROTATION = Quaternion.fromEulerDegrees(0, 90, 0)

// ── Trail pool (same as before) ──
const TRAIL_SPAWN_INTERVAL = 0.08
const TRAIL_LIFETIME_MS = 600
const TRAIL_START_SCALE = 0.18
const TRAIL_POOL_SIZE = 15
const TRAIL_MATERIAL = {
  albedoColor: Color4.create(1.0, 0.82, 0.2, 0.55),
  emissiveColor: Color4.create(1.0, 0.75, 0.1, 1),
  emissiveIntensity: 2.5,
  roughness: 1.0,
  metallic: 0.0,
  specularIntensity: 0.0,
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
}
let trailSpawnAccum = 0
let lastTrailFlagPos: Vector3 | null = null
const TRAIL_MIN_MOVE_DIST = 0.05
const trailPool: Entity[] = []
let trailPoolIdx = 0
let trailPoolReady = false
const activeTrailPuffs: { entity: Entity; expiresAt: number }[] = []
const TRAIL_HIDDEN_POS = Vector3.create(0, -100, 0)

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



// ── Helpers ──
function getCarrierEntity(carrierPlayerId: string): Entity | null {
  if (!carrierPlayerId) return null
  const local = getPlayerData()
  if (local?.userId === carrierPlayerId) return engine.PlayerEntity
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address === carrierPlayerId) return entity as Entity
  }
  return null
}

function isConnected(): boolean {
  const realm = RealmInfo.getOrNull(engine.RootEntity)
  return !!realm?.isConnectedSceneRoom
}

// ── Track previous flag state for sound triggers ──
let prevFlagState: FlagState | null = null

// ── Sound entities (lazy) ──
import { AudioSource } from '@dcl/sdk/ecs'
let pickupSoundEntity: Entity | null = null
let dropSoundEntity: Entity | null = null

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

// ── Ground raycast for server gravity ──
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

// ── Main client system ──
export function flagClientSystem(dt: number): void {
  const userId = getPlayerData()?.userId

  // E key: unified interact — drop / pickup / attack
  if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN) && userId) {
    let amCarrying = false
    for (const [, flag] of engine.getEntitiesWith(Flag)) {
      if (flag.state === FlagState.Carried && flag.carrierPlayerId === userId) {
        amCarrying = true
        break
      }
    }
    if (amCarrying) {
      // Carrying → drop the flag (no attacking while holding)
      room.send('requestDrop', { t: 0 })
    } else {
      // Not carrying → check if flag is nearby and available
      let flagNearby = false
      const myPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : null
      if (myPos) {
        for (const [flagEntity, flag] of engine.getEntitiesWith(Flag, Transform)) {
          if (flag.state === FlagState.Carried) continue
          const dist = Vector3.distance(myPos, Transform.get(flagEntity).position)
          if (dist <= 3) { flagNearby = true; break }
        }
      }
      if (flagNearby) {
        console.log('[Client] E pressed → sending requestPickup')
        room.send('requestPickup', { t: 0 })
      } else {
        console.log('[Client] E pressed → flag not nearby, sending requestAttack')
        room.send('requestAttack', { t: 0 })
      }
    }
  }

  // Detect flag state changes for sounds + collider management
  for (const [flagEntity, flag] of engine.getEntitiesWith(Flag)) {
    if (prevFlagState !== null && prevFlagState !== flag.state) {
      if (flag.state === FlagState.Carried) {
        playPickupSound()
        if (MeshCollider.has(flagEntity)) MeshCollider.deleteFrom(flagEntity)
      }
      if (flag.state === FlagState.Dropped || flag.state === FlagState.AtBase) {
        playDropSound()
        if (!MeshCollider.has(flagEntity)) MeshCollider.setBox(flagEntity)
        // Snap position from synced Flag data to override any stale carry-follow
        const ft = Transform.getMutable(flagEntity)
        if (flag.state === FlagState.Dropped) {
          ft.position = Vector3.create(flag.dropAnchorX, flag.dropAnchorY, flag.dropAnchorZ)
          // Fire a downward raycast to find the ground and report to server
          fireGroundRaycastForServer(Vector3.create(flag.dropAnchorX, flag.dropAnchorY, flag.dropAnchorZ))
        } else {
          ft.position = Vector3.create(flag.baseX, flag.baseY, flag.baseZ)
        }
      }
    }
    prevFlagState = flag.state
    break
  }

  const clampedDt = Math.min(dt, 0.1)

  // Carry follow (all clients compute for visual smoothness; snap on drop handles conflicts)
  const smoothFactor = 1 - Math.exp(-FLAG_FOLLOW_SPEED * clampedDt)
  for (const [flagEntity, flag] of engine.getEntitiesWith(Flag, Transform)) {
    if (flag.state !== FlagState.Carried || !flag.carrierPlayerId) continue
    const carrierEntity = getCarrierEntity(flag.carrierPlayerId)
    if (!carrierEntity || !Transform.has(carrierEntity)) continue
    const carrierT = Transform.get(carrierEntity)
    const flagT = Transform.getMutable(flagEntity)
    const offset = Vector3.create(FLAG_CARRY_OFFSET.x, FLAG_CARRY_OFFSET.y, FLAG_CARRY_OFFSET.z)
    const targetPos = Vector3.add(carrierT.position, offset)
    flagT.position = Vector3.lerp(flagT.position, targetPos, smoothFactor)
    const targetRot = Quaternion.multiply(carrierT.rotation, FLAG_CARRY_ROTATION)
    flagT.rotation = Quaternion.slerp(flagT.rotation, targetRot, smoothFactor)
  }

  // ── Check pending ground raycast and report to server ──
  if (groundRayEntity !== null) {
    const rayResult = RaycastResult.getOrNull(groundRayEntity)
    if (rayResult) {
      if (rayResult.hits.length > 0) {
        const groundY = rayResult.hits[0].position!.y
        room.send('reportGroundY', { y: groundY })
      } else {
        // No collider found — assume default DCL ground plane at y=0
        room.send('reportGroundY', { y: 0 })
      }
      engine.removeEntity(groundRayEntity)
      groundRayEntity = null
    }
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
    // Ease-out position (fast start, slow near top)
    const easedPos = 1 - Math.pow(1 - progress, 2)
    const bt = Transform.getMutable(bp.entity)
    bt.position = Vector3.lerp(bp.startPos, bp.endPos, easedPos)
    // Shrink: full size at bottom → zero at top
    const scale = bp.startScale * (1 - progress)
    bt.scale = Vector3.create(scale, scale, scale)
  }

  // ── Trail (moving) + Beacon (idle) effects ──
  let flagPos: Vector3 | null = null
  for (const [flagEntity] of engine.getEntitiesWith(Flag, Transform)) {
    flagPos = Transform.get(flagEntity).position
    break
  }

  const isMoving = flagPos != null && lastTrailFlagPos != null &&
    Vector3.distance(flagPos, lastTrailFlagPos) > TRAIL_MIN_MOVE_DIST
  if (flagPos) lastTrailFlagPos = Vector3.create(flagPos.x, flagPos.y, flagPos.z)

  if (flagPos && isMoving) {
    // Moving trail (gold puffs behind the flag)
    trailSpawnAccum += clampedDt
    while (trailSpawnAccum >= TRAIL_SPAWN_INTERVAL) {
      trailSpawnAccum -= TRAIL_SPAWN_INTERVAL
      spawnTrailPuff(flagPos)
    }
    beaconSpawnAccum = 0
  } else if (flagPos) {
    // Idle beacon (gold bubbles floating upward)
    beaconSpawnAccum += clampedDt
    while (beaconSpawnAccum >= BEACON_SPAWN_INTERVAL) {
      beaconSpawnAccum -= BEACON_SPAWN_INTERVAL
      spawnBeaconPuff(flagPos)
    }
    trailSpawnAccum = 0
  } else {
    trailSpawnAccum = 0
    beaconSpawnAccum = 0
  }
}
