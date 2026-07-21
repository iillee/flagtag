import { buildScoreRoundId, createScoreSessionId } from '../src/server/scoreRoundId'

describe('score round identifiers', () => {
  describe('when the same server session builds the same round twice', () => {
    let firstId: string
    let secondId: string

    beforeEach(() => {
      firstId = buildScoreRoundId('session-a', 1_000)
      secondId = buildScoreRoundId('session-a', 1_000)
    })

    afterEach(() => {
      firstId = ''
      secondId = ''
    })

    it('should produce a stable identifier', () => {
      expect(firstId).toBe(secondId)
    })
  })

  describe('when two server sessions share one round boundary', () => {
    let firstId: string
    let secondId: string

    beforeEach(() => {
      firstId = buildScoreRoundId('session-a', 1_000)
      secondId = buildScoreRoundId('session-b', 1_000)
    })

    afterEach(() => {
      firstId = ''
      secondId = ''
    })

    it('should produce different identifiers', () => {
      expect(firstId).not.toBe(secondId)
    })
  })

  describe('when one server session advances to another round boundary', () => {
    let firstId: string
    let secondId: string

    beforeEach(() => {
      firstId = buildScoreRoundId('session-a', 1_000)
      secondId = buildScoreRoundId('session-a', 2_000)
    })

    afterEach(() => {
      firstId = ''
      secondId = ''
    })

    it('should produce different identifiers', () => {
      expect(firstId).not.toBe(secondId)
    })
  })

  describe('when two server lifetimes start in the same millisecond', () => {
    let firstSessionId: string
    let secondSessionId: string

    beforeEach(() => {
      firstSessionId = createScoreSessionId(1_000, 0.25)
      secondSessionId = createScoreSessionId(1_000, 0.75)
    })

    afterEach(() => {
      firstSessionId = ''
      secondSessionId = ''
    })

    it('should use entropy to keep the sessions distinct', () => {
      expect(firstSessionId).not.toBe(secondSessionId)
    })
  })
})
