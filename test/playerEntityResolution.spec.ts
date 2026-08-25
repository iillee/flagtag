import {
  pickNewestId,
  selectNewestPerAddress,
} from '../src/shared/playerEntityResolution'

// Real ids from the 2026-08-15 production log, packed as (number & 0xffff) | (version << 16).
const SLOT_35_V21 = 1376291 // #35 v21
const SLOT_35_V22 = 1441827 // #35 v22 — same slot, recycled once more
const SLOT_37_V8 = 524325 // #37 v8 — a DIFFERENT slot with a LOWER raw id

describe('picking one entity id among candidates', () => {
  describe('when there are no candidates', () => {
    it('should report that there is nothing to pick', () => {
      expect(pickNewestId([])).toBeNull()
    })
  })

  describe('when there is exactly one candidate', () => {
    it('should return it regardless of its version bits', () => {
      expect(pickNewestId([SLOT_35_V21])).toBe(SLOT_35_V21)
    })
  })

  describe('when the same slot was recycled', () => {
    // The one shape the rule gets right: same entity number, so comparing raw ids
    // compares versions, and the higher version really is the later occupant.
    it('should pick the higher version', () => {
      expect(pickNewestId([SLOT_35_V21, SLOT_35_V22])).toBe(SLOT_35_V22)
    })

    it('should not depend on the order the candidates arrive in', () => {
      expect(pickNewestId([SLOT_35_V22, SLOT_35_V21])).toBe(SLOT_35_V22)
    })
  })

  describe('and the player moved to a different slot with a lower raw id', () => {
    // KNOWN LIMITATION, pinned deliberately. 37 of 103 consecutive reallocations in the
    // 2026-08-15 log moved an address to a lower raw id, and in every one of those this
    // returns the CORPSE rather than the live entity. The rule sorts by version first
    // (high 16 bits) and version counts SLOT recycles, not when the occupant was assigned.
    //
    // If this expectation ever flips, the rule gained a real recency signal — update the
    // module header too, and check every caller still resolves consistently with it.
    it('should return the stale entity, because raw id ordering is not recency', () => {
      expect(pickNewestId([SLOT_35_V21, SLOT_37_V8])).toBe(SLOT_35_V21)
    })
  })
})

describe('resolving duplicate avatar entities per address', () => {
  describe('when every address has exactly one entity', () => {
    it('should map each address to that entity', () => {
      const resolved = selectNewestPerAddress([
        { addr: '0xaaa', id: 100 },
        { addr: '0xbbb', id: 200 },
      ])
      expect(resolved.get('0xaaa')).toBe(100)
      expect(resolved.get('0xbbb')).toBe(200)
    })

    it('should hold one entry per address', () => {
      const resolved = selectNewestPerAddress([
        { addr: '0xaaa', id: 100 },
        { addr: '0xbbb', id: 200 },
      ])
      expect(resolved.size).toBe(2)
    })
  })

  describe('when one address has a corpse entity alongside the live one', () => {
    it('should collapse it to a single entity', () => {
      const resolved = selectNewestPerAddress([
        { addr: '0xaaa', id: SLOT_35_V21 },
        { addr: '0xaaa', id: SLOT_35_V22 },
      ])
      expect(resolved.size).toBe(1)
    })

    it('should apply the same rule as a direct pick', () => {
      const resolved = selectNewestPerAddress([
        { addr: '0xaaa', id: SLOT_35_V21 },
        { addr: '0xaaa', id: SLOT_35_V22 },
      ])
      expect(resolved.get('0xaaa')).toBe(pickNewestId([SLOT_35_V21, SLOT_35_V22]))
    })

    // The property that matters at the call sites: the answer is a pure function of the
    // entity SET, never of iteration order. First-match — what seven lookups used to do —
    // fails exactly this, and `getEntitiesWith` walks a Map in insertion order, so
    // first-match resolved to the corpse deterministically rather than intermittently.
    it('should not depend on which entity is iterated first', () => {
      const forwards = selectNewestPerAddress([
        { addr: '0xaaa', id: SLOT_35_V21 },
        { addr: '0xaaa', id: SLOT_35_V22 },
      ])
      const backwards = selectNewestPerAddress([
        { addr: '0xaaa', id: SLOT_35_V22 },
        { addr: '0xaaa', id: SLOT_35_V21 },
      ])
      expect(forwards.get('0xaaa')).toBe(backwards.get('0xaaa'))
    })
  })

  describe('when a duplicated address sits alongside healthy ones', () => {
    it('should only collapse the duplicated address', () => {
      const resolved = selectNewestPerAddress([
        { addr: '0xaaa', id: SLOT_35_V21 },
        { addr: '0xbbb', id: 300 },
        { addr: '0xaaa', id: SLOT_35_V22 },
      ])
      expect(resolved.get('0xaaa')).toBe(SLOT_35_V22)
      expect(resolved.get('0xbbb')).toBe(300)
    })
  })

  describe('when there are no entities at all', () => {
    it('should resolve to an empty map', () => {
      expect(selectNewestPerAddress([]).size).toBe(0)
    })
  })

  describe('and the addresses differ only by casing', () => {
    // The resolver's callers lowercase before building entries; this pins that the pure
    // rule does NOT normalise, so a caller that forgets would silently get two entries.
    it('should treat differently-cased addresses as distinct keys', () => {
      const resolved = selectNewestPerAddress([
        { addr: '0xAAA', id: 100 },
        { addr: '0xaaa', id: 200 },
      ])
      expect(resolved.size).toBe(2)
    })
  })
})
