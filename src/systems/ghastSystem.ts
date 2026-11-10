/**
 * ghastSystem.ts - client visuals for the Halloween ghasts.
 *
 * Positions come from shared/ghast.ts ghastPosAt(i, t, seed) using the seed and
 * epoch from the server's ghastSync reply (no streaming): each ghast orbits the
 * castle. Idle = the no-red-eyes skull (Skull 01); while charging (ghastCharge)
 * the model swaps to the red-eyed skull (Skull 02_2) plus a red point light on
 * desktop, and turns to the aim point; ghastFire spawns a glowing fireball the
 * client flies along the same line; ghastFireballEnd removes it and plays the
 * impact. The explosion VFX + softened knockback/stun arrive as bombExploded
 * (ghast id range, see bombSystem). The nearest ghasts moan now and then.
 * ghastKilled: the ghast sinks below the ground spinning and shrinking, stays
 * hidden until its respawn time, then pops back in on its orbit.
 *
 * Models are read from the Creator Hub template entities by name
 * (GHAST_*_TEMPLATE_NAME) so Creator Hub stays the source of the GLBs.
 */
import {
  engine, Entity, GltfContainer, LightSource, Material, MeshRenderer, Name, Transform,
} from '@dcl/sdk/ecs'
import { Color3, Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { room } from '../shared/messages'
import { HALLOWEEN_MODE } from '../shared/dayNight'
import { isServerConnected } from './clientUtils'
import { playSpatialSound } from '../utils/spatialAudio'
import {
  GHAST_ENABLED, GHAST_COUNT, GHAST_TELEGRAPH_S, GHAST_MODEL_SCALE, GHAST_MODEL_YAW_OFFSET_DEG, GHAST_TURN_DEG_S,
  GHAST_IDLE_TEMPLATE_NAME, GHAST_CHARGE_TEMPLATE_NAME, GHAST_IDLE_FALLBACK_SRC, GHAST_CHARGE_FALLBACK_SRC,
  GHAST_HIDE_TEMPLATES, GHAST_CHARGE_LIGHT, GHAST_FIREBALL_VISUAL_RADIUS_M,
  GHAST_SFX_MOAN, GHAST_SFX_CHARGE, GHAST_SFX_FIRE, GHAST_SFX_IMPACT,
  GHAST_MOAN_VOLUME, GHAST_CHARGE_VOLUME, GHAST_FIRE_VOLUME, GHAST_IMPACT_VOLUME,
  GHAST_MOAN_NEAREST, GHAST_MOAN_MAX_DIST_M, GHAST_SYNC_RETRY_S, GHAST_SYNC_MAX_RETRIES,
  GhastClock, ghastMouthPos, fireballBlend, ghastLifeAt, ghastDeathPose, ghastRespawnScale,
  GHAST_SFX_DEATH, GHAST_DEATH_VOLUME, GHAST_DEATH_SINK_TO_Y,
  ghastPosAt, ghastTravelYaw, ghastMoanDue, yawToward, turnToward, fireballPosAt, type FireballLaunch, type V3,
} from '../shared/ghast'

const HIDDEN = Vector3.create(0, -300, 0)
const ZERO = Vector3.Zero()
const FIREBALL_POOL = 6
const SYNC_FALLBACK_S = 5

interface GhastVis {
  root: Entity
  idle: Entity
  charge: Entity
  light: Entity | null
  sound: Entity
  moan: Entity
  moaning: boolean
  yaw: number
  chargingUntil: number
  aim: V3 | null
  diedAt: number
  respawnAt: number
  deathPos: V3
  deathYaw: number
  scale: number
}
interface FireballVis { root: Entity; core: Entity; light: Entity | null; id: number; launch: FireballLaunch | null; speed: number; t: number; off: V3 }

const vis: GhastVis[] = []
const balls: FireballVis[] = []
let seed: number | null = null
const clock = new GhastClock()
let serverEnabled = true
let requests = 0
let retryIn = 0
let replied = false
let fallbackIn = SYNC_FALLBACK_S
let templatesHidden = false
let impactSound: Entity | null = null
let mobile = false
let prevT = -1

function templateSrc(name: string, fallback: string): string {
  for (const [e, n] of engine.getEntitiesWith(Name, GltfContainer)) {
    if (n.value === name) return GltfContainer.get(e).src
  }
  return fallback
}

function hideTemplates(): void {
  if (templatesHidden || !GHAST_HIDE_TEMPLATES) return
  let found = 0
  for (const [e, n] of engine.getEntitiesWith(Name, GltfContainer, Transform)) {
    if (n.value !== GHAST_IDLE_TEMPLATE_NAME && n.value !== GHAST_CHARGE_TEMPLATE_NAME) continue
    Transform.getMutable(e).scale = ZERO
    found++
  }
  if (found > 0) templatesHidden = true
}

const modelScale = () => Vector3.create(GHAST_MODEL_SCALE, GHAST_MODEL_SCALE, GHAST_MODEL_SCALE)

function makeGhast(idleSrc: string, chargeSrc: string): GhastVis {
  const root = engine.addEntity()
  Transform.create(root, { position: HIDDEN })
  const modelRot = Quaternion.fromEulerDegrees(0, GHAST_MODEL_YAW_OFFSET_DEG, 0)
  const idle = engine.addEntity()
  Transform.create(idle, { parent: root, rotation: modelRot, scale: modelScale() })
  GltfContainer.create(idle, { src: idleSrc, visibleMeshesCollisionMask: 0, invisibleMeshesCollisionMask: 0 })
  // Red-eyed model (emissive eye material baked in the GLB), swapped in on charge.
  const charge = engine.addEntity()
  Transform.create(charge, { parent: root, rotation: modelRot, scale: ZERO })
  GltfContainer.create(charge, { src: chargeSrc, visibleMeshesCollisionMask: 0, invisibleMeshesCollisionMask: 0 })
  let light: Entity | null = null
  if (!mobile && GHAST_CHARGE_LIGHT) {
    light = engine.addEntity()
    Transform.create(light, { parent: root, position: Vector3.create(0, 1.5, 1.5) })
    LightSource.create(light, { type: LightSource.Type.Point({}), color: Color3.create(1, 0.15, 0.05), intensity: 4000, range: 12, shadow: false, active: false })
  }
  // Sound entities are unparented: playSpatialSound writes world positions.
  const sound = engine.addEntity()
  Transform.create(sound, { position: HIDDEN })
  const moan = engine.addEntity()
  Transform.create(moan, { position: HIDDEN })
  return { root, idle, charge, light, sound, moan, moaning: false, yaw: 0, chargingUntil: 0, aim: null, diedAt: -1, respawnAt: 0, deathPos: { x: 0, y: 0, z: 0 }, deathYaw: 0, scale: 1 }
}

function makeFireball(): FireballVis {
  const root = engine.addEntity()
  Transform.create(root, { position: HIDDEN, scale: ZERO })
  MeshRenderer.setSphere(root)
  Material.setPbrMaterial(root, { albedoColor: Color4.create(1, 0.42, 0.06, 0.9), emissiveColor: Color3.create(1, 0.35, 0.05), emissiveIntensity: 4, castShadows: false })
  const core = engine.addEntity()
  Transform.create(core, { parent: root, scale: Vector3.create(0.6, 0.6, 0.6) })
  MeshRenderer.setSphere(core)
  Material.setPbrMaterial(core, { albedoColor: Color4.create(1, 0.85, 0.3, 1), emissiveColor: Color3.create(1, 0.8, 0.25), emissiveIntensity: 6, castShadows: false })
  let light: Entity | null = null
  if (!mobile) {
    light = engine.addEntity()
    Transform.create(light, { parent: root })
    LightSource.create(light, { type: LightSource.Type.Point({}), color: Color3.create(1, 0.5, 0.15), intensity: 5000, range: 10, shadow: false, active: false })
  }
  return { root, core, light, id: 0, launch: null, speed: 0, t: 0, off: { x: 0, y: 0, z: 0 } }
}

function setCharging(g: GhastVis, on: boolean): void {
  Transform.getMutable(g.idle).scale = on ? ZERO : modelScale()
  Transform.getMutable(g.charge).scale = on ? modelScale() : ZERO
  if (g.light) LightSource.getMutable(g.light).active = on
}

function releaseBall(b: FireballVis): void {
  b.launch = null
  b.id = 0
  const t = Transform.getMutable(b.root)
  t.position = HIDDEN
  t.scale = ZERO
  if (b.light) LightSource.getMutable(b.light).active = false
}

function elapsedMs(): number { return clock.elapsed(Date.now()) }

function setRootScale(g: GhastVis, k: number): void {
  if (Math.abs(g.scale - k) < 1e-3) return
  g.scale = k
  Transform.getMutable(g.root).scale = Vector3.create(k, k, k)
}

function applyDeath(i: number, diedAt: number, respawnAt: number, pos: V3): void {
  const g = vis[i]
  if (!g) return
  g.diedAt = diedAt
  g.respawnAt = respawnAt
  g.deathPos = pos
  g.deathYaw = g.yaw
  g.chargingUntil = 0
  if (g.aim) { g.aim = null; setCharging(g, false) }
  g.moaning = false
}

function sync(newSeed: number, elapsed: number, isEnabled: boolean): void {
  seed = newSeed
  clock.reset(Date.now(), elapsed)
  serverEnabled = isEnabled
  prevT = -1
  if (!isEnabled) for (const g of vis) Transform.getMutable(g.root).position = HIDDEN
  console.log(`[Ghast] synced seed ${newSeed} t=${(elapsed / 1000).toFixed(0)}s ${isEnabled ? '' : '(disabled on server)'}`)
}

const moanRank: { i: number; d: number }[] = []

function tickMoans(t: number, pos: V3[]): void {
  if (prevT < 0 || seed === null) { prevT = t; return }
  if (!Transform.has(engine.PlayerEntity)) { prevT = t; return }
  const me = Transform.get(engine.PlayerEntity).position
  moanRank.length = 0
  for (let i = 0; i < pos.length; i++) {
    if (ghastLifeAt(t, vis[i].diedAt, vis[i].respawnAt) !== 'alive') { vis[i].moaning = false; continue }
    const d = Math.hypot(pos[i].x - me.x, pos[i].y - me.y, pos[i].z - me.z)
    if (d <= GHAST_MOAN_MAX_DIST_M) moanRank.push({ i, d })
  }
  moanRank.sort((a, b) => a.d - b.d)
  const n = Math.min(GHAST_MOAN_NEAREST, moanRank.length)
  for (let k = 0; k < n; k++) {
    const i = moanRank[k].i
    if (ghastMoanDue(i, prevT, t, seed)) {
      vis[i].moaning = playSpatialSound(vis[i].moan, GHAST_SFX_MOAN, Vector3.create(pos[i].x, pos[i].y, pos[i].z), GHAST_MOAN_VOLUME, { pitch: 0.9 + 0.2 * ((i * 0.37) % 1) })
    }
  }
  // Keep playing moans riding on their ghast (a moan is ~3 s).
  for (let i = 0; i < vis.length; i++) {
    if (vis[i].moaning) Transform.getMutable(vis[i].moan).position = Vector3.create(pos[i].x, pos[i].y, pos[i].z)
  }
  prevT = t
}

const posBuf: V3[] = []

function tick(dt: number): void {
  hideTemplates()
  // Ask for seed + epoch and keep retrying until the server answers: the first
  // request can go out before the message channel is ready and be lost.
  const connected = isServerConnected()
  if (!replied && connected && requests < GHAST_SYNC_MAX_RETRIES) {
    retryIn -= dt
    if (retryIn <= 0) {
      retryIn = GHAST_SYNC_RETRY_S
      requests++
      room.send('requestGhastSync', { t: requests })
      if (requests > 1) console.log(`[Ghast] requestGhastSync retry ${requests}`)
    }
  }
  if (seed === null) {
    // Local preview only when there is no server at all; with a server, stay
    // hidden until synced rather than flying on a made-up clock.
    if (connected) return
    fallbackIn -= dt
    if (fallbackIn > 0) return
    sync(1, 0, true) // local preview without a server: orbit, never fire
  }
  clock.tick(dt)
  if (!serverEnabled || seed === null) return
  const t = elapsedMs()
  const now = Date.now()
  const maxTurn = GHAST_TURN_DEG_S * dt
  posBuf.length = 0
  for (let i = 0; i < vis.length; i++) {
    const g = vis[i]
    const p = ghastPosAt(i, t, seed)
    posBuf.push(p)
    const life = ghastLifeAt(t, g.diedAt, g.respawnAt)
    if (life === 'dying' || life === 'dead') {
      // Sink below the ground from the death point, spinning, shrinking at the end.
      const pose = ghastDeathPose(t - g.diedAt)
      const tr = Transform.getMutable(g.root)
      if (life === 'dead') { tr.position = HIDDEN; setRootScale(g, 0); continue }
      const y = g.deathPos.y + (GHAST_DEATH_SINK_TO_Y - g.deathPos.y) * pose.sink
      tr.position = Vector3.create(g.deathPos.x, y, g.deathPos.z)
      tr.rotation = Quaternion.fromEulerDegrees(0, g.deathYaw + pose.spinDeg, 0)
      setRootScale(g, pose.scale)
      continue
    }
    setRootScale(g, life === 'respawning' ? ghastRespawnScale(t - g.respawnAt) : 1)
    const charging = g.chargingUntil > now
    if (!charging && g.aim) { g.aim = null; setCharging(g, false) }
    // Face the aim point while charging, otherwise the direction of travel.
    // Each ghast faces along its OWN route velocity (shared/ghast ghastTravelYaw).
    const want = charging && g.aim ? yawToward(p, g.aim) : ghastTravelYaw(i, t, seed)
    g.yaw = turnToward(g.yaw, want, charging ? maxTurn * 2 : maxTurn)
    const tr = Transform.getMutable(g.root)
    tr.position = Vector3.create(p.x, p.y, p.z)
    tr.rotation = Quaternion.fromEulerDegrees(0, g.yaw, 0)
  }
  tickMoans(t, posBuf)
  for (const b of balls) {
    if (!b.launch) continue
    b.t += dt
    const p = fireballPosAt(b.launch, b.t, b.speed)
    // Start at our rendered mouth and blend onto the server path.
    const k = fireballBlend(b.t)
    const tr = Transform.getMutable(b.root)
    tr.position = Vector3.create(p.x + b.off.x * k, p.y + b.off.y * k, p.z + b.off.z * k)
    const pulse = 1 + 0.12 * Math.sin(b.t * 25)
    const r = GHAST_FIREBALL_VISUAL_RADIUS_M * 2 * pulse
    tr.scale = Vector3.create(r, r, r)
    // Safety: server end message lost.
    if (b.t * b.speed > b.launch.dist + 20) releaseBall(b)
  }
}

/** Every charge/fire carries the server's seed + elapsed: re-sync from it. */
function resample(msgSeed: number, serverElapsed: number): void {
  if (msgSeed === 0) return
  if (seed !== msgSeed) { replied = true; sync(msgSeed, serverElapsed, true); return }
  clock.sample(Date.now(), serverElapsed)
}

export function setupGhasts(): void {
  if (!GHAST_ENABLED || !HALLOWEEN_MODE || vis.length > 0) return
  mobile = isMobile()
  const idleSrc = templateSrc(GHAST_IDLE_TEMPLATE_NAME, GHAST_IDLE_FALLBACK_SRC)
  const chargeSrc = templateSrc(GHAST_CHARGE_TEMPLATE_NAME, GHAST_CHARGE_FALLBACK_SRC)
  for (let i = 0; i < GHAST_COUNT; i++) vis.push(makeGhast(idleSrc, chargeSrc))
  for (let i = 0; i < FIREBALL_POOL; i++) balls.push(makeFireball())
  impactSound = engine.addEntity()
  Transform.create(impactSound, { position: HIDDEN })

  room.onMessage('ghastSync', (d) => {
    replied = true
    sync(d.seed | 0, Math.max(0, d.elapsedMs | 0), (d.enabled | 0) !== 0)
    for (const g of vis) { g.diedAt = -1; g.respawnAt = 0 }
    try {
      const dead: number[][] = JSON.parse(d.deadJson || '[]')
      for (const r of dead) applyDeath(r[0] | 0, r[1], r[2], { x: r[3], y: r[4], z: r[5] })
    } catch { /* ignore */ }
  })
  room.onMessage('ghastKilled', (d) => {
    resample(d.seed | 0, d.t | 0)
    const i = d.g | 0
    const g = vis[i]
    if (!g) return
    // Start the sink from where WE drew it (no visible jump), timed on the server's clock.
    const drawn = Transform.get(g.root).position
    const from = drawn.y > -100 ? { x: drawn.x, y: drawn.y, z: drawn.z } : { x: d.x, y: d.y, z: d.z }
    applyDeath(i, Math.min(d.t | 0, elapsedMs()), d.respawnT | 0, from)
    playSpatialSound(g.sound, GHAST_SFX_DEATH, Vector3.create(from.x, from.y, from.z), GHAST_DEATH_VOLUME)
    console.log(`[Ghast] ${i} killed (${d.cause}) by ${d.killer ? String(d.killer).slice(0, 8) : '?'}`)
  })
  room.onMessage('ghastCharge', (d) => {
    resample(d.seed | 0, d.t | 0)
    const g = vis[d.g | 0]
    if (!g || ghastLifeAt(elapsedMs(), g.diedAt, g.respawnAt) !== 'alive') return
    g.aim = { x: d.x, y: d.y, z: d.z }
    g.chargingUntil = Date.now() + GHAST_TELEGRAPH_S * 1000 + 300
    setCharging(g, true)
    const p = Transform.get(g.root).position
    playSpatialSound(g.sound, GHAST_SFX_CHARGE, p, GHAST_CHARGE_VOLUME)
  })
  room.onMessage('ghastFire', (d) => {
    resample(d.seed | 0, d.t | 0)
    const g = vis[d.g | 0]
    if (g) { g.chargingUntil = 0 }
    const b = balls.find((x) => x.launch === null) ?? balls[0]
    b.id = d.id | 0
    b.launch = { start: { x: d.sx, y: d.sy, z: d.sz }, dir: { x: d.dx, y: d.dy, z: d.dz }, dist: d.dist }
    b.speed = d.speed
    b.t = 0
    b.off = { x: 0, y: 0, z: 0 }
    if (g && seed !== null) {
      // Visual leaves OUR rendered skull's mouth; the server keeps its own path for hits.
      const root = Transform.get(g.root).position
      const mouth = ghastMouthPos(root, g.yaw)
      b.off = { x: mouth.x - d.sx, y: mouth.y - d.sy, z: mouth.z - d.sz }
      const err = Math.hypot(b.off.x, b.off.y, b.off.z)
      if (err > 3) console.log(`[Ghast] fire g${d.g} client/server mouth gap ${err.toFixed(1)} m (clock ${(elapsedMs() - (d.t | 0)).toFixed(0)} ms)`)
    }
    if (b.light) LightSource.getMutable(b.light).active = true
    if (g) playSpatialSound(g.sound, GHAST_SFX_FIRE, Vector3.create(d.sx, d.sy, d.sz), GHAST_FIRE_VOLUME)
  })
  room.onMessage('ghastFireballEnd', (d) => {
    const b = balls.find((x) => x.id === (d.id | 0))
    if (b) releaseBall(b)
    if (impactSound) playSpatialSound(impactSound, GHAST_SFX_IMPACT, Vector3.create(d.x, d.y, d.z), GHAST_IMPACT_VOLUME)
  })
  engine.addSystem(tick)
  console.log(`[Ghast] setup: ${GHAST_COUNT} ghasts, idle=${idleSrc}, charge=${chargeSrc}`)
}
