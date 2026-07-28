/**
 * Tests for src/shared/flagFallThrottle.ts — pure decision helper for the
 * flag-fall CRDT quantization (docs/CRDT_SATURATION_REDUCTION.md priority 2).
 */
import {
  shouldWriteFallCrdt,
  FALL_CRDT_INTERVAL_MS
} from '../src/shared/flagFallThrottle'

describe('shouldWriteFallCrdt', () => {
  it('always writes on the landing frame regardless of throttle window', () => {
    // Even 1ms after the previous write, landing frame must promote so the
    // final rest position is authoritative. Otherwise a client sees the flag
    // hovering just above the ground for up to intervalMs.
    expect(shouldWriteFallCrdt(1001, 1000, 100, true)).toBe(true)
    expect(shouldWriteFallCrdt(1000, 1000, 100, true)).toBe(true)
  })

  it('writes on the first fall frame (no prior write)', () => {
    // lastWriteMs = 0 at start of a fall; the first frame's diff exceeds
    // any reasonable interval, so we promote immediately.
    expect(shouldWriteFallCrdt(1000, 0, 100, false)).toBe(true)
  })

  it('suppresses writes within the throttle window', () => {
    expect(shouldWriteFallCrdt(1050, 1000, 100, false)).toBe(false)
    expect(shouldWriteFallCrdt(1099, 1000, 100, false)).toBe(false)
  })

  it('writes exactly at the interval boundary', () => {
    expect(shouldWriteFallCrdt(1100, 1000, 100, false)).toBe(true)
  })

  it('writes after the interval has passed', () => {
    expect(shouldWriteFallCrdt(2000, 1000, 100, false)).toBe(true)
  })

  it('landing takes precedence even in a stale-clock edge case', () => {
    // Defensive: if nowMs < lastWriteMs (clock jump / test harness), the
    // landing signal must still override so we never miss the final write.
    expect(shouldWriteFallCrdt(500, 1000, 100, true)).toBe(true)
  })
})

describe('constants', () => {
  it('interval is 100ms (~10 Hz)', () => {
    // Trip-wire on future edits: if this ever changes the diagnostic label
    // ("~10 Hz") in flagLogic.ts should be updated to match.
    expect(FALL_CRDT_INTERVAL_MS).toBe(100)
  })
})
