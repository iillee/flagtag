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
import { PROXIMITY_STEAL_RADIUS } from '../shared/constants'
import { room } from '../shared/messages'
import { showShieldForPlayer, setShieldAlpha, hideShieldForPlayer, hideAllShields } from './shieldSystem'
import { isLightningRespawning } from '../gameState/lightningState'
import { setConfirmedCarrier, clearConfirmedCarrier } from '../gameState/flagHoldTime'

// Visual clone system for smooth flag carrying
//
// Architecture (inspired by STS mannequin pattern):
//   Anchor (AvatarAttach)  →  Offset (STATIC)  →  Visual (bob + spin)
//
// KEY RULE: Never write Transform on a direct child of AvatarAttach.
// Bevy's AvatarAttach propagation can race with per-frame Transform writes
// on direct children, causing the entity to "detach" and freeze in world space.
// The static Offset entity acts as a buffer — its Transform is set once at
// creation and NEVER mutated, so there's no race. The Visual (grandchild)
// is safely animated because AvatarAttach only interacts with its immediate child.
//
let carryCloneAnchor: Entity | null = null     // AvatarAttach entity (smooth tracking)
let carryCloneOffset: Entity | null = null     // STATIC child — never mutated after creation
let carryCloneVisual: Entity | null = null     // Grandchild — GltfContainer + bob/spin writes
let carryCloneCarrierId: string | null = null  // Current carrier ID
let cloneVisible = false                       // Whether the clone is currently showing
let cloneBobPhase = 0                          // Bob animation phase (radians)
let cloneSpinAngle = 0                         // Spin animation angle (degrees)

const BANNER_SRC = 'assets/models/Banner_Red_02/Banner_Red_02.glb'
function getBobBaseY(): number { return isMobile() ? 2.4 : 3.0 }  // Y offset above feet (AAPT_POSITION) to float above head
const BOB_AMP = 0.15
const BOB_SPEED = 2.1             // radians/sec (~3s cycle)
const SPIN_SPEED = 50             // degrees/sec (~7.2s full rotation)

const CLONE_HIDDEN_POS = Vector3.create(0, -500, 0)

// ── Pre-pooled clone entities ──
// Created once at scene start, reused for every pickup. No entity creation on the hot path.
// Architecture: Anchor (AvatarAttach) → Offset (STATIC) → Visual (bob + spin)
// KEY RULE: Never write Transform on a direct child of AvatarAttach — the static Offset
// entity buffers against the Bevy propagation race.
let clonePoolReady = false

function initClonePool(): void {
  if (clonePoolReady) return
  clonePoolReady = true

  // Layer 1: Anchor — parked offscreen until needed
  carryCloneAnchor = engine.addEntity()
  Transform.create(carryCloneAnchor, { position: CLONE_HIDDEN_POS })

  // Layer 2: Offset — STATIC child, set once, NEVER mutated
  carryCloneOffset = engine.addEntity()
  Transform.create(carryCloneOffset, {
    parent: carryCloneAnchor,
    position: Vector3.create(0, getBobBaseY(), 0)
  })

  // Layer 3: Visual — grandchild with model, animated per-frame (safe)
  carryCloneVisual = engine.addEntity()
  Transform.create(carryCloneVisual, {
    parent: carryCloneOffset,
    position: Vector3.Zero()
  })
  GltfContainer.create(carryCloneVisual, {
    src: BANNER_SRC,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })
  VisibilityComponent.create(carryCloneVisual, { visible: false })

  console.log('[Flag] Clone pool initialized (Anchor → StaticOffset → Visual)')
}

/** Retarget the pre-pooled clone to a carrier and show it. No entity creation. */
function showClone(carrierId: string): void {
  initClonePool()
  if (carryCloneAnchor === null) return

  // Retarget AvatarAttach to the new carrier
  if (carryCloneCarrierId !== carrierId) {
    // Remove old Transform (it may have a stale parent or position)
    // and recreate with AvatarAttach — this is the only way to retarget
    if (AvatarAttach.has(carryCloneAnchor)) {
      AvatarAttach.deleteFrom(carryCloneAnchor)
    }
    // Keep Transform (needed for child parenting) but zero it out — AvatarAttach overrides position
    Transform.createOrReplace(carryCloneAnchor, { position: Vector3.Zero() })
    AvatarAttach.create(carryCloneAnchor, {
      avatarId: carrierId,
      anchorPointId: AvatarAnchorPointType.AAPT_POSITION
    })
    carryCloneCarrierId = carrierId
    cloneBobPhase = 0
    cloneSpinAngle = 0
  }

  // Update offset Y for mobile (isMobile may not be ready at pool init time)
  if (carryCloneOffset !== null && Transform.has(carryCloneOffset)) {
    Transform.getMutable(carryCloneOffset).position = Vector3.create(0, getBobBaseY(), 0)
  }

  VisibilityComponent.createOrReplace(carryCloneVisual!, { visible: true })
  cloneVisible = true
}

