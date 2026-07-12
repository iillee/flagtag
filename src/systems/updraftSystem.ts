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
  Vector3.create(426.896, 15.2, 404.691),
  Vector3.create(444.646, 15.279, 391.977),
  Vector3.create(452.53, 15.279, 398.463),
  Vector3.create(459.351, 15.279, 388.626),
  Vector3.create(444.628, 15.327, 408.668),
  Vector3.create(365, 20.25, 384.25),
  Vector3.create(366, 20.25, 406.75),
  Vector3.create(378, 20.25, 362.5),
  Vector3.create(386.75, 20.25, 374.75),
  Vector3.create(387.75, 20.25, 365.5),
  Vector3.create(405.879, 20.25, 378.5),
  Vector3.create(411.379, 20.25, 384.75),
  Vector3.create(414.629, 20.25, 387.5),
  Vector3.create(387.79499999999996, 20.29, 329.5),
  Vector3.create(389.54499999999996, 20.29, 326),
  Vector3.create(411.79499999999996, 20.29, 323.533),
  Vector3.create(413.29499999999996, 20.29, 307.899),
  Vector3.create(387.31399999999996, 20.309, 391.5),
  Vector3.create(422.347, 20.319, 416.191),
  Vector3.create(370.735, 25.208, 470.931),
  Vector3.create(380.235, 25.208, 467.931),
  Vector3.create(385.452, 25.208, 441.735),
  Vector3.create(390.43600000000004, 25.208, 470.822),
  Vector3.create(391.68600000000004, 25.208, 444.485),
  Vector3.create(408.43600000000004, 25.208, 443.985),
  Vector3.create(364.289, 25.261, 439.544),
  Vector3.create(428.916, 25.273, 352.033),
  Vector3.create(432.239, 25.273, 354.783),
  Vector3.create(377.727, 25.339, 372),
  Vector3.create(384.977, 25.339, 358.75),
  Vector3.create(394.748, 30.167, 409.959),
  Vector3.create(397.998, 30.167, 408.075),
  Vector3.create(367.289, 30.208, 452.044),
  Vector3.create(368.789, 30.208, 458.931),
  Vector3.create(404.664, 30.208, 469.804),
  Vector3.create(408.85400000000004, 30.208, 472.103),
  Vector3.create(411.27, 30.208, 455.985),
  Vector3.create(413.63800000000003, 30.208, 475.249),
  Vector3.create(420.403, 30.208, 482.999),
  Vector3.create(425.807, 30.208, 437.985),
  Vector3.create(444.714, 30.245, 479.078),
  Vector3.create(450.26, 30.245, 470.434),
  Vector3.create(419.153, 35.208, 467.749),
  Vector3.create(433.653, 35.208, 483.499),
  Vector3.create(378.702, 40.208, 422.235),
  Vector3.create(382.85699999999997, 40.208, 423.954),
  Vector3.create(429.996, 40.208, 466.552),
  Vector3.create(405.18399999999997, 40.21, 427.954),
  Vector3.create(418.006, 40.307, 426.691),
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
const TRIGGER_HEIGHT  = 30
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

// ── Debug cylinders (visible trigger zone) ──────────────────
const debugCylinders: (Entity | null)[] = [null, null]
function ensureDebugCylinder(slot: number): Entity {
  if (debugCylinders[slot] == null) {
    debugCylinders[slot] = engine.addEntity()
    Transform.create(debugCylinders[slot]!, { position: HIDDEN_POS, scale: Vector3.create(TRIGGER_RADIUS * 2, TRIGGER_HEIGHT, TRIGGER_RADIUS * 2) })
  }
  return debugCylinders[slot]!
}
function updateDebugCylinders(): void {
  for (let s = 0; s < NUM_SLOTS; s++) {
    const cyl = ensureDebugCylinder(s)
    const sl = slots[s]
    if (sl.activeLocationIndex < 0) {
      Transform.getMutable(cyl).position = HIDDEN_POS
      continue
    }
    const loc = CHIMNEY_LOCATIONS[sl.activeLocationIndex]
    const t = Transform.getMutable(cyl)
    t.position = Vector3.create(loc.x, loc.y + TRIGGER_HEIGHT / 2, loc.z)
    t.scale = Vector3.create(TRIGGER_RADIUS * 2, TRIGGER_HEIGHT, TRIGGER_RADIUS * 2)
  }
}

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

  activeSmokePuffs.push({ entity: puff, startPos: jitteredPos, endPos, startScale: s, spawnTime: Date.now(), slot })
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
      Material.setPbrMaterial(sp.entity, { ...getSmokeMaterial(), albedoColor: Color4.create(1, 1, 1, alpha) })
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
  PhysicsCombinedForce.createOrReplace(engine.PlayerEntity, { vector: UPDRAFT_FORCE })
  // Use SDK Physics helper so the eventId is coordinated with bomb knockback etc.
  // Direct createOrReplace here caused Physics.applyKnockbackToPlayer to throw on
  // subsequent bomb hits ("modified outside Physics helper").
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
  updateDebugCylinders()

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
