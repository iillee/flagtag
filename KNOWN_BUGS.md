# Known Bugs — Playtest Tracking

Last updated: May 18, 2026

These three game-breaking bugs have been recurring over the past month during multiplayer sessions. Recent refactoring may have resolved them. This document tracks root causes, fixes applied, and remaining risks for the May 19 playtest.

---

## Bug 1: Scoreboard Stops Tracking

**Symptoms:**
- Live scoreboard on the right freezes mid-round
- Players stuck at 0 points, or stuck at a random score
- Usually happens after playing with multiple players for a while
- Final round-end cinematic score often appears correct
- Sometimes self-corrects on new round, sometimes persists

**Root Causes Identified & Fixed:**

1. **CRDT buffer saturation (commit `5b9f2ba`)**
   - Projectiles and traps were synced via `syncEntity` but visuals were driven entirely by WebSocket messages. The CRDT writes + tombstone recycling accumulated and eventually blocked ALL CRDT propagation — including `PlayerFlagHoldTime` updates that drive the scoreboard.
   - **Fix:** Removed `syncEntity` calls from projectiles and traps. Server collision detection unchanged (still authoritative).

2. **`hasZero` scoreboard wipe (commit `bb7a12e`)**
   - Old logic: "if ANY hold-time entity for a player has seconds=0, force their displayed score to 0." Orphaned duplicate CRDT entities (from server restarts or ghost data) with seconds=0 would override the real entity's score.
   - **Fix:** Now only forces score to 0 when ALL entities for a player are 0 (true round reset). Mixed 0/non-zero keeps the max.

3. **Ghost players on scoreboard (commit `bb7a12e`)**
   - Stale `onEnterScene` CRDT events added phantom players to `playersInScene`. These ghosts appeared on the scoreboard with 0 or stale scores.
   - **Fix:** `addPlayer()` now validates remote players against `PlayerIdentityData` before accepting. `nameResolverSystem` periodically reconciles `playersInScene` against engine entities.

4. **Round-end race condition (addressed in `roundManager.ts`)**
   - If flag was still `Carried` during an `await` gap in `handleRoundEnd`, `holdTimeServerSystem` would keep accumulating time and write it back after scores were reset to 0.
   - **Fix:** All state mutations (flag reset, score reads, score zeroing, `clearHoldTimeAccum()`) happen synchronously before any `await`.

**Remaining Risks:**
- Client-side interpolation (`updateHoldTimeInterpolation`) adds elapsed time between CRDT syncs. If `interpolationStartTime` doesn't reset properly during rapid steal chains, displayed scores could drift. This is cosmetic — server scores are authoritative for round-end results.
- The 250ms cache (`HOLD_TIME_CACHE_MS`) in `getPlayersWithHoldTimes()` means the UI won't reflect changes faster than 4x/second. Not a bug, but worth knowing.

**How to verify in playtest:**
- Watch scoreboard during 3+ player sessions lasting 10+ minutes
- Check if scores count up smoothly for the flag carrier
- Check if scores reset to 0 cleanly at round boundaries
- Check if players who join mid-round appear correctly

---

## Bug 2: Flag Gets Stuck

### Bug 2a: Flag stuck above player's head (can't drop, can't steal)

**Symptoms:**
- Flag visual freezes in world space above a player's head
- Carrier unable to drop with key 3
- Other players unable to proximity-steal
- Persists until round ends or carrier disconnects

**Root Cause & Fix:**
- **AvatarAttach race condition:** Writing `Transform` on a direct child of an `AvatarAttach` entity races with Bevy's internal propagation, causing the entity to "detach" and freeze in world space.
- **Fix (flagSystem.ts):** Implemented 3-layer architecture:
  - Layer 1: **Anchor** — has `AvatarAttach`, position controlled by engine
  - Layer 2: **Static Offset** — child of Anchor, Transform set ONCE at creation, NEVER mutated
  - Layer 3: **Visual** — grandchild, safely animated per-frame (bob + spin)
- **Server safety nets:**
  - Stale carrier detection (`CARRIER_NO_POSITION_TIMEOUT_MS`) — force-drops flag if carrier position unavailable for 5s
  - Carrier disconnect detection — checks `PlayerIdentityData` every frame, force-drops if carrier entity gone

**Remaining Risks:**
- If `AvatarAttach.create()` or `AvatarAttach.deleteFrom()` on the anchor entity has timing issues during rapid steal chains, the retargeting in `showClone()` could glitch. The pool reuses a single anchor entity, so retargeting means delete + recreate AvatarAttach.
- The server stale-carrier timeout (5s) is a safety net but is a long time for the flag to appear stuck before auto-recovery.

