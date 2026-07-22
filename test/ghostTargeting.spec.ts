import {
  type GhostTargetCandidate,
  type NearestGhostTarget,
  GHOST_TARGET_MAX_Y_DELTA,
  findNearestGhostTarget,
} from '../src/server/ghostTargeting'

describe('ghost nearest-target selection', () => {
  let ghostX: number
  let ghostY: number
  let ghostZ: number
  let candidates: GhostTargetCandidate[]
  let nearest: NearestGhostTarget | null

  beforeEach(() => {
    ghostX = 100
    ghostY = 50
    ghostZ = 100
    candidates = []
    nearest = null
  })

  afterEach(() => {
    candidates = []
  })

  describe('when several players are on the ghost plane', () => {
    beforeEach(() => {
      candidates = [
        { addr: '0xfar', x: 110, y: 50, z: 100 },
        { addr: '0xnear', x: 103, y: 50, z: 104 },
      ]
      nearest = findNearestGhostTarget(candidates, ghostX, ghostY, ghostZ)
    })

    it('should target the player nearest on the XZ plane', () => {
      expect(nearest?.addr).toBe('0xnear')
    })

    it('should report the XZ distance for the chase and contact checks', () => {
      expect(nearest?.distXZ).toBe(5)
    })
  })

  describe('when the nearest player is outside the vertical band', () => {
    beforeEach(() => {
      // Regression guard for the cross-wire class: a candidate hovering far above
      // (e.g. a poisoned Y) must not be chased or scare-touched.
      candidates = [
        { addr: '0xabove', x: 101, y: ghostY + GHOST_TARGET_MAX_Y_DELTA + 1, z: 100 },
        { addr: '0xgrounded', x: 108, y: 50, z: 100 },
      ]
      nearest = findNearestGhostTarget(candidates, ghostX, ghostY, ghostZ)
    })

    it('should target the next-nearest player inside the band', () => {
      expect(nearest?.addr).toBe('0xgrounded')
    })
  })

  describe('when a player hovers exactly at the vertical band boundary', () => {
    beforeEach(() => {
      candidates = [{ addr: '0xboundary', x: 102, y: ghostY + GHOST_TARGET_MAX_Y_DELTA, z: 100 }]
      nearest = findNearestGhostTarget(candidates, ghostX, ghostY, ghostZ)
    })

    it('should keep the player targetable (inclusive boundary, matching the previous behavior)', () => {
      expect(nearest?.addr).toBe('0xboundary')
    })
  })

  describe('when a higher player is closer on the XZ plane than a grounded one', () => {
    beforeEach(() => {
      candidates = [
        { addr: '0xhighnear', x: 102, y: 60, z: 100 },
        { addr: '0xgroundedfar', x: 105, y: 50, z: 100 },
      ]
      nearest = findNearestGhostTarget(candidates, ghostX, ghostY, ghostZ)
    })

    it('should target by XZ distance only, ignoring the in-band vertical offset', () => {
      expect(nearest?.addr).toBe('0xhighnear')
    })
  })

  describe('when there are no candidates', () => {
    beforeEach(() => {
      nearest = findNearestGhostTarget(candidates, ghostX, ghostY, ghostZ)
    })

    it('should return null so the ghost falls back to its idle orbit', () => {
      expect(nearest).toBeNull()
    })
  })
})
