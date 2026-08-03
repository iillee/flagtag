# CRDT Saturation Reduction — Session Handoff

**Purpose:** Context for a fresh session picking up the CRDT / MessageBus traffic reduction work in Flag Tag.

> **UPDATE 2026-08-03 — the platform CRDT issue is fixed, and both heartbeat
> workarounds have been removed.** `posHeartbeat` (client → server position
> reporting) and `ghostHeartbeat` (ghost fallback visual) are gone, along with
> `src/server/positionTrust.ts`, `src/systems/positionHeartbeat.ts`, and
> `src/shared/ghostHeartbeat.ts`. `getPlayerPosition` reads the CRDT Transform
> again. This removes the single largest stream in the budget table below
> (`posHeartbeat` at N × 8 Hz), so the MEDIUM priority item (3) and every
> "don't break the heartbeat" guardrail no longer apply. The retained defenses
> are the `requestSteal` corroboration gate and the duplicate-entity
> diagnostics. Sections below are kept as written for historical context —
> re-measure before acting on the numbers.

**Current branch state (as of the original handoff):** on `main`, clean. Last three PRs merged in order:
- #17 — Ghost fallback visual channel (invisible-ghost fix)
- #18 & #19 — Ghost fallback polish (rotation, death flash)
- (unnumbered on GitHub) — `fix/proximity-steal-heartbeat` merged: reliable proximity steal via heartbeat position + dual-corroboration + three visual/audio consistency fixes

---

## Why we're doing this

### The symptom chain
Playtest of the proximity-steal PR (~4 players, night play) surfaced two remaining issues:
1. **Scoreboard ghost names** — players who left the scene stayed on the live scoreboard indefinitely (likely CRDT removal for `PlayerIdentityData` / `PlayerFlagHoldTime` got dropped under load).
2. **One player fully disconnected** — connected to Decentraland realm but not to our authoritative server room; saw a local default flag state, couldn't be stolen from. Probably NOT saturation directly (likely a room-join failure), but saturation could contribute via server CPU pressure.

3-of-4 players had clean gameplay, so the steal fix itself is working. These remaining issues point at the underlying CRDT / MessageBus saturation problem.

### The MessageBus budget
The auth-server allows **~40 messages/second per room**. Below is a rough steady-state estimate for a busy night with ~5 players + one active ghost + one flag being carried/dropped:

| Stream | Approx rate | Notes |
|---|---|---|
| ~~`posHeartbeat` inbound~~ | ~~**N × 8 Hz**~~ | Client → server, per-player. 5 players = 40/s. **By itself hit the limit.** REMOVED 2026-08-03. |
| `ghostTouching` outbound | **~30 Hz** while touching | Server → all clients, every server tick while ghost contacts anyone |
| Flag falling CRDT (Transform + `Flag` component) | **~30 Hz** during multi-second falls | Directly saturates the CRDT bus |
| Ghost CRDT target updates | ~5 Hz | Reasonable |
| ~~`ghostHeartbeat` (WS fallback)~~ | ~~~2 Hz~~ | Added in PR #17. REMOVED 2026-08-03. |
| `flagHeartbeat` | 1 Hz | Fine |
| `PlayerFlagHoldTime` CRDT | 0.5 Hz | Already throttled from 2 Hz historically |
| Combat MessageBus | Event bursts | Correct pattern; not steady |

We're demonstrably over budget under normal play. This is what's causing components to fail to replicate ("scoreboard ghosts").

### The feedback loop
Historical context: Flag Tag hit CRDT saturation before, and the fix was moving projectiles/traps off `syncEntity` onto MessageBus. Since then, we've added WS fallbacks (`flagHeartbeat`, `ghostHeartbeat`, `posHeartbeat`) to paper over CRDT gaps — those are lightweight, but the *un-throttled event streams* (`ghostTouching`, flag fall) still saturate the bus, and saturation is what forces us to rely on the fallbacks. Vicious cycle. Reducing the event-stream churn should reduce reliance on fallbacks.

(2026-08-03: `ghostHeartbeat` and `posHeartbeat` were removed once the platform CRDT issue was fixed; `flagHeartbeat` remains.)

---

## The plan

### Priority order (from grok's analysis, validated)

**HIGH — do first, cheapest ROI:**
1. **Throttle or edge-trigger `ghostTouching`**
   - Location: `src/server/ghostSystem.ts` around line 167:
     ```ts
     if (nearest.distXZ < GHOST_HIT_RADIUS) {
       room.send('ghostTouching', { victimId: nearest.addr })
     }
     ```
   - Currently fires every server tick (~30 Hz) to ALL clients while any ghost touches any player.
   - **Fix direction:** edge-trigger — send `ghostTouchStarted` when contact begins, `ghostTouchStopped` when it ends. Client interpolates scare meter locally between events.
   - Alternative (simpler): throttle to 5 Hz per victim. Scare meter fills over 3s of contact (`SCARE_TIME` in `src/systems/ghostSystem.ts`), so 200ms granularity is invisible.
   - Client scare meter logic in `src/systems/ghostSystem.ts` currently uses `ghostTouchingThisFrame` as a boolean flipped by each `ghostTouching` message. Would need adaptation for edge-trigger.

