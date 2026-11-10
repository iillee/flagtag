import { isOpenLavaAt, lavaOpenCellCount, pickLavaBubblePoint } from '../src/shared/lavaBubbleSpawn'

const CASTLE = { x0: 294, x1: 433, z0: 239, z1: 456 }

describe('lava bubble spawn mask', () => {
  it('has a usable amount of open lava', () => {
    expect(lavaOpenCellCount()).toBeGreaterThan(500)
  })

  it('never spawns inside the castle footprint or outside the lava circle', () => {
    for (const [px, pz] of [[400, 400], [364, 348], [100, 100], [700, 650], [385, 392]]) {
      for (let i = 0; i < 2000; i++) {
        const p = pickLavaBubblePoint(px, pz, 180)!
        expect(p).not.toBeNull()
        expect(isOpenLavaAt(p.x, p.z)).toBe(true)
        const inCastle = p.x > CASTLE.x0 && p.x < CASTLE.x1 && p.z > CASTLE.z0 && p.z < CASTLE.z1
        expect(inCastle).toBe(false)
        expect(Math.hypot(p.x - 400, p.z - 400)).toBeLessThanOrEqual(368)
      }
    }
  })

  it('castle centre and far corners are not open lava', () => {
    expect(isOpenLavaAt(364, 348)).toBe(false)
    expect(isOpenLavaAt(5, 5)).toBe(false)
    expect(isOpenLavaAt(795, 795)).toBe(false)
  })
})