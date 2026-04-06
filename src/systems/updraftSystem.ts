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

function isServerConnected(): boolean {
  try { return room != null && typeof room.send === 'function' } catch { return false }
}

// ── Chimney locations (all 49 green cube markers) ──
const CHIMNEY_LOCATIONS: { x: number; y: number; z: number }[] = [
  { x: 80.896, y: 14.200, z: 126.691 },
  { x: 98.646, y: 14.279, z: 113.977 },
  { x: 106.530, y: 14.279, z: 120.463 },
  { x: 113.351, y: 14.279, z: 110.626 },
  { x: 98.628, y: 14.327, z: 130.668 },
  { x: 19.000, y: 19.250, z: 106.250 },
  { x: 20.000, y: 19.250, z: 128.750 },
  { x: 32.000, y: 19.250, z: 84.500 },
  { x: 40.750, y: 19.250, z: 96.750 },
  { x: 41.750, y: 19.250, z: 87.500 },
  { x: 59.879, y: 19.250, z: 100.500 },
  { x: 65.379, y: 19.250, z: 106.750 },
  { x: 68.629, y: 19.250, z: 109.500 },
  { x: 41.795, y: 19.290, z: 51.500 },
  { x: 43.545, y: 19.290, z: 48.000 },
  { x: 65.795, y: 19.290, z: 45.533 },
  { x: 67.295, y: 19.290, z: 29.899 },
  { x: 41.314, y: 19.309, z: 113.500 },
  { x: 76.347, y: 19.319, z: 138.191 },
  { x: 24.735, y: 24.208, z: 192.931 },
  { x: 34.235, y: 24.208, z: 189.931 },
  { x: 39.452, y: 24.208, z: 163.735 },
  { x: 44.436, y: 24.208, z: 192.822 },
  { x: 45.686, y: 24.208, z: 166.485 },
  { x: 62.436, y: 24.208, z: 165.985 },
  { x: 18.289, y: 24.261, z: 161.544 },
  { x: 82.916, y: 24.273, z: 74.033 },
  { x: 86.239, y: 24.273, z: 76.783 },
  { x: 31.727, y: 24.339, z: 94.000 },
  { x: 38.977, y: 24.339, z: 80.750 },
  { x: 48.748, y: 29.167, z: 131.959 },
  { x: 51.998, y: 29.167, z: 130.075 },
  { x: 21.289, y: 29.208, z: 174.044 },
  { x: 22.789, y: 29.208, z: 180.931 },
  { x: 58.664, y: 29.208, z: 191.804 },
  { x: 62.854, y: 29.208, z: 194.103 },
  { x: 65.270, y: 29.208, z: 177.985 },
  { x: 67.638, y: 29.208, z: 197.249 },
  { x: 74.403, y: 29.208, z: 204.999 },
  { x: 79.807, y: 29.208, z: 159.985 },
  { x: 98.714, y: 29.245, z: 201.078 },
  { x: 104.260, y: 29.245, z: 192.434 },
  { x: 73.153, y: 34.208, z: 189.749 },
  { x: 87.653, y: 34.208, z: 205.499 },
  { x: 32.702, y: 39.208, z: 144.235 },
  { x: 36.857, y: 39.208, z: 145.954 },
  { x: 83.996, y: 39.208, z: 188.552 },
  { x: 59.184, y: 39.210, z: 149.954 },
  { x: 72.006, y: 39.307, z: 148.691 },
]

// ══════════════════════════════════════════════════════════════
// Smoke visual — same pattern as beacon puffs in flagSystem.ts
// ══════════════════════════════════════════════════════════════
const SMOKE_SPAWN_INTERVAL = 0.35
const SMOKE_LIFETIME_MS = 28000
const SMOKE_FLOAT_HEIGHT = 25
const SMOKE_START_SCALE = 1.0
const SMOKE_POOL_SIZE = 85
const SMOKE_JITTER_XZ = 0.5
const SMOKE_DRIFT_XZ = 0.8
const SMOKE_BASE_OFFSET = 0
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
const FADE_START = 0.98  // start fading at 98% of lifetime (~0.56s fade)

const smokePool: Entity[] = []
let smokePoolIdx = 0
let smokePoolReady = false
let smokeSpawnAccum = 0

interface SmokePuff {
  entity: Entity
  startPos: Vector3
  endPos: Vector3
  startScale: number
  spawnTime: number
}
const activeSmokePuffs: SmokePuff[] = []

function initSmokePool(): void {
  if (smokePoolReady) return
  smokePoolReady = true
  for (let i = 0; i < SMOKE_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, SMOKE_MATERIAL)
    smokePool.push(e)
  }
}

function spawnSmokePuff(basePos: Vector3): void {
  initSmokePool()
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
    jitteredPos.z + (Math.random() - 0.5) * SMOKE_DRIFT_XZ
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
    const elapsed = now - sp.spawnTime
    const progress = Math.min(1, elapsed / SMOKE_LIFETIME_MS)
    if (progress >= 1) {
      hideSmokePuff(sp.entity)
      activeSmokePuffs.splice(i, 1)
      continue
    }
    const easedPos = 1 - Math.pow(1 - progress, 2)
    const t = Transform.getMutable(sp.entity)
    t.position = Vector3.lerp(sp.startPos, sp.endPos, easedPos)
    const scale = sp.startScale + progress * 2.0
    t.scale = Vector3.create(scale, scale, scale)
    // Fade out in top portion
    if (progress > FADE_START) {
      const fadeProgress = (progress - FADE_START) / (1 - FADE_START)
      const alpha = 1.0 - fadeProgress
      Material.setPbrMaterial(sp.entity, {
        ...SMOKE_MATERIAL,
        albedoColor: Color4.create(1.0, 1.0, 1.0, alpha),
      })
    }
  }
}

