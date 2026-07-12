#!/usr/bin/env node
/**
 * shift-scene.mjs — one-off script to move all gameplay content to scene center.
 * Offset: (+170, 0, +142). Only shifts positions where x > 50 AND z > 50
 * (heuristic: world coords are always large; local offsets/scales are small).
 *
 * Targets:
 *  1. assets/scene/main.composite — root entities only (parent === 0)
 *  2. scene.json — spawnPoints x/z (ranges of numbers)
 *  3. src/**\/*.ts — Vector3.create(x, y, z) and { x: N, y: N, z: N } literals
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const DX = 170
const DY = 0
const DZ = 142
const THRESHOLD = 50 // only shift if x > 50 AND z > 50

const args = process.argv.slice(2)
const DRY = !args.includes('--apply')
let changes = 0
const changed = []

function shouldShift(x, z) {
  return Math.abs(x) > THRESHOLD && Math.abs(z) > THRESHOLD
}

// 1. main.composite
function shiftComposite() {
  const path = 'assets/scene/main.composite'
  const d = JSON.parse(readFileSync(path, 'utf8'))
  const tc = d.components.find(c => c.name === 'core::Transform')
  let n = 0
  for (const [k, v] of Object.entries(tc.data)) {
    const j = v.json
    if (!j || j.parent !== 0) continue
    const p = j.position
    if (!p) continue
    if (shouldShift(p.x, p.z)) {
      p.x += DX
      p.y += DY
      p.z += DZ
      n++
    }
  }
  console.log(`[composite] ${n} root positions shifted`)
  changes += n
  if (!DRY && n > 0) {
    writeFileSync(path, JSON.stringify(d, null, 2))
    changed.push(path)
  }
}

// 2. scene.json — spawnPoints (x/z can be scalar or [min,max])
function shiftSceneJson() {
  const path = 'scene.json'
  const raw = readFileSync(path, 'utf8')
  const d = JSON.parse(raw)
  let n = 0
  if (Array.isArray(d.spawnPoints)) {
    for (const sp of d.spawnPoints) {
      const pos = sp.position
      if (!pos) continue
      const getFirst = v => Array.isArray(v) ? v[0] : v
      if (shouldShift(getFirst(pos.x), getFirst(pos.z))) {
        if (Array.isArray(pos.x)) pos.x = pos.x.map(v => v + DX); else pos.x += DX
        if (Array.isArray(pos.y)) pos.y = pos.y.map(v => v + DY); else pos.y += DY
        if (Array.isArray(pos.z)) pos.z = pos.z.map(v => v + DZ); else pos.z += DZ
        n++
      }
    }
  }
  console.log(`[scene.json] ${n} spawnPoints shifted`)
  changes += n
  if (!DRY && n > 0) {
    writeFileSync(path, JSON.stringify(d, null, 2))
    changed.push(path)
  }
}

// 3. src/**/*.ts — regex-based shifts
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, out)
    else if (f.endsWith('.ts') || f.endsWith('.tsx')) out.push(p)
  }
  return out
}

function shiftSrcFile(path) {
  let src = readFileSync(path, 'utf8')
  const orig = src
  let n = 0

  // Pattern A: Vector3.create(x, y, z)  where x, z are numeric literals
  src = src.replace(/Vector3\.create\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g,
    (m, x, y, z) => {
      const xn = parseFloat(x), yn = parseFloat(y), zn = parseFloat(z)
      if (shouldShift(xn, zn)) {
        n++
        return `Vector3.create(${xn + DX}, ${yn + DY}, ${zn + DZ})`
      }
      return m
    })

  // Pattern B: { x: N, y: N, z: N }  (order-sensitive to keep it simple)
  src = src.replace(/\{\s*x:\s*(-?\d+(?:\.\d+)?)\s*,\s*y:\s*(-?\d+(?:\.\d+)?)\s*,\s*z:\s*(-?\d+(?:\.\d+)?)\s*\}/g,
    (m, x, y, z) => {
      const xn = parseFloat(x), yn = parseFloat(y), zn = parseFloat(z)
      if (shouldShift(xn, zn)) {
        n++
        return `{ x: ${xn + DX}, y: ${yn + DY}, z: ${zn + DZ} }`
      }
      return m
    })

  if (src !== orig) {
    console.log(`[src] ${path}: ${n} positions shifted`)
    changes += n
    if (!DRY) {
      writeFileSync(path, src)
      changed.push(path)
    }
  }
}

console.log(DRY ? '=== DRY RUN (use --apply to write) ===' : '=== APPLYING SHIFT ===')
shiftComposite()
shiftSceneJson()
for (const f of walk('src')) shiftSrcFile(f)
console.log(`\nTotal: ${changes} positions ${DRY ? 'would be' : ''} shifted by (+${DX}, +${DY}, +${DZ})`)
if (!DRY) console.log(`Wrote ${changed.length} files`)
