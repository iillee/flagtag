/**
 * Tiny circular wave mesh for flagtag's moat.
 *
 * Same morph-clip idea as pixelwars `scripts/build-water-swell.ts`: each
 * train is a sin/cos morph pair, and the `wave` clip's weights are
 * cos(ωt) and sin(ωt), so the loop is a traveling interference pattern.
 * Amplitude is ~0.10 m (see WATER_SURFACE), not the 48–110 m ocean swells.
 *
 * Run: npx tsx scripts/build-water-waves.ts
 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WATER_SURFACE,
  WAVE_NORM,
  WAVE_PARTS,
  waterSurfaceRadiusM,
  wavePartY,
  type WavePart,
} from '../src/shared/waterLook'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIP = WATER_SURFACE.clipS
const AMP = WATER_SURFACE.amplitudeM
const PARTS = WAVE_PARTS
const TARGETS = PARTS.length * 2
const NORM = WAVE_NORM
const RADIUS = waterSurfaceRadiusM()

type Built = {
  name: string
  pos: number[]
  nrm: number[]
  uv: number[]
  idx: number[]
  morphPos: number[][]
  morphNrm: number[][]
  tris: number
}

function seaUv(x: number, z: number): [number, number] {
  const tile = WATER_SURFACE.softNormalTileM
  return [x / tile, z / tile]
}

function triNormal(pos: number[], a: number, b: number, c: number): [number, number, number] {
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2]
  const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2]
  const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2]
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  return [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx]
}

function faceUp(pos: number[], a: number, b: number, c: number): [number, number, number] {
  const n = triNormal(pos, a, b, c)
  return n[1] < 0 ? [a, c, b] : [a, b, c]
}

function normalsOf(pos: number[], idx: number[]): number[] {
  const nrm = new Array(pos.length).fill(0)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2]
    const n = triNormal(pos, a, b, c)
    for (const v of [a, b, c]) {
      nrm[v * 3] += n[0]
      nrm[v * 3 + 1] += n[1]
      nrm[v * 3 + 2] += n[2]
    }
  }
  for (let v = 0; v < nrm.length; v += 3) {
    const x = nrm[v], y = nrm[v + 1], z = nrm[v + 2]
    const len = Math.hypot(x, y, z) || 1
    nrm[v] = x / len
    nrm[v + 1] = y / len
    nrm[v + 2] = z / len
  }
  return nrm
}

function displaceComponent(
  base: number[],
  idx: number[],
  part: WavePart,
  kind: 0 | 1,
  envAt: (x: number, z: number) => number,
): { delta: number[]; nrm: number[] } {
  const pos = base.slice()
  const delta = new Array(base.length).fill(0)
  for (let v = 0; v < base.length; v += 3) {
    const e = envAt(base[v], base[v + 2])
    const y = (wavePartY(base[v], base[v + 2], part, kind) * e * AMP) / NORM
    delta[v + 1] = y
    pos[v + 1] = y
  }
  return { delta, nrm: normalsOf(pos, idx) }
}

class MeshBuilder {
  pos: number[] = []
  uv: number[] = []
  idx: number[] = []
  map = new Map<string, number>()
  add(x: number, z: number, u: number, v: number): number {
    const key = `${x.toFixed(3)},${z.toFixed(3)}`
    const hit = this.map.get(key)
    if (hit !== undefined) return hit
    const i = this.pos.length / 3
    this.pos.push(x, 0, z)
    this.uv.push(u, v)
    this.map.set(key, i)
    return i
  }
  tri(a: number, b: number, c: number) {
    const [i, j, k] = faceUp(this.pos, a, b, c)
    this.idx.push(i, j, k)
  }
}

function finish(m: MeshBuilder, envAt: (x: number, z: number) => number, name: string): Built {
  const morphPos: number[][] = []
  const morphNrm: number[][] = []
  const baseNrm = new Array(m.pos.length)
  for (let v = 0; v < m.pos.length; v += 3) {
    baseNrm[v] = 0
    baseNrm[v + 1] = 1
    baseNrm[v + 2] = 0
  }
  for (const part of PARTS) {
    for (const kind of [0, 1] as const) {
      const posed = displaceComponent(m.pos, m.idx, part, kind, envAt)
      morphPos.push(posed.delta)
      const nd = new Array(baseNrm.length)
      for (let i = 0; i < nd.length; i++) nd[i] = posed.nrm[i] - baseNrm[i]
      morphNrm.push(nd)
    }
  }
  return {
    name,
    pos: m.pos,
    nrm: baseNrm,
    uv: m.uv,
    idx: m.idx,
    morphPos,
    morphNrm,
    tris: m.idx.length / 3,
  }
}

function radialFade(x: number, z: number): number {
  const d = Math.hypot(x, z)
  const inner = Math.max(0, RADIUS - WATER_SURFACE.fadeM)
  if (d <= inner) return 1
  if (d >= RADIUS) return 0
  const t = (d - inner) / Math.max(1e-6, RADIUS - inner)
  const s = Math.min(1, Math.max(0, t))
  return 1 - s * s * (3 - 2 * s)
}

function disk(step: number, name: string): Built {
  const segs = Math.max(24, Math.round((2 * Math.PI * RADIUS) / step / 4) * 4)
  const radii: number[] = []
  for (let r = step; r < RADIUS - 0.5; r += step) radii.push(r)
  radii.push(RADIUS)
  const m = new MeshBuilder()
  const [u0, v0] = seaUv(0, 0)
  const center = m.add(0, 0, u0, v0)
  const rings: number[][] = []
  for (const R of radii) {
    const row: number[] = []
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2
      const x = Math.cos(a) * R
      const z = Math.sin(a) * R
      const [u, v] = seaUv(x, z)
      row.push(m.add(x, z, u, v))
    }
    rings.push(row)
  }
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs
    m.tri(center, rings[0][i], rings[0][j])
  }
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs
      m.tri(rings[k][i], rings[k + 1][i], rings[k + 1][j])
      m.tri(rings[k][i], rings[k + 1][j], rings[k][j])
    }
  }
  return finish(m, radialFade, name)
}

class Buf {
  parts: Buffer[] = []
  len = 0
  align(n: number) {
    while (this.len % n) {
      this.parts.push(Buffer.from([0]))
      this.len++
    }
  }
  f32(arr: number[]): number {
    this.align(4)
    const b = Buffer.alloc(arr.length * 4)
    for (let i = 0; i < arr.length; i++) b.writeFloatLE(arr[i], i * 4)
    this.parts.push(b)
    const o = this.len
    this.len += b.length
    return o
  }
  u32(arr: number[]): number {
    this.align(4)
    const b = Buffer.alloc(arr.length * 4)
    for (let i = 0; i < arr.length; i++) b.writeUInt32LE(arr[i], i * 4)
    this.parts.push(b)
    const o = this.len
    this.len += b.length
    return o
  }
  concat() {
    return Buffer.concat(this.parts)
  }
}

function writeGlb(mesh: Built, file: string) {
  const buf = new Buf()
  const views: object[] = []
  const acc: object[] = []
  const view = (off: number, len: number, target?: number) => {
    const v: { buffer: number; byteOffset: number; byteLength: number; target?: number } = {
      buffer: 0,
      byteOffset: off,
      byteLength: len,
    }
    if (target) v.target = target
    views.push(v)
    return views.length - 1
  }
  const accessor = (
    viewIndex: number,
    count: number,
    type: string,
    ctype: number,
    min?: number[],
    max?: number[],
  ) => {
    const a: {
      bufferView: number
      componentType: number
      count: number
      type: string
      min?: number[]
      max?: number[]
    } = { bufferView: viewIndex, componentType: ctype, count, type }
    if (min) a.min = min
    if (max) a.max = max
    acc.push(a)
    return acc.length - 1
  }
  const F32 = 5126
  const U32 = 5125
  const putF32 = (arr: number[], type: string, min?: number[], max?: number[]) => {
    const off = buf.f32(arr)
    const comps = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1
    return accessor(view(off, arr.length * 4), arr.length / comps, type, F32, min, max)
  }
  let pMin = [Infinity, Infinity, Infinity]
  let pMax = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      pMin[k] = Math.min(pMin[k], mesh.pos[i + k])
      pMax[k] = Math.max(pMax[k], mesh.pos[i + k])
    }
  }
  if (mesh.morphPos.length) {
    pMin[1] = Math.min(pMin[1], -AMP)
    pMax[1] = Math.max(pMax[1], AMP)
  }
  const posA = putF32(mesh.pos, 'VEC3', pMin, pMax)
  const nrmA = putF32(mesh.nrm, 'VEC3')
  const uvA = putF32(mesh.uv, 'VEC2')
  const iOff = buf.u32(mesh.idx)
  const iA = accessor(view(iOff, mesh.idx.length * 4, 34963), mesh.idx.length, 'SCALAR', U32)
  const animate = mesh.morphPos.length > 0 && mesh.morphPos.some((p) => p.some((v) => Math.abs(v) > 1e-6))
  const morphTargets = animate
    ? mesh.morphPos.map((p, t) => ({
      POSITION: putF32(p, 'VEC3'),
      NORMAL: putF32(mesh.morphNrm[t], 'VEC3'),
    }))
    : []
  const keys = 24
  const times: number[] = []
  const weights: number[] = []
  if (animate) {
    for (let i = 0; i <= keys; i++) {
      const ang = (i / keys) * Math.PI * 2
      times.push((i / keys) * CLIP)
      for (let n = 0; n < PARTS.length; n++) weights.push(Math.cos(ang), Math.sin(ang))
    }
  }
  const tA = animate ? putF32(times, 'SCALAR', [times[0]], [times[times.length - 1]]) : 0
  const wA = animate ? putF32(weights, 'SCALAR', [0], [1]) : 0
  const primitive: {
    attributes: { POSITION: number; NORMAL: number; TEXCOORD_0: number }
    indices: number
    material: number
    targets?: object[]
  } = {
    attributes: { POSITION: posA, NORMAL: nrmA, TEXCOORD_0: uvA },
    indices: iA,
    material: 0,
  }
  if (animate) primitive.targets = morphTargets
  const gltf: {
    asset: { version: string; generator: string }
    scene: number
    scenes: object[]
    nodes: object[]
    meshes: object[]
    materials: object[]
    animations?: object[]
    accessors: object[]
    bufferViews: object[]
    buffers: Array<{ byteLength: number }>
  } = {
    asset: { version: '2.0', generator: 'flagtag build-water-waves' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: mesh.name, mesh: 0 }],
    meshes: [{
      name: mesh.name,
      weights: animate ? new Array(TARGETS).fill(0) : undefined,
      primitives: [primitive],
    }],
    materials: [{
      name: 'Water',
      doubleSided: false,
      pbrMetallicRoughness: {
        baseColorFactor: [WATER_SURFACE.color.r, WATER_SURFACE.color.g, WATER_SURFACE.color.b, 1],
        metallicFactor: WATER_SURFACE.metallic,
        roughnessFactor: WATER_SURFACE.roughness,
      },
    }],
    accessors: acc,
    bufferViews: views,
    buffers: [{ byteLength: 0 }],
  }
  if (animate) {
    gltf.animations = [{
      name: 'wave',
      samplers: [{ input: tA, output: wA, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }],
    }]
  }
  let json = Buffer.from(JSON.stringify(gltf))
  const bin = buf.concat()
  gltf.buffers[0].byteLength = bin.length
  json = Buffer.from(JSON.stringify(gltf))
  while (json.length % 4) json = Buffer.concat([json, Buffer.from(' ')])
  const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4)
  const total = 12 + 8 + json.length + 8 + bin.length + binPad.length
  const out = Buffer.alloc(total)
  out.writeUInt32LE(0x46546c67, 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(json.length, 12)
  out.writeUInt32LE(0x4e4f534a, 16)
  json.copy(out, 20)
  const b0 = 20 + json.length
  out.writeUInt32LE(bin.length + binPad.length, b0)
  out.writeUInt32LE(0x004e4942, b0 + 4)
  bin.copy(out, b0 + 8)
  writeFileSync(file, out)
  return out.length
}

function emit(mesh: Built, rel: string): void {
  const file = resolve(ROOT, rel)
  const bytes = writeGlb(mesh, file)
  const verts = mesh.pos.length / 3
  console.log(`[water-waves] ${rel}  verts=${verts} tris=${mesh.tris} morphs=${mesh.morphPos.length} bytes=${bytes}`)
}

const desktop = disk(WATER_SURFACE.stepM, 'WaterWaves')
const lite = disk(WATER_SURFACE.liteStepM, 'WaterWavesLite')
emit(desktop, WATER_SURFACE.meshSrc)
emit(lite, WATER_SURFACE.meshLiteSrc)
console.log(`[water-waves] radius=${RADIUS}m amp=${AMP}m period=${CLIP}s norm=${NORM.toFixed(3)}`)
