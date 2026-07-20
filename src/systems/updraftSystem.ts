/**
 * Updraft Smoke Stack System
 *
 * Server randomly selects one of 49 chimney locations every 60s.
 * Client renders a column of rising white orbs (beacon puff pattern)
 * and applies physics lift when the player holds space inside the column.
 */
import {
  engine,
  Entity,
  Transform,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  PhysicsCombinedForce,
  AudioSource,
  Physics,
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { room } from '../shared/messages'
import { registerThrottled, removeSystem } from './systemManager'

// ── Helpers ──────────────────────────────────────────────────
function isServerConnected(): boolean {
  try { return room != null && typeof room.send === 'function' } catch { return false }
}

// ── Chimney locations (49 rooftop positions) ─────────────────
const CHIMNEY_LOCATIONS: Vector3[] = [
  Vector3.create(378.896, 63.2, 356.691),
  Vector3.create(396.646, 63.278999999999996, 343.977),
  Vector3.create(404.53, 63.278999999999996, 350.463),
  Vector3.create(411.351, 63.278999999999996, 340.626),
  Vector3.create(396.628, 63.327, 360.668),
  Vector3.create(317, 68.25, 336.25),
  Vector3.create(318, 68.25, 358.75),
  Vector3.create(330, 68.25, 314.5),
  Vector3.create(338.75, 68.25, 326.75),
  Vector3.create(339.75, 68.25, 317.5),
  Vector3.create(357.879, 68.25, 330.5),
  Vector3.create(363.379, 68.25, 336.75),
  Vector3.create(366.629, 68.25, 339.5),
  Vector3.create(339.79499999999996, 68.28999999999999, 281.5),
  Vector3.create(341.54499999999996, 68.28999999999999, 278),
  Vector3.create(363.79499999999996, 68.28999999999999, 275.533),
  Vector3.create(365.29499999999996, 68.28999999999999, 259.899),
  Vector3.create(339.31399999999996, 68.309, 343.5),
  Vector3.create(374.347, 68.319, 368.191),
  Vector3.create(322.735, 73.208, 422.931),
  Vector3.create(332.235, 73.208, 419.931),
  Vector3.create(337.452, 73.208, 393.735),
  Vector3.create(342.43600000000004, 73.208, 422.822),
  Vector3.create(343.68600000000004, 73.208, 396.485),
  Vector3.create(360.43600000000004, 73.208, 395.985),
  Vector3.create(316.289, 73.261, 391.544),
  Vector3.create(380.916, 73.273, 304.033),
  Vector3.create(384.239, 73.273, 306.783),
  Vector3.create(329.727, 73.339, 324),
  Vector3.create(336.977, 73.339, 310.75),
  Vector3.create(346.748, 78.167, 361.959),
  Vector3.create(349.998, 78.167, 360.075),
  Vector3.create(319.289, 78.208, 404.044),
  Vector3.create(320.789, 78.208, 410.931),
  Vector3.create(356.664, 78.208, 421.804),
  Vector3.create(360.85400000000004, 78.208, 424.103),
  Vector3.create(363.27, 78.208, 407.985),
  Vector3.create(365.63800000000003, 78.208, 427.249),
  Vector3.create(372.403, 78.208, 434.999),
  Vector3.create(377.807, 78.208, 389.985),
  Vector3.create(396.714, 78.245, 431.078),
  Vector3.create(402.26, 78.245, 422.434),
  Vector3.create(371.153, 83.208, 419.749),
  Vector3.create(385.653, 83.208, 435.499),
  Vector3.create(330.702, 88.208, 374.235),
  Vector3.create(334.85699999999997, 88.208, 375.954),
  Vector3.create(381.996, 88.208, 418.552),
  Vector3.create(357.18399999999997, 88.21000000000001, 379.954),
  Vector3.create(370.006, 88.307, 378.691),
]

// ── Smoke orb configuration ─────────────────────────────────
const SMOKE_SPAWN_INTERVAL = 0.35  // seconds between spawns
const SMOKE_LIFETIME_MS    = 28000 // how long each orb lives
const SMOKE_FLOAT_HEIGHT   = 25    // meters orbs rise
const SMOKE_START_SCALE    = 1.0
const SMOKE_POOL_SIZE      = 170   // must be > LIFETIME / INTERVAL, x2 for two updrafts
const SMOKE_JITTER_XZ      = 0.5   // spawn scatter
const SMOKE_DRIFT_XZ       = 0.8   // horizontal drift while rising
const SMOKE_GROW_RATE      = 2.0   // scale added over full rise
const SMOKE_BASE_OFFSET    = 0     // height above chimney to spawn
const FADE_START           = 0.98  // fade out in final 2% of rise
const SMOKE_ALPHA_STEP     = 0.05  // quantize fade so material is only rewritten per visible step
const HIDDEN_POS = Vector3.create(0, -200, 0)

// Smoke emissive is halved on mobile to reduce brightness
let _smokeMaterial: Record<string, any> | null = null
let _mobileFlag: boolean | null = null

export function setSmokeMobileFlag(mobile: boolean) { _mobileFlag = mobile }

function getSmokeMaterial() {
  if (!_smokeMaterial) {
    const mobile = _mobileFlag === true
    _smokeMaterial = {
      albedoColor: Color4.create(1.0, 1.0, 1.0, 1.0),
      emissiveColor: mobile ? Color4.create(0.45, 0.45, 0.45, 1) : Color4.create(0.9, 0.9, 0.9, 1),
      emissiveIntensity: mobile ? 0.5 : 1.0,
      roughness: 1.0,
      metallic: 0.0,
      specularIntensity: 0.0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      castShadows: false,
    }
  }
  return _smokeMaterial
}

// ── Physics lift configuration ──────────────────────────────
const TRIGGER_RADIUS  = 2.5
const UPDRAFT_FORCE   = Vector3.create(0, 140, 0)  // continuous lift — must overpower gravity strongly
const UPDRAFT_KICK    = Vector3.create(0, 25, 0)   // snappy pop on entry

// ── Transition configuration ────────────────────────────────
const TRANSITION_DELAY = 1 // seconds to wait after drain completes

// ── Internal state (per-slot) ────────────────────────────────
const NUM_SLOTS = 2

interface SmokePuff {
  entity: Entity
  startPos: Vector3
  endPos: Vector3
  startScale: number
  spawnTime: number
  slot: number
  lastAlphaStep: number  // last quantized fade step written to the material (-1 = none yet)
}

interface UpdraftSlot {
  activeLocationIndex: number
  spawning: boolean
  smokeBasePos: Vector3
  pendingLocationIndex: number
  transitionTimer: number
  drainStartTime: number
  smokeSpawnAccum: number
  orbMinY: number
  orbMaxY: number
}

function createSlot(): UpdraftSlot {
  return {
    activeLocationIndex: -1,
    spawning: false,
    smokeBasePos: HIDDEN_POS,
    pendingLocationIndex: -1,
    transitionTimer: 0,
    drainStartTime: 0,
    smokeSpawnAccum: 0,
    orbMinY: 0,
    orbMaxY: 0,
  }
}

const slots: UpdraftSlot[] = []
for (let i = 0; i < NUM_SLOTS; i++) slots.push(createSlot())

const smokePool: Entity[] = []
const activeSmokePuffs: SmokePuff[] = []
let smokePoolIdx = 0

let forceActive = false

// ── Smoke pool ──────────────────────────────────────────────
function initSmokePool(): void {
  for (let i = 0; i < SMOKE_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, getSmokeMaterial())
    smokePool.push(e)
  }
}

