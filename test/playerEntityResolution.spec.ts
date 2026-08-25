import {
  pickNewestId,
  selectNewestPerAddress,
  selectLivePerAddress,
  LIVENESS_WINDOW_MS,
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

describe('resolving duplicate avatar entities by observed liveness', () => {
  const NOW = 1_000_000
  const FRESH = NOW - 100 // well inside LIVENESS_WINDOW_MS
  const STALE = NOW - 5_000 // long past it
  const NEVER = 0 // never observed to advance

  describe('when no candidate has ever been observed to advance', () => {
    // The load-bearing degradation: with no liveness signal at all, this must return exactly
    // what the old max-id rule returned, so an unsampled index cannot change behaviour.
    it('should fall back to the highest raw id', () => {
      const resolved = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_35_V21, lastAdvancedMs: NEVER },
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: NEVER },
      ], NOW)
      expect(resolved.get('0xaaa')).toBe(pickNewestId([SLOT_35_V21, SLOT_37_V8]))
    })
  })

  describe('when one candidate is still streaming and the other is frozen', () => {
    it('should pick the streaming one even though it has the lower raw id', () => {
      const resolved = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_35_V21, lastAdvancedMs: STALE },
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: FRESH },
      ], NOW)
      expect(resolved.get('0xaaa')).toBe(SLOT_37_V8)
    })

    // This is the case max-id already got right; liveness must not regress it.
    it('should pick the streaming one when it has the higher raw id too', () => {
      const resolved = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_35_V22, lastAdvancedMs: FRESH },
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: STALE },
      ], NOW)
      expect(resolved.get('0xaaa')).toBe(SLOT_35_V22)
    })

    it('should not depend on iteration order', () => {
      const forwards = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_35_V21, lastAdvancedMs: STALE },
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: FRESH },
      ], NOW)
      const backwards = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: FRESH },
        { addr: '0xaaa', id: SLOT_35_V21, lastAdvancedMs: STALE },
      ], NOW)
      expect(forwards.get('0xaaa')).toBe(backwards.get('0xaaa'))
    })

    it('should prefer a never-observed entity over none, but a streaming one over it', () => {
      const resolved = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_35_V22, lastAdvancedMs: NEVER },
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: FRESH },
      ], NOW)
      expect(resolved.get('0xaaa')).toBe(SLOT_37_V8)
    })
  })

  describe('when both candidates are streaming', () => {
    it('should pick the more recently advanced one', () => {
      const resolved = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_35_V22, lastAdvancedMs: NOW - 300 },
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: NOW - 50 },
      ], NOW)
      expect(resolved.get('0xaaa')).toBe(SLOT_37_V8)
    })

    describe('and they advanced on the very same sample', () => {
      it('should break the tie on the highest raw id', () => {
        const resolved = selectLivePerAddress([
          { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: FRESH },
          { addr: '0xaaa', id: SLOT_35_V21, lastAdvancedMs: FRESH },
        ], NOW)
        expect(resolved.get('0xaaa')).toBe(SLOT_35_V21)
      })
    })
  })

  describe('when both candidates are stale but at different times', () => {
    // Neither is "live", so neither wins on freshness — but the less-ancient one is still the
    // better guess, and this must stay order-independent.
    it('should prefer the less ancient one', () => {
      const resolved = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_35_V22, lastAdvancedMs: NOW - 90_000 },
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: NOW - 4_000 },
      ], NOW)
      expect(resolved.get('0xaaa')).toBe(SLOT_37_V8)
    })
  })

  describe('when the sole candidate is frozen', () => {
    // A player standing perfectly still must not be resolved to null — there is no better
    // candidate, and dropping them would break every proximity read for them.
    it('should still resolve to it', () => {
      const resolved = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_35_V21, lastAdvancedMs: STALE },
      ], NOW)
      expect(resolved.get('0xaaa')).toBe(SLOT_35_V21)
    })
  })

  describe('when a liveness stamp is corrupt', () => {
    // Fail CLOSED: garbage must not manufacture liveness and outrank a genuinely live entity.
    it('should not treat a future-dated stamp as live', () => {
      const resolved = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_35_V21, lastAdvancedMs: NOW + 60_000 },
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: FRESH },
      ], NOW)
      expect(resolved.get('0xaaa')).toBe(SLOT_37_V8)
    })

    it('should not treat a non-finite stamp as live', () => {
      const resolved = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_35_V21, lastAdvancedMs: Number.NaN },
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: FRESH },
      ], NOW)
      expect(resolved.get('0xaaa')).toBe(SLOT_37_V8)
    })
  })

  describe('when the window is crossed exactly', () => {
    it('should count an entity at the window boundary as live', () => {
      const resolved = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: NOW - LIVENESS_WINDOW_MS },
      ], NOW)
      expect(resolved.get('0xaaa')).toBe(SLOT_37_V8)
    })

    it('should rank an entity one ms past the window below a live one', () => {
      const resolved = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_35_V22, lastAdvancedMs: NOW - LIVENESS_WINDOW_MS - 1 },
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: NOW - LIVENESS_WINDOW_MS },
      ], NOW)
      expect(resolved.get('0xaaa')).toBe(SLOT_37_V8)
    })
  })

  describe('when several addresses are present', () => {
    it('should resolve each independently', () => {
      const resolved = selectLivePerAddress([
        { addr: '0xaaa', id: SLOT_35_V21, lastAdvancedMs: STALE },
        { addr: '0xaaa', id: SLOT_37_V8, lastAdvancedMs: FRESH },
        { addr: '0xbbb', id: 900, lastAdvancedMs: NEVER },
      ], NOW)
      expect(resolved.get('0xaaa')).toBe(SLOT_37_V8)
      expect(resolved.get('0xbbb')).toBe(900)
    })
  })
})
