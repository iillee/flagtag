/**
 * Tests for src/shared/flagFall.ts — analytic gravity used by both server
 * (pickup validation, landing detection, water-hit detection) and client
 * (local visual interpolation) for the message-driven flag fall pattern.
 */
import { computeFallY, computeLandTimeMs } from '../src/shared/flagFall'

const G = 20  // arbitrary but stable across tests; production uses FLAG_GRAVITY

describe('computeFallY', () => {
  it('returns startY exactly at dropTime', () => {
    expect(computeFallY(100, 0, 1000, 1000, G)).toBe(100)
  })

  it('returns startY if now is BEFORE dropTime (clock skew / replay guard)', () => {
    // Without this guard a stale/late-arriving flagFallStart could produce
    // a Y above startY (from a negative t² is still positive — but a
    // negative t means the fall hasn't started, which is what we want).
    expect(computeFallY(100, 0, 2000, 1500, G)).toBe(100)
  })

  it('drops by 0.5·g·t² after t seconds', () => {
    // 1 second at g=20 → drops 10m
    expect(computeFallY(100, 0, 1000, 2000, G)).toBeCloseTo(90, 5)
    // 2 seconds → drops 40m
    expect(computeFallY(100, 0, 1000, 3000, G)).toBeCloseTo(60, 5)
  })

  it('clamps to targetY after landing', () => {
    // With g=20 and drop 100 → 0, land time = sqrt(200/20)s = ~3.162s
    const landMs = computeLandTimeMs(100, 0, G)
    expect(computeFallY(100, 0, 1000, 1000 + landMs, G)).toBeCloseTo(0, 5)
    // Long after landing — still clamped, not going through the floor
    expect(computeFallY(100, 0, 1000, 10_000, G)).toBe(0)
  })

  it('handles non-zero targetY', () => {
    // Fall from 100 to 50 over sqrt(100/20)s = ~2.236s
    const landMs = computeLandTimeMs(100, 50, G)
    expect(landMs).toBeCloseTo(2236, -1)
    expect(computeFallY(100, 50, 0, landMs, G)).toBeCloseTo(50, 5)
    expect(computeFallY(100, 50, 0, landMs + 5000, G)).toBe(50)
  })

  it('server and client agree at the same nowMs (determinism)', () => {
    // Same inputs → same output. This is the whole reason we use analytic
    // instead of Euler: the server's pickup validation and every client's
    // local visual sim compute IDENTICAL Y for the same `now`.
    const nowMs = 4321
    const dropMs = 1000
    const serverY = computeFallY(200, 10, dropMs, nowMs, G)
    const clientY = computeFallY(200, 10, dropMs, nowMs, G)
    expect(serverY).toBe(clientY)
  })
})

describe('computeLandTimeMs', () => {
  it('returns 0 when targetY is at or above startY (nothing to fall through)', () => {
    expect(computeLandTimeMs(50, 50, G)).toBe(0)
    expect(computeLandTimeMs(50, 60, G)).toBe(0)
  })

  it('returns the correct kinematic land time', () => {
    // drop = 20m, g = 20 → t = sqrt(2s²) = ~1.414s → 1414ms
    expect(computeLandTimeMs(20, 0, G)).toBeCloseTo(1414, -1)
  })

  it('scales as sqrt(drop distance) — 4x drop = 2x time', () => {
    const t1 = computeLandTimeMs(10, 0, G)
    const t4 = computeLandTimeMs(40, 0, G)
    expect(t4 / t1).toBeCloseTo(2, 3)
  })
})
