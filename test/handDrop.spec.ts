import { handScaleAt, HAND_DROP_WINDUP_SEC } from '../src/shared/handDropAnim'

describe('hand drop wind-up', () => {
  it('starts at 0 and ends at 1', () => {
    expect(handScaleAt(0)).toBe(0)
    expect(handScaleAt(HAND_DROP_WINDUP_SEC)).toBe(1)
    expect(handScaleAt(HAND_DROP_WINDUP_SEC * 5)).toBe(1)
  })
  it('eases out (past halfway at the midpoint) and is monotonic', () => {
    expect(handScaleAt(HAND_DROP_WINDUP_SEC / 2)).toBeGreaterThan(0.5)
    let prev = -1
    for (let i = 0; i <= 20; i++) {
      const s = handScaleAt((HAND_DROP_WINDUP_SEC * i) / 20)
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })
  it('zero duration snaps to full', () => {
    expect(handScaleAt(0, 0)).toBe(1)
  })
})
