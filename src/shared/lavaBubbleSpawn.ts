/**
 * lavaBubbleSpawn.ts - where Halloween moat bubbles may appear.
 * Pure (no engine access): safe in Jest. Uses the generated terrain mask
 * (lavaMask.ts): open lava only, never on land or under/inside the castle.
 */
import { LAVA_MASK_BASE64, LAVA_MASK_CELL_M, LAVA_MASK_N } from './lavaMask'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let buf = 0, bits = 0, o = 0
  for (let i = 0; i < clean.length; i++) {
    buf = (buf << 6) | B64.indexOf(clean[i]); bits += 6
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff }
  }
  return out
}

const mask = decodeBase64(LAVA_MASK_BASE64)
/** Flat list of open-lava cell indices (fallback when nothing is near the player). */
const openCells: number[] = []
for (let k = 0; k < LAVA_MASK_N * LAVA_MASK_N; k++) if (mask[k >> 3] & (1 << (k & 7))) openCells.push(k)

export function lavaOpenCellCount(): number { return openCells.length }

/** True when (x, z) is in an open-lava cell. */
export function isOpenLavaAt(x: number, z: number): boolean {
  const gx = Math.floor(x / LAVA_MASK_CELL_M), gz = Math.floor(z / LAVA_MASK_CELL_M)
  if (gx < 0 || gz < 0 || gx >= LAVA_MASK_N || gz >= LAVA_MASK_N) return false
  const k = gz * LAVA_MASK_N + gx
  return (mask[k >> 3] & (1 << (k & 7))) !== 0
}

/**
 * Random open-lava point, preferably within nearRadius of (px, pz) so bubble
 * density looks good around the player. Rejection-samples the disc `tries`
 * times, then falls back to any open-lava cell on the map.
 */
export function pickLavaBubblePoint(
  px: number, pz: number, nearRadius: number, rand: () => number = Math.random, tries = 16
): { x: number; z: number } | null {
  for (let i = 0; i < tries; i++) {
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(rand()) * nearRadius
    const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r
    if (isOpenLavaAt(x, z)) return { x, z }
  }
  if (openCells.length === 0) return null
  const k = openCells[Math.floor(rand() * openCells.length)]
  const gx = k % LAVA_MASK_N, gz = Math.floor(k / LAVA_MASK_N)
  return { x: (gx + rand()) * LAVA_MASK_CELL_M, z: (gz + rand()) * LAVA_MASK_CELL_M }
}