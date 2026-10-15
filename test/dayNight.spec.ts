import {
  ROUND_MS, DAY_NIGHT_BLEND_SEC, getDayPhaseAt, isNightAt, getNextPhaseChangeMs, getSkyboxSecondsAt
} from '../src/shared/dayNight'
import { getNextRoundEndTimeMs } from '../src/shared/dateUtils'

const H = 3600
const isDarkSky = (s: number) => s >= 19 * H || s < 5 * H

describe('round-locked day/night cycle', () => {
  const base = 1_000 * ROUND_MS // even round index -> day

  it('uses 5-minute rounds', () => {
    expect(ROUND_MS).toBe(300_000)
  })

  it('alternates day (even rounds) and night (odd rounds)', () => {
    expect(getDayPhaseAt(base)).toBe('day')
    expect(getDayPhaseAt(base + ROUND_MS)).toBe('night')
    expect(getDayPhaseAt(base + 2 * ROUND_MS)).toBe('day')
  })

  it('flips exactly on the round boundary', () => {
    expect(isNightAt(base + ROUND_MS - 1)).toBe(false)
    expect(isNightAt(base + ROUND_MS)).toBe(true)
    expect(isNightAt(base + 2 * ROUND_MS - 1)).toBe(true)
    expect(isNightAt(base + 2 * ROUND_MS)).toBe(false)
  })

  it('phase changes land on the same boundary as the round timer', () => {
    const realNow = Date.now
    try {
      for (const t of [base + 1, base + 123_456, base + ROUND_MS - 1]) {
        Date.now = () => t
        expect(getNextPhaseChangeMs(t)).toBe(getNextRoundEndTimeMs())
      }
    } finally {
      Date.now = realNow
    }
  })

  it('sky is bright for the whole day round until the dusk blend', () => {
    for (let s = 0; s < 300 - DAY_NIGHT_BLEND_SEC; s += 10) {
      const sky = getSkyboxSecondsAt(base + s * 1000)
      expect(sky).toBeGreaterThanOrEqual(7.5 * H)
      expect(sky).toBeLessThanOrEqual(16.5 * H)
    }
  })

  it('sky is dark for the whole night round until the dawn blend', () => {
    for (let s = 0; s < 300 - DAY_NIGHT_BLEND_SEC; s += 10) {
      expect(isDarkSky(getSkyboxSecondsAt(base + ROUND_MS + s * 1000))).toBe(true)
    }
  })

  it('sky is continuous across boundaries (blend ends exactly at the next start)', () => {
    expect(getSkyboxSecondsAt(base + ROUND_MS - 1)).toBeCloseTo(19.5 * H, -1)
    expect(getSkyboxSecondsAt(base + ROUND_MS)).toBeCloseTo(19.5 * H, 5)
    expect(getSkyboxSecondsAt(base + 2 * ROUND_MS - 1)).toBeCloseTo(7.5 * H, -1)
    expect(getSkyboxSecondsAt(base + 2 * ROUND_MS)).toBeCloseTo(7.5 * H, 5)
  })
})