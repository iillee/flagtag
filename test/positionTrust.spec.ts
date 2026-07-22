import {
  type HeartbeatStore,
  HEARTBEAT_FRESH_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  HEARTBEAT_RETENTION_MS,
  recordHeartbeat,
  getFreshHeartbeat,
  clearHeartbeat,
  isPlausibleHeartbeat,
  positionsDisagree,
  pruneStaleHeartbeats,
  activeAddressUnion,
} from '../src/server/positionTrust'

describe('position heartbeat trust store', () => {
  let store: HeartbeatStore
  let nowMs: number

  beforeEach(() => {
    store = new Map()
    nowMs = 1_000_000
  })

  afterEach(() => {
    store.clear()
  })

  describe('when a client reports a plausible position', () => {
    let accepted: boolean

    beforeEach(() => {
      accepted = recordHeartbeat(store, '0xAbC123', 372.5, 60.2, 349.9, nowMs)
    })

    it('should accept the sample', () => {
      expect(accepted).toBe(true)
    })

    it('should return the sample for a fresh read under a lowercased address', () => {
      expect(getFreshHeartbeat(store, '0xabc123', nowMs)).toEqual({ x: 372.5, y: 60.2, z: 349.9, t: nowMs })
    })

    describe('and a second sample arrives faster than the rate limit', () => {
      let secondAccepted: boolean

      beforeEach(() => {
        secondAccepted = recordHeartbeat(store, '0xabc123', 1, 60, 1, nowMs + HEARTBEAT_MIN_INTERVAL_MS - 1)
      })

      it('should reject the second sample', () => {
        expect(secondAccepted).toBe(false)
      })

      it('should keep the first sample readable', () => {
        expect(getFreshHeartbeat(store, '0xabc123', nowMs)?.x).toBe(372.5)
      })
    })

    describe('and a second sample arrives after the rate-limit interval', () => {
      let secondAccepted: boolean

      beforeEach(() => {
        secondAccepted = recordHeartbeat(store, '0xabc123', 380, 61, 350, nowMs + HEARTBEAT_MIN_INTERVAL_MS)
      })

      it('should accept the second sample', () => {
        expect(secondAccepted).toBe(true)
      })

      it('should replace the stored position with the newer one', () => {
        expect(getFreshHeartbeat(store, '0xabc123', nowMs + HEARTBEAT_MIN_INTERVAL_MS)?.x).toBe(380)
      })
    })

    describe('and the sample ages beyond the freshness window', () => {
      it('should return null instead of the stale sample', () => {
        expect(getFreshHeartbeat(store, '0xabc123', nowMs + HEARTBEAT_FRESH_MS + 1)).toBeNull()
      })
    })

    describe('and the heartbeat is cleared for that address', () => {
      beforeEach(() => {
        clearHeartbeat(store, '0xABC123')
      })

      it('should no longer return a sample', () => {
        expect(getFreshHeartbeat(store, '0xabc123', nowMs)).toBeNull()
      })
    })
  })

  describe('when a client reports non-finite coordinates', () => {
    let accepted: boolean

    beforeEach(() => {
      accepted = recordHeartbeat(store, '0xabc123', Number.NaN, 60, 349, nowMs)
    })

    it('should reject the sample', () => {
      expect(accepted).toBe(false)
    })

    it('should not store anything for the address', () => {
      expect(getFreshHeartbeat(store, '0xabc123', nowMs)).toBeNull()
    })
  })

  describe('when a client reports coordinates outside the world envelope', () => {
    let farXAccepted: boolean
    let deepYAccepted: boolean
    let negativeZAccepted: boolean

    beforeEach(() => {
      farXAccepted = recordHeartbeat(store, '0xaaa', 5000, 60, 349, nowMs)
      deepYAccepted = recordHeartbeat(store, '0xbbb', 372, -500, 349, nowMs)
      negativeZAccepted = recordHeartbeat(store, '0xccc', 372, 60, -5, nowMs)
    })

    it('should reject an X far beyond the world bounds', () => {
      expect(farXAccepted).toBe(false)
    })

    it('should reject a Y far below the scene floor', () => {
      expect(deepYAccepted).toBe(false)
    })

    it('should reject a negative Z', () => {
      expect(negativeZAccepted).toBe(false)
    })
  })

  describe('when validating plausibility directly', () => {
    let terrainPosition: [number, number, number]
    let infinitePosition: [number, number, number]

    beforeEach(() => {
      terrainPosition = [372.75, 60, 349.5]
      infinitePosition = [Number.POSITIVE_INFINITY, 60, 349]
    })

    it('should accept a position on the playable terrain', () => {
      expect(isPlausibleHeartbeat(...terrainPosition)).toBe(true)
    })

    it('should reject an infinite coordinate', () => {
      expect(isPlausibleHeartbeat(...infinitePosition)).toBe(false)
    })
  })

  describe('when building the active-address roster from CRDT and heartbeat sources', () => {
    let crdtAddresses: string[]
    let roster: Set<string>

    beforeEach(() => {
      crdtAddresses = ['0xCrdtOnly', '0xBoth']
      recordHeartbeat(store, '0xboth', 372, 60, 349, nowMs)
      recordHeartbeat(store, '0xhbonly', 380, 61, 350, nowMs)
      recordHeartbeat(store, '0xstalehb', 390, 62, 351, nowMs - HEARTBEAT_FRESH_MS - 1)
      roster = activeAddressUnion(crdtAddresses, store, nowMs)
    })

    it('should include a CRDT-only player lowercased', () => {
      expect(roster.has('0xcrdtonly')).toBe(true)
    })

    it('should include a heartbeat-only player whose entity never replicated', () => {
      expect(roster.has('0xhbonly')).toBe(true)
    })

    it('should not duplicate a player present in both sources', () => {
      expect(roster.size).toBe(3)
    })

    it('should exclude a player whose heartbeat went stale', () => {
      expect(roster.has('0xstalehb')).toBe(false)
    })
  })

  describe('when pruning a store with mixed-age entries', () => {
    let pruned: string[]

    beforeEach(() => {
      recordHeartbeat(store, '0xfresh', 372, 60, 349, nowMs)
      recordHeartbeat(store, '0xstale', 380, 61, 350, nowMs - HEARTBEAT_RETENTION_MS - 1)
      pruned = pruneStaleHeartbeats(store, nowMs)
    })

    it('should report the stale address as pruned', () => {
      expect(pruned).toEqual(['0xstale'])
    })

    it('should drop the stale entry from the store', () => {
      expect(store.has('0xstale')).toBe(false)
    })

    it('should keep the fresh entry in the store', () => {
      expect(store.has('0xfresh')).toBe(true)
    })
  })

  describe('when comparing two position readings for disagreement', () => {
    let closeA: { x: number; y: number; z: number }
    let closeB: { x: number; y: number; z: number }
    let farB: { x: number; y: number; z: number }

    beforeEach(() => {
      closeA = { x: 100, y: 60, z: 100 }
      closeB = { x: 101, y: 60.8, z: 100.5 }
      farB = { x: 130, y: 60, z: 100 }
    })

    it('should not flag readings within the threshold', () => {
      expect(positionsDisagree(closeA, closeB, 3)).toBe(false)
    })

    it('should flag readings beyond the threshold', () => {
      expect(positionsDisagree(closeA, farB, 3)).toBe(true)
    })
  })
})