**HIGH — do second:**
2. **Throttle flag-fall CRDT writes**
   - Location: `src/server/flagLogic.ts` around line 556:
     ```ts
     if (flag.state === FlagState.Dropped && flagFalling) {
       // ... gravity math ...
       const flagMutable = Flag.getMutable(flagEntity)
       flagMutable.dropAnchorY = newY
     }
     ```
   - Plus Transform re-assert whenever position changes → every frame of a multi-second sink is a CRDT write.
   - **Fix direction:** two options
     - **(a)** Quantize CRDT writes to ~10 Hz during fall (write only if 100ms elapsed since last write). Interpolation on client.
     - **(b)** Same pattern as `dropForced`: send fall position via a new `flagFalling` WS message at ~10 Hz, only write CRDT on final rest. Requires client-side interpolation logic parallel to what CRDT would have driven.
   - **(a)** is smaller / lower risk. Start there.

**MEDIUM — ~~defer unless (1) + (2) don't resolve remaining issues~~ MOOT as of 2026-08-03:**
3. ~~**Tune `posHeartbeat` cadence**~~ — the stream was removed outright, which recovers the whole N × 8 Hz budget this item was trying to trim. Nothing left to tune.

**DO NOT DO:**
- Reintroduce projectile/trap `syncEntity`. This was the original saturation source and is correctly off CRDT.
- Reduce `flagHeartbeat` — 1 Hz, negligible.
- Reduce `PlayerFlagHoldTime` CRDT below 0.5 Hz — scoreboard smoothness suffers.

---

## Constraints and guardrails

- ~~**The anti-cross-wire mechanism (`positionTrust.ts` + `posHeartbeat`) must remain functionally intact.**~~ Removed 2026-08-03 with the platform fix. The `requestSteal` corroboration gate in `stealIntent.ts` is what the steal path now depends on — keep that.
- **Don't break `flagHeartbeat`** — it's the live scoreboard's reliable transport when `PlayerFlagHoldTime` CRDT stalls.
- **Keep the pattern of extractable pure logic + unit tests.** Every meaningful change to server logic in this codebase gets a `test/*.spec.ts` file (see `test/stealIntent.spec.ts`, `test/ghostContactState.spec.ts` for the shape). Don't skip this.
- **Small atomic PRs.** The project's rhythm is one focused change per PR. If (1) and (2) are independent, they can be one PR (both reduce message traffic, same theme). Don't stack unrelated work.
- **Bump `src/version.ts`** — the pre-commit hook does it automatically. Don't fight it.

---

## What "done" looks like

- **Measured:** on server-side, log throttled traffic counters (e.g. "sent 47 `ghostTouching` messages in the last 10s, dropped 250" style). Add a diagnostic on the server that logs approximate `msg/s` fanout every 30s so we can characterize the impact of the reduction in playtest.
- **Playtest signal:** scoreboard ghost names should stop appearing (or become rare). Ghost/steal reliability holds. No new regressions in visual smoothness.
- **Regression protection:** existing tests pass (currently 121 across 15 spec files). New pure logic (if any extracted) has its own tests.

---

## Related files to load in the new session

**Read first:**
- This document (obviously)
- `src/server/ghostSystem.ts` — the `ghostTouching` broadcast
- `src/server/flagLogic.ts` — around line 556 for flag gravity, around line 500 for `flagHeartbeat` (reference for the WS pattern)
- `src/systems/ghostSystem.ts` — how the client consumes `ghostTouching` and drives the scare meter
- `src/shared/messages.ts` — for any new WS message additions

**Reference:**
- `src/server/stealIntent.ts` — the retained `requestSteal` corroboration gate (don't break)
- `docs/history/KNOWN_BUGS-2026-06.md` — historical context on the original saturation crisis
- `docs/BUG_stale-crdt-transform-in-combat.md` — the cross-wire bug that motivated `posHeartbeat` (fixed platform-side; heartbeat removed 2026-08-03)

---

## Related context: SDK bump is blocked

We tried to bump `@dcl/sdk@auth-server` from July's `7.24.6` to `7.25.x` for the "clearer logs" improvements. Two blockers:
1. `@dcl/js-runtime/apis.d.ts` in the new SDK references `import('../ecs').AvatarMask`, but no `ecs` module exists at that path — typecheck / build fails.
2. `room.onMessage` type inference broke — every handler now needs explicit type params. ~20 files, real migration.

Filed with the Foundation via the community-manager bridge. Until fixed, we stay on `7.24.6-29505165911.commit-d270434`. **This work must succeed on the July SDK.**

---

## Suggested opening move for the new session

1. Confirm on `main`, clean tree, tests green.
2. Read this document + the four "Read first" source files.
3. Branch: `perf/reduce-crdt-saturation`.
4. Start with priority (1) — `ghostTouching` throttle/edge-trigger. Extract any decision logic into a pure module (e.g. `src/shared/ghostContactState.ts`) with a spec file.
5. Add the `msg/s` diagnostic counter alongside so we can measure impact.
6. Once (1) is clean and tested, add priority (2) — flag-fall CRDT throttle — in the same PR (same theme).
7. Deploy to `flagtag.dcl.eth`, playtest with 3+ players, verify scoreboard ghosts stop appearing.
8. ~~If saturation is still evident in logs, THEN consider (3) `posHeartbeat` tuning~~ — moot; the stream is gone as of 2026-08-03.

Ready when the new session starts.
