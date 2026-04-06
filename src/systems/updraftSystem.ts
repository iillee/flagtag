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
  PhysicsCombinedImpulse,
  inputSystem,
  InputAction,
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { room } from '../shared/messages'

// ── Helpers ──────────────────────────────────────────────────
function isServerConnected(): boolean {
  try { return room != null && typeof room.send === 'function' } catch { return false }
}

// ── Chimney locations (49 rooftop positions) ─────────────────
const CHIMNEY_LOCATIONS: Vector3[] = [
  Vector3.create(80.896, 14.200, 126.691),
  Vector3.create(98.646, 14.279, 113.977),
  Vector3.create(106.530, 14.279, 120.463),
  Vector3.create(113.351, 14.279, 110.626),
  Vector3.create(98.628, 14.327, 130.668),
  Vector3.create(19.000, 19.250, 106.250),
  Vector3.create(20.000, 19.250, 128.750),
  Vector3.create(32.000, 19.250, 84.500),
  Vector3.create(40.750, 19.250, 96.750),
  Vector3.create(41.750, 19.250, 87.500),
  Vector3.create(59.879, 19.250, 100.500),
  Vector3.create(65.379, 19.250, 106.750),
  Vector3.create(68.629, 19.250, 109.500),
  Vector3.create(41.795, 19.290, 51.500),
  Vector3.create(43.545, 19.290, 48.000),
  Vector3.create(65.795, 19.290, 45.533),
  Vector3.create(67.295, 19.290, 29.899),
  Vector3.create(41.314, 19.309, 113.500),
  Vector3.create(76.347, 19.319, 138.191),
  Vector3.create(24.735, 24.208, 192.931),
  Vector3.create(34.235, 24.208, 189.931),
  Vector3.create(39.452, 24.208, 163.735),
  Vector3.create(44.436, 24.208, 192.822),
  Vector3.create(45.686, 24.208, 166.485),
  Vector3.create(62.436, 24.208, 165.985),
  Vector3.create(18.289, 24.261, 161.544),
  Vector3.create(82.916, 24.273, 74.033),
  Vector3.create(86.239, 24.273, 76.783),
  Vector3.create(31.727, 24.339, 94.000),
  Vector3.create(38.977, 24.339, 80.750),
  Vector3.create(48.748, 29.167, 131.959),
  Vector3.create(51.998, 29.167, 130.075),
  Vector3.create(21.289, 29.208, 174.044),
  Vector3.create(22.789, 29.208, 180.931),
  Vector3.create(58.664, 29.208, 191.804),
  Vector3.create(62.854, 29.208, 194.103),
  Vector3.create(65.270, 29.208, 177.985),
  Vector3.create(67.638, 29.208, 197.249),
  Vector3.create(74.403, 29.208, 204.999),
  Vector3.create(79.807, 29.208, 159.985),
  Vector3.create(98.714, 29.245, 201.078),
  Vector3.create(104.260, 29.245, 192.434),
  Vector3.create(73.153, 34.208, 189.749),
  Vector3.create(87.653, 34.208, 205.499),
  Vector3.create(32.702, 39.208, 144.235),
  Vector3.create(36.857, 39.208, 145.954),
  Vector3.create(83.996, 39.208, 188.552),
  Vector3.create(59.184, 39.210, 149.954),
  Vector3.create(72.006, 39.307, 148.691),
]

// ── Smoke orb configuration ─────────────────────────────────
const SMOKE_SPAWN_INTERVAL = 0.35  // seconds between spawns
const SMOKE_LIFETIME_MS    = 28000 // how long each orb lives
const SMOKE_FLOAT_HEIGHT   = 25    // meters orbs rise
const SMOKE_START_SCALE    = 1.0
const SMOKE_POOL_SIZE      = 85    // must be > LIFETIME / INTERVAL
const SMOKE_JITTER_XZ      = 0.5   // spawn scatter
const SMOKE_DRIFT_XZ       = 0.8   // horizontal drift while rising
const SMOKE_GROW_RATE      = 2.0   // scale added over full rise
const SMOKE_BASE_OFFSET    = 0     // height above chimney to spawn
const FADE_START           = 0.98  // fade out in final 2% of rise
const HIDDEN_POS = Vector3.create(0, -200, 0)

const SMOKE_MATERIAL = {
  albedoColor: Color4.create(1.0, 1.0, 1.0, 1.0),
  emissiveColor: Color4.create(0.9, 0.9, 0.9, 1),
  emissiveIntensity: 1.0,
  roughness: 1.0,
  metallic: 0.0,
  specularIntensity: 0.0,
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
  castShadows: false,
}

// ── Physics lift configuration ──────────────────────────────
const TRIGGER_RADIUS  = 2.5
const TRIGGER_HEIGHT  = 30
const UPDRAFT_FORCE   = Vector3.create(0, 60, 0)
const UPDRAFT_KICK    = Vector3.create(0, 15, 0)

// ── Transition configuration ────────────────────────────────
const TRANSITION_DELAY = 5 // seconds to wait after last orb fades

// ── Internal state ──────────────────────────────────────────
interface SmokePuff {
  entity: Entity
  startPos: Vector3
  endPos: Vector3
  startScale: number
  spawnTime: number
}

const smokePool: Entity[] = []
const activeSmokePuffs: SmokePuff[] = []
let smokePoolIdx = 0
let smokeSpawnAccum = 0

