# Known Bugs — Playtest Tracking

Last updated: May 20, 2026

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

**Root Cause Identified (May 20 playtest):**
- **Entity churn causing engine renderer failure.** After ~45 min with 3-5 players, ALL projectile and trap visuals stopped rendering simultaneously. Hand-attached boomerangs (persistent entities) still visible. Cooldowns still worked (set locally before server round-trip).
- **Primary offender: `remoteBoomerangSystem.ts` charge VFX.** `startRemoteCharge()` created 21 entities (1 glow + 20 particles) per charge cycle, and `stopRemoteCharge()` destroyed all of them. Over 45 min with active combat: ~19,000 entity create/destroy cycles. The Decentraland engine's internal renderer eventually stops tracking entities after excessive churn.
- **Secondary offender: per-frame `Material.setPbrMaterial()` calls.** The charge animation called `Material.setPbrMaterial()` on 20 particles × N players × 60fps — thousands of material replacements per second, despite the color only changing once (at 75% charge).
- **Other entity churn sources:** wall raycasts (1 per throw), ground raycasts (1 per trap), mushroom head bounce entities (3 per pickup). These are lower volume but contribute.

**Fixes Applied (May 20):**
1. **Pooled charge VFX particles** (`remoteBoomerangSystem.ts`): Pre-created pool of 100 sphere entities (enough for 5 concurrent chargers). `startRemoteCharge` acquires from pool, `stopRemoteCharge` releases back. Zero entity creation during gameplay.
2. **Throttled material updates**: Material only updated when charge phase changes (blue→gold at 75%), reducing `setPbrMaterial` calls by ~99%.

**Remaining Risks:**
- If WebSocket messages are still unreliable for reasons other than CRDT saturation (network latency, server load), `shellDropped` could still be missed. The client has no retry/ack mechanism for projectile visuals.
- The `localThrow` → `sawVisual` → `shellReturned` chain has three points of failure. If any message is lost, the state machine relies on timeouts (4s safety, lifetime expiry) rather than self-healing.
- Other entity churn sources (raycasts, mushroom bounces) are not yet pooled. If the issue persists after this fix, pool those next.
- The `remoteOrbitAnimSystem` still creates/destroys 1 entity per orbit per remote player (lower volume, ~1 per green throw).

**How to verify in playtest:**
- Have 3-5 players throwing boomerangs continuously for 45+ minutes
- Check if boomerang AND banana visuals still render after extended play
- Check if boomerang visuals appear for both the thrower and other players
- Check if cooldown and visual are always in sync
- Watch server logs for `Pool exhausted` messages

---

## Playtest Results (May 19, 2026)

- [x] Scoreboard counts up smoothly for carrier during entire round — **MOSTLY OK, one incident of local player stuck at 0 (reload fixed)**
- [x] Scores reset to 0 at round boundary for all players
- [x] Final cinematic scores match live scoreboard
- [x] No phantom/ghost players on scoreboard
- [x] Flag drops cleanly when carrier is hit (banana, boomerang, orbit)
- [x] Flag drops cleanly when carrier disconnects
- [x] Dropped flag is pickable by nearby players within ~1s
- [x] No flag stuck in mid-air for more than 5s
- [x] Boomerang visuals appear on every throw — **FAILED after ~45 min**
- [x] Boomerang visuals visible to other players — **FAILED after ~45 min**
- [ ] No "cooldown without visual" occurrences after 10+ min sessions — **FAILED after ~45 min**
- [x] Test with 5+ concurrent players for 15+ minutes minimum
- **NEW:** Grace period shield persists on both players after steal — **FIXED**
- **NEW:** Discord webhook spam from unnamed bot accounts — **FIXED**

---

## Bug 4: UI Buttons Unresponsive on Ultrawide (21:9) Monitors

**Symptoms:**
- ALL UI buttons require 1-4 clicks to register on a 21:9 ultrawide monitor
- Same machine on a 16:9 TV — buttons work first click every time
- Other Decentraland scenes (including LootDrop) work perfectly on the same ultrawide
- Other players' scenes also work fine on the same ultrawide
- Issue is specific to FlagTag — not an engine bug

