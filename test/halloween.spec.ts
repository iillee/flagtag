import {
  ROUND_MS, HALLOWEEN_MODE, HALLOWEEN_SKY_SUNSET, HALLOWEEN_SKY_PRE_SUNRISE, HALLOWEEN_SKY_PERIOD_MS,
  setHalloweenModeForTests, isNightAt, lightsEnabledAt, defaultMusicTapeIdAt,
  getSkyboxSecondsAt, halloweenSkyUnwrappedAt, isSkyMovingBackwardAt, skyStepIsBackward
} from '../src/shared/dayNight'

const H = 3600
const DAY = 86400
const END = HALLOWEEN_SKY_PRE_SUNRISE + DAY
const isNightSky = (s: number) => s >= HALLOWEEN_SKY_SUNSET - 1e-6 || s <= HALLOWEEN_SKY_PRE_SUNRISE + 1e-6
/** Shortest signed difference on the 24 h circle. */
const circDiff = (a: number, b: number) => ((a - b + DAY * 1.5) % DAY) - DAY / 2

describe('halloween mode', () => {
  beforeAll(() => setHalloweenModeForTests(true))
  const base = 5_000 * ROUND_MS // even round, aligned to the 2-round period

  it('is enabled by the flag and constants are as documented', () => {
    expect(HALLOWEEN_MODE).toBe(true)
    expect(HALLOWEEN_SKY_SUNSET).toBe(19.5 * H)
    expect(HALLOWEEN_SKY_PRE_SUNRISE).toBe(4.5 * H)
    expect(HALLOWEEN_SKY_PERIOD_MS).toBe(2 * ROUND_MS)
  })

  it('is always night for gameplay, lights and music', () => {
    for (let t = base; t < base + 4 * ROUND_MS; t += 7_000) {
      expect(isNightAt(t)).toBe(true)
      expect(lightsEnabledAt(t)).toBe(true)
      expect(defaultMusicTapeIdAt(t)).toBe('b')
    }
  })

  it('stays inside the night band (wraps through midnight, never daytime)', () => {
    let sawAfterMidnight = false
    for (let t = base; t < base + 2 * HALLOWEEN_SKY_PERIOD_MS; t += 1_000) {
      const s = getSkyboxSecondsAt(t)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(DAY)
      expect(isNightSky(s)).toBe(true)
      const u = halloweenSkyUnwrappedAt(t)
      expect(u).toBeGreaterThanOrEqual(HALLOWEEN_SKY_SUNSET - 1e-6)
      expect(u).toBeLessThanOrEqual(END + 1e-6)
      if (s < 12 * H) sawAfterMidnight = true
    }
    expect(sawAfterMidnight).toBe(true)
  })

  it('turns around on round boundaries: sunset at even, pre-sunrise at odd, midnight mid-sweep', () => {
    expect(getSkyboxSecondsAt(base)).toBeCloseTo(HALLOWEEN_SKY_SUNSET, 3)
    expect(getSkyboxSecondsAt(base + ROUND_MS)).toBeCloseTo(HALLOWEEN_SKY_PRE_SUNRISE, 3)
    expect(getSkyboxSecondsAt(base + 2 * ROUND_MS)).toBeCloseTo(HALLOWEEN_SKY_SUNSET, 3)
    // middle of the forward sweep is the midpoint (00:00 for 19:30..04:30)
    expect(halloweenSkyUnwrappedAt(base + ROUND_MS / 2)).toBeCloseTo((HALLOWEEN_SKY_SUNSET + END) / 2, 3)
  })

  it('forward on even rounds, backward on odd rounds', () => {
    for (let k = 0; k < 4; k++) {
      expect(isSkyMovingBackwardAt(base + k * ROUND_MS + 1_000)).toBe(k % 2 === 1)
      expect(isSkyMovingBackwardAt(base + k * ROUND_MS + ROUND_MS - 1_000)).toBe(k % 2 === 1)
    }
  })

  it('moves smoothly across midnight and round boundaries (no jumps)', () => {
    let prev = getSkyboxSecondsAt(base - 100)
    for (let t = base; t < base + 2 * HALLOWEEN_SKY_PERIOD_MS; t += 100) {
      const s = getSkyboxSecondsAt(t)
      expect(Math.abs(circDiff(s, prev))).toBeLessThan(30) // peak ~28 sky-s per 100 ms
      prev = s
    }
  })

  it('direction flag matches the actual (wrap-aware) motion', () => {
    for (let t = base + 2_000; t < base + HALLOWEEN_SKY_PERIOD_MS - 2_000; t += 3_000) {
      if (Math.abs((t - base) - ROUND_MS) < 2_000) continue // skip the turnaround itself
      const moved = circDiff(getSkyboxSecondsAt(t + 500), getSkyboxSecondsAt(t))
      expect(isSkyMovingBackwardAt(t)).toBe(moved < 0)
    }
  })

  it('never reaches daylight: stays within 19:30..04:30', () => {
    for (let t = base; t < base + HALLOWEEN_SKY_PERIOD_MS; t += 500) {
      const s = getSkyboxSecondsAt(t)
      expect(s >= 19.5 * H - 1e-6 || s <= 4.5 * H + 1e-6).toBe(true)
    }
  })

  it('simulated 10 Hz writes: every step is short and in the declared direction (no long way round)', () => {
    let last = Math.floor(getSkyboxSecondsAt(base - 100))
    let back = isSkyMovingBackwardAt(base - 100)
    let flips = 0
    for (let t = base; t < base + 2 * HALLOWEEN_SKY_PERIOD_MS; t += 100) {
      const next = Math.floor(getSkyboxSecondsAt(t))
      if (next === last) continue
      const nb = skyStepIsBackward(last, next, back)
      if (nb !== back) flips++
      // distance travelled in the declared direction
      const fwd = (next - last + DAY) % DAY
      const travelled = nb ? (DAY - fwd) % DAY : fwd
      expect(travelled).toBeLessThan(60)
      back = nb; last = next
    }
    expect(flips).toBe(4) // exactly one flip per turnaround over two periods
  })

  it('direction helper: follows the actual step, incl. wraparound', () => {
    expect(skyStepIsBackward(100, 101, true)).toBe(false)        // even 1 s steps set direction
    expect(skyStepIsBackward(100, 99, false)).toBe(true)
    expect(skyStepIsBackward(100, 100, true)).toBe(true)         // zero step keeps it
    expect(skyStepIsBackward(86390, 10, true)).toBe(false)       // forward across midnight
    expect(skyStepIsBackward(10, 86390, false)).toBe(true)       // backward across midnight
  })

  it('client-local: starts at sunset going forward from any join time', () => {
    for (const join of [base + 1234, base + ROUND_MS * 0.37, base + ROUND_MS * 1.5, 1_760_000_000_123]) {
      expect(getSkyboxSecondsAt(join, join)).toBeCloseTo(HALLOWEEN_SKY_SUNSET, 3)
      expect(isSkyMovingBackwardAt(join + 1_000, join)).toBe(false)
      expect(getSkyboxSecondsAt(join + 10_000, join)).toBeGreaterThan(HALLOWEEN_SKY_SUNSET)
      // pre-sunrise after half a period, back to sunset after a full one
      expect(getSkyboxSecondsAt(join + HALLOWEEN_SKY_PERIOD_MS / 2, join)).toBeCloseTo(HALLOWEEN_SKY_PRE_SUNRISE, 3)
      expect(isSkyMovingBackwardAt(join + HALLOWEEN_SKY_PERIOD_MS / 2 + 1_000, join)).toBe(true)
      expect(getSkyboxSecondsAt(join + HALLOWEEN_SKY_PERIOD_MS, join)).toBeCloseTo(HALLOWEEN_SKY_SUNSET, 3)
    }
  })

  it('normal mode ignores the join anchor (stays UTC-aligned)', () => {
    setHalloweenModeForTests(false)
    try {
      const t = base + 123_456
      expect(getSkyboxSecondsAt(t, t - 99_999)).toBe(getSkyboxSecondsAt(t))
      expect(isSkyMovingBackwardAt(t, t)).toBe(false)
    } finally { setHalloweenModeForTests(true) }
  })
})
