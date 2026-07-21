import {
  commitDailyLeaderboardReset,
  mutateDailyLeaderboardAfterRecovery,
  resetDailyLeaderboardAfterRecovery,
  type DailyLeaderboardResetCommit,
  type DailyLeaderboardResetLifecycle,
} from '../src/server/leaderboardLifecycle'

describe('daily leaderboard reset lifecycle', () => {
  describe('when persisted leaderboard data has not been loaded yet', () => {
    let loaded: boolean
    let calls: string[]
    let lifecycle: DailyLeaderboardResetLifecycle
    let recover: jest.MockedFunction<() => Promise<void>>
    let reset: jest.MockedFunction<() => Promise<boolean>>
    let expectedCalls: string[]

    beforeEach(() => {
      loaded = false
      calls = []
      expectedCalls = ['recover', 'reset']
      recover = jest.fn(async () => {
        calls.push('recover')
        loaded = true
      })
      reset = jest.fn(async () => {
        calls.push('reset')
        return false
      })
      lifecycle = { isLoaded: () => loaded, recover, reset }
    })

    afterEach(() => {
      calls = []
      jest.resetAllMocks()
    })

    it('should validate recovery before allowing the reset path to run', async () => {
      await resetDailyLeaderboardAfterRecovery(lifecycle)
      expect(calls).toEqual(expectedCalls)
    })
  })

  describe('when persisted leaderboard recovery rejects malformed data', () => {
    let lifecycle: DailyLeaderboardResetLifecycle
    let recoveryError: Error
    let recover: jest.MockedFunction<() => Promise<void>>
    let reset: jest.MockedFunction<() => Promise<boolean>>

    beforeEach(() => {
      recoveryError = new Error('Leaderboard JSON has an invalid shape')
      recover = jest.fn().mockRejectedValueOnce(recoveryError)
      reset = jest.fn().mockResolvedValueOnce(false)
      lifecycle = { isLoaded: () => false, recover, reset }
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject without permitting a destructive reset write', async () => {
      await resetDailyLeaderboardAfterRecovery(lifecycle).catch(() => undefined)
      expect(reset).not.toHaveBeenCalled()
    })
  })

  describe('when the leaderboard reset data write fails', () => {
    let commit: DailyLeaderboardResetCommit
    let calls: string[]
    let expectedCalls: string[]
    let writeError: Error

    beforeEach(() => {
      calls = []
      expectedCalls = ['persist-board']
      writeError = new Error('leaderboard write failed')
      commit = {
        persistEmptyLeaderboard: jest.fn(async () => {
          calls.push('persist-board')
          throw writeError
        }),
        persistResetDay: jest.fn(async () => { calls.push('persist-day') }),
        publishEmptyLeaderboard: jest.fn(() => { calls.push('publish-board') }),
        markResetDay: jest.fn(() => { calls.push('mark-day') }),
      }
    })

    afterEach(() => {
      calls = []
      jest.resetAllMocks()
    })

    it('should leave all published reset state untouched for a retry', async () => {
      await commitDailyLeaderboardReset(commit).catch(() => undefined)
      expect(calls).toEqual(expectedCalls)
    })
  })

  describe('when the reset-day write fails after clearing durable leaderboard data', () => {
    let commit: DailyLeaderboardResetCommit
    let calls: string[]
    let expectedCalls: string[]
    let writeError: Error

    beforeEach(() => {
      calls = []
      expectedCalls = ['persist-board', 'persist-day']
      writeError = new Error('reset-day write failed')
      commit = {
        persistEmptyLeaderboard: jest.fn(async () => { calls.push('persist-board') }),
        persistResetDay: jest.fn(async () => {
          calls.push('persist-day')
          throw writeError
        }),
        publishEmptyLeaderboard: jest.fn(() => { calls.push('publish-board') }),
        markResetDay: jest.fn(() => { calls.push('mark-day') }),
      }
    })

    afterEach(() => {
      calls = []
      jest.resetAllMocks()
    })

    it('should keep the reset unpublished so the next round retries it', async () => {
      await commitDailyLeaderboardReset(commit).catch(() => undefined)
      expect(calls).toEqual(expectedCalls)
    })
  })

  describe('when both durable reset writes succeed', () => {
    let commit: DailyLeaderboardResetCommit
    let calls: string[]
    let expectedCalls: string[]

    beforeEach(() => {
      calls = []
      expectedCalls = ['persist-board', 'persist-day', 'publish-board', 'mark-day']
      commit = {
        persistEmptyLeaderboard: jest.fn(async () => { calls.push('persist-board') }),
        persistResetDay: jest.fn(async () => { calls.push('persist-day') }),
        publishEmptyLeaderboard: jest.fn(() => { calls.push('publish-board') }),
        markResetDay: jest.fn(() => { calls.push('mark-day') }),
      }
    })

    afterEach(() => {
      calls = []
      jest.resetAllMocks()
    })

    it('should publish the reset only after storage is consistent', async () => {
      await commitDailyLeaderboardReset(commit)
      expect(calls).toEqual(expectedCalls)
    })
  })

  describe('when a round mutation starts with unloaded valid data from a previous day', () => {
    let loaded: boolean
    let calls: string[]
    let lifecycle: DailyLeaderboardResetLifecycle
    let mutate: jest.MockedFunction<() => Promise<void>>
    let expectedCalls: string[]

    beforeEach(async () => {
      loaded = false
      calls = []
      expectedCalls = ['recover', 'reset', 'mutate']
      lifecycle = {
        isLoaded: () => loaded,
        recover: jest.fn(async () => {
          calls.push('recover')
          loaded = true
        }),
        reset: jest.fn(async () => {
          calls.push('reset')
          return true
        }),
      }
      mutate = jest.fn(async () => { calls.push('mutate') })
      await mutateDailyLeaderboardAfterRecovery(lifecycle, mutate)
    })

    afterEach(() => {
      calls = []
      jest.resetAllMocks()
    })

    it('should recover and reset before applying the round update', () => {
      expect(calls).toEqual(expectedCalls)
    })
  })

  describe('when the calendar reset fails during a round mutation', () => {
    let lifecycle: DailyLeaderboardResetLifecycle
    let mutate: jest.MockedFunction<() => Promise<void>>
    let resetError: Error

    beforeEach(async () => {
      resetError = new Error('reset storage failed')
      lifecycle = {
        isLoaded: () => true,
        recover: jest.fn().mockResolvedValueOnce(undefined),
        reset: jest.fn().mockRejectedValueOnce(resetError),
      }
      mutate = jest.fn().mockResolvedValueOnce(undefined)
      await mutateDailyLeaderboardAfterRecovery(lifecycle, mutate).catch(() => undefined)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should prevent the round update from mixing data across days', () => {
      expect(mutate).not.toHaveBeenCalled()
    })
  })
})
