import {
  SCENE_POS_MAX_X,
  SCENE_POS_MAX_Y,
  REPORTED_POS_MAX_AGE_MS,
  REPORTED_POS_MAX_SPEED_MPS,
  acceptReportedPosition,
  isFreshReportedPosition,
  isPlausibleScenePosition,
  type ReportedPos
} from '../src/shared/reportedPosition'

describe('client-reported player position validation', () => {
  const now = 1_000_000

  describe('when the coordinates are a normal in-scene point', () => {
    it('should accept the position', () => {
      expect(isPlausibleScenePosition(400, 48, 400)).toBe(true)
    })
  })

  describe('when the coordinates are non-finite', () => {
    it('should reject NaN', () => {
      expect(isPlausibleScenePosition(Number.NaN, 48, 400)).toBe(false)
    })

    it('should reject Infinity', () => {
      expect(isPlausibleScenePosition(400, Number.POSITIVE_INFINITY, 400)).toBe(false)
    })
  })

  describe('when the coordinates are the schema default origin', () => {
    it('should reject (0,0,0)', () => {
      expect(isPlausibleScenePosition(0, 0, 0)).toBe(false)
    })
  })

  describe('when the coordinates are outside the scene', () => {
    it('should reject a point past the X edge', () => {
      expect(isPlausibleScenePosition(SCENE_POS_MAX_X + 1, 48, 400)).toBe(false)
    })

    it('should reject a point above the Y cap', () => {
      expect(isPlausibleScenePosition(400, SCENE_POS_MAX_Y + 1, 400)).toBe(false)
    })

    it('should reject a point below the interior floor slack', () => {
      expect(isPlausibleScenePosition(400, -20, 400)).toBe(false)
    })
  })

  describe('acceptReportedPosition', () => {
    describe('when there is no previous sample', () => {
      it('should accept a plausible first report', () => {
        const result = acceptReportedPosition(undefined, 100, 48, 200, now)
        expect(result).toEqual({ ok: true, pos: { x: 100, y: 48, z: 200, t: now } })
      })

      it('should reject a non-finite first report', () => {
        expect(acceptReportedPosition(undefined, Number.NaN, 48, 200, now)).toEqual({
          ok: false,
          reason: 'non-finite'
        })
      })

      it('should reject the schema default origin', () => {
        expect(acceptReportedPosition(undefined, 0, 0, 0, now)).toEqual({
          ok: false,
          reason: 'origin-default'
        })
      })

      it('should reject an out-of-bounds first report', () => {
        expect(acceptReportedPosition(undefined, 900, 48, 200, now)).toEqual({
          ok: false,
          reason: 'out-of-bounds'
        })
      })
    })

    describe('when a fresh previous sample exists', () => {
      let prev: ReportedPos

      beforeEach(() => {
        prev = { x: 100, y: 48, z: 200, t: now - 200 }
      })

      afterEach(() => {
        prev = { x: 0, y: 0, z: 0, t: 0 }
      })

      it('should accept ordinary movement', () => {
        const result = acceptReportedPosition(prev, 104, 48, 201, now)
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.pos).toEqual({ x: 104, y: 48, z: 201, t: now })
        }
      })

      it('should reject a teleport faster than the glider cap', () => {
        const farX = prev.x + REPORTED_POS_MAX_SPEED_MPS * 0.2 + 20
        expect(acceptReportedPosition(prev, farX, prev.y, prev.z, now)).toEqual({
          ok: false,
          reason: 'too-fast'
        })
      })
    })

    describe('when the previous sample is stale', () => {
      it('should re-lock to a plausible new position without a speed check', () => {
        const prev: ReportedPos = { x: 100, y: 48, z: 200, t: now - REPORTED_POS_MAX_AGE_MS - 1 }
        const result = acceptReportedPosition(prev, 700, 60, 700, now)
        expect(result).toEqual({ ok: true, pos: { x: 700, y: 60, z: 700, t: now } })
      })
    })
  })

  describe('isFreshReportedPosition', () => {
    const pos: ReportedPos = { x: 100, y: 48, z: 200, t: now }

    it('should treat a just-received sample as fresh', () => {
      expect(isFreshReportedPosition(pos, now)).toBe(true)
    })

    it('should treat a sample at the age cap as fresh', () => {
      expect(isFreshReportedPosition(pos, now + REPORTED_POS_MAX_AGE_MS)).toBe(true)
    })

    it('should treat a sample past the age cap as stale', () => {
      expect(isFreshReportedPosition(pos, now + REPORTED_POS_MAX_AGE_MS + 1)).toBe(false)
    })

    it('should treat a missing sample as stale', () => {
      expect(isFreshReportedPosition(undefined, now)).toBe(false)
    })
  })
})