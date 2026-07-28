import {
  type StealIntentStore,
  type StealCandidate,
  type StealSelection,
  STEAL_INTENT_WINDOW_MS,
  recordStealIntent,
  hasRecentStealIntent,
  clearStealIntent,
  pruneStaleIntents,
  selectStealCandidate,
  isStealCorroborated,
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

describe('isStealCorroborated', () => {
  it('corroborates on client intent alone', () => {
    expect(isStealCorroborated({
      hasClientIntent: true,
      carrierHasFreshHeartbeat: false,
      candidateHasFreshHeartbeat: false,
    })).toBe(true)
  })

  it('corroborates on heartbeat-dual freshness alone', () => {
    // Closes the "steal doesn't work" playtest bug: a client with fully stalled
    // flag CRDT never sends requestSteal, but two independent WS heartbeats
    // agreeing on proximity is still trustworthy — heartbeats aren't
    // cross-wireable.
    expect(isStealCorroborated({
      hasClientIntent: false,
      carrierHasFreshHeartbeat: true,
      candidateHasFreshHeartbeat: true,
    })).toBe(true)
  })

  it('does NOT corroborate on carrier heartbeat alone (candidate might be a cross-wired ghost)', () => {
    expect(isStealCorroborated({
      hasClientIntent: false,
      carrierHasFreshHeartbeat: true,
      candidateHasFreshHeartbeat: false,
    })).toBe(false)
  })

  it('does NOT corroborate on candidate heartbeat alone (carrier position unverified)', () => {
    expect(isStealCorroborated({
      hasClientIntent: false,
      carrierHasFreshHeartbeat: false,
      candidateHasFreshHeartbeat: true,
    })).toBe(false)
  })

  it('does NOT corroborate when no signal at all', () => {
    expect(isStealCorroborated({
      hasClientIntent: false,
      carrierHasFreshHeartbeat: false,
      candidateHasFreshHeartbeat: false,
    })).toBe(false)
  })

  it('corroborates when both signals are present (belt and suspenders)', () => {
    expect(isStealCorroborated({
      hasClientIntent: true,
      carrierHasFreshHeartbeat: true,
      candidateHasFreshHeartbeat: true,
    })).toBe(true)
  })
})

describe('steal candidate selection', () => {
  let radius: number
  let corroborated: Set<string>
  let hasIntent: (addr: string) => boolean
  let candidates: StealCandidate[]
  let selection: StealSelection

  beforeEach(() => {
    radius = 1.8
    corroborated = new Set()
    hasIntent = (addr: string) => corroborated.has(addr)
    candidates = []
  })

  afterEach(() => {
    corroborated.clear()
    candidates = []
  })

  describe('when the closest in-radius candidate has client corroboration', () => {
    beforeEach(() => {
      corroborated.add('0xstealer')
      candidates = [
        { addr: '0xstealer', dist: 1.2 },
        { addr: '0xfar', dist: 5.0 },
      ]
      selection = selectStealCandidate(candidates, hasIntent, radius)
    })

    it('should select the corroborated candidate for the steal', () => {
      expect(selection.closestId).toBe('0xstealer')
    })

    it('should report no blocked candidate', () => {
      expect(selection.blockedId).toBeNull()
    })
  })

  describe('when an uncorroborated candidate is closer than a corroborated one', () => {
    beforeEach(() => {
      // Regression for the shadowing bug: a cross-wired ghost at a fake 0.85m
      // must not stop a real stealer at 1.5m from taking the flag.
      corroborated.add('0xrealstealer')
      candidates = [
        { addr: '0xcrosswiredghost', dist: 0.85 },
        { addr: '0xrealstealer', dist: 1.5 },
      ]
      selection = selectStealCandidate(candidates, hasIntent, radius)
    })

    it('should still select the corroborated candidate for the steal', () => {
      expect(selection.closestId).toBe('0xrealstealer')
    })

    it('should report the uncorroborated candidate as blocked', () => {
      expect(selection.blockedId).toBe('0xcrosswiredghost')
    })
  })

  describe('when no in-radius candidate has corroboration', () => {
    beforeEach(() => {
      candidates = [
        { addr: '0xcrosswiredghost', dist: 0.85 },
        { addr: '0xanotherghost', dist: 1.1 },
      ]
      selection = selectStealCandidate(candidates, hasIntent, radius)
    })

    it('should select nobody for the steal', () => {
      expect(selection.closestId).toBeNull()
    })

    it('should report the closest uncorroborated candidate as blocked', () => {
      expect(selection.blockedId).toBe('0xcrosswiredghost')
    })

    it('should report the blocked candidate distance for the log', () => {
      expect(selection.blockedDist).toBe(0.85)
    })
  })

  describe('when every candidate is outside the steal radius', () => {
    beforeEach(() => {
      corroborated.add('0xstealer')
      candidates = [
        { addr: '0xstealer', dist: 2.5 },
        { addr: '0xghost', dist: 3.0 },
      ]
      selection = selectStealCandidate(candidates, hasIntent, radius)
    })

    it('should select nobody for the steal', () => {
      expect(selection.closestId).toBeNull()
    })

    it('should report nobody as blocked', () => {
      expect(selection.blockedId).toBeNull()
    })
  })

  describe('when a corroborated candidate stands exactly at the radius boundary', () => {
    beforeEach(() => {
      corroborated.add('0xstealer')
      candidates = [{ addr: '0xstealer', dist: 1.8 }]
      selection = selectStealCandidate(candidates, hasIntent, radius)
    })

    it('should not select it (strictly-inside check, matching the previous behavior)', () => {
      expect(selection.closestId).toBeNull()
    })
  })
})
