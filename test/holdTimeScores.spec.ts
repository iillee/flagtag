import { mergeMonotonicHoldTimes } from '../src/gameState/holdTimeScores'

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
})