### Bug 2b: Flag stuck on ground (can't pick up, or teleports back to spawn)

**Symptoms:**
- Flag on ground, players walk over it but can't pick up
- Or: player picks up flag but it visually teleports back to its spawn/drop position repeatedly

**Root Cause & Fix:**
- Multiple clients sending `requestPickup` simultaneously for a dropped flag. Server accepts one, others get no explicit rejection — they show optimistic clone locally, then roll back after 1.5s timeout.
- **Fix:** Client-side cooldowns prevent spam:
  - `AUTO_PICKUP_COOLDOWN_MS` (500ms) — minimum time between pickup requests
  - `DROP_PICKUP_COOLDOWN_MS` (2000ms) — can't auto-pickup for 2s after dropping
  - `WITNESSED_DROP_COOLDOWN_MS` (750ms) — brief cooldown after seeing any drop
  - `pendingPickupUntil` (1.5s timeout) — rolls back optimistic UI if server doesn't confirm
  - Failed pickup extends cooldown by 2.5s to prevent rapid re-attempts

**Remaining Risks:**
- Server pickup validation requires `dist <= PICKUP_RADIUS` but if the server's position cache (`getPlayerPosition`) is stale, valid pickups could be rejected silently. The fallback log says "trusting client proximity" when position is missing, but the distance check is skipped entirely — could allow remote pickups.
- No explicit `pickupDenied` message from server. Client relies on timeout, which means 1.5s of visual confusion on rejection.

**How to verify in playtest:**
- Have carrier disconnect/teleport away — does flag drop properly?
- Have 3+ players contest a dropped flag simultaneously — does one pick it up cleanly?
- Have carrier get hit by banana/boomerang — does flag drop and become pickable?
- Check if flag ever appears frozen in mid-air for more than a few seconds

---

## Bug 3: Boomerangs Don't Render When Thrown

**Symptoms:**
- Player presses E (or taps mobile button), cooldown activates normally
- No boomerang visual appears in the world
- Sound may or may not play
- Cooldown expires, next throw may or may not work

**Root Cause & Fix:**
- **CRDT buffer saturation (commit `5b9f2ba`)** — Same root cause as Bug 1. When CRDT buffer fills up, WebSocket messages like `shellDropped` are delayed or dropped. The server processes the throw (starting cooldown, creating server-side projectile for collision), broadcasts `shellDropped`, but the message never arrives at the throwing client or other clients.
- **Fix:** Removing `syncEntity` from projectiles/traps eliminated the CRDT tombstone accumulation that caused buffer saturation.

**Secondary causes:**
- **Pool exhaustion:** 10 entities per color. Yellow fires 2 simultaneously. Under extreme load with many players all throwing, pool could exhaust (logged as `Pool exhausted for color X`).
- **`localThrow.active` stuck state:** If `shellReturned` message is lost (network issue), `localThrow.active` stays true, blocking subsequent throws. Safety timeout at `LOCAL_THROW_SAFETY_MS` (4s) force-clears it, and a second check at `PROJECTILE_LIFETIME_SEC` also clears.

**Remaining Risks:**
- If WebSocket messages are still unreliable for reasons other than CRDT saturation (network latency, server load), `shellDropped` could still be missed. The client has no retry/ack mechanism for projectile visuals.
- The `localThrow` → `sawVisual` → `shellReturned` chain has three points of failure. If any message is lost, the state machine relies on timeouts (4s safety, lifetime expiry) rather than self-healing.

**How to verify in playtest:**
- Have 5+ players throwing boomerangs continuously for 10+ minutes
- Check if boomerang visuals appear for both the thrower and other players
- Check if cooldown and visual are always in sync
- Watch server logs for `Pool exhausted` messages

---

## Playtest Checklist (May 19, 2026)

- [ ] Scoreboard counts up smoothly for carrier during entire round
- [ ] Scores reset to 0 at round boundary for all players
- [ ] Final cinematic scores match live scoreboard
- [ ] No phantom/ghost players on scoreboard
- [ ] Flag drops cleanly when carrier is hit (banana, boomerang, orbit)
- [ ] Flag drops cleanly when carrier disconnects
- [ ] Dropped flag is pickable by nearby players within ~1s
- [ ] No flag stuck in mid-air for more than 5s
- [ ] Boomerang visuals appear on every throw (E key / mobile tap)
- [ ] Boomerang visuals visible to other players
- [ ] No "cooldown without visual" occurrences after 10+ min sessions
- [ ] Test with 5+ concurrent players for 15+ minutes minimum
