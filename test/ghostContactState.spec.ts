/**
 * Tests for src/shared/ghostContactState.ts — the pure throttle helpers
 * behind the `ghostTouching` reduction (see docs/CRDT_SATURATION_REDUCTION.md).
 */
import {
  shouldSendGhostTouching,
  isTouchingHeld,
  GHOST_TOUCHING_SEND_INTERVAL_MS,
  GHOST_TOUCHING_HOLD_MS
} from '../src/shared/ghostContactState'

describe('shouldSendGhostTouching', () => {
  it('sends immediately for a first-time victim (no prior send)', () => {
    expect(shouldSendGhostTouching(1000, undefined, 200)).toBe(true)
  })

  it('suppresses a send within the interval', () => {
    expect(shouldSendGhostTouching(1100, 1000, 200)).toBe(false)
    expect(shouldSendGhostTouching(1199, 1000, 200)).toBe(false)
  })

  it('sends exactly at the interval boundary', () => {
    expect(shouldSendGhostTouching(1200, 1000, 200)).toBe(true)
  })

  it('sends after the interval has passed', () => {
    expect(shouldSendGhostTouching(2000, 1000, 200)).toBe(true)
  })
})

describe('isTouchingHeld', () => {
  it('is not held when never received', () => {
    expect(isTouchingHeld(1000, 0, 300)).toBe(false)
  })

  it('is held immediately after a message', () => {
    expect(isTouchingHeld(1000, 1000, 300)).toBe(true)
  })

  it('is held within the hold window', () => {
    expect(isTouchingHeld(1250, 1000, 300)).toBe(true)
    expect(isTouchingHeld(1299, 1000, 300)).toBe(true)
  })

  it('is released at exactly the hold boundary', () => {
    // strictly less-than: at boundary we're no longer held
    expect(isTouchingHeld(1300, 1000, 300)).toBe(false)
  })

  it('is released after the hold window expires', () => {
    expect(isTouchingHeld(2000, 1000, 300)).toBe(false)
  })
})

describe('constants', () => {
  it('hold window exceeds send interval so one dropped message is tolerated', () => {
    // If hold <= interval, a single dropped message drains the scare meter
    // between server sends. Margin protects the 3-second contact invariant.
    expect(GHOST_TOUCHING_HOLD_MS).toBeGreaterThan(GHOST_TOUCHING_SEND_INTERVAL_MS)
  })
})
