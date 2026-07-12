#!/usr/bin/env node
/**
 * Shift entire scene by (-48, 0, -48).
 * Excludes: terrain (only in code — terrainSetup.ts, not shifted), water plane (composite entity 517).
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const DX = -48, DY = 0, DZ = -48
const THRESHOLD = 50
const WATER_ENTITY_ID = '517'
const EXCLUDE_FILES = new Set(['src/systems/terrainSetup.ts'])

const args = process.argv.slice(2)
const DRY = !args.includes('--apply')
let changes = 0

function shift(x, z) { return Math.abs(x) > THRESHOLD && Math.abs(z) > THRESHOLD }

// composite
function shiftComposite() {
  const path = 'assets/scene/main.composite'
  const d = JSON.parse(readFileSync(path, 'utf8'))
  const tc = d.components.find(c => c.name === 'core::Transform')
  let n = 0
  for (const [k, v] of Object.entries(tc.data)) {
    if (k === WATER_ENTITY_ID) continue
    const j = v.json
    if (!j || j.parent !== 0) continue
    const p = j.position
    if (!p) continue
    if (shift(p.x, p.z)) { p.x += DX; p.y += DY; p.z += DZ; n++ }
  }
  console.log(`[composite] ${n} shifted (water 517 excluded)`)
  changes += n
  if (!DRY && n) writeFileSync(path, JSON.stringify(d, null, 2))
}

// scene.json
function shiftSceneJson() {
  const path = 'scene.json'
  const d = JSON.parse(readFileSync(path, 'utf8'))
  let n = 0
  for (const sp of d.spawnPoints || []) {
    const pos = sp.position
    if (!pos) continue
    const gf = v => Array.isArray(v) ? v[0] : v
    if (shift(gf(pos.x), gf(pos.z))) {
      if (Array.isArray(pos.x)) pos.x = pos.x.map(v => v + DX); else pos.x += DX
      if (Array.isArray(pos.z)) pos.z = pos.z.map(v => v + DZ); else pos.z += DZ
      n++
    }
  }
  console.log(`[scene.json] ${n} spawnPoints shifted`)
  changes += n
  if (!DRY && n) writeFileSync(path, JSON.stringify(d, null, 2))
}

// src/
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f).replace(/\\/g, '/')
    const s = statSync(p)
    if (s.isDirectory()) walk(p, out)
    else if (f.endsWith('.ts') || f.endsWith('.tsx')) out.push(p)
  }
  return out
}

function shiftFile(path) {
  if (EXCLUDE_FILES.has(path)) return
  let src = readFileSync(path, 'utf8')
  const orig = src
  let n = 0
  src = src.replace(/Vector3\.create\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g,
    (m, x, y, z) => {
      const xn = parseFloat(x), yn = parseFloat(y), zn = parseFloat(z)
      if (shift(xn, zn)) { n++; return `Vector3.create(${xn + DX}, ${yn + DY}, ${zn + DZ})` }
      return m
    })
  src = src.replace(/\{\s*x:\s*(-?\d+(?:\.\d+)?)\s*,\s*y:\s*(-?\d+(?:\.\d+)?)\s*,\s*z:\s*(-?\d+(?:\.\d+)?)\s*\}/g,
    (m, x, y, z) => {
      const xn = parseFloat(x), yn = parseFloat(y), zn = parseFloat(z)
      if (shift(xn, zn)) { n++; return `{ x: ${xn + DX}, y: ${yn + DY}, z: ${zn + DZ} }` }
      return m
    })
  // Patterns like: x: 431.75 + Math.random() * 3, y: 47.48, z: 438.5 + ...
  src = src.replace(/x:\s*(-?\d+(?:\.\d+)?)\s*(\+[^,]+),\s*y:\s*(-?\d+(?:\.\d+)?)\s*,\s*z:\s*(-?\d+(?:\.\d+)?)\s*(\+[^,}]+)/g,
    (m, x, xTail, y, z, zTail) => {
      const xn = parseFloat(x), zn = parseFloat(z)
      if (shift(xn, zn)) { n++; return `x: ${xn + DX}${xTail}, y: ${y}, z: ${zn + DZ}${zTail}` }
      return m
    })
  // Bare constants like BOUNDARY_CX = N, BOUNDARY_CZ = N (paired). We'll just shift any 'const \w+ = <big num>' if that number is a plausible x or z. Too risky — skip.

  if (src !== orig) { console.log(`[src] ${path}: ${n}`); changes += n; if (!DRY) writeFileSync(path, src) }
}

console.log(DRY ? '=== DRY RUN ===' : '=== APPLYING ===')
shiftComposite()
shiftSceneJson()
for (const f of walk('src')) shiftFile(f)
console.log(`\nTotal: ${changes} shifted by (${DX}, ${DY}, ${DZ})`)
