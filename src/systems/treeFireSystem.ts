/**
 * treeFireSystem.ts - Halloween: rotating tree fires (client only).
 *
 * Flame look ported from dcl-snowdrift src/client/flameBillboards.ts
 * (emissive plane "tongue" cards in two crossed arms + bed glow cube + rising
 * embers, Y-billboarded). Trees are found at runtime by Name.
 *
 * Rotation: one swap every TREE_FIRE_SWAP_SEC (one tree out, one in). Synced
 * like the updraft smoke - the client asks once (`requestTreeFireSeed`), the
 * server answers with its seed + ms since its epoch, and every later swap is
 * derived locally (treeFireOrder / isRankLit), so there is no ongoing traffic.
 * Smoke-style transition: the outgoing tree fades out and the incoming one
 * fades in after TREE_FIRE_SWITCH_DELAY_SEC.
 *
 * Perf: flame rigs are pooled and rebound to whichever trees are burning;
 * only the nearest N burning trees show, only those within the animate radius
 * tick, only the nearest TREE_FIRE_LIGHTS_* lights emit (night window), and
 * two crackle sources roam to the nearest burning trees.
 */
import { AudioSource, Billboard, BillboardMode, engine, Entity, GltfContainer, LightSource, Material, MeshRenderer, Name, Transform } from '@dcl/sdk/ecs'
import { Color3, Color4, Quaternion, Vector3 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { HALLOWEEN_MODE, lightsEnabledAt } from '../shared/dayNight'
import { room } from '../shared/messages'
import { isServerConnected } from './clientUtils'
import {
  TREE_FIRE_ENABLED, TREE_FIRE_NAME_RE, TREE_FIRE_MAX_DESKTOP, TREE_FIRE_MAX_MOBILE,
  TREE_FIRE_ANIMATE_RADIUS_DESKTOP_M, TREE_FIRE_ANIMATE_RADIUS_MOBILE_M,
  TREE_FIRE_LIGHTS_DESKTOP, TREE_FIRE_LIGHTS_MOBILE, TREE_FIRE_LIGHT_INTENSITY, TREE_FIRE_LIGHT_RANGE_M,
  TREE_FIRE_LIGHTS_ENABLED, TREE_FIRE_LIGHT_Y, TREE_FIRE_LIGHT_FLICKER_HZ, treeFireLightFlicker,
  TREE_FIRE_SOUND_SRC, TREE_FIRE_SOUNDS, TREE_FIRE_SOUND_VOLUME, TREE_FIRE_RERANK_S,
  TREE_FIRE_FADE_IN_SEC, TREE_FIRE_SWITCH_DELAY_SEC, TREE_FIRE_FADE_OUT_SEC, TREE_FIRE_SEED_FALLBACK_SEC,
  treeFirePlacement, treeFireVariant, treeFireOrder, isRankLit, treeFireStepAt, hash01, nearestIndices, Vec3,
} from '../shared/treeFire'

const BED_Y = 0.08
const CORE_SIZE = 0.42
const HIDDEN = Vector3.create(0.001, 0.001, 0.001)
const COL_YELLOW_ALBEDO = Color4.create(1.0, 0.8, 0.3, 1)
const COL_YELLOW_EMIT = Color3.create(1.0, 0.66, 0.16)
const COL_ORANGE_ALBEDO = Color4.create(1.0, 0.42, 0.06, 1)
const COL_ORANGE_EMIT = Color3.create(1.0, 0.3, 0.04)
const EMIT_BASE = 1.35
const LIGHT_COLOR = Color3.create(1.0, 0.6, 0.2)

type Kind = 'base' | 'medium' | 'tall'
interface TongueSpec { kind: Kind; heat: number; yaw: number; x: number; z: number; width: number; height: number; period: number; phase: number }
interface EmberSpec { yaw: number; x: number; z: number; width: number; height: number; period: number; phase: number; riseY: number; heat: number }

// Subset of snowdrift's TONGUES / EMBERS.
const TONGUES: readonly TongueSpec[] = [
  { kind: 'base', heat: 0.0, yaw: -8, x: -0.2, z: 0.0, width: 0.52, height: 0.38, period: 2.15, phase: 0.0 },
  { kind: 'base', heat: 0.18, yaw: 10, x: 0.2, z: 0.01, width: 0.5, height: 0.34, period: 2.85, phase: 0.48 },
  { kind: 'medium', heat: 0.35, yaw: 8, x: -0.06, z: -0.02, width: 0.28, height: 0.95, period: 1.35, phase: 0.22 },
  { kind: 'tall', heat: 0.7, yaw: -4, x: -0.02, z: -0.06, width: 0.16, height: 1.4, period: 1.75, phase: 0.61 },
]
const EMBERS: readonly EmberSpec[] = [
  { yaw: 40, x: -0.1, z: 0.04, width: 0.12, height: 0.2, period: 1.8, phase: 0.0, riseY: 2.8, heat: 0.1 },
  { yaw: 120, x: 0.08, z: -0.02, width: 0.06, height: 0.1, period: 0.7, phase: 0.35, riseY: 1.4, heat: 0.5 },
  { yaw: 200, x: 0.12, z: 0.06, width: 0.09, height: 0.16, period: 1.25, phase: 0.62, riseY: 2.2, heat: 0.3 },
  { yaw: 300, x: 0.14, z: -0.06, width: 0.06, height: 0.11, period: 0.82, phase: 0.7, riseY: 1.6, heat: 0.55 },
]

interface Card<S> { spec: S; root: Entity }
interface Rig {
  anchor: Entity
  facing: Entity
  core: Entity
  tongues: Card<TongueSpec>[]
  embers: Card<EmberSpec>[]
  light: Entity | null
  tree: Tree | null
  scaleWritten: number
}

interface Tree {
  entity: Entity
  /** Tree base position (rotation-order hash input). */
  base: Vec3
  /** Flame bed position. */
  pos: Vec3
  flameScale: number
  speed: number
  phase: number
  /** Position in the seeded rotation order. */
  rank: number
  /** Target state for the current swap step. */
  lit: boolean
  /** 0..1 visual presence. */
  fade: number
  /** Seconds before a newly lit tree starts fading in (smoke-style drain + delay). */
  waitIn: number
  rig: Rig | null
  shown: boolean
}

const trees: Tree[] = []
const known = new Set<Entity>()
const pool: Rig[] = []
/** Server seed; null until synced (or fallback). */
let seed: number | null = null
/** Local Date.now() that corresponds to the server's rotation epoch. */
let epochLocalMs = 0
let lastStep = -1
let lightCap = 0
let litRigs: Tree[] = []
let flickerIn = 0
let sounds: Entity[] = []
let timeSec = 0
let rerankIn = 0
let scanIn = 0
let fallbackIn = TREE_FIRE_SEED_FALLBACK_SEC
let seedRequests = 0
let seedRetryIn = 0
let seedReplied = false
/** Re-ask every few seconds until answered: the first request can be lost if it goes out before the message channel is ready. */
const SEED_RETRY_SEC = 3
const SEED_MAX_RETRIES = 20
let started = false

function heatMaterial(e: Entity, heat: number): void {
  const t = Math.min(1, Math.max(0, heat))
  const u = 1 - t
  Material.setPbrMaterial(e, {
    albedoColor: Color4.create(COL_YELLOW_ALBEDO.r * u + COL_ORANGE_ALBEDO.r * t, COL_YELLOW_ALBEDO.g * u + COL_ORANGE_ALBEDO.g * t, COL_YELLOW_ALBEDO.b * u + COL_ORANGE_ALBEDO.b * t, 1),
    emissiveColor: Color3.create(COL_YELLOW_EMIT.r * u + COL_ORANGE_EMIT.r * t, COL_YELLOW_EMIT.g * u + COL_ORANGE_EMIT.g * t, COL_YELLOW_EMIT.b * u + COL_ORANGE_EMIT.b * t),
    emissiveIntensity: EMIT_BASE,
    metallic: 0,
    roughness: 1,
    castShadows: false,
  })
}

function wave(time: number, period: number, phase: number): number {
  const u = (time / period + phase) % 1
  return 0.5 - 0.5 * Math.cos(u * Math.PI * 2)
}

function card(parent: Entity, x: number, z: number, yaw: number, heat: number): Entity {
  const root = engine.addEntity()
  Transform.create(root, { parent, position: Vector3.create(x, BED_Y, z), rotation: Quaternion.fromEulerDegrees(0, yaw, 0), scale: Vector3.create(0.001, 0.001, 1) })
  const face = engine.addEntity()
  Transform.create(face, { parent: root, position: Vector3.create(0, 0.5, 0) })
  MeshRenderer.setPlane(face)
  heatMaterial(face, heat)
  return root
}

function poseTongue(c: Card<TongueSpec>, time: number): void {
  const s = c.spec
  const a = wave(time, s.period, s.phase)
  const b = wave(time, s.period * 1.41, s.phase + 0.33)
  const f = wave(time, s.period * 0.28, s.phase + 0.17)
  let sx: number, sy: number
  if (s.kind === 'base') { sx = 0.94 + 0.08 * a + 0.02 * f; sy = 0.42 + 0.62 * Math.pow(a, 0.4) + 0.04 * f }
  else if (s.kind === 'medium') { sx = 0.92 + 0.08 * b + 0.04 * f; sy = 0.78 + 0.24 * Math.pow(a, 0.38) + 0.06 * f }
  else { sx = 0.9 + 0.08 * b + 0.05 * f; sy = 0.5 + 0.5 * Math.pow(a, 0.32) + 0.08 * f }
  Transform.getMutable(c.root).scale = Vector3.create(s.width * sx, Math.max(s.height * sy, 0.02), 1)
}

function poseEmber(c: Card<EmberSpec>, time: number): void {
  const s = c.spec
  const u = (time / s.period + s.phase) % 1
  const rise = u < 0.55 ? u / 0.55 : 1
  const fade = u < 0.55 ? Math.pow(rise, 0.55) : 1 - Math.pow((u - 0.55) / 0.45, 0.85)
  const tr = Transform.getMutable(c.root)
  if (fade < 0.04) { tr.scale = Vector3.create(0.001, 0.001, 1); return }
  const lean = Math.sin((time / (s.period * 0.7) + s.phase) * Math.PI * 2)
  tr.position = Vector3.create(s.x + 0.02 * lean, BED_Y + s.riseY * rise, s.z + 0.01 * lean)
  const k = fade * (1 - 0.4 * rise)
  tr.scale = Vector3.create(s.width * k, Math.max(s.height * k, 0.02), 1)
}

function makeRig(): Rig {
  const anchor = engine.addEntity()
  Transform.create(anchor, { position: Vector3.create(0, -200, 0), scale: HIDDEN })
  Billboard.create(anchor, { billboardMode: BillboardMode.BM_Y })
  const facing = engine.addEntity()
  Transform.create(facing, { parent: anchor })
  const core = engine.addEntity()
  Transform.create(core, { parent: anchor, position: Vector3.create(0, BED_Y + CORE_SIZE * 0.35, 0), scale: Vector3.create(CORE_SIZE, CORE_SIZE, CORE_SIZE) })
  MeshRenderer.setBox(core)
  heatMaterial(core, 0.15)
  const tongues: Card<TongueSpec>[] = []
  for (let a = 0; a < 2; a++) {
    const arm = engine.addEntity()
    Transform.create(arm, { parent: facing, rotation: Quaternion.fromEulerDegrees(0, a * 90, 0) })
    TONGUES.forEach((s) => tongues.push({ spec: s, root: card(arm, s.x, s.z, s.yaw, s.heat) }))
  }
  const embers = EMBERS.map((s) => ({ spec: s, root: card(facing, s.x, s.z, s.yaw, s.heat) }))
  let light: Entity | null = null
  if (TREE_FIRE_LIGHTS_ENABLED) {
    light = engine.addEntity()
    Transform.create(light, { position: Vector3.create(0, -200, 0) })
    LightSource.create(light, { type: LightSource.Type.Point({}), color: LIGHT_COLOR, intensity: TREE_FIRE_LIGHT_INTENSITY, range: TREE_FIRE_LIGHT_RANGE_M, shadow: false, active: false })
  }
  return { anchor, facing, core, tongues, embers, light, tree: null, scaleWritten: -1 }
}

/** Point a pooled rig at a tree: position, light, and per-tree card timing jitter. */
function bindRig(rig: Rig, t: Tree): void {
  rig.tree = t
  const P = t.pos
  Transform.getMutable(rig.anchor).position = Vector3.create(P.x, P.y, P.z)
  if (rig.light) Transform.getMutable(rig.light).position = Vector3.create(P.x, P.y + TREE_FIRE_LIGHT_Y * t.flameScale, P.z)
  for (let a = 0; a < 2; a++) {
    TONGUES.forEach((s, i) => {
      const spec = a === 0 ? s : { ...s, height: s.height * (i % 2 === 0 ? 0.88 : 1.12), period: s.period * (i % 2 === 0 ? 1.08 : 0.92), phase: (s.phase + 0.28 + i * 0.07) % 1 }
      rig.tongues[a * TONGUES.length + i].spec = { ...spec, phase: (spec.phase + hash01(P.x, P.y, P.z, 10 + a * 8 + i)) % 1, period: spec.period * (0.85 + 0.3 * hash01(P.x, P.y, P.z, 30 + a * 8 + i)) }
    })
  }
  EMBERS.forEach((s, i) => {
    rig.embers[i].spec = { ...s, phase: (s.phase + hash01(P.x, P.y, P.z, 50 + i)) % 1, period: s.period * (0.8 + 0.4 * hash01(P.x, P.y, P.z, 60 + i)) }
  })
  rig.scaleWritten = -1
}

function acquireRig(t: Tree): void {
  const rig = pool.find((r) => r.tree === null) ?? (() => { const r = makeRig(); pool.push(r); return r })()
  bindRig(rig, t)
  t.rig = rig
}

function releaseRig(t: Tree): void {
  const rig = t.rig
  if (!rig) return
  rig.tree = null
  Transform.getMutable(rig.anchor).scale = HIDDEN
  if (rig.light) LightSource.getMutable(rig.light).active = false
  t.rig = null
  t.shown = false
}

function writeScale(t: Tree): void {
  if (!t.rig) return
  // Ease-out so fades read as flames swelling up / dying down.
  const f = t.shown ? 1 - (1 - t.fade) * (1 - t.fade) : 0
  const s = f > 0.002 ? t.flameScale * f : 0.001
  if (Math.abs(s - t.rig.scaleWritten) < 0.002) return
  t.rig.scaleWritten = s
  Transform.getMutable(t.rig.anchor).scale = Vector3.create(s, s, s)
}

/** Recompute ranks (tree list or seed changed). */
function reorder(): void {
  if (seed === null) return
  const ranks = treeFireOrder(trees.map((t) => t.base), seed)
  trees.forEach((t, i) => { t.rank = ranks[i] })
}

/** Apply swap `step`. `instant` (sync / tree list change) skips the transition. */
function applyStep(step: number, instant: boolean): void {
  lastStep = step
  const n = trees.length
  for (const t of trees) {
    const lit = isRankLit(t.rank, n, step)
    if (lit === t.lit) continue
    t.lit = lit
    if (instant) { t.fade = lit ? 1 : 0; t.waitIn = 0 }
    else if (lit) t.waitIn = TREE_FIRE_SWITCH_DELAY_SEC
  }
  rerankIn = 0
}

function currentStep(): number {
  return treeFireStepAt(Date.now() - epochLocalMs)
}

function sync(newSeed: number, elapsedMs: number): void {
  const first = seed === null
  seed = newSeed
  epochLocalMs = Date.now() - elapsedMs
  reorder()
  applyStep(currentStep(), first)
  console.log(`[TreeFire] synced seed ${newSeed}, step ${lastStep}, ${trees.filter((t) => t.lit).length}/${trees.length} lit`)
}

function scanTrees(): void {
  let added = 0
  for (const [e, name] of engine.getEntitiesWith(Name, Transform)) {
    if (known.has(e) || !TREE_FIRE_NAME_RE.test(name.value)) continue
    // Skip non-model entities that happen to be named "Tree..." (e.g. groups).
    if (!GltfContainer.has(e)) continue
    known.add(e)
    const tr = Transform.get(e)
    const p = treeFirePlacement(tr.position, tr.scale)
    const v = treeFireVariant(p.position)
    trees.push({ entity: e, base: { ...tr.position }, pos: p.position, flameScale: p.flameScale * v.size, speed: v.speed, phase: v.phase, rank: 0, lit: false, fade: 0, waitIn: 0, rig: null, shown: false })
    added++
  }
  if (added) {
    console.log(`[TreeFire] ${trees.length} trees tracked`)
    // Tree list changed (scene load / Creator Hub edit): re-derive the order, snap.
    if (seed !== null) { reorder(); applyStep(currentStep(), true) }
    rerankIn = 0
  }
}

function playerPos(): Vec3 | null {
  const t = Transform.getOrNull(engine.PlayerEntity)
  return t ? t.position : null
}

function rerank(): void {
  const me = playerPos()
  if (!me) return
  const burning = trees.filter((t) => t.fade > 0 || (t.lit && t.waitIn <= 0))
  const max = isMobile() ? TREE_FIRE_MAX_MOBILE : TREE_FIRE_MAX_DESKTOP
  const order = nearestIndices(burning.map((t) => t.pos), me, burning.length)
  const night = lightsEnabledAt(Date.now())
  litRigs = []
  order.forEach((idx, rank) => {
    const t = burning[idx]
    t.shown = rank < max
    if (t.shown && !t.rig) acquireRig(t)
    if (!t.shown && t.rig) releaseRig(t)
    writeScale(t)
    if (t.rig?.light) {
      const on = night && t.shown && rank < lightCap
      const ls = LightSource.getMutable(t.rig.light)
      if (ls.active !== on) ls.active = on
      if (on) litRigs.push(t)
    }
  })
  // Crackle follows the nearest trees that are (or are becoming) lit.
  const loud = order.map((i) => burning[i]).filter((t) => t.lit)
  sounds.forEach((s, i) => {
    const t = loud[i]
    Transform.getMutable(s).position = t ? Vector3.create(t.pos.x, t.pos.y, t.pos.z) : Vector3.create(0, -200, 0)
  })
}

function updateFades(dt: number): void {
  for (const t of trees) {
    if (t.lit) {
      if (t.waitIn > 0) { t.waitIn -= dt; if (t.waitIn <= 0) rerankIn = 0; continue }
      if (t.fade < 1) { t.fade = Math.min(1, t.fade + dt / TREE_FIRE_FADE_IN_SEC); writeScale(t) }
    } else if (t.fade > 0) {
      t.fade = Math.max(0, t.fade - dt / TREE_FIRE_FADE_OUT_SEC)
      writeScale(t)
      if (t.fade === 0) { releaseRig(t); rerankIn = 0 }
    }
  }
}

function tick(dt: number): void {
  timeSec += dt
  scanIn -= dt
  if (scanIn <= 0) { scanIn = 5; scanTrees() }
  // Ask the server for seed + epoch, retrying until it answers.
  const connected = isServerConnected()
  if (!seedReplied && connected && seedRequests < SEED_MAX_RETRIES) {
    seedRetryIn -= dt
    if (seedRetryIn <= 0) {
      seedRetryIn = SEED_RETRY_SEC
      seedRequests++
      room.send('requestTreeFireSeed', { t: seedRequests })
      if (seedRequests > 1) console.log(`[TreeFire] requestTreeFireSeed retry ${seedRequests}`)
    }
  }
  // Offline fallback (local seed 1) only when there is no server at all.
  if (fallbackIn > 0 && !connected) {
    fallbackIn -= dt
    if (fallbackIn <= 0 && seed === null) sync(1, 0)
  }
  if (seed !== null) {
    const step = currentStep()
    if (step !== lastStep) applyStep(step, step < lastStep || step - lastStep > 3)
  }
  updateFades(dt)
  rerankIn -= dt
  if (rerankIn <= 0) { rerankIn = TREE_FIRE_RERANK_S; rerank() }
  flickerIn -= dt
  if (flickerIn <= 0) {
    flickerIn = 1 / TREE_FIRE_LIGHT_FLICKER_HZ
    for (const t of litRigs) {
      if (!t.rig?.light) continue
      const f = treeFireLightFlicker(timeSec, t.phase)
      const ls = LightSource.getMutable(t.rig.light)
      ls.range = TREE_FIRE_LIGHT_RANGE_M * f.range * Math.max(0.2, t.fade)
      ls.intensity = TREE_FIRE_LIGHT_INTENSITY * f.intensity * t.fade
    }
  }
  const me = playerPos()
  if (!me) return
  const rad = isMobile() ? TREE_FIRE_ANIMATE_RADIUS_MOBILE_M : TREE_FIRE_ANIMATE_RADIUS_DESKTOP_M
  const r2 = rad * rad
  for (const t of trees) {
    if (!t.rig || !t.shown) continue
    const dx = t.pos.x - me.x, dz = t.pos.z - me.z
    if (dx * dx + dz * dz > r2) continue
    const rt = timeSec * t.speed + t.phase * 10
    for (const c of t.rig.tongues) poseTongue(c, rt)
    for (const c of t.rig.embers) poseEmber(c, rt)
  }
}

export function setupTreeFires(): void {
  if (started || !HALLOWEEN_MODE || !TREE_FIRE_ENABLED) return
  started = true
  lightCap = isMobile() ? TREE_FIRE_LIGHTS_MOBILE : TREE_FIRE_LIGHTS_DESKTOP
  room.onMessage('treeFireSeed', (data) => {
    seedReplied = true
    sync(data.seed | 0, Math.max(0, data.elapsedMs | 0))
  })
  for (let i = 0; i < TREE_FIRE_SOUNDS; i++) {
    const s = engine.addEntity()
    Transform.create(s, { position: Vector3.create(0, -200, 0) })
    AudioSource.create(s, { audioClipUrl: TREE_FIRE_SOUND_SRC, loop: true, playing: true, global: false, volume: TREE_FIRE_SOUND_VOLUME })
    sounds.push(s)
  }
  engine.addSystem(tick)
  console.log('[TreeFire] setup')
}
