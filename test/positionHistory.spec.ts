import {
  type Point3,
  type PosSample,
  POS_HISTORY_MAX_MS,
  pushSample,
  anySampleWithinRadius,
  wasEverWithinRadius,
} from '../src/server/positionHistory'

describe('position history time-windowed sample buffer', () => {
  let samples: PosSample[]

  beforeEach(() => {
    samples = []
  })

  afterEach(() => {
    samples = []
  })

  describe('when a sample is appended with nothing to trim', () => {
    beforeEach(() => {
      pushSample(samples, { t: 1000, x: 1, y: 2, z: 3 }, 500)
    })

    it('should keep the sample', () => {
      expect(samples).toEqual([{ t: 1000, x: 1, y: 2, z: 3 }])
    })
  })

  describe('when older samples sit behind the cutoff', () => {
    beforeEach(() => {
      samples = [
        { t: 100, x: 0, y: 0, z: 0 },
        { t: 200, x: 0, y: 0, z: 0 },
        { t: 900, x: 0, y: 0, z: 0 },
      ]
      pushSample(samples, { t: 1000, x: 9, y: 9, z: 9 }, 500)
    })

    it('should drop every sample older than the cutoff', () => {
      expect(samples.map((s) => s.t)).toEqual([900, 1000])
    })
  })

  describe('when every existing sample is behind the cutoff', () => {
    beforeEach(() => {
      samples = [
        { t: 100, x: 0, y: 0, z: 0 },
        { t: 200, x: 0, y: 0, z: 0 },
      ]
      pushSample(samples, { t: 5000, x: 1, y: 1, z: 1 }, 4500)
    })

    it('should keep only the new sample', () => {
      expect(samples.map((s) => s.t)).toEqual([5000])
    })
  })

  describe('when a sample exactly at the cutoff is present', () => {
    beforeEach(() => {
      samples = [{ t: 500, x: 0, y: 0, z: 0 }]
      pushSample(samples, { t: 1000, x: 0, y: 0, z: 0 }, 500)
    })

    it('should retain it (the trim is strictly-older-than)', () => {
      expect(samples.map((s) => s.t)).toEqual([500, 1000])
    })
  })
})