/** Hide the clone (keeps entities alive for reuse). */
function hideClone(): void {
  if (!clonePoolReady || !carryCloneVisual) return
  if (!cloneVisible) return

  VisibilityComponent.createOrReplace(carryCloneVisual, { visible: false })
  // Detach from carrier and park offscreen
  if (carryCloneAnchor && AvatarAttach.has(carryCloneAnchor)) {
    AvatarAttach.deleteFrom(carryCloneAnchor)
  }
  if (carryCloneAnchor) {
    // Restore Transform to park offscreen (was removed when AvatarAttach was added)
    Transform.createOrReplace(carryCloneAnchor, { position: CLONE_HIDDEN_POS })
  }
  carryCloneCarrierId = null
  cloneVisible = false
}

/** Per-frame update: bob/spin on the Visual grandchild (safe — not a direct AvatarAttach child) */
function updateCarryClonePosition(dt: number): void {
  if (!cloneVisible || carryCloneVisual === null) return
  if (!Transform.has(carryCloneVisual)) return

  // AvatarAttach health check: if the engine stripped the AvatarAttach component
  // (race condition), re-attach it to prevent the clone from freezing in world space.
  if (carryCloneAnchor && carryCloneCarrierId && !AvatarAttach.has(carryCloneAnchor)) {
    console.log('[Flag] ⚠️ AvatarAttach lost on clone anchor — re-attaching to', carryCloneCarrierId.slice(0, 8))
    Transform.createOrReplace(carryCloneAnchor, { position: Vector3.Zero() })
    AvatarAttach.create(carryCloneAnchor, {
      avatarId: carryCloneCarrierId,
      anchorPointId: AvatarAnchorPointType.AAPT_POSITION
    })
  }

  // Animate bob and spin
  cloneBobPhase += BOB_SPEED * dt
  cloneSpinAngle = (cloneSpinAngle + SPIN_SPEED * dt) % 360
  const bobOffset = Math.sin(cloneBobPhase) * BOB_AMP

  const t = Transform.getMutable(carryCloneVisual)
  t.position = Vector3.create(0, bobOffset, 0)
  t.rotation = Quaternion.fromEulerDegrees(0, cloneSpinAngle, 0)
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
const WITNESSED_DROP_COOLDOWN_MS = 750 // after seeing anyone drop, brief cooldown to let server settle
let lastWitnessedDropTimeMs = 0

// Sound entities
let pickupSoundEntity: Entity | null = null
let dropSoundEntity: Entity | null = null

// Sound dedup — prevent double-play when local action + CRDT both trigger
let skipNextPickupSound = false
let skipNextDropSound = false

// Server confirmation fast-path — pickupConfirmed message arrives before CRDT sync
// Phase 1 (instant): hide flag visual + play sound on auto-pickup
// Phase 2 (~50-100ms): create clone + shield when pickupConfirmed arrives
let pendingPickupUntil = 0                       // Suppress flag-visual restore until this timestamp
const PENDING_PICKUP_TIMEOUT_MS = 1500           // Give up waiting for confirmation after 1.5s
let confirmedCarrierId: string | null = null     // Set by pickupConfirmed message, consumed by system

// Post-confirmation grace period — trust the server message over CRDT until CRDT catches up.
// During this window, the safety net will NOT hide the clone even if CRDT still shows non-Carried.
let confirmedGraceUntil = 0                      // Timestamp: don't let safety net override until this
let confirmedGraceCarrier = ''                   // Who the server confirmed as carrier
const CONFIRMED_GRACE_MS = 3000                  // 3s grace — CRDT should arrive well within this

// Listen for fast server confirmation (arrives before CRDT sync)
room.onMessage('pickupConfirmed', (data) => {
  confirmedCarrierId = data.playerId
  // Start grace period — trust this over CRDT until CRDT catches up
  confirmedGraceUntil = Date.now() + CONFIRMED_GRACE_MS
  confirmedGraceCarrier = data.playerId
  // Also tell the interpolation system who the carrier is so scoreboard doesn't reset
  setConfirmedCarrier(data.playerId)
  // Play pickup sound now that server confirmed (prevents repeated sounds on rejected pickups)
  // But skip if Phase 1 (auto-pickup) already played it
  if (!skipNextPickupSound) {
    playPickupSound()
  }
  skipNextPickupSound = true  // skip the CRDT-triggered sound since we already played it
})

// ── Fast-path for combat-forced drops (arrives before CRDT) ──
room.onMessage('dropForced', (data) => {
  const droppedPlayerId = data.playerId
  console.log('[Flag] ⚡ dropForced received for', droppedPlayerId?.slice(0, 8))
  // Immediately clear grace period so safety net doesn't re-show the clone
  confirmedGraceUntil = 0
  confirmedGraceCarrier = ''
  clearConfirmedCarrier()
  pendingPickupUntil = 0
  skipNextPickupSound = false  // reset for next pickup
  // Hide clone + shield, restore flag visual
  hideClone()
  hideAllShields()
  if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: true })
  // Apply drop cooldown if we were the carrier
  const userId = getPlayerData()?.userId?.toLowerCase()
  if (userId && droppedPlayerId === userId) {
    lastDropTimeMs = Date.now()
  }
  lastWitnessedDropTimeMs = Date.now()
})

