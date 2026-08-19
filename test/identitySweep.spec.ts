import {
  type IdentitySweepEvent,
  entityNumberOf,
  entityVersionOf,
  describeEntityId,
  type AliasedPair,
  type AliasTrackEntry,
  diffIdentitySweep,
  trackAliasedPositions,
  ALIAS_EPSILON,
  ALIAS_MOVE_THRESHOLD,
  ALIAS_Y_TOLERANCE,
  ALIAS_LAG_EPSILON,
  ALIAS_LOCKSTEP_TOLERANCE,
  selectNewestPerAddress,
} from '../src/server/identitySweep'

describe('avatar entity id decoding', () => {
  // @dcl/ecs packs ids as (number & 0xffff) | (version << 16).
  describe('when the entity has never been recycled', () => {
    it('should report the raw number', () => {
      expect(entityNumberOf(33)).toBe(33)
    })

    it('should report version zero', () => {
      expect(entityVersionOf(33)).toBe(0)
    })

    it('should describe it without a recycle marker', () => {
      expect(describeEntityId(33)).toBe('33 (#33 v0)')
    })
  })

  // 65568 is the id from the 2026-08-04 playtest: slot #32 handed out a second time.
  describe('when the entity number was handed out again', () => {
    it('should recover the original slot number', () => {
      expect(entityNumberOf(65568)).toBe(32)
    })

    it('should report the incremented version', () => {
      expect(entityVersionOf(65568)).toBe(1)
    })

    it('should describe both halves for the log', () => {
      expect(describeEntityId(65568)).toBe('65568 (#32 v1)')
    })
  })

  describe('when the slot number is above the reserved-avatar range', () => {
    it('should still decode both halves', () => {
      expect(describeEntityId(70000)).toBe('70000 (#4464 v1)')
    })
  })
})