function spawnSmokePuff(basePos: Vector3, slot: number): void {
  const puff = smokePool[smokePoolIdx % SMOKE_POOL_SIZE]
  smokePoolIdx++

  const jitteredPos = Vector3.create(
    basePos.x + (Math.random() - 0.5) * SMOKE_JITTER_XZ,
    basePos.y + Math.random() * 0.3,
    basePos.z + (Math.random() - 0.5) * SMOKE_JITTER_XZ,
  )
  const s = SMOKE_START_SCALE * (0.7 + Math.random() * 0.6)
  const endPos = Vector3.create(
    jitteredPos.x + (Math.random() - 0.5) * SMOKE_DRIFT_XZ,
    jitteredPos.y + SMOKE_FLOAT_HEIGHT,
    jitteredPos.z + (Math.random() - 0.5) * SMOKE_DRIFT_XZ,
  )

  const t = Transform.getMutable(puff)
  t.position = jitteredPos
  t.scale = Vector3.create(s, s, s)
  Material.setPbrMaterial(puff, getSmokeMaterial())

  activeSmokePuffs.push({ entity: puff, startPos: jitteredPos, endPos, startScale: s, spawnTime: Date.now(), slot, lastAlphaStep: -1 })
}

function hideSmokePuff(entity: Entity): void {
  const t = Transform.getMutable(entity)
  t.position = HIDDEN_POS
  t.scale = Vector3.Zero()
}

