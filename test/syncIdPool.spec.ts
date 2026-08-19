/**
 * Tests for src/shared/syncIdPool.ts — the fixed-size network-id pool behind ghost (and,
 * latently, trap/projectile) sync registration.
 *
 * The exhaustion contract is the reason this spec exists. `next()` used to return
 * `base + random(size)` when the pool ran dry: by construction every id in an exhausted pool
 * is either tainted (deliberately not recycled after a syncEntity failure) or registered to a
 * LIVE entity, so that fallback could hand two entities the same network identity and cross
 * their CRDT streams on every client. It now returns null and callers must back off.
 */
import { createSyncIdPool } from '../src/shared/syncIdPool'

describe('sync id pool', () => {
  const BASE = 3_000_000
  let pool: ReturnType<typeof createSyncIdPool>

  describe('when ids are drawn from a fresh pool', () => {
    let drawn: (number | null)[]

    beforeEach(() => {
      pool = createSyncIdPool(BASE, 3)
      drawn = [pool.next(), pool.next(), pool.next()]
    })

    afterEach(() => {
      drawn = []
    })

    it('should hand out every id in the range exactly once, in order', () => {
      expect(drawn).toEqual([BASE, BASE + 1, BASE + 2])
    })
  })

  describe('when the pool is exhausted', () => {
    let afterExhaustion: number | null

    beforeEach(() => {
      pool = createSyncIdPool(BASE, 2)
      pool.next()
      pool.next()
      afterExhaustion = pool.next()
    })

    it('should return null rather than an id that may belong to a live entity', () => {
      expect(afterExhaustion).toBeNull()
    })

    describe('and the caller keeps asking', () => {
      let extraDraws: (number | null)[]

      beforeEach(() => {
        extraDraws = [pool.next(), pool.next(), pool.next()]
      })

      afterEach(() => {
        extraDraws = []
      })

      it('should keep refusing instead of ever reissuing an in-use id', () => {
        expect(extraDraws).toEqual([null, null, null])
      })
    })

    describe('and an id is recycled', () => {
      let reissued: number | null

      beforeEach(() => {
        pool.recycle(BASE)
        reissued = pool.next()
      })

      it('should hand back the recycled id', () => {
        expect(reissued).toBe(BASE)
      })
    })
  })

  describe('when an id outside the pool range is recycled', () => {
    let afterForeignRecycle: number | null

    beforeEach(() => {
      pool = createSyncIdPool(BASE, 1)
      pool.next()
      pool.recycle(BASE + 999)
      afterForeignRecycle = pool.next()
    })

    it('should ignore it, so a foreign id cannot enter the pool', () => {
      expect(afterForeignRecycle).toBeNull()
    })
  })

  describe('when the same id is recycled twice', () => {
    let drawnAfterDoubleRecycle: (number | null)[]

    beforeEach(() => {
      pool = createSyncIdPool(BASE, 1)
      pool.next()
      pool.recycle(BASE)
      pool.recycle(BASE)
      drawnAfterDoubleRecycle = [pool.next(), pool.next()]
    })

    afterEach(() => {
      drawnAfterDoubleRecycle = []
    })

    it('should make it available only once, so two entities cannot share it', () => {
      expect(drawnAfterDoubleRecycle).toEqual([BASE, null])
    })
  })
})