// ══════════════════════════════════════════════════════════════
// Physics lift config
// ══════════════════════════════════════════════════════════════
const TRIGGER_RADIUS = 2.5
const TRIGGER_HEIGHT = 30
const UPDRAFT_FORCE = Vector3.create(0, 60, 0)
const UPDRAFT_KICK = Vector3.create(0, 15, 0)
let forceActive = false
let impulseEventId = 0

function activateForce() {
  if (forceActive) return
  forceActive = true
  PhysicsCombinedForce.createOrReplace(engine.PlayerEntity, { vector: UPDRAFT_FORCE })
  impulseEventId++
  PhysicsCombinedImpulse.createOrReplace(engine.PlayerEntity, { vector: UPDRAFT_KICK, eventId: impulseEventId })
}

function deactivateForce() {
  if (!forceActive) return
  forceActive = false
  PhysicsCombinedForce.deleteFrom(engine.PlayerEntity)
}

// ══════════════════════════════════════════════════════════════
// State
// ══════════════════════════════════════════════════════════════
let activeLocationIndex = -1
let spawning = false
let smokeBasePos = Vector3.create(0, -200, 0)
const TRANSITION_DELAY = 5  // seconds to wait after last orb fades before spawning at new location
let transitionTimer = 0
let pendingLocationIndex = -1

// ══════════════════════════════════════════════════════════════
// Setup & system
// ══════════════════════════════════════════════════════════════
export function setupUpdraftSystem() {
  initSmokePool()

  room.onMessage('updraftLocation', (data) => {
    const idx = data.index as number
    if (idx < 0 || idx >= CHIMNEY_LOCATIONS.length) {
      activeLocationIndex = -1
      spawning = false
      return
    }

    if (activeLocationIndex < 0) {
      // First time — start immediately
      activeLocationIndex = idx
      const loc = CHIMNEY_LOCATIONS[idx]
      smokeBasePos = Vector3.create(loc.x, loc.y + SMOKE_BASE_OFFSET, loc.z)
      smokeSpawnAccum = 0
      spawning = true
      console.log(`[Updraft] Active chimney ${idx}`)
    } else {
      // Switching — stop spawning, wait for orbs to die + 15s gap
      spawning = false
      pendingLocationIndex = idx
      transitionTimer = 0
      console.log(`[Updraft] Stopping chimney ${activeLocationIndex}, waiting to switch to ${idx}`)
    }
  })

  // Request initial location once server is connected
  let requested = false
  engine.addSystem(() => {
    if (!requested && isServerConnected()) {
      requested = true
      room.send('requestUpdraftLocation', { t: 0 })
      console.log('[Updraft] Requested initial location from server')
    }
  })
}

export function updraftSystem(dt: number) {
  animateSmokePuffs()

  // Transition delay: wait for existing orbs to fade + 15s gap
  if (pendingLocationIndex >= 0) {
    transitionTimer += dt
    // Wait for all current orbs to finish (SMOKE_LIFETIME_MS) + 15s
    const totalWait = SMOKE_LIFETIME_MS / 1000 + TRANSITION_DELAY
    if (transitionTimer >= totalWait) {
      activeLocationIndex = pendingLocationIndex
      pendingLocationIndex = -1
      const loc = CHIMNEY_LOCATIONS[activeLocationIndex]
      smokeBasePos = Vector3.create(loc.x, loc.y + SMOKE_BASE_OFFSET, loc.z)
      smokeSpawnAccum = 0
      spawning = true
      console.log(`[Updraft] Active chimney ${activeLocationIndex}`)
    }
  }

  // Physics lift — proximity check + hold space
  if (activeLocationIndex >= 0 && Transform.has(engine.PlayerEntity)) {
    const loc = CHIMNEY_LOCATIONS[activeLocationIndex]
    const playerPos = Transform.get(engine.PlayerEntity).position
    const dx = playerPos.x - loc.x
    const dz = playerPos.z - loc.z
    const inRadius = dx * dx + dz * dz <= TRIGGER_RADIUS * TRIGGER_RADIUS
    const inHeight = playerPos.y >= loc.y - 2 && playerPos.y <= loc.y + TRIGGER_HEIGHT

    if (inRadius && inHeight && inputSystem.isPressed(InputAction.IA_JUMP)) {
      activateForce()
    } else {
      deactivateForce()
    }
  } else {
    deactivateForce()
  }

  // Spawn new puffs only when active
  if (spawning) {
    smokeSpawnAccum += dt
    while (smokeSpawnAccum >= SMOKE_SPAWN_INTERVAL) {
      smokeSpawnAccum -= SMOKE_SPAWN_INTERVAL
      spawnSmokePuff(smokeBasePos)
    }
  }
}