describe('avatar identity sweep diffing', () => {
  let lastSeen: Map<string, number>
  let events: IdentitySweepEvent[]

  beforeEach(() => {
    lastSeen = new Map()
    events = []
  })

  afterEach(() => {
    lastSeen.clear()
    events = []
  })

  describe('when an address is seen for the first time on a fresh entity', () => {
    beforeEach(() => {
      events = diffIdentitySweep(new Map([['0xalice', [33]]]), lastSeen)
    })

    it('should report nothing', () => {
      expect(events).toEqual([])
    })

    it('should start tracking the entity id', () => {
      expect(lastSeen.get('0xalice')).toBe(33)
    })
  })

  // The playtest case: the affected player was ALREADY on a recycled slot before the first
  // sweep, so a change-detector alone would have reported nothing at all.
  describe('when an address is seen for the first time on a recycled slot', () => {
    beforeEach(() => {
      events = diffIdentitySweep(new Map([['0xalice', [65568]]]), lastSeen)
    })

    it('should report it as recycled', () => {
      expect(events).toEqual([{ kind: 'recycled', addr: '0xalice', id: 65568 }])
    })
  })

  describe('when a tracked address keeps the same entity across sweeps', () => {
    beforeEach(() => {
      diffIdentitySweep(new Map([['0xalice', [33]]]), lastSeen)
      events = diffIdentitySweep(new Map([['0xalice', [33]]]), lastSeen)
    })

    it('should report nothing on the second sweep', () => {
      expect(events).toEqual([])
    })
  })

  describe("when a tracked address's entity id changes mid-session", () => {
    beforeEach(() => {
      diffIdentitySweep(new Map([['0xalice', [33]]]), lastSeen)
      events = diffIdentitySweep(new Map([['0xalice', [65569]]]), lastSeen)
    })

    it('should report it as reissued with both ids', () => {
      expect(events).toEqual([
        { kind: 'reissued', addr: '0xalice', prevId: 33, id: 65569 },
      ])
    })

    it('should track the new id', () => {
      expect(lastSeen.get('0xalice')).toBe(65569)
    })

    describe('and the next sweep sees the new id again', () => {
      beforeEach(() => {
        events = diffIdentitySweep(new Map([['0xalice', [65569]]]), lastSeen)
      })

      it('should not report it a second time', () => {
        expect(events).toEqual([])
      })
    })
  })

  describe('when an address has more than one entity', () => {
    beforeEach(() => {
      events = diffIdentitySweep(new Map([['0xalice', [33, 65568]]]), lastSeen)
    })

    it('should report the duplicate with every id', () => {
      expect(events).toEqual([
        { kind: 'duplicate', addr: '0xalice', ids: [33, 65568] },
      ])
    })

    // Recording a "current" id while two entities compete would flip-flop with engine
    // iteration order and emit a spurious reissued event on every single sweep.
    it('should not start tracking either id', () => {
      expect(lastSeen.has('0xalice')).toBe(false)
    })
  })

  describe('when a tracked address develops a duplicate', () => {
    beforeEach(() => {
      diffIdentitySweep(new Map([['0xalice', [33]]]), lastSeen)
      events = diffIdentitySweep(new Map([['0xalice', [33, 65568]]]), lastSeen)
    })

    it('should report the duplicate', () => {
      expect(events).toEqual([
        { kind: 'duplicate', addr: '0xalice', ids: [33, 65568] },
      ])
    })

    it('should leave the previously tracked id untouched', () => {
      expect(lastSeen.get('0xalice')).toBe(33)
    })

    describe('and the duplicate later resolves back to the original entity', () => {
      beforeEach(() => {
        events = diffIdentitySweep(new Map([['0xalice', [33]]]), lastSeen)
      })

      it('should report nothing, because the surviving entity is the tracked one', () => {
        expect(events).toEqual([])
      })
    })

    describe('and the duplicate later resolves to the other entity', () => {
      beforeEach(() => {
        events = diffIdentitySweep(new Map([['0xalice', [65568]]]), lastSeen)
      })

      it('should report the reissue against the pre-duplicate id', () => {
        expect(events).toEqual([
          { kind: 'reissued', addr: '0xalice', prevId: 33, id: 65568 },
        ])
      })
    })
  })

  // All three event kinds are edge-triggered. Without this, one lingering corpse entity emits
  // a line every sweep — ~86k lines/day for a single unchanging fact.
  describe('when a duplicate persists across sweeps with a signature map threaded through', () => {
    let signatures: Map<string, string>

    beforeEach(() => {
      signatures = new Map()
      events = diffIdentitySweep(new Map([['0xalice', [33, 65568]]]), lastSeen, signatures)
    })

    afterEach(() => {
      signatures.clear()
    })

    it('should report it on the first sweep', () => {
      expect(events).toHaveLength(1)
    })

    describe('and the same duplicate is seen again', () => {
      beforeEach(() => {
        events = diffIdentitySweep(new Map([['0xalice', [33, 65568]]]), lastSeen, signatures)
      })

      it('should not report it again', () => {
        expect(events).toEqual([])
      })
    })

    describe('and the duplicate gains a third entity', () => {
      beforeEach(() => {
        events = diffIdentitySweep(new Map([['0xalice', [33, 65568, 65569]]]), lastSeen, signatures)
      })

      it('should report the changed id set', () => {
        expect(events).toEqual([
          { kind: 'duplicate', addr: '0xalice', ids: [33, 65568, 65569] },
        ])
      })
    })

    describe('and the same ids arrive in a different iteration order', () => {
      beforeEach(() => {
        events = diffIdentitySweep(new Map([['0xalice', [65568, 33]]]), lastSeen, signatures)
      })

      it('should not report it again, because the signature is order-independent', () => {
        expect(events).toEqual([])
      })
    })

    describe('and the duplicate resolves to a single entity', () => {
      beforeEach(() => {
        diffIdentitySweep(new Map([['0xalice', [33]]]), lastSeen, signatures)
      })

      it('should forget the signature so a recurrence reports again', () => {
        expect(signatures.has('0xalice')).toBe(false)
      })
    })

    describe('and the address departs', () => {
      beforeEach(() => {
        diffIdentitySweep(new Map(), lastSeen, signatures)
      })

      it('should forget the signature', () => {
        expect(signatures.has('0xalice')).toBe(false)
      })
    })
  })

  describe('when a tracked address disappears', () => {
    beforeEach(() => {
      diffIdentitySweep(new Map([['0xalice', [33]]]), lastSeen)
      events = diffIdentitySweep(new Map(), lastSeen)
    })

    it('should report nothing', () => {
      expect(events).toEqual([])
    })

    it('should forget the address', () => {
      expect(lastSeen.has('0xalice')).toBe(false)
    })

    // Without the forget step a rejoin looks like a mid-session reissue, which would cry
    // wolf on every ordinary reconnect.
    describe('and that address later rejoins on a different entity', () => {
      beforeEach(() => {
        events = diffIdentitySweep(new Map([['0xalice', [34]]]), lastSeen)
      })

      it('should treat it as a first sight rather than a reissue', () => {
        expect(events).toEqual([])
      })
    })
  })

  describe('when several addresses are present at once', () => {
    beforeEach(() => {
      diffIdentitySweep(new Map([['0xalice', [33]], ['0xbob', [34]]]), lastSeen)
      events = diffIdentitySweep(
        new Map([
          ['0xalice', [65569]],
          ['0xbob', [34]],
          ['0xcarol', [65568]],
        ]),
        lastSeen
      )
    })

    // Order is not asserted: byAddr insertion order comes from engine entity iteration, so
    // pinning it would couple the spec to something the engine chooses arbitrarily.
    it('should report exactly two events', () => {
      expect(events).toHaveLength(2)
    })

    it('should report the address whose entity id changed as reissued', () => {
      expect(events).toContainEqual({ kind: 'reissued', addr: '0xalice', prevId: 33, id: 65569 })
    })

    it('should report the newly arrived recycled address as recycled', () => {
      expect(events).toContainEqual({ kind: 'recycled', addr: '0xcarol', id: 65568 })
    })

    it('should track every present address', () => {
      expect(lastSeen.size).toBe(3)
    })

    it('should track the reissued id for the changed address', () => {
      expect(lastSeen.get('0xalice')).toBe(65569)
    })

    it('should keep tracking the unchanged address', () => {
      expect(lastSeen.get('0xbob')).toBe(34)
    })

    it('should track the recycled id for the new address', () => {
      expect(lastSeen.get('0xcarol')).toBe(65568)
    })
  })

  // The exported signature permits an empty id list even though the only caller cannot
  // produce one. Without the guard, `ids[0]` would be undefined and get written into the
  // cache, poisoning the next sweep's comparison for that address.
  describe('when an address maps to an empty id list', () => {
    beforeEach(() => {
      events = diffIdentitySweep(new Map([['0xalice', []]]), lastSeen)
    })

    it('should report nothing', () => {
      expect(events).toEqual([])
    })

    it('should not record anything for that address', () => {
      expect(lastSeen.has('0xalice')).toBe(false)
    })
  })
})

