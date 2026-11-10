import { nextDropNonce, isPredictionExpired, findPrediction, needsServerSnap, DROP_PREDICTION_TIMEOUT_MS } from '../src/shared/dropPrediction'

describe('dropPrediction', () => {
  it('nonces are non-zero and unique', () => {
    const a = nextDropNonce(), b = nextDropNonce()
    expect(a).not.toBe(0)
    expect(b).not.toBe(a)
  })
  it('expires after the timeout', () => {
    expect(isPredictionExpired(1000, 1000 + DROP_PREDICTION_TIMEOUT_MS)).toBe(false)
    expect(isPredictionExpired(1000, 1001 + DROP_PREDICTION_TIMEOUT_MS)).toBe(true)
  })
  it('matches by nonce, never by 0/undefined', () => {
    const list = [{ nonce: 0 }, { nonce: 7 }, { nonce: 9 }]
    expect(findPrediction(list, 9)).toBe(2)
    expect(findPrediction(list, 0)).toBe(-1)
    expect(findPrediction(list, undefined)).toBe(-1)
    expect(findPrediction(list, 3)).toBe(-1)
  })
  it('snaps only when the server position is noticeably different', () => {
    expect(needsServerSnap(0, 0, 0.3, 0.2)).toBe(false)
    expect(needsServerSnap(0, 0, 2, 0)).toBe(true)
  })
})