let activeLocationIndex = -1
let spawning = false
let smokeBasePos = HIDDEN_POS

let pendingLocationIndex = -1
let transitionTimer = 0

let forceActive = false
let impulseEventId = 0

// ── Smoke pool ──────────────────────────────────────────────
function initSmokePool(): void {
  for (let i = 0; i < SMOKE_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, SMOKE_MATERIAL)
    smokePool.push(e)
  }
}

function spawnSmokePuff(basePos: Vector3): void {
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
  Material.setPbrMaterial(puff, SMOKE_MATERIAL)

  activeSmokePuffs.push({ entity: puff, startPos: jitteredPos, endPos, startScale: s, spawnTime: Date.now() })
}

function hideSmokePuff(entity: Entity): void {
  const t = Transform.getMutable(entity)
  t.position = HIDDEN_POS
  t.scale = Vector3.Zero()
}

function animateSmokePuffs(): void {
  const now = Date.now()
  for (let i = activeSmokePuffs.length - 1; i >= 0; i--) {
    const sp = activeSmokePuffs[i]
    const progress = Math.min(1, (now - sp.spawnTime) / SMOKE_LIFETIME_MS)

    if (progress >= 1) {
      hideSmokePuff(sp.entity)
      activeSmokePuffs.splice(i, 1)
      continue
    }

    const easedPos = 1 - Math.pow(1 - progress, 2)
    const t = Transform.getMutable(sp.entity)
    t.position = Vector3.lerp(sp.startPos, sp.endPos, easedPos)

    const scale = sp.startScale + progress * SMOKE_GROW_RATE
    t.scale = Vector3.create(scale, scale, scale)

    // Rapid fade at the top
    if (progress > FADE_START) {
      const alpha = 1.0 - (progress - FADE_START) / (1 - FADE_START)
      Material.setPbrMaterial(sp.entity, { ...SMOKE_MATERIAL, albedoColor: Color4.create(1, 1, 1, alpha) })
    }
  }
}

// ── Physics lift ────────────────────────────────────────────
function activateForce(): void {
  if (forceActive) return
  forceActive = true
  PhysicsCombinedForce.createOrReplace(engine.PlayerEntity, { vector: UPDRAFT_FORCE })
  impulseEventId++
  PhysicsCombinedImpulse.createOrReplace(engine.PlayerEntity, { vector: UPDRAFT_KICK, eventId: impulseEventId })
}

function deactivateForce(): void {
  if (!forceActive) return
  forceActive = false
  PhysicsCombinedForce.deleteFrom(engine.PlayerEntity)
}

function updateLift(): void {
  if (activeLocationIndex < 0 || !Transform.has(engine.PlayerEntity)) {
    deactivateForce()
    return
  }

  const loc = CHIMNEY_LOCATIONS[activeLocationIndex]
  const p = Transform.get(engine.PlayerEntity).position
  const dx = p.x - loc.x
  const dz = p.z - loc.z
  const inRadius = dx * dx + dz * dz <= TRIGGER_RADIUS * TRIGGER_RADIUS
  const inHeight = p.y >= loc.y - 2 && p.y <= loc.y + TRIGGER_HEIGHT

  if (inRadius && inHeight && inputSystem.isPressed(InputAction.IA_JUMP)) {
    activateForce()
  } else {
    deactivateForce()
  }
}

// ── Transition handling ─────────────────────────────────────
function switchToChimney(idx: number): void {
  activeLocationIndex = idx
  const loc = CHIMNEY_LOCATIONS[idx]
  smokeBasePos = Vector3.create(loc.x, loc.y + SMOKE_BASE_OFFSET, loc.z)
  smokeSpawnAccum = 0
  spawning = true
  console.log(`[Updraft] Active chimney ${idx}`)
}

function updateTransition(dt: number): void {
  if (pendingLocationIndex < 0) return

  transitionTimer += dt
  const totalWait = SMOKE_LIFETIME_MS / 1000 + TRANSITION_DELAY
  if (transitionTimer >= totalWait) {
    switchToChimney(pendingLocationIndex)
    pendingLocationIndex = -1
  }
}

// ── Public API ──────────────────────────────────────────────
export function setupUpdraftSystem(): void {
  initSmokePool()

  room.onMessage('updraftLocation', (data) => {
    const idx = data.index as number
    if (idx < 0 || idx >= CHIMNEY_LOCATIONS.length) {
      activeLocationIndex = -1
      spawning = false
      return
    }

    if (activeLocationIndex < 0) {
      switchToChimney(idx)
    } else {
      spawning = false
      pendingLocationIndex = idx
      transitionTimer = 0
      console.log(`[Updraft] Transitioning from chimney ${activeLocationIndex} to ${idx}`)
    }
  })

  // Wait for server connection before requesting initial location
  let requested = false
  engine.addSystem(() => {
    if (!requested && isServerConnected()) {
      requested = true
      room.send('requestUpdraftLocation', { t: 0 })
    }
  })
}

export function updraftSystem(dt: number): void {
  animateSmokePuffs()
  updateTransition(dt)
  updateLift()

  if (spawning) {
    smokeSpawnAccum += dt
    while (smokeSpawnAccum >= SMOKE_SPAWN_INTERVAL) {
      smokeSpawnAccum -= SMOKE_SPAWN_INTERVAL
      spawnSmokePuff(smokeBasePos)
    }
  }
}