**Observations:**
- FlagTag has 28 UI files, 245+ `S()` scaling calls, 35 absolute-positioned elements, 37 click handlers
- LootDrop has 5 UI files, no dynamic scaling, hardcoded pixel values — and works perfectly on ultrawide
- FlagTag's `S()` function scales all pixel values by `canvas.width / 1920` (clamped 0.6–1.6)
- On 21:9 ultrawide (~3440×1440): width ratio = 1.79 (clamped to 1.6), but height ratio would be 1440/1080 = 1.33
- The scaling is **width-only** — it ignores height entirely. On ultrawide, UI elements are scaled 20% larger than they should be vertically relative to the actual screen height

**Suspected Root Causes (to investigate):**

1. **Width-only scaling mismatch on ultrawide aspect ratios.** The `S()` function computes scale from `canvas.width / 1920`, which on ultrawide gives a much higher scale factor than the height warrants. This means all absolute-positioned elements are offset further than expected. The SDK's internal click hitbox detection may use a different coordinate system or the scaled positions may push elements partially offscreen/overlapping in ways that cause hitbox conflicts. On 16:9, width and height ratios are proportional so no mismatch occurs.

2. **Stacked full-screen CLICK_BLOCKER overlays.** There are 13+ full-screen overlay wrappers with `CLICK_BLOCKER` (alpha=0.001) backgrounds and `onMouseDown={() => {}}`. Even when their content is conditionally hidden, the `PlayerListUi` function evaluates all overlay conditions every frame. If any invisible wrapper is still intercepting pointer events due to the SDK treating near-zero-alpha backgrounds as valid hit targets, clicks would be silently consumed. The larger the screen, the more chance of overlap with actual buttons.

3. **Absolute positioning with scaled offsets.** FlagTag uses 35 absolute-positioned elements with `S()`-scaled positions. On ultrawide, the scale factor is at max clamp (1.6), so positions are pushed 60% further from their anchors. If two absolute-positioned elements overlap at this scale but not at 16:9 scale, the top element would intercept clicks meant for the one underneath.

4. **UI complexity / React-ECS render overhead.** 28 files and 245+ scaled values means the UI tree is large. The SDK's UI event system processes hit-tests against the full tree every frame. Unlikely to cause missed clicks (more likely would cause lag), but worth ruling out.

**Diagnosis Plan:**

1. **Quick test — disable `S()` scaling:** Temporarily make `S(px)` return `px` unchanged. If clicks work on ultrawide, the scaling system is confirmed as the cause.
2. **Quick test — use `Math.min(width, height)` scaling:** Change to `Math.min(canvas.width / 1920, canvas.height / 1080)` so ultrawide uses the height ratio (1.33) instead of the width ratio (1.6). This was in the stashed commit `stash@{0}` but was reverted.
3. **Quick test — remove all CLICK_BLOCKER overlays:** Temporarily strip all `uiBackground={{ color: CLICK_BLOCKER }}` to see if invisible overlays are eating clicks.
4. **Quick test — count UI entities:** Add a diagnostic counter showing total UI elements rendered per frame. Compare ultrawide vs 16:9.

**Prior art:**
- Commit `8e933be` fixed the original "2-4 clicks" issue by adding CLICK_BLOCKERs to prevent 3D entity click-through
- Stash `stash@{0}` had height-aware scaling with device breakpoints but was reverted
- REFACTOR_PLAN.md notes: "Noticeably improved but user reports 'not perfect.' Remaining click issues may be related to the SDK's own UI event processing or z-order conflicts between overlapping absolute-positioned elements"

**Files to investigate:** `src/ui/uiConstants.ts` (S() and scaling), `src/ui.tsx` (overlay stack), `src/ui/layouts/DesktopLayout.tsx` (absolute positioning), all files using `CLICK_BLOCKER`

---

## Playtest Checklist (Next Session)

- [ ] Scoreboard counts up for ALL players (especially local) over full session
- [ ] Boomerang visuals render after 45+ min of active combat (charge VFX pooling fix)
- [ ] Banana visuals render after 45+ min
- [ ] Grace period shield correctly transfers on steal (only new carrier has shield)
- [ ] Discord webhook only fires for named players (no bot spam)
- [ ] Test with 3-5 concurrent players for 45+ minutes minimum
- [ ] UI buttons register first-click on ultrawide (21:9) monitor
- [ ] Test S() scaling bypass on ultrawide to confirm root cause
