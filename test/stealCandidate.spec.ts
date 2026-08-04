import {
  type StealCandidate,
  type StealSelection,
  selectClosestCandidate,
} from '../src/server/stealCandidate'

/** Stands in for the flag's current carrier, who must never be selected to steal from themselves. */
const CARRIER = '0xcarrier'

describe('steal candidate selection', () => {
  let radius: number
  let candidates: StealCandidate[]
  let selection: StealSelection

  beforeEach(() => {
    radius = 1.8
    candidates = []
  })

  afterEach(() => {
    candidates = []
  })

  describe('when several candidates are inside the steal radius', () => {
    beforeEach(() => {
      candidates = [
        { addr: '0xnearest', dist: 0.9 },
        { addr: '0xalsoclose', dist: 1.5 },
      ]
      selection = selectClosestCandidate(candidates, radius, CARRIER)
    })

    it('should select the closest one for the steal', () => {
      expect(selection.closestId).toBe('0xnearest')
    })

    it('should report that candidate distance for the log', () => {
      expect(selection.closestDist).toBe(0.9)
    })
  })

  // The candidates arrive in engine iteration order, which has no relationship to distance,
  // so the scan must consider all of them. Putting the farther in-radius candidate FIRST is
  // what separates "closest wins" from "first one in radius wins" — with the nearest listed
  // first, both implementations agree and the contract goes unverified.
  describe('when a farther in-radius candidate is yielded before a nearer one', () => {
    beforeEach(() => {
      candidates = [
        { addr: '0xfarther', dist: 1.7 },
        { addr: '0xnearest', dist: 0.5 },
      ]
      selection = selectClosestCandidate(candidates, radius, CARRIER)
    })

    it('should select the nearer candidate', () => {
      expect(selection.closestId).toBe('0xnearest')
    })

    it('should report the nearer distance', () => {
      expect(selection.closestDist).toBe(0.5)
    })
  })

  describe('when the nearest candidate is yielded last of several in-radius candidates', () => {
    beforeEach(() => {
      candidates = [
        { addr: '0xa', dist: 1.75 },
        { addr: '0xb', dist: 1.2 },
        { addr: '0xc', dist: 1.5 },
        { addr: '0xd', dist: 0.3 },
      ]
      selection = selectClosestCandidate(candidates, radius, CARRIER)
    })

    it('should still select the nearest', () => {
      expect(selection.closestId).toBe('0xd')
    })
  })

  describe('when only the farther candidate is inside the steal radius', () => {
    beforeEach(() => {
      candidates = [
        { addr: '0xoutside', dist: 5.0 },
        { addr: '0xinside', dist: 1.7 },
      ]
      selection = selectClosestCandidate(candidates, radius, CARRIER)
    })

    it('should select the in-radius candidate', () => {
      expect(selection.closestId).toBe('0xinside')
    })
  })

  describe('when every candidate is outside the steal radius', () => {
    beforeEach(() => {
      candidates = [
        { addr: '0xfar', dist: 2.5 },
        { addr: '0xfarther', dist: 3.0 },
      ]
      selection = selectClosestCandidate(candidates, radius, CARRIER)
    })

    it('should select nobody for the steal', () => {
      expect(selection.closestId).toBeNull()
    })

    it('should leave the reported distance at the radius', () => {
      expect(selection.closestDist).toBe(radius)
    })
  })

  describe('when there are no candidates at all', () => {
    beforeEach(() => {
      selection = selectClosestCandidate([], radius, CARRIER)
    })

    it('should select nobody for the steal', () => {
      expect(selection.closestId).toBeNull()
    })
  })

  describe('when a candidate stands exactly at the radius boundary', () => {
    beforeEach(() => {
      candidates = [{ addr: '0xboundary', dist: 1.8 }]
      selection = selectClosestCandidate(candidates, radius, CARRIER)
    })

    it('should not select it (strictly-inside check, matching the previous behavior)', () => {
      expect(selection.closestId).toBeNull()
    })
  })

  describe('when two candidates sit at exactly the same distance', () => {
    beforeEach(() => {
      candidates = [
        { addr: '0xfirst', dist: 1.0 },
        { addr: '0xsecond', dist: 1.0 },
      ]
      selection = selectClosestCandidate(candidates, radius, CARRIER)
    })

    it('should select the one the iterable yielded first', () => {
      expect(selection.closestId).toBe('0xfirst')
    })
  })

  // A corrupt Transform must never win the flag: NaN fails the strict `<` comparison, so the
  // candidate is skipped rather than treated as distance-zero.
  describe('when a candidate has a non-finite distance', () => {
    beforeEach(() => {
      candidates = [{ addr: '0xcorrupt', dist: NaN }]
      selection = selectClosestCandidate(candidates, radius, CARRIER)
    })

    it('should not select it for the steal', () => {
      expect(selection.closestId).toBeNull()
    })

    describe('and a genuinely in-radius candidate is also present', () => {
      beforeEach(() => {
        candidates = [
          { addr: '0xcorrupt', dist: NaN },
          { addr: '0xvalid', dist: 1.4 },
        ]
        selection = selectClosestCandidate(candidates, radius, CARRIER)
      })

      it('should select the valid candidate', () => {
        expect(selection.closestId).toBe('0xvalid')
      })
    })
  })
})

