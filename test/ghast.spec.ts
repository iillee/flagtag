import {
  ghastPosAt, pickGhastTarget, fireballLaunch, fireballPosAt, segPointDist2, turnToward, yawToward, ghastAim,
  ghastFiringAllowed, ghastMoanDue, ghastFireballBombId, isGhastFireballBombId,
  GHAST_CENTER, GHAST_ORBIT_RADIUS_MIN_M, GHAST_ORBIT_RADIUS_MAX_M, GHAST_ORBIT_RADIUS_WOBBLE_M,
  GHAST_ALT_MIN, GHAST_ALT_MAX, GHAST_RANGE_M, GHAST_MIN_DROP_M, GHAST_COUNT,
  GHAST_PAUSE_BEFORE_ROUND_END_S, GHAST_ROUND_START_GRACE_S,
  GhastClock, ghastMouthPos, fireballBlend, GHAST_MOUTH_OFFSET, GHAST_SPEED, GHAST_SPEED_VARIANCE,
  GHAST_ORBIT_WOBBLE_PERIOD_MIN_S, GHAST_ALT_WOBBLE_M, GHAST_ALT_WOBBLE_PERIOD_MIN_S, GHAST_BOB_M, GHAST_BOB_PERIOD_S,
  GHAST_SWOOP_ALT, GHAST_SWOOP_DURATION_S, ghastSwoopAt, ghastBodyHit, GHAST_BODY_CENTER_Y,
  ghastOrbitParams, ghastTravelYaw, GHAST_ROUTE_MAX_EXTENT_M,
  ghastLifeAt, ghastDeathPose, ghastRespawnScale, GHAST_DEATH_SINK_S, GHAST_RESPAWN_FADE_S,
} from '../src/shared/ghast'

describe('ghast orbits', () => {
  it('stay in the orbit ring and altitude band', () => {
    for (let i = 0; i < GHAST_COUNT; i++) {
      for (let t = 0; t < 3_600_000; t += 7_919) {
        const p = ghastPosAt(i, t, 1234)
        const r = Math.hypot(p.x - GHAST_CENTER.x, p.z - GHAST_CENTER.z)
        expect(r).toBeLessThanOrEqual(GHAST_ROUTE_MAX_EXTENT_M + 1e-6)
        expect(p.y).toBeGreaterThanOrEqual(Math.min(GHAST_ALT_MIN, GHAST_SWOOP_ALT - GHAST_BOB_M) - 1e-6)
        expect(p.y).toBeLessThanOrEqual(GHAST_ALT_MAX + 1e-6)
      }
    }
  })
  it('ellipse/trefoil routes circle the castle (angle keeps advancing one way)', () => {
    for (let i = 0; i < GHAST_COUNT; i++) {
      if (ghastOrbitParams(i, 99).shape === 'figure8') continue
      let total = 0
      let prev = ghastPosAt(i, 0, 99)
      for (let t = 1000; t <= 300_000; t += 1000) {
        const p = ghastPosAt(i, t, 99)
        let d = Math.atan2(p.z - GHAST_CENTER.z, p.x - GHAST_CENTER.x) - Math.atan2(prev.z - GHAST_CENTER.z, prev.x - GHAST_CENTER.x)
        d = ((d + 3 * Math.PI) % (2 * Math.PI)) - Math.PI
        total += d
        prev = p
      }
      expect(Math.abs(total)).toBeGreaterThan(2 * Math.PI) // > 1 lap in 5 min
    }
  })
  it('are deterministic, smooth, and differ per ghast', () => {
    expect(ghastPosAt(0, 50_000, 7)).toEqual(ghastPosAt(0, 50_000, 7))
    const a = ghastPosAt(0, 50_000, 7), b = ghastPosAt(0, 50_100, 7)
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(1.5) // < 15 m/s even mid-swoop
    const c = ghastPosAt(1, 50_000, 7)
    expect(Math.hypot(a.x - c.x, a.z - c.z)).toBeGreaterThan(0.1)
  })
})

