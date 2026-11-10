import { treeFireOrder, isRankLit, treeFireLitCount, treeFireStepAt, TREE_FIRE_SWAP_SEC, isTreeLit, TREE_FIRE_LIT_FRACTION, fireNoise, treeFireLightFlicker, TREE_FIRE_LIGHT_RANGE_FLICKER, treeFireVariant, TREE_FIRE_SIZE_VARIANCE, treeFirePlacement, nearestIndices, TREE_GLB_TOP_M, TREE_FIRE_HEIGHT_FRAC, TREE_FIRE_MIN_SCALE, TREE_FIRE_MAX_SCALE } from '../src/shared/treeFire'

describe('treeFire', () => {
  it('places the flame in the canopy relative to scaled height', () => {
    const p = treeFirePlacement({ x: 10, y: 50, z: 20 }, { x: 0.3, y: 0.3, z: 0.3 })
    expect(p.position.x).toBe(10)
    expect(p.position.z).toBe(20)
    expect(p.position.y).toBeCloseTo(50 + TREE_GLB_TOP_M * 0.3 * TREE_FIRE_HEIGHT_FRAC)
  })
  it('clamps flame scale', () => {
    expect(treeFirePlacement({ x: 0, y: 0, z: 0 }, { x: 0.01, y: 0.01, z: 0.01 }).flameScale).toBe(TREE_FIRE_MIN_SCALE)
    expect(treeFirePlacement({ x: 0, y: 0, z: 0 }, { x: 50, y: 50, z: 50 }).flameScale).toBe(TREE_FIRE_MAX_SCALE)
  })
  it('ranks nearest by XZ', () => {
    const pts = [{ x: 10, y: 0, z: 0 }, { x: 1, y: 99, z: 0 }, { x: 5, y: 0, z: 0 }]
    expect(nearestIndices(pts, { x: 0, y: 0, z: 0 }, 2)).toEqual([1, 2])
  })
  it('varies deterministically per tree', () => {
    const a = treeFireVariant({ x: 340.62, y: 51.33, z: 340.42 })
    expect(treeFireVariant({ x: 340.62, y: 51.33, z: 340.42 })).toEqual(a)
    const sizes = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => treeFireVariant({ x: 300 + i * 3.7, y: 51, z: 320 + i }).size)
    sizes.forEach((s) => { expect(s).toBeGreaterThanOrEqual(1 - TREE_FIRE_SIZE_VARIANCE); expect(s).toBeLessThanOrEqual(1 + TREE_FIRE_SIZE_VARIANCE) })
    expect(new Set(sizes.map((s) => s.toFixed(3))).size).toBeGreaterThan(4)
  })
  it('flicker stays bounded and differs per seed', () => {
    for (let t = 0; t < 10; t += 0.07) {
      const f = treeFireLightFlicker(t, 0.3)
      expect(Math.abs(f.range - 1)).toBeLessThanOrEqual(TREE_FIRE_LIGHT_RANGE_FLICKER + 1e-9)
    }
    expect(fireNoise(1.23, 0.1)).not.toBeCloseTo(fireNoise(1.23, 0.6), 3)
  })
  it('lights roughly the configured fraction, deterministically', () => {
    const pts = Array.from({ length: 600 }, (_, i) => ({ x: 300 + (i % 30) * 3.1, y: 51 + (i % 7) * 0.13, z: 280 + Math.floor(i / 30) * 4.7 }))
    const lit = pts.filter((p) => isTreeLit(p)).length
    expect(Math.abs(lit / pts.length - TREE_FIRE_LIT_FRACTION)).toBeLessThan(0.07)
    expect(pts.map((p) => isTreeLit(p))).toEqual(pts.map((p) => isTreeLit(p)))
  })
  it('rotation order is a stable permutation', () => {
    const pts = Array.from({ length: 56 }, (_, i) => ({ x: 300 + (i % 8) * 3.1, y: 51, z: 280 + Math.floor(i / 8) * 4.7 }))
    const r = treeFireOrder(pts, 42)
    expect([...r].sort((a, b) => a - b)).toEqual(pts.map((_, i) => i))
    expect(treeFireOrder(pts, 42)).toEqual(r)
    expect(treeFireOrder(pts, 43)).not.toEqual(r)
  })
  it('swaps exactly one tree per step and keeps ~1/3 lit', () => {
    const n = 56, L = treeFireLitCount(n)
    expect(L).toBe(19)
    for (let step = 0; step < 3 * n; step++) {
      const a = Array.from({ length: n }, (_, k) => isRankLit(k, n, step))
      const b = Array.from({ length: n }, (_, k) => isRankLit(k, n, step + 1))
      expect(a.filter(Boolean).length).toBe(L)
      const out = a.filter((x, k) => x && !b[k]).length, inn = a.filter((x, k) => !x && b[k]).length
      expect(out).toBe(1); expect(inn).toBe(1)
    }
  })
  it('a tree that just went out stays out for n - lit swaps', () => {
    const n = 56, L = treeFireLitCount(n)
    // rank 0 is lit at step 0 and goes out at step 1
    expect(isRankLit(0, n, 0)).toBe(true)
    for (let s = 1; s <= n - L; s++) expect(isRankLit(0, n, s)).toBe(false)
    expect(isRankLit(0, n, n - L + 1)).toBe(true)
  })
  it('step derives from elapsed time', () => {
    expect(treeFireStepAt(0)).toBe(0)
    expect(treeFireStepAt(TREE_FIRE_SWAP_SEC * 1000 * 5 + 1)).toBe(5)
    expect(treeFireStepAt(-100)).toBe(0)
  })
})
