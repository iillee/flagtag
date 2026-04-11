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
  AudioSource,
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
  Vector3.create(256.896, 15.200, 262.691),
  Vector3.create(274.646, 15.279, 249.977),
  Vector3.create(282.530, 15.279, 256.463),
  Vector3.create(289.351, 15.279, 246.626),
  Vector3.create(274.628, 15.327, 266.668),
  Vector3.create(195.000, 20.250, 242.250),
  Vector3.create(196.000, 20.250, 264.750),
  Vector3.create(208.000, 20.250, 220.500),
  Vector3.create(216.750, 20.250, 232.750),
  Vector3.create(217.750, 20.250, 223.500),
  Vector3.create(235.879, 20.250, 236.500),
  Vector3.create(241.379, 20.250, 242.750),
  Vector3.create(244.629, 20.250, 245.500),
  Vector3.create(217.795, 20.290, 187.500),
  Vector3.create(219.545, 20.290, 184.000),
  Vector3.create(241.795, 20.290, 181.533),
  Vector3.create(243.295, 20.290, 165.899),
  Vector3.create(217.314, 20.309, 249.500),
  Vector3.create(252.347, 20.319, 274.191),
  Vector3.create(200.735, 25.208, 328.931),
  Vector3.create(210.235, 25.208, 325.931),
  Vector3.create(215.452, 25.208, 299.735),
  Vector3.create(220.436, 25.208, 328.822),
  Vector3.create(221.686, 25.208, 302.485),
  Vector3.create(238.436, 25.208, 301.985),
  Vector3.create(194.289, 25.261, 297.544),
  Vector3.create(258.916, 25.273, 210.033),
  Vector3.create(262.239, 25.273, 212.783),
  Vector3.create(207.727, 25.339, 230.000),
  Vector3.create(214.977, 25.339, 216.750),
  Vector3.create(224.748, 30.167, 267.959),
  Vector3.create(227.998, 30.167, 266.075),
  Vector3.create(197.289, 30.208, 310.044),
  Vector3.create(198.789, 30.208, 316.931),
  Vector3.create(234.664, 30.208, 327.804),
  Vector3.create(238.854, 30.208, 330.103),
  Vector3.create(241.270, 30.208, 313.985),
  Vector3.create(243.638, 30.208, 333.249),
  Vector3.create(250.403, 30.208, 340.999),
  Vector3.create(255.807, 30.208, 295.985),
  Vector3.create(274.714, 30.245, 337.078),
  Vector3.create(280.260, 30.245, 328.434),
  Vector3.create(249.153, 35.208, 325.749),
  Vector3.create(263.653, 35.208, 341.499),
  Vector3.create(208.702, 40.208, 280.235),
  Vector3.create(212.857, 40.208, 281.954),
  Vector3.create(259.996, 40.208, 324.552),
  Vector3.create(235.184, 40.210, 285.954),
  Vector3.create(248.006, 40.307, 284.691),
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
const UPDRAFT_FORCE   = Vector3.create(0, 40, 0)
const UPDRAFT_KICK    = Vector3.create(0, 10, 0)

// ── Transition configuration ────────────────────────────────
const TRANSITION_DELAY = 1 // seconds to wait after drain completes

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
let drainStartTime = 0  // when spawning stopped, for top-down fade

let forceActive = false
let impulseEventId = 0



// ── Debug cylinder (visible trigger zone) ───────────────────
let debugCylinder: Entity | null = null
function ensureDebugCylinder(): Entity {
  if (debugCylinder == null) {
    debugCylinder = engine.addEntity()
    Transform.create(debugCylinder, { position: HIDDEN_POS, scale: Vector3.create(TRIGGER_RADIUS * 2, TRIGGER_HEIGHT, TRIGGER_RADIUS * 2) })
  }
  return debugCylinder
}
function updateDebugCylinder(): void {
  const cyl = ensureDebugCylinder()
  if (activeLocationIndex < 0) {
    Transform.getMutable(cyl).position = HIDDEN_POS
    return
  }
  const loc = CHIMNEY_LOCATIONS[activeLocationIndex]
  const t = Transform.getMutable(cyl)
  // Cylinder mesh is 1m tall centered at origin, so scale Y = height, position Y = base + height/2
  t.position = Vector3.create(loc.x, loc.y + TRIGGER_HEIGHT / 2, loc.z)
  t.scale = Vector3.create(TRIGGER_RADIUS * 2, TRIGGER_HEIGHT, TRIGGER_RADIUS * 2)
}

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

