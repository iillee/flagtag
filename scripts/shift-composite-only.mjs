#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs'
const DX=170, DY=0, DZ=142
const path='assets/scene/main.composite'
const d = JSON.parse(readFileSync(path,'utf8'))
const tc = d.components.find(c => c.name === 'core::Transform')
let n=0
for (const [k,v] of Object.entries(tc.data)) {
  const j = v.json
  if (!j || j.parent !== 0) continue
  const p = j.position
  if (!p) continue
  if (Math.abs(p.x) > 50 && Math.abs(p.z) > 50) {
    p.x += DX; p.y += DY; p.z += DZ; n++
  }
}
writeFileSync(path, JSON.stringify(d, null, 2))
console.log(`shifted ${n} root composite positions`)
