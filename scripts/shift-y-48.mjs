#!/usr/bin/env node
/**
 * Shift EVERYTHING up by +48m on Y axis.
 * Includes: composite, code positions, scene.json spawn, terrain, water plane center.
 * Uses same heuristic: only world positions (x > 50 AND z > 50) get their Y shifted.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const DY = 48
const THRESHOLD = 50

const args = process.argv.slice(2)
const DRY = !args.includes('--apply')
let changes = 0
function isWorld(x, z) { return Math.abs(x) > THRESHOLD && Math.abs(z) > THRESHOLD }

// composite — shift Y of every root entity (including water 517 this time)
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
    // Y-only shift — even entities near origin (water plane, etc.) get lifted
    p.y += DY
    n++
  }
  console.log(`[composite] ${n} Y-shifted`)
  changes += n
  if (!DRY && n) writeFileSync(path, JSON.stringify(d, null, 2))
}

// scene.json — spawn Y
function shiftSceneJson() {
  const path = 'scene.json'
  const d = JSON.parse(readFileSync(path, 'utf8'))
  let n = 0
  for (const sp of d.spawnPoints || []) {
    const y = sp.position?.y
    if (y === undefined) continue
    if (Array.isArray(y)) sp.position.y = y.map(v => v + DY); else sp.position.y = y + DY
    n++
  }
  console.log(`[scene.json] ${n} spawnPoints Y-shifted`)
  changes += n
  if (!DRY && n) writeFileSync(path, JSON.stringify(d, null, 2))
}

// src/*.ts — Y shift for Vector3.create + object literals where x,z > 50 (world coords)
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
  let src = readFileSync(path, 'utf8')
  const orig = src
  let n = 0

  // Vector3.create(x, y, z) — world only (x>50, z>50)
  src = src.replace(/Vector3\.create\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g,
    (m, x, y, z) => {
      const xn = parseFloat(x), yn = parseFloat(y), zn = parseFloat(z)
      if (isWorld(xn, zn)) { n++; return `Vector3.create(${xn}, ${yn + DY}, ${zn})` }
      return m
    })

  // { x: N, y: N, z: N }
  src = src.replace(/\{\s*x:\s*(-?\d+(?:\.\d+)?)\s*,\s*y:\s*(-?\d+(?:\.\d+)?)\s*,\s*z:\s*(-?\d+(?:\.\d+)?)\s*\}/g,
    (m, x, y, z) => {
      const xn = parseFloat(x), yn = parseFloat(y), zn = parseFloat(z)
      if (isWorld(xn, zn)) { n++; return `{ x: ${xn}, y: ${yn + DY}, z: ${zn} }` }
      return m
    })

  // x: N + ..., y: N, z: N + ... pattern (cinematic movePlayerTo)
  src = src.replace(/x:\s*(-?\d+(?:\.\d+)?)\s*(\+[^,]+),\s*y:\s*(-?\d+(?:\.\d+)?)\s*,\s*z:\s*(-?\d+(?:\.\d+)?)\s*(\+[^,}]+)/g,
    (m, x, xTail, y, z, zTail) => {
      const xn = parseFloat(x), yn = parseFloat(y), zn = parseFloat(z)
      if (isWorld(xn, zn)) { n++; return `x: ${xn}${xTail}, y: ${yn + DY}, z: ${zn}${zTail}` }
      return m
    })

  if (src !== orig) { console.log(`[src] ${path}: ${n}`); changes += n; if (!DRY) writeFileSync(path, src) }
}

console.log(DRY ? '=== DRY RUN ===' : '=== APPLYING ===')
shiftComposite()
shiftSceneJson()
for (const f of walk('src')) shiftFile(f)
console.log(`\nTotal: ${changes} shifted by +${DY} on Y`)