// The carrier's distance to themselves is 0, so if they are ever eligible they win every tick
// and steal the flag from themselves forever — a silent, permanent corruption of the round.
// checkProximitySteal ALSO pre-filters the carrier out while building the list, deliberately
// — two independent layers. This is the tested one, and the case-insensitive one.
describe('excluding the flag carrier from steal candidates', () => {
  const RADIUS = 1.8
  let candidates: StealCandidate[]
  let selection: StealSelection

  beforeEach(() => {
    candidates = []
  })

  afterEach(() => {
    candidates = []
  })

  describe('when the carrier appears among the candidates at distance zero', () => {
    beforeEach(() => {
      candidates = [
        { addr: CARRIER, dist: 0 },
        { addr: '0xstealer', dist: 1.5 },
      ]
      selection = selectClosestCandidate(candidates, RADIUS, CARRIER)
    })

    it('should not select the carrier despite being nearest', () => {
      expect(selection.closestId).toBe('0xstealer')
    })

    it('should report the selected stealer distance, not the carrier zero', () => {
      expect(selection.closestDist).toBe(1.5)
    })
  })

  describe('when the carrier is the only candidate', () => {
    beforeEach(() => {
      candidates = [{ addr: CARRIER, dist: 0 }]
      selection = selectClosestCandidate(candidates, RADIUS, CARRIER)
    })

    it('should select nobody', () => {
      expect(selection.closestId).toBeNull()
    })
  })

  // Case-insensitivity on BOTH sides is what makes the guarantee structural rather than
  // dependent on every writer in the codebase remembering to lowercase.
  describe('when the candidate list carries the carrier address in mixed case', () => {
    beforeEach(() => {
      candidates = [
        { addr: '0xCaRRiEr', dist: 0 },
        { addr: '0xstealer', dist: 1.5 },
      ]
      selection = selectClosestCandidate(candidates, RADIUS, CARRIER)
    })

    it('should still exclude the carrier', () => {
      expect(selection.closestId).toBe('0xstealer')
    })
  })

  describe('when the carrier id passed in is mixed case', () => {
    beforeEach(() => {
      candidates = [
        { addr: CARRIER, dist: 0 },
        { addr: '0xstealer', dist: 1.5 },
      ]
      selection = selectClosestCandidate(candidates, RADIUS, '0xCaRRiEr')
    })

    it('should still exclude the carrier', () => {
      expect(selection.closestId).toBe('0xstealer')
    })
  })

  describe('when both the candidate address and the carrier id are mixed case differently', () => {
    beforeEach(() => {
      candidates = [{ addr: '0XCARRIER', dist: 0 }]
      selection = selectClosestCandidate(candidates, RADIUS, '0xcarrier')
    })

    it('should still exclude the carrier', () => {
      expect(selection.closestId).toBeNull()
    })
  })

  describe('when no candidate matches the excluded address', () => {
    beforeEach(() => {
      candidates = [
        { addr: '0xstealer', dist: 1.5 },
        { addr: '0xnearer', dist: 0.4 },
      ]
      selection = selectClosestCandidate(candidates, RADIUS, CARRIER)
    })

    it('should select normally', () => {
      expect(selection.closestId).toBe('0xnearer')
    })
  })
})
