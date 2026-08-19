import {
  mergeMonotonicHoldTimes,
  resolveInterpolationCarrier,
  cappedInterpolationSeconds,
  isTrueScoreReset,
  INTERPOLATION_UNANCHORED_CAP_SEC,
  type InterpolationCarrierResolution
} from '../src/gameState/holdTimeScores'

describe('live scoreboard score merging', () => {
  describe('when an authoritative remote score has no replicated entity', () => {
    let synced: Map<string, number>
    let authoritative: Map<string, number>

    beforeEach(() => {
      synced = new Map<string, number>()
      authoritative = new Map<string, number>([['player-a', 7.5]])
      mergeMonotonicHoldTimes(synced, authoritative)
    })

    afterEach(() => {
      synced.clear()
      authoritative.clear()
    })

    it('should add the player with the authoritative score', () => {
      expect(synced.get('player-a')).toBe(7.5)
    })
  })

  describe('when a replicated score falls behind the authoritative score', () => {
    let synced: Map<string, number>
    let authoritative: Map<string, number>

    beforeEach(() => {
      synced = new Map<string, number>([['player-a', 0]])
      authoritative = new Map<string, number>([['player-a', 4.25]])
      mergeMonotonicHoldTimes(synced, authoritative)
    })

    afterEach(() => {
      synced.clear()
      authoritative.clear()
    })

    it('should preserve the authoritative score', () => {
      expect(synced.get('player-a')).toBe(4.25)
    })
  })

  describe('when a replicated score advances beyond the remembered score', () => {
    let synced: Map<string, number>
    let authoritative: Map<string, number>

    beforeEach(() => {
      synced = new Map<string, number>([['player-a', 9]])
      authoritative = new Map<string, number>([['player-a', 6]])
      mergeMonotonicHoldTimes(synced, authoritative)
    })

    afterEach(() => {
      synced.clear()
      authoritative.clear()
    })

    it('should remember the newer replicated score', () => {
      expect(authoritative.get('player-a')).toBe(9)
    })
  })

  describe('when CRDT still names the previous carrier after a steal', () => {
    let resolution: InterpolationCarrierResolution
    let nowMs: number

    beforeEach(() => {
      nowMs = 10_000
      resolution = resolveInterpolationCarrier('previous-carrier', 'confirmed-carrier', 9_000, nowMs)
    })

    afterEach(() => {
      resolution = { carrierId: '', confirmationExpired: false }
      nowMs = 0
    })

    it('should use the recently confirmed carrier', () => {
      expect(resolution.carrierId).toBe('confirmed-carrier')
    })

    it('should keep the confirmation active', () => {
      expect(resolution.confirmationExpired).toBe(false)
    })
  })

  describe('when the server confirmation has expired', () => {
    let resolution: InterpolationCarrierResolution
    let nowMs: number

    beforeEach(() => {
      nowMs = 20_000
      resolution = resolveInterpolationCarrier('replicated-carrier', 'old-confirmed-carrier', 10_000, nowMs)
    })

    afterEach(() => {
      resolution = { carrierId: '', confirmationExpired: false }
      nowMs = 0
    })

    it('should return to the replicated carrier', () => {
      expect(resolution.carrierId).toBe('replicated-carrier')
    })

    it('should mark the old confirmation as expired', () => {
      expect(resolution.confirmationExpired).toBe(true)
    })
  })

  // (isScoreFromActiveRound tests removed 2026-08-19 with the function — the flagHeartbeat
  // was its only round-id source.)
})

// Both rules below were inline in the engine-coupled flagHoldTime.ts until 2026-08-19. They
// exist to bound what the removed flagHeartbeat used to correct every second, and a regression
// in either is silent — the scoreboard just shows a wrong number.
describe('capping unanchored score interpolation', () => {
  describe('when the last CRDT anchor is recent', () => {
    it('should add the full elapsed time', () => {
      expect(cappedInterpolationSeconds(3)).toBeCloseTo(3, 5)
    })
  })

  // The stalled-CRDT / stale-carrier case: without the cap a carrier that only a stale Flag
  // CRDT claims exists accrues wall-clock seconds forever, and the monotonic display clamp
  // locks the invented total in for the rest of the round.
  describe('when nothing has re-anchored for far longer than the cap', () => {
    it('should freeze the display at the cap rather than keep inventing seconds', () => {
      expect(cappedInterpolationSeconds(600)).toBe(INTERPOLATION_UNANCHORED_CAP_SEC)
    })
  })

  describe('when elapsed time is negative', () => {
    it('should contribute nothing rather than move the score backwards', () => {
      expect(cappedInterpolationSeconds(-5)).toBe(0)
    })
  })

  describe('when elapsed time is not a finite number', () => {
    it('should contribute nothing', () => {
      expect(cappedInterpolationSeconds(NaN)).toBe(0)
    })
  })
})

describe('deciding whether a lower replicated score proves a round reset', () => {
  describe('when a lower nonzero value arrives', () => {
    it('should count as a true reset, so the display clamp may be cleared', () => {
      expect(isTrueScoreReset(4, 30)).toBe(true)
    })
  })

  // THE case this predicate exists for. Zero is what a stalled entity reads AND what an absent
  // entity reads, so treating it as a reset wipes the clamp for every player — collapsing
  // exactly the rows the clamp is holding up.
  describe('when the value drops to zero', () => {
    it('should not count as a reset, because zero means no information', () => {
      expect(isTrueScoreReset(0, 30)).toBe(false)
    })
  })

  describe('when the value has not dropped', () => {
    it('should not count as a reset', () => {
      expect(isTrueScoreReset(30, 30)).toBe(false)
    })
  })

  describe('when the value is not a finite number', () => {
    it('should not count as a reset', () => {
      expect(isTrueScoreReset(NaN, 30)).toBe(false)
    })
  })
})