// When spawning stops, orbs drain top-down over this duration (ms)
const DRAIN_DURATION_MS = 12000

function animateSmokePuffs(): void {
  const now = Date.now()

  for (let i = activeSmokePuffs.length - 1; i >= 0; i--) {
    const sp = activeSmokePuffs[i]
    const sl = slots[sp.slot]
    const draining = !sl.spawning && sl.drainStartTime > 0
    const progress = Math.min(1, (now - sp.spawnTime) / SMOKE_LIFETIME_MS)

    let effectiveProgress = progress
    if (draining) {
      const drainElapsed = now - sl.drainStartTime
      const drainT = Math.min(1, drainElapsed / DRAIN_DURATION_MS)
      const killThreshold = 1.0 - drainT
      if (progress >= killThreshold) {
        effectiveProgress = 1.0
      }
    }

    if (effectiveProgress >= 1) {
      hideSmokePuff(sp.entity)
      activeSmokePuffs.splice(i, 1)
      continue
    }

    const easedPos = 1 - Math.pow(1 - progress, 2)
    const t = Transform.getMutable(sp.entity)
    t.position = Vector3.lerp(sp.startPos, sp.endPos, easedPos)

    const scale = sp.startScale + progress * SMOKE_GROW_RATE
    t.scale = Vector3.create(scale, scale, scale)

    let alpha = 1.0
    if (draining) {
      const drainElapsed = now - sl.drainStartTime
      const drainT = Math.min(1, drainElapsed / DRAIN_DURATION_MS)
      const killThreshold = 1.0 - drainT
      const fadeZone = 0.15
      if (progress >= killThreshold - fadeZone) {
        alpha = Math.max(0, (killThreshold - progress) / fadeZone)
      }
    }
    if (progress > FADE_START) {
      alpha = Math.min(alpha, 1.0 - (progress - FADE_START) / (1 - FADE_START))
    }

    if (alpha < 1.0) {
      // Quantize the fade to SMOKE_ALPHA_STEP so the material is only rewritten
      // when it visibly changes. Calling Material.setPbrMaterial every frame across
      // hundreds of puffs is the per-frame material-churn pattern that breaks the
      // renderer.
      const alphaStep = Math.round(alpha / SMOKE_ALPHA_STEP)
      if (alphaStep !== sp.lastAlphaStep) {
        sp.lastAlphaStep = alphaStep
        Material.setPbrMaterial(sp.entity, { ...getSmokeMaterial(), albedoColor: Color4.create(1, 1, 1, alpha) })
      }
    }
  }
}

// ── Swoosh sound ────────────────────────────────────────────
let swooshSoundEntity: Entity | null = null

function playSwooshSound(): void {
  if (!swooshSoundEntity) {
    swooshSoundEntity = engine.addEntity()
    Transform.create(swooshSoundEntity, { position: Vector3.create(0, 0, 0) })
    AudioSource.create(swooshSoundEntity, {
      audioClipUrl: 'assets/sounds/swoosh.mp3',
      playing: false,
      loop: false,
      volume: 1.0,
      global: true
    })
  }
  AudioSource.createOrReplace(swooshSoundEntity, { audioClipUrl: 'assets/sounds/swoosh.mp3', playing: true, loop: false, volume: 1, global: true })
}

// ── Physics lift ────────────────────────────────────────────
function activateForce(): void {
  if (forceActive) return
  forceActive = true
  playSwooshSound()
  // Continuous lift is a *sustained* force, so it must be a persistent
  // PhysicsCombinedForce component (there is no impulse-helper equivalent for a
  // held force). It is cleared again in deactivateForce() via
  // PhysicsCombinedForce.deleteFrom. Leave this direct write as-is — changing it to
  // route through a Physics helper needs care (the helper models one-shot impulses,
  // not a held force) and could reintroduce the knockback-throw described below.
  PhysicsCombinedForce.createOrReplace(engine.PlayerEntity, { vector: UPDRAFT_FORCE })
  // The one-shot entry kick DOES go through the SDK Physics helper so its eventId is
  // coordinated with bomb knockback etc. A direct createOrReplace here previously
  // caused Physics.applyKnockbackToPlayer to throw on later bomb hits
  // ("modified outside Physics helper").
  Physics.applyImpulseToPlayer(UPDRAFT_KICK)
}

