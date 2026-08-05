import { isRateLimited, pruneExpiredTimestamps } from '../src/server/cooldownValidation'

// isRateLimited also backs flag steal immunity — checkProximitySteal and combat's
// isFlagImmune both call it with lastStealTime and STEAL_IMMUNITY_MS. These cases pin the
// properties those two rely on: the exact window boundary, a missing timestamp, and
// fail-closed behaviour on corrupt input. The abuse-cooldown suite below also calls
// isRateLimited, but only mid-window and only as part of testing prune-plus-persistence.
describe('rate limit window', () => {
  const COOLDOWN_MS = 3_000
  const NOW = 1_000_000

  describe('when the action has never happened', () => {
    it('should not be limited', () => {
      expect(isRateLimited(undefined, NOW, COOLDOWN_MS)).toBe(false)
    })
  })

  describe('when the action happened this instant', () => {
    it('should be limited', () => {
      expect(isRateLimited(NOW, NOW, COOLDOWN_MS)).toBe(true)
    })
  })

  describe('when the action happened one millisecond short of the cooldown', () => {
    it('should still be limited', () => {
      expect(isRateLimited(NOW - (COOLDOWN_MS - 1), NOW, COOLDOWN_MS)).toBe(true)
    })
  })

  // The boundary a steal depends on: at exactly STEAL_IMMUNITY_MS the carrier is stealable
  // again. An off-by-one here either shields the carrier a tick too long or exposes them a
  // tick too early.
  describe('when the action happened exactly the cooldown ago', () => {
    it('should no longer be limited', () => {
      expect(isRateLimited(NOW - COOLDOWN_MS, NOW, COOLDOWN_MS)).toBe(false)
    })
  })

  describe('when the action happened long ago', () => {
    it('should not be limited', () => {
      expect(isRateLimited(NOW - COOLDOWN_MS * 10, NOW, COOLDOWN_MS)).toBe(false)
    })
  })

  // Fail-safe direction: a corrupt timestamp must keep the limit ON. Open-coded
  // `now - NaN < cooldown` evaluates false, which would have ALLOWED the action.
  describe('when the recorded timestamp is not a finite number', () => {
    it('should stay limited for NaN', () => {
      expect(isRateLimited(NaN, NOW, COOLDOWN_MS)).toBe(true)
    })

    it('should stay limited for Infinity', () => {
      expect(isRateLimited(Infinity, NOW, COOLDOWN_MS)).toBe(true)
    })
  })

  describe('when the clock reading is not a finite number', () => {
    it('should stay limited', () => {
      expect(isRateLimited(NOW, NaN, COOLDOWN_MS)).toBe(true)
    })
  })

  describe('when the cooldown itself is invalid', () => {
    it('should stay limited for a negative cooldown', () => {
      expect(isRateLimited(NOW - 10, NOW, -1)).toBe(true)
    })

    it('should stay limited for a non-finite cooldown', () => {
      expect(isRateLimited(NOW - 10, NOW, NaN)).toBe(true)
    })
  })

  describe('when the cooldown is zero', () => {
    it('should not be limited even immediately after the action', () => {
      expect(isRateLimited(NOW, NOW, 0)).toBe(false)
    })
  })

  // A timestamp in the future (clock skew) yields a negative elapsed time, which is still
  // inside the window — the safe reading.
  describe('when the recorded timestamp is in the future', () => {
    it('should be limited', () => {
      expect(isRateLimited(NOW + 5_000, NOW, COOLDOWN_MS)).toBe(true)
    })
  })
})

describe('persistent abuse cooldowns', () => {
  describe('when a player reconnects before the cooldown expires', () => {
    let timestamps: Map<string, number>
    let nowMs: number
    let cooldownMs: number
    let playerId: string

    beforeEach(() => {
      playerId = '0xplayer'
      timestamps = new Map([[playerId, 1_000]])
      nowMs = 5_000
      cooldownMs = 10_000
    })

    afterEach(() => {
      timestamps.clear()
      nowMs = 0
      cooldownMs = 0
    })

    it('should retain the wallet timestamp during periodic pruning', () => {
      pruneExpiredTimestamps(timestamps, nowMs, cooldownMs)
      expect(timestamps.has(playerId)).toBe(true)
    })

    it('should continue rejecting another action from the wallet', () => {
      expect(isRateLimited(timestamps.get(playerId), nowMs, cooldownMs)).toBe(true)
    })
  })

  describe('when a wallet cooldown has expired', () => {
    let timestamps: Map<string, number>
    let nowMs: number
    let cooldownMs: number
    let playerId: string

    beforeEach(() => {
      playerId = '0xplayer'
      timestamps = new Map([[playerId, 1_000]])
      nowMs = 11_000
      cooldownMs = 10_000
    })

    afterEach(() => {
      timestamps.clear()
      nowMs = 0
      cooldownMs = 0
    })

    it('should remove the timestamp during periodic pruning', () => {
      pruneExpiredTimestamps(timestamps, nowMs, cooldownMs)
      expect(timestamps.has(playerId)).toBe(false)
    })
  })
})
