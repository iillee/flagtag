import {
  isValidLeaderboardJson,
  parseLeaderboardJsonSafe,
  parseLeaderboardJsonStrict,
  type LeaderboardEntry,
} from '../src/server/leaderboardData'

describe('leaderboard data validation', () => {
  describe('when persisted JSON contains valid entries', () => {
    let json: string
    let expected: LeaderboardEntry[]

    beforeEach(() => {
      expected = [{ userId: '0xabc', name: 'Alice', roundsWon: 3 }]
      json = JSON.stringify(expected)
    })

    afterEach(() => {
      json = ''
      expected = []
    })

    it('should return the validated leaderboard entries', () => {
      expect(parseLeaderboardJsonStrict(json)).toEqual(expected)
    })

    it('should report the payload as valid', () => {
      expect(isValidLeaderboardJson(json)).toBe(true)
    })
  })

  describe('when persisted JSON is valid JSON but not an array', () => {
    let json: string

    beforeEach(() => {
      json = '{}'
    })

    afterEach(() => {
      json = ''
    })

    it('should reject the payload on strict mutation paths', () => {
      expect(() => parseLeaderboardJsonStrict(json)).toThrow('invalid shape')
    })

    it('should return an empty leaderboard on display paths', () => {
      expect(parseLeaderboardJsonSafe(json)).toEqual([])
    })
  })

  describe('when an entry has an invalid win count', () => {
    let json: string

    beforeEach(() => {
      json = JSON.stringify([{ userId: '0xabc', name: 'Alice', roundsWon: -1 }])
    })

    afterEach(() => {
      json = ''
    })

    it('should report the payload as invalid', () => {
      expect(isValidLeaderboardJson(json)).toBe(false)
    })
  })
})