function deactivateForce(): void {
  if (!forceActive) return
  forceActive = false
  PhysicsCombinedForce.deleteFrom(engine.PlayerEntity)
}

function computeOrbBounds(): void {
  // Reset all slot bounds
  for (const sl of slots) { sl.orbMinY = Infinity; sl.orbMaxY = -Infinity }
  for (const sp of activeSmokePuffs) {
    const y = Transform.get(sp.entity).position.y
    if (y < -100) continue
    const sl = slots[sp.slot]
    if (y < sl.orbMinY) sl.orbMinY = y
    if (y > sl.orbMaxY) sl.orbMaxY = y
  }
  for (const sl of slots) {
    if (sl.orbMinY === Infinity) { sl.orbMinY = 0; sl.orbMaxY = 0 }
  }
}

function updateLift(): void {
  if (!Transform.has(engine.PlayerEntity)) { deactivateForce(); return }
  const p = Transform.get(engine.PlayerEntity).position
  // Check if player is inside ANY active updraft column
  for (const sl of slots) {
    if (sl.activeLocationIndex < 0 || sl.orbMaxY <= sl.orbMinY) continue
    const loc = CHIMNEY_LOCATIONS[sl.activeLocationIndex]
    const dx = p.x - loc.x
    const dz = p.z - loc.z
    const inRadius = dx * dx + dz * dz <= TRIGGER_RADIUS * TRIGGER_RADIUS
    const inHeight = p.y >= sl.orbMinY - 2 && p.y <= sl.orbMaxY + 2
    if (inRadius && inHeight) {
      activateForce()
      return
    }
  }
  deactivateForce()
}

// ── Transition handling ─────────────────────────────────────
function switchSlotToChimney(sl: UpdraftSlot, idx: number): void {
  sl.activeLocationIndex = idx
  const loc = CHIMNEY_LOCATIONS[idx]
  sl.smokeBasePos = Vector3.create(loc.x, loc.y + SMOKE_BASE_OFFSET, loc.z)
  sl.smokeSpawnAccum = 0
  sl.spawning = true
  sl.drainStartTime = 0
  console.log(`[Updraft] Slot active chimney ${idx}`)
}

function updateTransitions(dt: number): void {
  for (const sl of slots) {
    if (sl.pendingLocationIndex < 0) continue
    sl.transitionTimer += dt
    const totalWait = DRAIN_DURATION_MS / 1000 + TRANSITION_DELAY
    if (sl.transitionTimer >= totalWait) {
      switchSlotToChimney(sl, sl.pendingLocationIndex)
      sl.pendingLocationIndex = -1
    }
  }
}

// ── Public API ──────────────────────────────────────────────
export function setupUpdraftSystem(): void {
  initSmokePool()

  room.onMessage('updraftLocation', (data) => {
    const idx = data.index as number
    const slotIdx = (data.slot as number) ?? 0
    const sl = slots[slotIdx] || slots[0]

    if (idx < 0 || idx >= CHIMNEY_LOCATIONS.length) {
      sl.activeLocationIndex = -1
      sl.spawning = false
      return
    }

    if (sl.activeLocationIndex < 0) {
      switchSlotToChimney(sl, idx)
    } else {
      sl.spawning = false
      sl.drainStartTime = Date.now()
      sl.pendingLocationIndex = idx
      sl.transitionTimer = 0
      console.log(`[Updraft] Slot ${slotIdx} transitioning from chimney ${sl.activeLocationIndex} to ${idx}`)
    }
  })

  // Wait for server connection before requesting initial locations
  let requested = false
  const updraftInitCheck = (_dt: number) => {
    if (requested) { removeSystem(updraftInitCheck); return }
    if (isServerConnected()) {
      requested = true
      room.send('requestUpdraftLocation', { t: 0 })
      removeSystem(updraftInitCheck)
    }
  }
  registerThrottled(updraftInitCheck, 1.0)
}

export function updraftSystem(dt: number): void {
  animateSmokePuffs()
  computeOrbBounds()
  updateTransitions(dt)
  updateLift()

  for (let s = 0; s < NUM_SLOTS; s++) {
    const sl = slots[s]
    if (sl.spawning) {
      sl.smokeSpawnAccum += dt
      while (sl.smokeSpawnAccum >= SMOKE_SPAWN_INTERVAL) {
        sl.smokeSpawnAccum -= SMOKE_SPAWN_INTERVAL
        spawnSmokePuff(sl.smokeBasePos, s)
      }
    }
  }
}
