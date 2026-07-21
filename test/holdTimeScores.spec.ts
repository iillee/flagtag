import {
  mergeMonotonicHoldTimes,
  isScoreFromActiveRound,
  resolveInterpolationCarrier,
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

  describe('when a delayed score belongs to the previous round', () => {
    let accepted: boolean

    beforeEach(() => {
      accepted = isScoreFromActiveRound('round-previous', 'round-current')
    })

    afterEach(() => {
      accepted = false
    })

    it('should reject the stale score', () => {
      expect(accepted).toBe(false)
    })
  })

  describe('when a score belongs to the active round', () => {
    let accepted: boolean

    beforeEach(() => {
      accepted = isScoreFromActiveRound('round-current', 'round-current')
    })

    afterEach(() => {
      accepted = false
    })

    it('should accept the current score', () => {
      expect(accepted).toBe(true)
    })
  })

  describe('when no authoritative round has arrived during startup', () => {
    let accepted: boolean

    beforeEach(() => {
      accepted = isScoreFromActiveRound('boot-round', '')
    })

    afterEach(() => {
      accepted = false
    })

    it('should accept the boot-time replicated score', () => {
      expect(accepted).toBe(true)
    })
  })
})
