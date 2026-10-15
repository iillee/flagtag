import {
  ROUND_MS, LIGHTS_ON_SECONDS_BEFORE_NIGHT, LIGHTS_OFF_SECONDS_AFTER_DAWN, lightsEnabledAt, isNightAt
} from '../src/shared/dayNight'

describe('scene light window', () => {
  const day = 1_000 * ROUND_MS        // even round -> day
  const night = day + ROUND_MS        // odd round  -> night
  const nextDay = day + 2 * ROUND_MS
  const at = (roundStart: number, sec: number) => roundStart + sec * 1000

  it('uses 15 s round-relative offsets', () => {
    expect(LIGHTS_ON_SECONDS_BEFORE_NIGHT).toBe(15)
    expect(LIGHTS_OFF_SECONDS_AFTER_DAWN).toBe(15)
  })

  it('is off from 15 s until 285 s into the day round', () => {
    for (let s = 15; s < 285; s += 5) expect(lightsEnabledAt(at(day, s))).toBe(false)
  })

  it('turns on exactly 285 s into the day round', () => {
    expect(lightsEnabledAt(at(day, 285) - 1)).toBe(false)
    expect(lightsEnabledAt(at(day, 285))).toBe(true)
    expect(isNightAt(at(day, 285))).toBe(false)
  })

  it('stays on through the entire night round', () => {
    for (let s = 0; s < 300; s += 1) expect(lightsEnabledAt(at(night, s))).toBe(true)
  })

  it('turns off exactly 15 s into the next day round', () => {
    expect(lightsEnabledAt(at(nextDay, 0))).toBe(true)
    expect(lightsEnabledAt(at(nextDay, 15) - 1)).toBe(true)
    expect(lightsEnabledAt(at(nextDay, 15))).toBe(false)
  })
})