describe('lag-forgiving proximity scan over position history', () => {
  let samples: PosSample[]
  const RADIUS = 1.8

  beforeEach(() => {
    samples = []
  })

  afterEach(() => {
    samples = []
  })

  describe('when the history is empty', () => {
    it('should report nobody in range', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, RADIUS, 0)).toBe(false)
    })
  })

  describe('when the newest sample is inside the radius', () => {
    beforeEach(() => {
      samples = [
        { t: 1000, x: 50, y: 0, z: 0 },
        { t: 1100, x: 1, y: 0, z: 0 },
      ]
    })

    it('should report in range', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, RADIUS, 900)).toBe(true)
    })
  })

  describe('when only an older in-window sample is inside the radius', () => {
    beforeEach(() => {
      // This is the whole point of the lookback: the player WAS there recently.
      samples = [
        { t: 1000, x: 1, y: 0, z: 0 },
        { t: 1100, x: 50, y: 0, z: 0 },
      ]
    })

    it('should report in range', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, RADIUS, 900)).toBe(true)
    })
  })

  // The scan walks newest-first and breaks at the first sample behind the cutoff. Without
  // that break, an in-radius sample from OUTSIDE the window would still authorize a hit,
  // and the caller's lookback would be meaningless.
  describe('when the only in-radius sample is older than the cutoff', () => {
    beforeEach(() => {
      samples = [
        { t: 1000, x: 1, y: 0, z: 0 },
        { t: 1100, x: 50, y: 0, z: 0 },
        { t: 1200, x: 50, y: 0, z: 0 },
      ]
    })

    it('should report out of range', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, RADIUS, 1050)).toBe(false)
    })

    describe('and the cutoff is widened to include it', () => {
      it('should report in range', () => {
        expect(anySampleWithinRadius(samples, 0, 0, 0, RADIUS, 1000)).toBe(true)
      })
    })
  })

  describe('when an in-radius sample sits exactly at the cutoff', () => {
    beforeEach(() => {
      samples = [{ t: 1000, x: 1, y: 0, z: 0 }]
    })

    it('should report in range (the cutoff is inclusive)', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, RADIUS, 1000)).toBe(true)
    })
  })

  // Distance is 3D. A player on a roof directly above the target shares XZ but is far away
  // in Y, and must not count as adjacent.
  describe('when a sample shares XZ with the target but is far above it', () => {
    beforeEach(() => {
      samples = [{ t: 1000, x: 0, y: 5, z: 0 }]
    })

    it('should report out of range because Y is included', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, RADIUS, 900)).toBe(false)
    })

    describe('and the vertical gap is inside the radius', () => {
      beforeEach(() => {
        samples = [{ t: 1000, x: 0, y: 1.5, z: 0 }]
      })

      it('should report in range', () => {
        expect(anySampleWithinRadius(samples, 0, 0, 0, RADIUS, 900)).toBe(true)
      })
    })
  })

  describe('when a sample sits exactly at the radius boundary', () => {
    beforeEach(() => {
      samples = [{ t: 1000, x: RADIUS, y: 0, z: 0 }]
    })

    it('should report out of range (strictly-inside check)', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, RADIUS, 900)).toBe(false)
    })
  })

  describe('when the target is offset on all three axes', () => {
    beforeEach(() => {
      // (1,1,1) from the target is sqrt(3) ≈ 1.732, inside 1.8.
      samples = [{ t: 1000, x: 11, y: 21, z: 31 }]
    })

    it('should measure true euclidean distance', () => {
      expect(anySampleWithinRadius(samples, 10, 20, 30, RADIUS, 900)).toBe(true)
    })

    describe('and each axis offset is 1.2 (distance ~2.08)', () => {
      beforeEach(() => {
        samples = [{ t: 1000, x: 11.2, y: 21.2, z: 31.2 }]
      })

      it('should report out of range', () => {
        expect(anySampleWithinRadius(samples, 10, 20, 30, RADIUS, 900)).toBe(false)
      })
    })
  })

  // Corrupt parameters must DENY, matching isRateLimited's posture. The natural failure here
  // is the opposite: `s.t < NaN` is false, so without a guard a non-finite cutoff skips the
  // break, scans the whole buffer and silently ignores the caller's lookback.
  describe('when the cutoff is not a finite number', () => {
    beforeEach(() => {
      samples = [{ t: 1000, x: 1, y: 0, z: 0 }]
    })

    it('should report out of range rather than ignoring the window', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, RADIUS, NaN)).toBe(false)
    })

    it('should report out of range for an infinite cutoff', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, RADIUS, -Infinity)).toBe(false)
    })
  })

  // A negative radius must never grant a hit. Comparing squared magnitudes effectively takes
  // abs(radius), so without the guard this would report in-range inside |radius| — where the
  // Vector3.distance form this replaced always said no.
  describe('when the radius is negative', () => {
    beforeEach(() => {
      samples = [{ t: 1000, x: 1, y: 0, z: 0 }]
    })

    it('should report out of range', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, -5, 900)).toBe(false)
    })
  })

  describe('when the radius is not a finite number', () => {
    beforeEach(() => {
      samples = [{ t: 1000, x: 1, y: 0, z: 0 }]
    })

    it('should report out of range for NaN', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, NaN, 900)).toBe(false)
    })

    it('should report out of range for Infinity', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, Infinity, 900)).toBe(false)
    })
  })

  describe('when the radius is exactly zero', () => {
    beforeEach(() => {
      samples = [{ t: 1000, x: 0, y: 0, z: 0 }]
    })

    it('should report out of range even for a co-located sample', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, 0, 900)).toBe(false)
    })
  })

  // Retention silently caps every caller's lookback: a sample trimmed by POS_HISTORY_MAX_MS
  // is gone, so asking for a longer window buys nothing. combat's resolveActionPosition
  // requests 1000ms against a 500ms buffer and therefore gets 500ms.
  describe('when a caller asks for a lookback longer than the retained history', () => {
    beforeEach(() => {
      // Simulate ticks: adjacent to the target long ago, then walked away and stayed away.
      samples = []
      pushSample(samples, { t: 1000, x: 0, y: 0, z: 0 }, 1000 - POS_HISTORY_MAX_MS)
      pushSample(samples, { t: 1400, x: 50, y: 0, z: 0 }, 1400 - POS_HISTORY_MAX_MS)
      pushSample(samples, { t: 1900, x: 50, y: 0, z: 0 }, 1900 - POS_HISTORY_MAX_MS)
    })

    it('should have trimmed the sample that fell outside retention', () => {
      expect(samples.map((s) => s.t)).toEqual([1400, 1900])
    })

    it('should not see the trimmed adjacent sample even with an unbounded lookback', () => {
      expect(anySampleWithinRadius(samples, 0, 0, 0, RADIUS, 0)).toBe(false)
    })
  })
})

