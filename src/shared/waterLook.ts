/**
 * Flagtag water-surface look. Numbers only; `src/systems/waterSurface.ts`
 * reads them at runtime, `scripts/build-water-waves.ts` bakes the mesh.
 *
 * The look is ported from pixelwars (`dcl-pixelwars` waterLook + water.ts):
 * glossy PBR, a soft scrolling normal, and a morph-target `wave` clip made
 * of two sine trains. Amplitude is a tiny ripple (default 0.10 m), not the
 * 48–110 m swells. The footprint and drown height stay where they were:
 * a 736 m disk (800 m scene minus a 64 m inset) centered at (400, 400),
 * mean surface at SCENE_FLOOR_Y + 1.58.
 *
 * Changing amplitude, wavelength, step, fade, period/clip, or trains
 * requires `npx tsx scripts/build-water-waves.ts`. Colors, gloss, scroll,
 * alpha, heightScale, and the mobile switch are runtime knobs.
 */
import { SCENE_FLOOR_Y } from './constants'

export type WaterRgb = { r: number; g: number; b: number; a: number }

export type WaveTrain = {
  wavelengthM: number
  weight: number
  dirDeg: number
  phase: number
}

/** Midday tone from pixelwars HORIZON_TONES.midday.water. */
export const WATER_COLOR: WaterRgb = { r: 0.2, g: 0.4, b: 0.74, a: 1 }

/** Opaque bed under a slightly clear surface (pixelwars LOOK.depthColor). */
export const WATER_FLOOR_COLOR: WaterRgb = { r: 0.015, g: 0.06, b: 0.16, a: 1 }

export const WATER_SURFACE = {
  centerX: 400,
  centerZ: 400,
  /** Floor / scene span (m). */
  diameterM: 800,
  /** Surface is this many metres smaller than the floor on the diameter. */
  surfaceInsetM: 64,
  /** Mean surface Y. Drowning still uses this (the waves do not raise it). */
  baseY: SCENE_FLOOR_Y + 1.58,
  floorBelowM: 0.3,

  color: WATER_COLOR,
  floorColor: WATER_FLOOR_COLOR,
  metallic: 0,
  roughness: 0.48,
  specular: 0.4,
  gloss: true,
  glossRoughness: 0.3,
  glossSpecular: 0.9,
  glossReflectivity: { r: 0.55, g: 0.72, b: 0.86 },
  /** See-through onto the floor disk. */
  clear: true,
  clearAlpha: 0.88,

  /** Morph-target ripples. Off falls back to a flat cylinder. */
  waves: true,
  /** Half peak-to-trough (m). Baked into the GLB. */
  amplitudeM: 0.1,
  /** Runtime Y scale on the wave mesh only. 1 = baked amplitude. */
  heightScale: 1,
  /** Seconds for one clip cycle. Animator speed = clipS / periodS. */
  periodS: 10,
  /** Length of the `wave` clip baked into the GLB. */
  clipS: 10,
  /** Desktop radial step (m). Rebuild after changing. */
  stepM: 8,
  /** Mobile / lite radial step (m). */
  liteStepM: 16,
  /** Amplitude eases to 0 over this many metres at the rim, so a crest is not cut. */
  fadeM: 16,
  trains: [
    { wavelengthM: 22, weight: 0.62, dirDeg: 18, phase: 0.4 },
    { wavelengthM: 14, weight: 0.38, dirDeg: 55, phase: 1.7 },
  ] as WaveTrain[],
  meshSrc: 'assets/models/water-waves.glb',
  meshLiteSrc: 'assets/models/water-waves-lite.glb',

  softNormal: true,
  softNormalSrc: 'assets/textures/water-soft-normal.png',
  albedoSrc: 'assets/textures/water-white.png',
  /** Metres per normal-map repeat. Baked into TEXCOORD. Rebuild after changing. */
  softNormalTileM: 18,
  softNormalDirX: 1,
  softNormalDirZ: 0.25,
  /** UV repeats per second. At 18 m/repeat this is about 0.36 m/s. */
  softNormalSpeed: 0.02,
  /**
   * Mobile plays the lite morph clip when true. When false, mobile gets a
   * flat disk plus the scrolling normal only (cheapest).
   */
  mobileWaves: true,
} as const

export function waterSurfaceDiameterM(): number {
  return Math.max(16, WATER_SURFACE.diameterM - WATER_SURFACE.surfaceInsetM)
}

export function waterSurfaceRadiusM(): number {
  return waterSurfaceDiameterM() / 2
}

export type WavePart = {
  k: number
  dx: number
  dz: number
  weight: number
  phase: number
}

export function waveParts(trains: readonly WaveTrain[] = WATER_SURFACE.trains): WavePart[] {
  return trains.map((t) => {
    const rad = (t.dirDeg * Math.PI) / 180
    return {
      k: (Math.PI * 2) / t.wavelengthM,
      dx: Math.cos(rad),
      dz: Math.sin(rad),
      weight: t.weight,
      phase: t.phase,
    }
  })
}

export const WAVE_PARTS: WavePart[] = waveParts()

/** One morph shape. kind 0 is sin, kind 1 is cos, before the global scale. */
export function wavePartY(x: number, z: number, part: WavePart, kind: 0 | 1): number {
  const theta = part.k * (x * part.dx + z * part.dz) + part.phase
  return part.weight * (kind === 0 ? Math.sin(theta) : Math.cos(theta))
}

export function waveSum(parts: WavePart[], x: number, z: number, ang: number): number {
  let y = 0
  for (const part of parts) {
    const theta = part.k * (x * part.dx + z * part.dz) + part.phase + ang
    y += part.weight * Math.sin(theta)
  }
  return y
}

export function sampleWaveNorm(parts: WavePart[] = WAVE_PARTS, extent = 80, step = 4): number {
  let hi = -Infinity
  let lo = Infinity
  for (let z = -extent; z <= extent; z += step) {
    for (let x = -extent; x <= extent; x += step) {
      for (let a = 0; a < 24; a++) {
        const y = waveSum(parts, x, z, (a / 24) * Math.PI * 2)
        if (y > hi) hi = y
        if (y < lo) lo = y
      }
    }
  }
  return Math.max(hi, -lo, 1e-6)
}

export const WAVE_NORM = sampleWaveNorm()

export function waveFade(localX: number, localZ: number, radiusM = waterSurfaceRadiusM(), fadeM = WATER_SURFACE.fadeM): number {
  const d = Math.hypot(localX, localZ)
  const inner = Math.max(0, radiusM - fadeM)
  if (d <= inner) return 1
  if (d >= radiusM) return 0
  const t = (d - inner) / Math.max(1e-6, radiusM - inner)
  const x = Math.min(1, Math.max(0, t))
  return 1 - x * x * (3 - 2 * x)
}
