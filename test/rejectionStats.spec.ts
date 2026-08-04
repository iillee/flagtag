import {
  type RejectionCounts,
  recordRejection,
  formatRejections,
  clearRejections,
} from '../src/server/rejectionStats'

describe('rejected request counters', () => {
  let counts: RejectionCounts

  beforeEach(() => {
    counts = new Map()
  })

  afterEach(() => {
    counts.clear()
  })

  describe('when nothing has been rejected', () => {
    it('should format to null so the caller can skip the log line', () => {
      expect(formatRejections(counts)).toBeNull()
    })
  })

  describe('when one rejection is recorded', () => {
    beforeEach(() => {
      recordRejection(counts, 'reportGroundY:not-dropper')
    })

    it('should format it with a count of one', () => {
      expect(formatRejections(counts)).toBe('reportGroundY:not-dropper=1')
    })
  })

  describe('when the same reason is recorded repeatedly', () => {
    beforeEach(() => {
      recordRejection(counts, 'reportGroundY:not-dropper')
      recordRejection(counts, 'reportGroundY:not-dropper')
      recordRejection(counts, 'reportGroundY:not-dropper')
    })

    it('should accumulate into a single entry', () => {
      expect(formatRejections(counts)).toBe('reportGroundY:not-dropper=3')
    })

    it('should keep one key rather than one per occurrence', () => {
      expect(counts.size).toBe(1)
    })
  })

  // Busiest first: the dominant reason is what a reader needs from a one-line summary.
  describe('when several reasons are recorded with different frequencies', () => {
    beforeEach(() => {
      recordRejection(counts, 'coinPickup:too-far')
      recordRejection(counts, 'reportGroundY:not-dropper')
      recordRejection(counts, 'reportGroundY:not-dropper')
      recordRejection(counts, 'reportGroundY:not-dropper')
      recordRejection(counts, 'mushroom:cooldown')
      recordRejection(counts, 'mushroom:cooldown')
    })

    it('should order the entries from most to least frequent', () => {
      expect(formatRejections(counts)).toBe(
        'reportGroundY:not-dropper=3 | mushroom:cooldown=2 | coinPickup:too-far=1'
      )
    })
  })

  // Stable output matters: an unstable order would make the line churn between intervals for
  // no reason, which is noise in a log being read by eye.
  describe('when two reasons have the same count', () => {
    beforeEach(() => {
      recordRejection(counts, 'zzz:reason')
      recordRejection(counts, 'aaa:reason')
    })

    it('should break the tie alphabetically rather than by insertion order', () => {
      expect(formatRejections(counts)).toBe('aaa:reason=1 | zzz:reason=1')
    })
  })

  describe('when the counters are cleared for the next interval', () => {
    beforeEach(() => {
      recordRejection(counts, 'reportGroundY:not-dropper')
      clearRejections(counts)
    })

    it('should format to null again', () => {
      expect(formatRejections(counts)).toBeNull()
    })

    it('should hold no keys', () => {
      expect(counts.size).toBe(0)
    })

    describe('and a new rejection arrives afterwards', () => {
      beforeEach(() => {
        recordRejection(counts, 'reportGroundY:malformed')
      })

      it('should count it from one rather than carrying the previous interval over', () => {
        expect(formatRejections(counts)).toBe('reportGroundY:malformed=1')
      })
    })
  })
})