describe('ghast round gate', () => {
  const now = 1_000_000
  const base = { roundEndTimeMs: now + 60_000, roundEndTriggered: false, roundEndDisplayUntilMs: 0 }
  it('fires mid-round only', () => {
    expect(ghastFiringAllowed(now, base)).toBe(true)
    expect(ghastFiringAllowed(now, null)).toBe(false)
    expect(ghastFiringAllowed(now, { ...base, roundEndTriggered: true })).toBe(false)
    expect(ghastFiringAllowed(now, { ...base, roundEndTimeMs: now + GHAST_PAUSE_BEFORE_ROUND_END_S * 1000 - 1 })).toBe(false)
    expect(ghastFiringAllowed(now, { ...base, roundEndDisplayUntilMs: now - GHAST_ROUND_START_GRACE_S * 1000 + 1 })).toBe(false)
    expect(ghastFiringAllowed(now, { ...base, roundEndDisplayUntilMs: now - GHAST_ROUND_START_GRACE_S * 1000 - 1 })).toBe(true)
  })
})

describe('ghast misc', () => {
  it('fireball bomb ids never collide with real bombs', () => {
    expect(isGhastFireballBombId(ghastFireballBombId(1))).toBe(true)
    expect(isGhastFireballBombId(0)).toBe(false)
    expect(isGhastFireballBombId(-1)).toBe(false) // predicted local bombs
  })
  it('moans come periodically', () => {
    let n = 0
    for (let t = 1000; t <= 140_000; t += 100) if (ghastMoanDue(0, t - 100, t, 5)) n++
    expect(n).toBeGreaterThanOrEqual(9)
    expect(n).toBeLessThanOrEqual(21)
  })
})

describe('ghast targeting', () => {
  const g = { x: 0, y: 100, z: 0 }
  it('picks the nearest eligible player below the ghast within range', () => {
    const t = pickGhastTarget(g, [
      { id: 'far', pos: { x: GHAST_RANGE_M, y: 60, z: 0 } },
      { id: 'near', pos: { x: 10, y: 60, z: 0 } },
      { id: 'level', pos: { x: 1, y: 100 - GHAST_MIN_DROP_M + 1, z: 0 } },
      { id: 'interior', pos: { x: 0, y: 5, z: 0 } },
    ])
    expect(t?.id).toBe('near')
  })
  it('returns null when nobody qualifies', () => {
    expect(pickGhastTarget(g, [{ id: 'x', pos: { x: 500, y: 60, z: 0 } }])).toBeNull()
  })
})

