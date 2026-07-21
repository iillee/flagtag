import { isRateLimited, pruneExpiredTimestamps } from '../src/server/cooldownValidation'

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
