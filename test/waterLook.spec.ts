import { SCENE_FLOOR_Y } from '../src/shared/constants'
import {
  WATER_SURFACE,
  WAVE_NORM,
  WAVE_PARTS,
  sampleWaveNorm,
  waterSurfaceDiameterM,
  waterSurfaceRadiusM,
  waveFade,
  waveSum,
} from '../src/shared/waterLook'

describe('waterLook', () => {
  it('keeps the historic moat footprint and drown height', () => {
    expect(WATER_SURFACE.centerX).toBe(400)
    expect(WATER_SURFACE.centerZ).toBe(400)
    expect(WATER_SURFACE.diameterM).toBe(800)
    expect(WATER_SURFACE.surfaceInsetM).toBe(64)
    expect(waterSurfaceDiameterM()).toBe(736)
    expect(waterSurfaceRadiusM()).toBe(368)
    expect(WATER_SURFACE.baseY).toBe(SCENE_FLOOR_Y + 1.58)
    expect(WATER_SURFACE.baseY).toBe(49.58)
    expect(WATER_SURFACE.floorBelowM).toBe(0.3)
  })

  it('uses tiny short-wavelength ripples, not ocean swells', () => {
    expect(WATER_SURFACE.amplitudeM).toBeGreaterThanOrEqual(0.05)
    expect(WATER_SURFACE.amplitudeM).toBeLessThanOrEqual(0.15)
    expect(WATER_SURFACE.heightScale).toBe(1)
    expect(WATER_SURFACE.periodS).toBeLessThanOrEqual(16)
    expect(WATER_SURFACE.trains.length).toBeGreaterThanOrEqual(2)
    for (const t of WATER_SURFACE.trains) {
      expect(t.wavelengthM).toBeGreaterThan(4)
      expect(t.wavelengthM).toBeLessThanOrEqual(32)
    }
  })

  it('normalises the train sum so crests stay near amplitudeM', () => {
    expect(WAVE_NORM).toBeCloseTo(sampleWaveNorm(WAVE_PARTS), 6)
    let hi = -Infinity
    for (let x = -40; x <= 40; x += 2) {
      for (let z = -40; z <= 40; z += 2) {
        for (let a = 0; a < 12; a++) {
          const y = waveSum(WAVE_PARTS, x, z, (a / 12) * Math.PI * 2) / WAVE_NORM
          if (y > hi) hi = y
        }
      }
    }
    expect(hi).toBeLessThanOrEqual(1.05)
    expect(hi).toBeGreaterThan(0.7)
  })

  it('eases wave height to zero at the rim', () => {
    expect(waveFade(0, 0)).toBe(1)
    expect(waveFade(waterSurfaceRadiusM(), 0)).toBe(0)
    const mid = waterSurfaceRadiusM() - WATER_SURFACE.fadeM / 2
    expect(waveFade(mid, 0)).toBeGreaterThan(0.2)
    expect(waveFade(mid, 0)).toBeLessThan(0.8)
  })
})