describe('fireballs', () => {
  it('fly straight to the aim point and stop there', () => {
    const l = fireballLaunch({ x: 0, y: 10, z: 0 }, { x: 0, y: 10, z: 20 })
    expect(l.dist).toBeCloseTo(20)
    expect(fireballPosAt(l, 0.5, 20).z).toBeCloseTo(10)
    expect(fireballPosAt(l, 5, 20).z).toBeCloseTo(20)
  })
  it('swept hit test catches a pass-through between ticks', () => {
    expect(segPointDist2({ x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBeCloseTo(1)
    expect(segPointDist2({ x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 9, y: 0, z: 0 })).toBeCloseTo(16)
  })
  it('lead offsets the aim by velocity', () => {
    expect(ghastAim({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, 0.5).x).toBeCloseTo(1)
    expect(ghastAim({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, 0).x).toBe(0)
  })
})

describe('facing', () => {
  it('turns the short way and caps the step', () => {
    expect(turnToward(170, -170, 30)).toBeCloseTo(190)
    expect(turnToward(0, 90, 30)).toBe(30)
    expect(yawToward({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(90)
  })
})

describe('server/client position parity', () => {
  // Upper bound on ghast speed (orbit + radius wobble + altitude wobble + bob), m/s.
  const vmax = GHAST_SPEED * (1 + GHAST_SPEED_VARIANCE) + GHAST_ORBIT_RADIUS_WOBBLE_M * 2 * Math.PI / GHAST_ORBIT_WOBBLE_PERIOD_MIN_S
    + GHAST_ALT_WOBBLE_M * 2 * Math.PI / GHAST_ALT_WOBBLE_PERIOD_MIN_S + GHAST_BOB_M * 2 * Math.PI / GHAST_BOB_PERIOD_S
    + (GHAST_ALT_MAX - GHAST_SWOOP_ALT) * Math.PI / GHAST_SWOOP_DURATION_S

  it('client tracks the server path within latency, despite a different clock domain', () => {
    const seed = 4242
    const serverEpoch = 5_000_000 // server Date.now() at its start
    const clientSkew = 987_654_321 // client Date.now() = server Date.now() + skew
    const clock = new GhastClock()
    let serverNow = serverEpoch + 600_000 // client joins 10 min into the server
    let rng = 1
    const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647)
    // Initial sync reply arrives late (300 ms), then charge/fire events with jittery latency.
    clock.reset(serverNow + 300 + clientSkew, serverNow - serverEpoch)
    for (let k = 0; k < 40; k++) {
      serverNow += 2000
      const delay = 40 + rand() * 260
      clock.sample(serverNow + delay + clientSkew, serverNow - serverEpoch)
      for (let f = 0; f < 120; f++) clock.tick(1 / 60) // 2 s of client frames
    }
    const clientNow = serverNow + clientSkew
    for (let i = 0; i < GHAST_COUNT; i++) {
      const server = ghastPosAt(i, serverNow - serverEpoch, seed)
      const client = ghastPosAt(i, clock.elapsed(clientNow), seed)
      const gap = Math.hypot(server.x - client.x, server.y - client.y, server.z - client.z)
      // Residual error is bounded by one-way latency (max 300 ms here) times speed.
      expect(gap).toBeLessThanOrEqual(vmax * 0.3 + 0.05)
      expect(gap).toBeLessThan(4)
    }
  })

  it('snaps on a big clock error and slews small ones', () => {
    const c = new GhastClock()
    c.reset(10_000, 0)
    c.sample(100_000, 0) // 90 s later than expected... (min keeps 10_000)
    expect(c.epoch).toBe(10_000)
    c.sample(5_000, 0) // 5 s earlier: snap
    expect(c.epoch).toBe(5_000)
    c.sample(4_900, 0) // 100 ms: slew, not jump
    expect(c.epoch).toBe(5_000)
    c.tick(1)
    expect(c.epoch).toBeCloseTo(4_900 + 5, 0) // reached target (relaxed 5 ms)
  })

  it('mouth is in front of the face and the blend leaves from it', () => {
    const p = { x: 10, y: 50, z: 10 }
    const m0 = ghastMouthPos(p, 0)
    expect(m0.z - p.z).toBeCloseTo(GHAST_MOUTH_OFFSET.z)
    expect(m0.y - p.y).toBeCloseTo(GHAST_MOUTH_OFFSET.y)
    const m90 = ghastMouthPos(p, 90) // facing +X
    expect(m90.x - p.x).toBeCloseTo(GHAST_MOUTH_OFFSET.z)
    expect(m90.z - p.z).toBeCloseTo(0)
    expect(fireballBlend(0)).toBe(1)
    expect(fireballBlend(0.15)).toBeCloseTo(0.5)
    expect(fireballBlend(0.3)).toBe(0)
  })
})

describe('ghast swoops and death', () => {
  it('each ghast swoops down into reach periodically', () => {
    for (let i = 0; i < GHAST_COUNT; i++) {
      let minY = Infinity, swoops = 0, was = false
      for (let t = 0; t < 600_000; t += 250) {
        const y = ghastPosAt(i, t, 77).y
        minY = Math.min(minY, y)
        const low = ghastSwoopAt(i, t, 77) > 0.9
        if (low && !was) swoops++
        was = low
      }
      expect(minY).toBeLessThan(GHAST_SWOOP_ALT + 3)
      expect(swoops).toBeGreaterThanOrEqual(7) // 10 min / <=75 s
    }
  })
  it('body hit sphere sits above the pivot', () => {
    const p = { x: 0, y: 50, z: 0 }
    expect(ghastBodyHit(p, { x: 0, y: 50 + GHAST_BODY_CENTER_Y + 2.9, z: 0 }, 3)).toBe(true)
    expect(ghastBodyHit(p, { x: 0, y: 50 - 1.5, z: 0 }, 3)).toBe(false)
  })
  it('life phases and poses', () => {
    const died = 10_000, resp = died + 5000
    expect(ghastLifeAt(9_999, died, resp)).toBe('alive')
    expect(ghastLifeAt(died + 100, died, resp)).toBe('dying')
    expect(ghastLifeAt(died + GHAST_DEATH_SINK_S * 1000 + 1, died, resp)).toBe('dead')
    expect(ghastLifeAt(resp + 1, died, resp)).toBe('respawning')
    expect(ghastLifeAt(resp + GHAST_RESPAWN_FADE_S * 1000 + 1, died, resp)).toBe('alive')
    expect(ghastLifeAt(5, -1, 0)).toBe('alive')
    expect(ghastDeathPose(0)).toEqual({ sink: 0, spinDeg: 0, scale: 1 })
    const end = ghastDeathPose(GHAST_DEATH_SINK_S * 1000)
    expect(end.sink).toBe(1)
    expect(end.scale).toBe(0)
    expect(ghastRespawnScale(0)).toBe(0)
    expect(ghastRespawnScale(GHAST_RESPAWN_FADE_S * 1000)).toBe(1)
  })
})

describe('ghast routes are distinct per ghast', () => {
  for (const seed of [1, 7, 4242, 777777, 123456]) {
    it(`seed ${seed}: params, direction, shape, positions and facing differ`, () => {
      const P = Array.from({ length: GHAST_COUNT }, (_, i) => ghastOrbitParams(i, seed))
      const gapR = (GHAST_ORBIT_RADIUS_MAX_M - GHAST_ORBIT_RADIUS_MIN_M) / GHAST_COUNT * 0.5
      for (let a = 0; a < GHAST_COUNT; a++) {
        for (let b = a + 1; b < GHAST_COUNT; b++) {
          expect(Math.abs(P[a].r - P[b].r)).toBeGreaterThanOrEqual(gapR * 0.99)
          expect(Math.abs(P[a].alt - P[b].alt)).toBeGreaterThan(2)
          expect(P[a].shape).not.toBe(P[b].shape)
          // Positions and facing differ most of the time.
          let far = 0, turned = 0, samples = 0
          for (let t = 0; t < 1_800_000; t += 9_973) {
            samples++
            const pa = ghastPosAt(a, t, seed), pb = ghastPosAt(b, t, seed)
            if (Math.hypot(pa.x - pb.x, pa.z - pb.z) > 15) far++
            const d = Math.abs(((ghastTravelYaw(a, t, seed) - ghastTravelYaw(b, t, seed) + 540) % 360) - 180)
            if (d > 20) turned++
          }
          expect(far / samples).toBeGreaterThan(0.8)
          expect(turned / samples).toBeGreaterThan(0.6)
        }
      }
      // At least one goes the other way.
      expect(P.some((p) => p.w > 0)).toBe(true)
      expect(P.some((p) => p.w < 0)).toBe(true)
    })
  }

  it('server and client compute positions with the same shared function', () => {
    const fs = require('fs') as typeof import('fs')
    const server = fs.readFileSync('src/server/ghastServer.ts', 'utf8')
    const client = fs.readFileSync('src/systems/ghastSystem.ts', 'utf8')
    for (const src of [server, client]) {
      expect(src).toMatch(/from '\.\.\/shared\/ghast'/)
      expect(src).toMatch(/ghastPosAt\(i, /)
      expect(src).not.toMatch(/ghastPosAt\(0, /)
    }
  })

  it('facing follows the route velocity', () => {
    const seed = 31
    for (let i = 0; i < GHAST_COUNT; i++) {
      const t = 120_000
      const a = ghastPosAt(i, t, seed), b = ghastPosAt(i, t + 50, seed)
      const v = (Math.atan2(b.x - a.x, b.z - a.z) * 180) / Math.PI
      const d = Math.abs(((ghastTravelYaw(i, t, seed) - v + 540) % 360) - 180)
      expect(d).toBeLessThan(15)
    }
  })
})
