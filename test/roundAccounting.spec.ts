import { buildRoundAwardPlayers, type RoundPlayerScore } from '../src/server/roundAccounting'

describe('round award accounting', () => {
  describe('when a participant did not hold the flag', () => {
    let participants: Set<string>
    let scores: Map<string, number>
    let expected: RoundPlayerScore[]

    beforeEach(() => {
      participants = new Set(['0xparticipant'])
      scores = new Map()
      expected = [{ userId: '0xparticipant', seconds: 0 }]
    })

    afterEach(() => {
      participants.clear()
      scores.clear()
      expected = []
    })

    it('should include the player in round awards with zero hold time', () => {
      expect(buildRoundAwardPlayers(participants, scores)).toEqual(expected)
    })
  })

  describe('when a scorer disconnected before round end', () => {
    let participants: Set<string>
    let scores: Map<string, number>
    let expected: RoundPlayerScore[]

    beforeEach(() => {
      participants = new Set()
      scores = new Map([['0xscorer', 12.5]])
      expected = [{ userId: '0xscorer', seconds: 12.5 }]
    })

    afterEach(() => {
      participants.clear()
      scores.clear()
      expected = []
    })

    it('should preserve the scorer in round awards', () => {
      expect(buildRoundAwardPlayers(participants, scores)).toEqual(expected)
    })
  })
})