// The cross-wire SYMPTOM detector: two distinct addresses tracking one player's position.
// Coincidence alone is NOT the signal — this scene parks players on shared fixed points and
// freezes them there (all three death respawns share one literal coordinate, the interior has
// a single ROOM_SPAWN). So the pair must also MOVE together across sweeps.
// The cross-wire SYMPTOM detector: two distinct addresses tracking one player's position.
// Coincidence alone is NOT the signal — this scene parks players on shared fixed points and
// freezes them there (all three death respawns share one literal coordinate, the interior has
// a single ROOM_SPAWN). So the pair must also MOVE together across sweeps, horizontally.
describe('position aliasing detection', () => {
  const AT = (addr: string, x: number, y = 0, z = 0) => ({ addr, x, y, z })
  let state: Map<string, AliasTrackEntry>
  let pairs: AliasedPair[]

  beforeEach(() => {
    state = new Map()
    pairs = []
  })

  afterEach(() => {
    state.clear()
    pairs = []
  })

  describe('when two addresses coincide on a single sweep', () => {
    beforeEach(() => {
      pairs = trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 10)], state)
    })

    it('should report nothing yet, because movement is not yet known', () => {
      expect(pairs).toEqual([])
    })

    it('should start tracking the pair', () => {
      expect(state.size).toBe(1)
    })
  })

  describe('when a coincident pair moves together between sweeps', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 10)], state)
      pairs = trackAliasedPositions([AT('0xalice', 15), AT('0xbob', 15)], state)
    })

    it('should report the pair', () => {
      expect(pairs).toEqual([{ a: '0xalice', b: '0xbob', dist: 0, dy: 0 }])
    })

    // Edge-triggered: a persistent cross-wire must not emit a line every second forever.
    describe('and they keep moving together on later sweeps', () => {
      beforeEach(() => {
        pairs = trackAliasedPositions([AT('0xalice', 25), AT('0xbob', 25)], state)
      })

      it('should not report the same pair again', () => {
        expect(pairs).toEqual([])
      })
    })

    describe('and they later separate, then coincide and move again', () => {
      beforeEach(() => {
        trackAliasedPositions([AT('0xalice', 25), AT('0xbob', 90)], state)
        trackAliasedPositions([AT('0xalice', 30), AT('0xbob', 30)], state)
        pairs = trackAliasedPositions([AT('0xalice', 40), AT('0xbob', 40)], state)
      })

      it('should report the recurrence', () => {
        expect(pairs).toHaveLength(1)
      })
    })
  })

  // THE case this detector exists for. Every recorded instance of the cross-wire shows XZ
  // tracking in lockstep with a consistent ~0.8m Y offset — the Babylon capsule-center anchor.
  // A full-3D comparison against a 0.05m epsilon is silent on it.
  describe('when addresses track in XZ with the recorded ~0.85m capsule-anchor Y offset', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 10, 60.6, 30), AT('0xbob', 10, 61.45, 30)], state)
      pairs = trackAliasedPositions([AT('0xalice', 20, 60.6, 30), AT('0xbob', 20, 61.45, 30)], state)
    })

    it('should report the pair', () => {
      expect(pairs).toHaveLength(1)
    })

    it('should surface the vertical offset so the anchor fingerprint is visible in the log', () => {
      expect(pairs[0].dy).toBeCloseTo(-0.85, 2)
    })
  })

  // Movement must be measured HORIZONTALLY, matching the coincidence test. If Y counted, the
  // 1m vertical window would supply the coincidence while vertical motion supplied the
  // "it's moving" evidence — and these three real situations would all be reported.
  describe('when two players ride the same updraft, pinned in XZ and lifted together', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 10, 60, 10), AT('0xbob', 10.004, 60.3, 10)], state)
      pairs = trackAliasedPositions([AT('0xalice', 10, 65, 10), AT('0xbob', 10.004, 65.3, 10)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  describe('when one player jumps in place inside a stationary player', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 10, 60, 10), AT('0xbob', 10, 60.9, 10)], state)
      pairs = trackAliasedPositions([AT('0xalice', 10, 60, 10), AT('0xbob', 10, 60.05, 10)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  // Entity iteration order decides which member's position is stored. With Y in the movement
  // test, a swap on a stationary pair made the stored delta the 0.85 fingerprint itself —
  // reporting a cross-wire for two players merely standing still, decided by a coin flip.
  describe('when a stationary pair at the fingerprint offset swaps iteration order', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 10, 60, 10), AT('0xbob', 10, 60.85, 10)], state)
      pairs = trackAliasedPositions([AT('0xbob', 10, 60.85, 10), AT('0xalice', 10, 60, 10)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  describe('when addresses coincide in XZ but the height gap exceeds the tolerance', () => {
    beforeEach(() => {
      const gap = ALIAS_Y_TOLERANCE * 2
      trackAliasedPositions([AT('0xalice', 10, 20, 30), AT('0xbob', 10, 20 + gap, 30)], state)
      pairs = trackAliasedPositions([AT('0xalice', 20, 20, 30), AT('0xbob', 20, 20 + gap, 30)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  // A Y allowance must not become an all-directions allowance.
  describe('when addresses share a height but are horizontally apart along X', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 10, 20, 30), AT('0xbob', 10.5, 20, 30)], state)
      pairs = trackAliasedPositions([AT('0xalice', 20, 20, 30), AT('0xbob', 20.5, 20, 30)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  describe('when addresses are horizontally apart along Z', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 10, 20, 30), AT('0xbob', 10, 20, 30.5)], state)
      pairs = trackAliasedPositions([AT('0xalice', 20, 20, 30), AT('0xbob', 20, 20, 30.5)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  // This is the false positive that made a coincidence-only detector unusable: the three death
  // respawns all teleport to (385, 96, 392) and hold the avatar there with input disabled.
  describe('when two addresses are parked at the same fixed point without moving', () => {
    beforeEach(() => {
      for (let sweep = 0; sweep < 10; sweep++) {
        pairs = trackAliasedPositions(
          [AT('0xalice', 385, 96, 392), AT('0xbob', 385, 96, 392)], state)
      }
    })

    it('should report nothing across the whole freeze', () => {
      expect(pairs).toEqual([])
    })
  })

  describe('when two addresses idle at one point with only float jitter', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 100), AT('0xbob', 100)], state)
      pairs = trackAliasedPositions([AT('0xalice', 100.01), AT('0xbob', 100.01)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  describe('when a coincident pair moves less than the movement threshold', () => {
    beforeEach(() => {
      const step = ALIAS_MOVE_THRESHOLD * 0.5
      trackAliasedPositions([AT('0xalice', 100), AT('0xbob', 100)], state)
      pairs = trackAliasedPositions([AT('0xalice', 100 + step), AT('0xbob', 100 + step)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  // Pins the movement threshold as a DISTANCE, not a squared distance. 0.6 m sits above
  // ALIAS_MOVE_THRESHOLD (0.5) but below sqrt(0.5) ~ 0.707, so comparing against an unsquared
  // threshold would silently require ~40% more movement before a real cross-wire is reported.
  describe('when a coincident pair moves just past the threshold but less than its square root', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 0), AT('0xbob', 0)], state)
      pairs = trackAliasedPositions([AT('0xalice', 0.6), AT('0xbob', 0.6)], state)
    })

    it('should report the pair', () => {
      expect(pairs).toHaveLength(1)
    })
  })

  // Both horizontal axes must count. Every other movement case travels along X, so a dropped Z
  // term would go unnoticed and a cross-wired pair walking north-south would never be reported.
  describe('when a coincident pair moves together along Z only', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 5, 60, 10), AT('0xbob', 5, 60.85, 10)], state)
      pairs = trackAliasedPositions([AT('0xalice', 5, 60, 25), AT('0xbob', 5, 60.85, 25)], state)
    })

    it('should report the pair', () => {
      expect(pairs).toHaveLength(1)
    })
  })

  describe('when a coincident pair moves together diagonally', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 0, 60, 0), AT('0xbob', 0, 60.85, 0)], state)
      pairs = trackAliasedPositions([AT('0xalice', 4, 60, 4), AT('0xbob', 4, 60.85, 4)], state)
    })

    it('should report the pair', () => {
      expect(pairs).toHaveLength(1)
    })
  })

  // The tracked position must advance each sweep, so movement is measured PER SWEEP rather than
  // cumulatively from first sighting. Otherwise two players idling on a shared point with a slow
  // drift eventually accumulate past the threshold and get reported as a cross-wire.
  describe('when a coincident pair drifts slowly, never moving far within one sweep', () => {
    beforeEach(() => {
      const step = ALIAS_MOVE_THRESHOLD * 0.4
      for (let sweep = 0; sweep < 10; sweep++) {
        const x = 100 + step * sweep
        pairs = trackAliasedPositions([AT('0xalice', x), AT('0xbob', x)], state)
        if (pairs.length > 0) break
      }
    })

    it('should never report them, however far they drift in total', () => {
      expect(pairs).toEqual([])
    })
  })

  describe('when two addresses differ by less than float noise and move together', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 10.001)], state)
      pairs = trackAliasedPositions([AT('0xalice', 20), AT('0xbob', 20.001)], state)
    })

    it('should report the pair', () => {
      expect(pairs).toHaveLength(1)
    })
  })

  // Players standing next to each other is ordinary gameplay — avatars have no player-player
  // collision, so they can legitimately overlap.
  describe('when two addresses are merely adjacent while both moving', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 10.5)], state)
      pairs = trackAliasedPositions([AT('0xalice', 20), AT('0xbob', 20.5)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  // Pins epsilon as a DISTANCE, not a squared distance. 0.1 m sits above ALIAS_EPSILON (0.05)
  // but below sqrt(0.05) ~ 0.224, so an unsquared threshold would wrongly flag two players
  // standing 10 cm apart as a cross-wire.
  describe('when two addresses are closer than the square root of epsilon but farther than epsilon', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 0), AT('0xbob', 0.1)], state)
      pairs = trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 10.1)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  // Checked on ONE sweep at ONE position: exact-boundary coincidence is not translation-invariant
  // in floating point — the same 0.05 m separation measured at x=10 yields
  // (10.05-10)^2 = 0.002500000000000071, which exceeds 0.05^2 — so a test that moves a knife-edge
  // pair asserts float luck rather than behaviour.
  describe('when two addresses sit exactly at the epsilon boundary', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 0), AT('0xbob', ALIAS_EPSILON)], state)
    })

    it('should treat them as coincident and start tracking the pair', () => {
      expect(state.size).toBe(1)
    })
  })

  describe('when two addresses are comfortably inside epsilon and move together', () => {
    beforeEach(() => {
      const gap = ALIAS_EPSILON * 0.5
      trackAliasedPositions([AT('0xalice', 0), AT('0xbob', gap)], state)
      pairs = trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 10 + gap)], state)
    })

    it('should report the pair', () => {
      expect(pairs).toHaveLength(1)
    })
  })

  describe('when two addresses sit just beyond the epsilon boundary', () => {
    beforeEach(() => {
      const gap = ALIAS_EPSILON * 1.5
      trackAliasedPositions([AT('0xalice', 0), AT('0xbob', gap)], state)
      pairs = trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 10 + gap)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  // Duplicate entities put one address in `entries` twice. That is the sibling detector's job,
  // and it must not double-report the logical pair it forms with a third address.
  describe('when one address has duplicate entities alongside a genuinely aliased address', () => {
    beforeEach(() => {
      const sweep = (x: number) => [AT('0xalice', x), AT('0xalice', x), AT('0xbob', x)]
      trackAliasedPositions(sweep(10), state)
      pairs = trackAliasedPositions(sweep(20), state)
    })

    it('should report the alice/bob pair exactly once', () => {
      expect(pairs).toEqual([{ a: '0xalice', b: '0xbob', dist: 0, dy: 0 }])
    })

    it('should not track an alice/alice pair', () => {
      expect(state.size).toBe(1)
    })
  })

  describe('when the same address appears twice and nothing else', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 10), AT('0xalice', 10)], state)
      pairs = trackAliasedPositions([AT('0xalice', 20), AT('0xalice', 20)], state)
    })

    it('should report nothing, because that is duplicate entities rather than aliasing', () => {
      expect(pairs).toEqual([])
    })
  })

  describe('when three addresses all coincide and move together', () => {
    beforeEach(() => {
      const sweep = (x: number) => [AT('0xa', x), AT('0xb', x), AT('0xc', x)]
      trackAliasedPositions(sweep(1), state)
      pairs = trackAliasedPositions(sweep(10), state)
    })

    it('should report each unordered pair exactly once', () => {
      expect(pairs).toHaveLength(3)
    })
  })

  describe('when a tracked pair stops being coincident', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 10)], state)
      trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 90)], state)
    })

    it('should forget the pair', () => {
      expect(state.size).toBe(0)
    })
  })

  describe('when only one address is present', () => {
    beforeEach(() => {
      pairs = trackAliasedPositions([AT('0xalice', 0)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  describe('when no addresses are present', () => {
    beforeEach(() => {
      pairs = trackAliasedPositions([], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  describe('when the epsilon is negative', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 0), AT('0xbob', 0)], state, -1)
      pairs = trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 10)], state, -1)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })

    it('should not accumulate state', () => {
      expect(state.size).toBe(0)
    })
  })

  describe('when the epsilon is not a finite number', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 0), AT('0xbob', 0)], state, NaN)
      pairs = trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 10)], state, NaN)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  describe('when the move threshold is not a finite number', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 0), AT('0xbob', 0)], state, ALIAS_EPSILON, NaN)
      pairs = trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 10)], state, ALIAS_EPSILON, NaN)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })
})