describe('choosing between position history and a live position', () => {
  const RADIUS = 1.8
  let currentPos: jest.Mock<Point3 | null, []>

  beforeEach(() => {
    currentPos = jest.fn<Point3 | null, []>(() => null)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('when history exists', () => {
    let samples: PosSample[]

    beforeEach(() => {
      samples = [{ t: 1000, x: 1, y: 0, z: 0 }]
    })

    it('should answer from history', () => {
      expect(wasEverWithinRadius(samples, 0, 0, 0, RADIUS, 900, currentPos)).toBe(true)
    })

    // Resolving a live position scans every entity, so paying for it when history is present
    // would be a per-player, per-projectile cost on the hot path.
    it('should not resolve the live position at all', () => {
      wasEverWithinRadius(samples, 0, 0, 0, RADIUS, 900, currentPos)
      expect(currentPos).not.toHaveBeenCalled()
    })

    describe('and history puts the player out of range', () => {
      beforeEach(() => {
        samples = [{ t: 1000, x: 50, y: 0, z: 0 }]
      })

      it('should report out of range', () => {
        expect(wasEverWithinRadius(samples, 0, 0, 0, RADIUS, 900, currentPos)).toBe(false)
      })

      it('should not consult the live position', () => {
        wasEverWithinRadius(samples, 0, 0, 0, RADIUS, 900, currentPos)
        expect(currentPos).not.toHaveBeenCalled()
      })
    })
  })

  // Reachable for a player who has never been sampled — message handlers can run before the
  // first recordPlayerPositions tick after a join.
  describe('when there is no history for the player', () => {
    describe('and the live position is inside the radius', () => {
      beforeEach(() => {
        currentPos = jest.fn<Point3 | null, []>(() => ({ x: 1, y: 0, z: 0 }))
      })

      it('should fall back to it and report in range', () => {
        expect(wasEverWithinRadius(undefined, 0, 0, 0, RADIUS, 900, currentPos)).toBe(true)
      })

      it('should resolve the live position exactly once', () => {
        wasEverWithinRadius(undefined, 0, 0, 0, RADIUS, 900, currentPos)
        expect(currentPos).toHaveBeenCalledTimes(1)
      })
    })

    describe('and the live position is outside the radius', () => {
      beforeEach(() => {
        currentPos = jest.fn<Point3 | null, []>(() => ({ x: 50, y: 0, z: 0 }))
      })

      it('should report out of range', () => {
        expect(wasEverWithinRadius(undefined, 0, 0, 0, RADIUS, 900, currentPos)).toBe(false)
      })
    })

    describe('and the player has no live position either', () => {
      it('should report out of range rather than assume proximity', () => {
        expect(wasEverWithinRadius(undefined, 0, 0, 0, RADIUS, 900, currentPos)).toBe(false)
      })
    })

    describe('and the live position differs only in height', () => {
      beforeEach(() => {
        currentPos = jest.fn<Point3 | null, []>(() => ({ x: 0, y: 5, z: 0 }))
      })

      it('should include Y in the fallback distance too', () => {
        expect(wasEverWithinRadius(undefined, 0, 0, 0, RADIUS, 900, currentPos)).toBe(false)
      })
    })

    describe('and the live position sits exactly at the radius boundary', () => {
      beforeEach(() => {
        currentPos = jest.fn<Point3 | null, []>(() => ({ x: RADIUS, y: 0, z: 0 }))
      })

      it('should report out of range (strictly-inside, matching the history path)', () => {
        expect(wasEverWithinRadius(undefined, 0, 0, 0, RADIUS, 900, currentPos)).toBe(false)
      })
    })
  })

  describe('when the parameters are unusable', () => {
    beforeEach(() => {
      currentPos = jest.fn<Point3 | null, []>(() => ({ x: 0, y: 0, z: 0 }))
    })

    it('should deny on a non-finite cutoff', () => {
      expect(wasEverWithinRadius(undefined, 0, 0, 0, RADIUS, NaN, currentPos)).toBe(false)
    })

    it('should not consult the live position when the parameters are unusable', () => {
      wasEverWithinRadius(undefined, 0, 0, 0, RADIUS, NaN, currentPos)
      expect(currentPos).not.toHaveBeenCalled()
    })

    it('should deny on a negative radius even for a co-located player', () => {
      expect(wasEverWithinRadius(undefined, 0, 0, 0, -5, 900, currentPos)).toBe(false)
    })
  })

  // An empty array must take the fallback, not report "scanned and found nothing". The live
  // path reaches the fallback via a missing Map entry rather than an empty one (pushSample
  // always appends at `now`), so this pins the contract for any future caller.
  describe('when history exists but is empty', () => {
    beforeEach(() => {
      currentPos = jest.fn<Point3 | null, []>(() => ({ x: 1, y: 0, z: 0 }))
    })

    it('should fall back to the live position', () => {
      expect(wasEverWithinRadius([], 0, 0, 0, RADIUS, 900, currentPos)).toBe(true)
    })

    it('should resolve the live position exactly once', () => {
      wasEverWithinRadius([], 0, 0, 0, RADIUS, 900, currentPos)
      expect(currentPos).toHaveBeenCalledTimes(1)
    })
  })
})
