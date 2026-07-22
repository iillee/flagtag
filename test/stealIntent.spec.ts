import {
  type StealIntentStore,
  STEAL_INTENT_WINDOW_MS,
  recordStealIntent,
  hasRecentStealIntent,
  clearStealIntent,
  pruneStaleIntents,
} from '../src/server/stealIntent'

describe('proximity steal client corroboration', () => {
  let store: StealIntentStore
  let nowMs: number

  beforeEach(() => {
    store = new Map()
    nowMs = 2_000_000
  })

  afterEach(() => {
    store.clear()
  })

  describe('when a client recorded a steal intent', () => {
    beforeEach(() => {
      recordStealIntent(store, '0xAtTaCkEr', nowMs)
    })

    it('should corroborate a server-side steal within the window', () => {
      expect(hasRecentStealIntent(store, '0xattacker', nowMs + STEAL_INTENT_WINDOW_MS)).toBe(true)
    })

    it('should corroborate regardless of address casing', () => {
      expect(hasRecentStealIntent(store, '0xATTACKER', nowMs + 100)).toBe(true)
    })

    describe('and the corroboration window has elapsed', () => {
      it('should not corroborate the steal', () => {
        expect(hasRecentStealIntent(store, '0xattacker', nowMs + STEAL_INTENT_WINDOW_MS + 1)).toBe(false)
      })
    })

    describe('and the intent is cleared', () => {
      beforeEach(() => {
        clearStealIntent(store, '0xAttacker')
      })

      it('should not corroborate the steal', () => {
        expect(hasRecentStealIntent(store, '0xattacker', nowMs + 100)).toBe(false)
      })
    })

    describe('and a newer intent is recorded later', () => {
      beforeEach(() => {
        recordStealIntent(store, '0xattacker', nowMs + 10_000)
      })

      it('should corroborate based on the newest intent', () => {
        expect(hasRecentStealIntent(store, '0xattacker', nowMs + 10_000 + STEAL_INTENT_WINDOW_MS)).toBe(true)
      })
    })
  })

  describe('when no intent was ever recorded for the address', () => {
    it('should not corroborate the steal', () => {
      expect(hasRecentStealIntent(store, '0xnobody', nowMs)).toBe(false)
    })
  })

  describe('when pruning a store with mixed-age intents', () => {
    beforeEach(() => {
      recordStealIntent(store, '0xrecent', nowMs)
      recordStealIntent(store, '0xexpired', nowMs - STEAL_INTENT_WINDOW_MS - 1)
      pruneStaleIntents(store, nowMs)
    })

    it('should drop the expired intent', () => {
      expect(store.has('0xexpired')).toBe(false)
    })

    it('should keep the recent intent', () => {
      expect(store.has('0xrecent')).toBe(true)
    })
  })
})