// ── Flag heartbeat: periodic server broadcast to fix stale CRDT visuals ──
let heartbeatMismatchCount = 0
room.onMessage('flagHeartbeat', (data) => {
  const hbState = data.state as FlagState
  const hbCarrier = (data.carrierId || '').toLowerCase()

  // Read current CRDT state
  let crdtState: FlagState | null = null
  let crdtCarrier = ''
  for (const [, flag] of engine.getEntitiesWith(Flag)) {
    crdtState = flag.state
    crdtCarrier = flag.carrierPlayerId
    break
  }

  // Only act if CRDT disagrees with the heartbeat (stale)
  if (crdtState === null) return
  const stateMatch = crdtState === hbState
  const carrierMatch = crdtCarrier === hbCarrier
  if (stateMatch && carrierMatch) {
    // CRDT matches server — reset mismatch counter
    heartbeatMismatchCount = 0
    return
  }

  // Don't override during pending pickup or grace period
  if (pendingPickupUntil > 0 || Date.now() < confirmedGraceUntil) return

  // Require 2 consecutive mismatches (10s) before correcting —
  // brief CRDT propagation delays are normal, don't fight them.
  heartbeatMismatchCount++
  if (heartbeatMismatchCount < 2) {
    console.log('[Flag] 💓 Heartbeat mismatch #' + heartbeatMismatchCount + ': CRDT says', crdtState, '/', crdtCarrier.slice(0, 8),
      '— server says', hbState, '/', hbCarrier.slice(0, 8), '— waiting for next heartbeat')
    return
  }

  console.log('[Flag] 💓 Heartbeat correction (stale ' + heartbeatMismatchCount + 'x): CRDT says', crdtState, '/', crdtCarrier.slice(0, 8),
    '— server says', hbState, '/', hbCarrier.slice(0, 8))
  heartbeatMismatchCount = 0

  // Fix clone + flag visibility only — shield is driven by CRDT state changes
  if (hbState === FlagState.Carried && hbCarrier) {
    if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: false })
    if (carryCloneCarrierId !== hbCarrier || !cloneVisible) {
      showClone(hbCarrier)
    }
  } else {
    // Server says not carried — clear any stale clone
    if (cloneVisible) {
      hideClone()
    }
    if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: true })
  }
})