// When spawning stops, orbs drain top-down over this duration (ms)
const DRAIN_DURATION_MS = 12000

function animateSmokePuffs(): void {
  const now = Date.now()
  const draining = !spawning && drainStartTime > 0

  for (let i = activeSmokePuffs.length - 1; i >= 0; i--) {
    const sp = activeSmokePuffs[i]
    const progress = Math.min(1, (now - sp.spawnTime) / SMOKE_LIFETIME_MS)

    // When draining, kill orbs top-down: higher progress = die sooner
    let effectiveProgress = progress
    if (draining) {
      const drainElapsed = now - drainStartTime
      // Orbs with high progress (near top) get pushed to 1.0 first
      // drainT goes 0→1 over DRAIN_DURATION_MS
      const drainT = Math.min(1, drainElapsed / DRAIN_DURATION_MS)
      // Threshold rises from 1.0 down to 0.0 — orbs above threshold die
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

    // Rapid fade at the top (normal lifetime) or when draining
    let alpha = 1.0
    if (draining) {
      const drainElapsed = now - drainStartTime
      const drainT = Math.min(1, drainElapsed / DRAIN_DURATION_MS)
      const killThreshold = 1.0 - drainT
      // Fade orbs approaching the kill threshold
      const fadeZone = 0.15
      if (progress >= killThreshold - fadeZone) {
        alpha = Math.max(0, (killThreshold - progress) / fadeZone)
      }
    }
    if (progress > FADE_START) {
      alpha = Math.min(alpha, 1.0 - (progress - FADE_START) / (1 - FADE_START))
    }

    if (alpha < 1.0) {
      Material.setPbrMaterial(sp.entity, { ...SMOKE_MATERIAL, albedoColor: Color4.create(1, 1, 1, alpha) })
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
  const a = AudioSource.getMutable(swooshSoundEntity)
  a.playing = false
  a.currentTime = 0
  a.playing = true
}

// ── Physics lift ────────────────────────────────────────────
function activateForce(): void {
  if (forceActive) return
  forceActive = true
  playSwooshSound()
  PhysicsCombinedForce.createOrReplace(engine.PlayerEntity, { vector: UPDRAFT_FORCE })
  impulseEventId++
  PhysicsCombinedImpulse.createOrReplace(engine.PlayerEntity, { vector: UPDRAFT_KICK, eventId: impulseEventId })
}

function deactivateForce(): void {
  if (!forceActive) return
  forceActive = false
  PhysicsCombinedForce.deleteFrom(engine.PlayerEntity)
}

// Track the Y range of active orbs for dynamic trigger bounds
let orbMinY = 0
let orbMaxY = 0

function computeOrbBounds(): void {
  if (activeSmokePuffs.length === 0) {
    orbMinY = 0
    orbMaxY = 0
    return
  }
  let minY = Infinity
  let maxY = -Infinity
  for (const sp of activeSmokePuffs) {
    const y = Transform.get(sp.entity).position.y
    if (y < -100) continue // skip hidden puffs
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  orbMinY = minY === Infinity ? 0 : minY
  orbMaxY = maxY === -Infinity ? 0 : maxY
}

function updateLift(): void {
  if (activeLocationIndex < 0 || !Transform.has(engine.PlayerEntity) || orbMaxY <= orbMinY) {
    deactivateForce()
    return
  }

  const loc = CHIMNEY_LOCATIONS[activeLocationIndex]
  const p = Transform.get(engine.PlayerEntity).position
  const dx = p.x - loc.x
  const dz = p.z - loc.z
  const inRadius = dx * dx + dz * dz <= TRIGGER_RADIUS * TRIGGER_RADIUS
  const inHeight = p.y >= orbMinY - 2 && p.y <= orbMaxY + 2

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
  drainStartTime = 0
  console.log(`[Updraft] Active chimney ${idx}`)
}

function updateTransition(dt: number): void {
  if (pendingLocationIndex < 0) return

  transitionTimer += dt
  const totalWait = DRAIN_DURATION_MS / 1000 + TRANSITION_DELAY
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
      drainStartTime = Date.now()
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
  computeOrbBounds()
  updateTransition(dt)
  updateLift()
  updateDebugCylinder()

  if (spawning) {
    smokeSpawnAccum += dt
    while (smokeSpawnAccum >= SMOKE_SPAWN_INTERVAL) {
      smokeSpawnAccum -= SMOKE_SPAWN_INTERVAL
      spawnSmokePuff(smokeBasePos)
    }
  }
}