// The LAGGED tier: a cross-wired stream that trails its source by a comms snapshot sits
// 0.3-1m behind at run speed, so the exact tier above is structurally blind to it while
// moving (the 2026-08-19 playtest: cross-wire symptoms, zero 🔗 lines). This tier trades a
// loose coincidence window for a movement-vector lockstep requirement.
describe('lagged-tier position aliasing detection', () => {
  const AT = (addr: string, x: number, y = 0, z = 0) => ({ addr, x, y, z })
  const lagTrack = (entries: { addr: string; x: number; y: number; z: number }[], s: Map<string, AliasTrackEntry>) =>
    trackAliasedPositions(entries, s, ALIAS_LAG_EPSILON, ALIAS_MOVE_THRESHOLD, ALIAS_Y_TOLERANCE, ALIAS_LOCKSTEP_TOLERANCE)
  let state: Map<string, AliasTrackEntry>
  let pairs: AliasedPair[]

  beforeEach(() => {
    state = new Map()
    pairs = []
  })

  afterEach(() => {
    state.clear()
    pairs = []
  })

  // THE case this tier exists for: a copy trailing its source by ~0.6m, both replaying the
  // same walk. The exact tier never even starts tracking it (0.6 > ALIAS_EPSILON).
  describe('when a copy trails its source by half a meter and both move in lockstep', () => {
    beforeEach(() => {
      lagTrack([AT('0xalice', 10), AT('0xbob', 9.4)], state)
      pairs = lagTrack([AT('0xalice', 15), AT('0xbob', 14.4)], state)
    })

    it('should report the pair', () => {
      expect(pairs).toHaveLength(1)
    })

    it('should surface the offset distance for triage', () => {
      expect(pairs[0].dist).toBeCloseTo(0.6, 3)
    })

    describe('and the exact tier sees the same sweeps', () => {
      let exactState: Map<string, AliasTrackEntry>
      let exactPairs: AliasedPair[]

      beforeEach(() => {
        exactState = new Map()
        trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 9.4)], exactState)
        exactPairs = trackAliasedPositions([AT('0xalice', 15), AT('0xbob', 14.4)], exactState)
      })

      afterEach(() => {
        exactState.clear()
      })

      it('should report nothing, which is the blind spot this tier closes', () => {
        expect(exactPairs).toEqual([])
      })
    })

    describe('and they keep moving in lockstep on later sweeps', () => {
      beforeEach(() => {
        pairs = lagTrack([AT('0xalice', 20), AT('0xbob', 19.4)], state)
      })

      it('should not report the same pair again', () => {
        expect(pairs).toEqual([])
      })
    })
  })

  // A chase is the false positive this tier must reject: nearby, both moving, but steering
  // independently — the displacement vectors diverge past the lockstep tolerance.
  describe('when a chaser stays within the window but steers a diverging path', () => {
    beforeEach(() => {
      lagTrack([AT('0xalice', 10, 0, 10), AT('0xbob', 10.9, 0, 10)], state)
      pairs = lagTrack([AT('0xalice', 15, 0, 10), AT('0xbob', 15.5, 0, 10.7)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  describe('when only one side of a nearby pair moves', () => {
    beforeEach(() => {
      lagTrack([AT('0xalice', 10, 0, 10), AT('0xbob', 10.6, 0, 10)], state)
      pairs = lagTrack([AT('0xalice', 10.8, 0, 10), AT('0xbob', 10.6, 0, 10)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })
  })

  describe('when two addresses move in lockstep but sit outside the lag window', () => {
    beforeEach(() => {
      lagTrack([AT('0xalice', 10), AT('0xbob', 11.5)], state)
      pairs = lagTrack([AT('0xalice', 15), AT('0xbob', 16.5)], state)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })

    it('should not track the pair at all', () => {
      expect(state.size).toBe(0)
    })
  })

  // Sides are keyed by address, not by iteration order: a naive slot assignment would measure
  // alice-now against bob-prev when the entry order swaps between sweeps, and this genuinely
  // lockstepped pair would be missed.
  describe('when the entry order swaps between sweeps of a lockstepped pair', () => {
    beforeEach(() => {
      lagTrack([AT('0xalice', 10), AT('0xbob', 9.4)], state)
      pairs = lagTrack([AT('0xbob', 14.4), AT('0xalice', 15)], state)
    })

    it('should still report the pair', () => {
      expect(pairs).toHaveLength(1)
    })
  })

  describe('when the lockstep tolerance is not a finite number', () => {
    beforeEach(() => {
      trackAliasedPositions([AT('0xalice', 10), AT('0xbob', 9.4)], state,
        ALIAS_LAG_EPSILON, ALIAS_MOVE_THRESHOLD, ALIAS_Y_TOLERANCE, NaN)
      pairs = trackAliasedPositions([AT('0xalice', 15), AT('0xbob', 14.4)], state,
        ALIAS_LAG_EPSILON, ALIAS_MOVE_THRESHOLD, ALIAS_Y_TOLERANCE, NaN)
    })

    it('should report nothing', () => {
      expect(pairs).toEqual([])
    })

    it('should not accumulate state', () => {
      expect(state.size).toBe(0)
    })
  })
})

// Duplicate avatar entities must resolve to ONE per address before anything samples a position.
// recordPlayerPositions used to sample per ENTITY into a per-ADDRESS history, so a stale corpse
// entity's positions were interleaved with the live player's — and wasWithinRadius accepts if ANY
// sample matches, letting the corpse authorize projectile hits and client action positions.
describe('resolving duplicate avatar entities to one per address', () => {
  let newest: Map<string, number>

  beforeEach(() => {
    newest = new Map()
  })

  afterEach(() => {
    newest.clear()
  })

  describe('when an address has a single entity', () => {
    beforeEach(() => {
      newest = selectNewestPerAddress([{ addr: '0xalice', id: 33 }])
    })

    it('should select that entity', () => {
      expect(newest.get('0xalice')).toBe(33)
    })
  })

  describe('when an address has duplicate entities', () => {
    beforeEach(() => {
      newest = selectNewestPerAddress([
        { addr: '0xalice', id: 33 },
        { addr: '0xalice', id: 65568 },
      ])
    })

    it('should select the highest entity id, matching getPlayerPosition', () => {
      expect(newest.get('0xalice')).toBe(65568)
    })

    it('should collapse them to exactly one entry', () => {
      expect(newest.size).toBe(1)
    })
  })

  // KNOWN LIMITATION, pinned deliberately rather than fixed. "Highest id == newest" is false:
  // the version occupies the high 16 bits and counts recycles of that SLOT, not when its
  // occupant was assigned, so an address moving to a fresher slot sees its raw id DROP and this
  // returns the corpse. 37 of 103 reallocations did so in the 2026-08-15 production log. The
  // rule is kept because it is wrong symmetrically — server and every client agree — and the
  // duplicate condition needs a lost tombstone that has never been observed. See
  // selectNewestPerAddress for the full argument. If this test ever needs changing, the fix
  // has to cover every address lookup, not just this comparison.
  describe('when a corpse sits on a higher-versioned slot than the live entity', () => {
    const CORPSE_35_V21 = (35 | (21 << 16)) >>> 0 // 1376291
    const LIVE_37_V8 = (37 | (8 << 16)) >>> 0 // 524325

    beforeEach(() => {
      newest = selectNewestPerAddress([
        { addr: '0xalice', id: CORPSE_35_V21 },
        { addr: '0xalice', id: LIVE_37_V8 },
      ])
    })

    it('should confirm the live entity really does have the lower raw id', () => {
      expect(LIVE_37_V8).toBeLessThan(CORPSE_35_V21)
    })

    it('should return the CORPSE, which is the accepted limitation of the max-id rule', () => {
      expect(newest.get('0xalice')).toBe(CORPSE_35_V21)
    })

    describe('and the duplicates arrive in the opposite order', () => {
      beforeEach(() => {
        newest = selectNewestPerAddress([
          { addr: '0xalice', id: 65568 },
          { addr: '0xalice', id: 33 },
        ])
      })

      it('should still select the highest entity id', () => {
        expect(newest.get('0xalice')).toBe(65568)
      })
    })
  })

  describe('when several addresses are present and one of them is duplicated', () => {
    beforeEach(() => {
      newest = selectNewestPerAddress([
        { addr: '0xalice', id: 33 },
        { addr: '0xbob', id: 34 },
        { addr: '0xalice', id: 65568 },
      ])
    })

    it('should keep one entry per address', () => {
      expect(newest.size).toBe(2)
    })

    it('should resolve the duplicated address to its newest entity', () => {
      expect(newest.get('0xalice')).toBe(65568)
    })

    it('should leave the unduplicated address untouched', () => {
      expect(newest.get('0xbob')).toBe(34)
    })
  })

  describe('when there are no entries', () => {
    beforeEach(() => {
      newest = selectNewestPerAddress([])
    })

    it('should select nothing', () => {
      expect(newest.size).toBe(0)
    })
  })
})