function playPickupSound(): void {
  if (!pickupSoundEntity) {
    pickupSoundEntity = engine.addEntity()
    Transform.create(pickupSoundEntity, { position: Vector3.Zero() })
    // On first call, create with playing: true directly (avoid create + replace in same frame causing double audio)
    AudioSource.create(pickupSoundEntity, { audioClipUrl: 'assets/sounds/pickup2.wav', playing: true, loop: false, volume: 2, global: true })
    return
  }
  AudioSource.createOrReplace(pickupSoundEntity, { audioClipUrl: 'assets/sounds/pickup2.wav', playing: true, loop: false, volume: 2, global: true })
}

function playDropSound(): void {
  if (!dropSoundEntity) {
    dropSoundEntity = engine.addEntity()
    Transform.create(dropSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(dropSoundEntity, { audioClipUrl: 'assets/sounds/drop.mp3', playing: false, loop: false, volume: 0.25, global: true })
  }
  AudioSource.createOrReplace(dropSoundEntity, { audioClipUrl: 'assets/sounds/drop.mp3', playing: true, loop: false, volume: 0.25, global: true })
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

/** Manually drop the flag — called from mobile UI button */
export function requestManualDrop(): void {
  const userId = getPlayerData()?.userId?.toLowerCase()
  if (!userId) return
  let amCarrying = false
  for (const [, flag] of engine.getEntitiesWith(Flag)) {
    if (flag.state === FlagState.Carried && flag.carrierPlayerId === userId) {
      amCarrying = true
      break
    }
  }
  if (!amCarrying && Date.now() < confirmedGraceUntil && confirmedGraceCarrier === userId) {
    amCarrying = true
  }
  if (!amCarrying && cloneVisible && carryCloneCarrierId === userId) {
    amCarrying = true
  }
  if (amCarrying) {
    playDropSound()
    skipNextDropSound = true
    lastDropTimeMs = Date.now()
    confirmedGraceUntil = 0
    confirmedGraceCarrier = ''
    hideShieldForPlayer(userId)
    room.send('requestDrop', { t: 0 })
  }
}
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

  // Carried flag bob/spin is handled per-frame on a standalone visual entity
  // (decoupled from AvatarAttach to avoid the disappearing flag engine bug).
}

export function flagClientSystem(dt: number): void {
  // Ensure the synced flag entity has a local visual child (GltfContainer + bob/spin)
  ensureFlagModel()
  initClonePool()
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

    if (!amCarrying && !isLightningRespawning() && now - lastAutoPickupRequestMs >= AUTO_PICKUP_COOLDOWN_MS && now - lastDropTimeMs >= DROP_PICKUP_COOLDOWN_MS && now - lastWitnessedDropTimeMs >= WITNESSED_DROP_COOLDOWN_MS) {
      const myPos = Transform.get(engine.PlayerEntity).position
      for (const [flagEnt, flag] of engine.getEntitiesWith(Flag, Transform)) {
        if (flag.state === FlagState.Carried) continue
        const dist = Vector3.distance(myPos, Transform.get(flagEnt).position)
        if (dist <= AUTO_PICKUP_RADIUS) {
          // Optimistic Phase 1: show clone + sound immediately (no server round-trip lag)
          // Shield waits for server confirmation to avoid false positives.
          // If server rejects, the pending-pickup timeout will roll everything back.
          if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: false })
          showClone(userId)
          playPickupSound()
          skipNextPickupSound = true  // suppress duplicate when pickupConfirmed arrives
          pendingPickupUntil = now + PENDING_PICKUP_TIMEOUT_MS
          
          room.send('requestPickup', { t: 0 })
          lastAutoPickupRequestMs = now
          break
        }
      }
    }
  }

  // ── Client-side proximity steal prediction ──
  // If flag is carried by someone else and we're within steal radius, send requestSteal
  // and show optimistic visuals immediately (clone swaps to us, shield, sound).
  if (userId && Transform.has(engine.PlayerEntity) && !isLightningRespawning()) {
    const now = Date.now()
    let amCarrying = false
    let carrierIdForSteal = ''
    for (const [, flag] of engine.getEntitiesWith(Flag)) {
      if (flag.state === FlagState.Carried) {
        if (flag.carrierPlayerId === userId) {
          amCarrying = true
        } else {
          carrierIdForSteal = flag.carrierPlayerId
        }
      }
      break
    }
    // Also check grace period — if server confirmed someone else is carrying
    if (!amCarrying && !carrierIdForSteal && confirmedGraceUntil > now && confirmedGraceCarrier && confirmedGraceCarrier !== userId) {
      carrierIdForSteal = confirmedGraceCarrier
    }

    if (!amCarrying && carrierIdForSteal && now - lastAutoPickupRequestMs >= AUTO_PICKUP_COOLDOWN_MS && now - lastDropTimeMs >= DROP_PICKUP_COOLDOWN_MS) {
      // Find carrier position among players
      const myPos = Transform.get(engine.PlayerEntity).position
      for (const [, identity, transform] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
        if (identity.address.toLowerCase() === carrierIdForSteal) {
          const dist = Vector3.distance(myPos, transform.position)
          if (dist <= PROXIMITY_STEAL_RADIUS) {
            // Optimistic steal: show clone immediately, sound + shield wait for confirmation
            if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: false })
            showClone(userId)
            pendingPickupUntil = now + PENDING_PICKUP_TIMEOUT_MS

            room.send('requestSteal', { victimId: carrierIdForSteal })
            lastAutoPickupRequestMs = now
            console.log('[Flag] 🚩 Client proximity steal prediction — sending requestSteal for', carrierIdForSteal.slice(0, 8))
          }
          break
        }
      }
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
    // Also trust the server-confirmed grace period — if the server confirmed us as
    // carrier but CRDT hasn't caught up yet, we should still be able to drop
    if (!amCarrying && Date.now() < confirmedGraceUntil && confirmedGraceCarrier === userId) {
      amCarrying = true
    }
    // Fallback: if clone is showing for us, trust the visual state and let the server validate.
    // This catches edge cases where CRDT desyncs but the player visually has the flag.
    if (!amCarrying && cloneVisible && carryCloneCarrierId === userId) {
      console.log('[Flag] ⚠️ Drop fallback: CRDT says not carrying but clone is showing for us — sending drop anyway')
      amCarrying = true
    }
    if (amCarrying) {
      playDropSound()
      skipNextDropSound = true
      lastDropTimeMs = Date.now()
      confirmedGraceUntil = 0
      confirmedGraceCarrier = ''
      hideShieldForPlayer(userId)
      room.send('requestDrop', { t: 0 })
    }
  }

  // ── Phase 2: consume pickupConfirmed message (faster than CRDT) ──
  // For local pickups, clone is already showing (Phase 1). This confirms it or retargets for steals.
  // For other players' pickups/steals, this creates the clone before CRDT arrives.
  if (confirmedCarrierId) {
    const carrier = confirmedCarrierId
    confirmedCarrierId = null
    pendingPickupUntil = 0
    if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: false })
    // Hide previous carrier's shield and show new carrier's shield (handles steals)
    hideAllShields()
    showShieldForPlayer(carrier)
    setShieldAlpha(carrier, 1.0)
    // Show clone for confirmed carrier (no-op if already showing for same carrier)
    if (carryCloneCarrierId !== carrier || !cloneVisible) {
      showClone(carrier)
    }
    // Note: confirmedGraceUntil/confirmedGraceCarrier remain set — they protect the
    // clone from the safety net until CRDT catches up with the Carried state.
  }

  // ── Pending pickup timeout: server didn't confirm — roll back ──
  if (pendingPickupUntil > 0 && Date.now() > pendingPickupUntil) {
    console.log('[Flag] ⏪ Pickup not confirmed — rolling back')
    pendingPickupUntil = 0
    hideClone()
    if (userId) hideShieldForPlayer(userId)
    if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: true })
    skipNextPickupSound = false  // reset so next pickup's sound plays correctly
    // Apply a longer cooldown to prevent rapid re-pickup attempts when server keeps rejecting
    lastAutoPickupRequestMs = Date.now() + 2000  // won't retry for 2.5s (cooldown is 500ms, so 2000 + 500)
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
      (carryCloneVisual === null && !stateChanged)  // Clone missing (safety net)
    )
    const needsCloneRemove = flag.state !== FlagState.Carried && (
      isFirstFrame ||
      stateChanged
    )

    if (needsCloneCreate) {
      // CRDT now confirms Carried — clear the grace period (no longer needed)
      if (confirmedGraceCarrier === flag.carrierPlayerId) {
        confirmedGraceUntil = 0
        confirmedGraceCarrier = ''
      }
      // CRDT caught up — interpolation can now read carrier from CRDT directly
      clearConfirmedCarrier()

      // Play pickup sound (skip if we already played it in auto-pickup OR
      // if the grace period already handled this pickup via pickupConfirmed)
      if (!isFirstFrame) {
        // If clone is already showing for the correct carrier (from Phase 1/2),
        // this is just CRDT catching up — don't replay the sound
        if (skipNextPickupSound) {
          skipNextPickupSound = false
        } else if (cloneVisible && carryCloneCarrierId === flag.carrierPlayerId) {
          // Clone already showing from pickupConfirmed — suppress duplicate sound
        } else {
          playPickupSound()
        }
      }
      
      pendingPickupUntil = 0
      if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: false })
      // Ensure only the current carrier has a shield (handles steals where carrier swaps)
      hideAllShields()
      showShieldForPlayer(flag.carrierPlayerId)
      setShieldAlpha(flag.carrierPlayerId, 1.0)
      // Show clone for carrier (no-op if already showing for same carrier via Phase 1/2)
      if (carryCloneCarrierId !== flag.carrierPlayerId || !cloneVisible) {
        showClone(flag.carrierPlayerId)
      }

    } else if (needsCloneRemove) {
      // Brief cooldown so auto-pickup doesn't fire before the server has fully settled the drop
      lastWitnessedDropTimeMs = Date.now()

      // CRDT confirms flag is no longer carried — clear any grace period
      confirmedGraceUntil = 0
      confirmedGraceCarrier = ''
      clearConfirmedCarrier()
      skipNextPickupSound = false  // reset so next pickup's sound plays correctly

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

      hideAllShields()
      hideClone()
      pendingPickupUntil = 0
      
      // Restore flag visual visibility (server controls position via CRDT)
      if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: true })

      if (flag.state === FlagState.Dropped) {
        fireGroundRaycastForServer(Vector3.create(flag.dropAnchorX, flag.dropAnchorY, flag.dropAnchorZ))
      }
    }

    // ── Safety nets (unconditional, run every frame) ──

    // 1. Flag IS carried — ensure clone is showing for the correct carrier
    if (flag.state === FlagState.Carried && !needsCloneCreate) {
      const wrongOrMissing = !cloneVisible || carryCloneCarrierId !== flag.carrierPlayerId
      if (wrongOrMissing) {
        console.log(`[Flag] ⚠️ Safety net: showing clone for correct carrier`)
        if (flagVisualEntity) VisibilityComponent.createOrReplace(flagVisualEntity, { visible: false })
        showClone(flag.carrierPlayerId)
      }
    }
    
    // 2. Flag is NOT carried — hide any lingering clone + restore flag visual
    //    Guards with pendingPickupUntil AND confirmedGraceUntil to avoid flickering
    //    during the window between server confirmation and CRDT propagation.
    const inGracePeriod = Date.now() < confirmedGraceUntil
    if (flag.state !== FlagState.Carried && pendingPickupUntil === 0 && !inGracePeriod) {
      if (cloneVisible) {
        console.log('[Flag] ⚠️ Safety net: hiding orphaned clone (flag not carried)')
        hideClone()
        hideAllShields()
      }
      if (flagVisualEntity) {
        if (!VisibilityComponent.has(flagVisualEntity)) {
          VisibilityComponent.create(flagVisualEntity, { visible: true })
        } else if (!VisibilityComponent.get(flagVisualEntity).visible) {
          VisibilityComponent.createOrReplace(flagVisualEntity, { visible: true })
        }
      }
    }

    prevFlagState = flag.state
    prevCarrierId = flag.carrierPlayerId
    break
  }

  const clampedDt = Math.min(dt, 0.1)

  // Update carried flag bob/spin (writes on Visual grandchild — safe from AvatarAttach race)
  updateCarryClonePosition(clampedDt)


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
      // Beacon particles float up from the carrier
      let carrierPos: Vector3 | null = null
      for (const [, identity, transform] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
        if (identity.address.toLowerCase() === flag.carrierPlayerId) {
          carrierPos = transform.position
          break
        }
      }
      if (carrierPos) {
        beaconSpawnAccum += clampedDt
        while (beaconSpawnAccum >= BEACON_SPAWN_INTERVAL) {
          beaconSpawnAccum -= BEACON_SPAWN_INTERVAL
          spawnBeaconPuff(carrierPos)
        }
      }
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