# Flag Tag — Codebase Refactoring Plan

**Goal:** Make the codebase understandable, streamlined, and less bug-prone while keeping gameplay unchanged.

**Total estimate:** 3-4 hours across multiple sessions.

**Rule:** After each step, run `npm run build` to confirm zero errors. Preview-test after steps that touch gameplay-adjacent code.

---

## Status Key
- ⬜ Not started
- 🟡 In progress
- ✅ Done
- ⏭️ Skipped (with reason)

---

## Step 1 — Sync ID Pool Factory ✅
**Est: 15 min | Risk: Low | Files: 2**

**Problem:** Three identical copy-pasted sync ID pool implementations in `shared/components.ts` (trap, projectile, ghost). Each is ~10 lines doing the same thing with different base/size constants.

**Plan:**
1. Create `shared/syncIdPool.ts` with a factory function:
   ```ts
   export function createSyncIdPool(base: number, size: number) {
     const pool: number[] = []
     for (let i = 0; i < size; i++) pool.push(base + i)
     return {
       next(): number { ... },
       recycle(id: number): void { ... },
     }
   }
   ```
2. In `shared/components.ts`, replace the 3 pool implementations with:
   ```ts
   import { createSyncIdPool } from './syncIdPool'
   const trapPool = createSyncIdPool(1_000_000, 40)
   export const getNextTrapSyncId = trapPool.next
   export const recycleTrapSyncId = trapPool.recycle
   // same for projectile and ghost
   ```
3. Keep the same export names so no other files change.
4. `npm run build` to verify.

**Files changed:**
- `shared/syncIdPool.ts` (new, ~20 LOC)
- `shared/components.ts` (remove ~60 LOC, add ~10 LOC)

---

## Step 2 — Fix Sound Entity Leaks + Duplicate checkBlessing ✅
**Est: 10 min | Risk: Low | Files: 3**

**Problem A:** `pedestalSystem.ts:246` creates a new entity for sound at each 8s interval (up to 3 per blessing). Never removed. `teleportOrbs.ts:63` has the same pattern.

**Problem B:** `checkBlessing` is sent from 4 places — `index.ts:109`, `pedestalSystem.ts:141` (on blessing start), `pedestalSystem.ts:183` (pre-check on first tick), `pedestalSystem.ts:211` (click fallback). The `index.ts` send and the `startBlessing` send are redundant since the pedestal system pre-checks on its own.

**Plan:**
1. **Sound leaks:** In `pedestalSystem.ts`, reuse the existing `blessingSoundEntity` instead of creating new entities at each interval. Just call `AudioSource.createOrReplace(blessingSoundEntity, ...)`.
2. **Sound leaks:** In `teleportOrbs.ts`, create a single reusable sound entity per orb at setup time.
3. **Duplicate checkBlessing:** Remove the `room.send('checkBlessing')` from `index.ts:109` — the pedestal system already handles this on first tick.
4. Remove the `room.send('checkBlessing')` from `startBlessing()` in `pedestalSystem.ts:141` — it's redundant since the pre-check already ran or the click handler re-sends it.
5. `npm run build` to verify.

**Files changed:**
- `systems/pedestalSystem.ts` (minor edits)
- `systems/teleportOrbs.ts` (minor edit)
- `index.ts` (remove 3 lines)

---

## Step 3 — Consolidate uiState.ts into Typed State Objects ✅
**Est: 30 min | Risk: Medium | Files: ~15**

**Problem:** `uiState.ts` is 401 LOC with ~60 `let` variables and ~120 getter/setter functions. Pure boilerplate. Every new piece of state requires 3 lines (let + getter + setter).

**Plan:**
1. Group related variables into plain exported objects with typed fields:
   ```ts
   // Before (6 lines):
   let _blessingActive = false
   export function isBlessingActive(): boolean { return _blessingActive }
   export function setBlessingActive(v: boolean) { _blessingActive = v }
   
   // After (1 field in an object):
   export const blessingState = {
     active: false,
     timer: 0,
     lineIndex: 0,
     lineTimer: 0,
     completed: false,
     completedAt: 0,
     alreadyUsed: false,
     preCheckDone: false,
     fadeOut: 0,
     coinProgress: 0,
     coinSoundsPlayed: 0,
   }
   ```
2. Proposed state groups (each becomes one exported object):
   - `musicState` — muted flag
   - `cinematicState` — fade, title splash, showing flag
   - `creditsState` — next round, no scorers, countdown, line index/timer
   - `blessingState` — all 12 blessing variables
   - `earnedState` — all round-end earnings variables
   - `overlayState` — grace period, popup visibility flags
   - `splashState` — round-end splash variables
   - `serverDownState` — detection timers and visibility
   - `scrollState` / `tabState` / `hoverState` — already objects, keep as-is
   - Misc singletons stay as simple let+getter+setter

3. **Migration approach:** 
   - Keep old getter/setter functions as thin wrappers initially (deprecation layer).
   - Update all import sites to use `blessingState.active` etc. in a second pass.
   - Remove the wrappers once all call sites are updated.
   - OR: do it all at once per state group — update exports and all importers together.

4. Update all consumers (grep for each function name, update imports).
5. `npm run build` after each state group migration.

**Files changed:**
- `ui/uiState.ts` (major rewrite, net -150 LOC)
- ~12 consumer files (import path changes)

**Risk note:** This touches many files. Do one state group at a time, build between each. If a session ends mid-step, each group is independently shippable.

---

## Step 4 — Split projectileSystem.ts (1,490 LOC) ⬜
**Est: 45 min | Risk: Medium | Files: 4-5 new**

**Problem:** Largest file in the codebase. Handles pool creation, firing, movement, collision, VFX, sound, charge mechanics, and wall raycasting all in one file.

**Plan:**
1. Read the full file and identify natural seams.
2. Proposed split (exact boundaries TBD after reading):
   - `projectilePool.ts` — entity pool creation, GLB loading, recycling
   - `projectileCharge.ts` — charge-up mechanic (input hold, ring VFX, burnout)
   - `projectileFlight.ts` — movement, wall raycast, collision detection
   - `projectileVfx.ts` — hit/miss VFX, sound effects, trail particles
   - `projectileSystem.ts` — thin orchestrator that imports above and exports `projectileClientSystem` + `initProjectilePool`
3. Move code in sections, keeping the same exported API so `index.ts` doesn't change.
4. `npm run build` after each extraction.

**Files changed:**
- `systems/projectileSystem.ts` (shrinks to ~100-200 LOC)
- 3-4 new files in `systems/projectile/` subdirectory

**Risk note:** Shared mutable state between sections (module-level lets) will need to become a shared state object or be passed as parameters. Map out the state dependencies before splitting.

---

## Step 5 — Extract Inline Systems from index.ts ⬜
**Est: 20 min | Risk: Low | Files: 4-5**

**Problem:** `index.ts` has several inline anonymous systems and setup blocks that should be their own modules:
- Name retry polling system (lines ~113-130)
- Reload-drop detection system (lines ~170-190)
- Podium cube hiding system (lines ~205-230)
- Music entity creation + avatar modifier area setup

**Plan:**
1. Extract each into a small dedicated file:
   - `systems/nameRetrySystem.ts` — exports `setupNameRetry(room, local)`
   - `systems/reloadDropSystem.ts` — exports `setupReloadDrop(room, local)`
   - `systems/podiumCubeSystem.ts` — exports `setupPodiumCubeHiding()`
   - `systems/musicSetup.ts` — exports `setupMusic()` returning the entity
2. `index.ts` becomes a clean list of imports + setup calls + `engine.addSystem()`.
3. `npm run build` to verify.

**Files changed:**
- `index.ts` (shrinks by ~80 LOC)
- 3-4 new small files (~20-30 LOC each)

---

## Step 6 — Split shared/components.ts ⬜
**Est: 20 min | Risk: Low | Files: 3-4**

**Problem:** `components.ts` (379 LOC) mixes ECS component definitions, game constants, date utilities, spawn point logic, and sync ID pools.

**Plan:**
1. Split into:
   - `shared/components.ts` — just `engine.defineComponent()` calls + `validateBeforeChange` + SyncIds enum (~150 LOC)
   - `shared/constants.ts` — FLAG_BASE_POSITION, spawn points, trap/projectile/ghost tuning constants, ROUND_LENGTH_MINUTES (~80 LOC)
   - `shared/dateUtils.ts` — `getTodayDateString()`, `getCurrentMonthString()`, `getNextRoundEndTimeMs()`, `getCountdownSeconds()` (~30 LOC)
   - `shared/syncIdPool.ts` already created in Step 1
2. Update imports in all consumers (grep for each moved export).
3. `npm run build` to verify.

**Files changed:**
- `shared/components.ts` (shrinks by ~200 LOC)
- `shared/constants.ts` (new)
- `shared/dateUtils.ts` (new)
- ~10 consumer files (import path updates)

---

## Step 7 — Untangle Circular Dependencies ⬜
**Est: 20 min | Risk: Medium | Files: 4-5**

**Problem:** `systems/` imports from `ui/uiState` (5 systems) and `ui/` imports from `systems/` (3 imports in uiSystems). One more cross-reference could create a cycle.

**Current cross-references:**
- `systems → ui`: boomboxSystem, chestSystem, cinematicSystem, gravestoneSystem, mailboxSystem, pedestalSystem, terminalSystem
- `ui → systems`: uiSystems imports `applyDeferredBalance` (coinPickupSystem), `clearMushroomShield` (mushroomSystem), `isSpectatorMode` (spectatorSystem)

**Plan:**
1. Create `shared/clientState.ts` for state that both systems and UI need:
   - Move `spectatorMode` flag here (currently in spectatorSystem)
   - Move `deferredBalance` apply logic here (currently in coinPickupSystem)
   - Move `mushroomShield` clear logic here (currently in mushroomSystem)
2. Both `systems/` and `ui/` import from `shared/clientState.ts` — no cycles.
3. For `systems → ui` (popup visibility): these are acceptable one-way dependencies. The systems call `showChestPopup()` etc. which is a clean fire-and-forget. Keep as-is.
4. `npm run build` to verify.

**Files changed:**
- `shared/clientState.ts` (new, ~30 LOC)
- `systems/coinPickupSystem.ts`, `systems/mushroomSystem.ts`, `systems/spectatorSystem.ts` (move state out)
- `ui/uiSystems.ts` (update imports)

---

## Step 8 — Webhook to Env Var + Misc Cleanup ⬜
**Est: 10 min | Risk: Low | Files: 2-3**

**Problem:** Discord webhook URL is hardcoded in `server.ts`. Magic numbers scattered.

**Plan:**
1. Move `MAILBOX_WEBHOOK` to use `EnvVar` (Decentraland server env var system) with fallback to current value.
2. Audit remaining magic numbers — group any that appear in multiple places into `shared/constants.ts`.
3. Remove any dead code found during the refactor.
4. `npm run build` + final preview test.

**Files changed:**
- `server/server.ts` (webhook)
- `shared/constants.ts` (if new constants needed)

---

## Session Planning

Each step is independently shippable. Suggested session grouping:

**Session A (~30 min):** Steps 1 + 2 (quick wins, low risk)
**Session B (~50 min):** Step 3 (uiState consolidation — do one state group at a time)
**Session C (~45 min):** Step 4 (projectileSystem split)
**Session D (~40 min):** Steps 5 + 6 (index.ts + components.ts cleanup)
**Session E (~30 min):** Steps 7 + 8 (circular deps + final cleanup)

---

---

## Session Notes

### Session A — 2026-05-18 (Steps 1+2)
**Commit:** `9bbba69` — "Refactor steps 1+2: sync ID pool factory, fix sound leak, remove duplicate checkBlessing"

**Observations:**
- The `bind()` calls on pool methods (`trapPool.next.bind(trapPool)`) are needed because the factory returns an object with methods that reference `pool` via closure. Without bind, if someone destructures the export, `this` context would be lost. Verified this works in the SDK bundler.
- `teleportOrbs.ts` sound entities were already created once at setup and stored in an array — no leak there despite the grep hit. Only `pedestalSystem.ts` had the actual leak (creating new entities at each 8s interval, up to 3 per blessing ritual).
- The `checkBlessing` call in `startBlessing()` was originally added as a "pre-check so server can reject early" — but the pre-check on first tick already handles this, and the click handler now gates on `isBlessingPreCheckDone()`. Removing it is safe.
- `index.ts` still has a `checkBlessing`-adjacent comment removed cleanly. No orphaned references remain (verified via grep).

**Bugfix (post-commit):** Fixed `blessingResult` listener incorrectly marking `alreadyUsed = true` on a successful first-time claim. The condition `data.success && data.reason !== 'eligible'` matched the claim response (`reason: ''`), causing the UI to show "already blessed" instead of the coin reward animation. Fix: (1) separated `already_blessed` handling from successful claim handling, (2) added `delayedMarkUsed` flag so `alreadyUsed` is only set after the reward UI dismisses (`blessingCompleted` returns to false), (3) added defensive cancellation if `already_blessed` arrives during an active ritual. Also added diagnostic console logs to click handler and listener.

**Concerns for future steps:**
- **Step 3 (uiState):** The `bind()` pattern won't apply there, but need to be careful with `setBlessingCompleted` which has a side effect (`if (v) _blessingCompletedAt = Date.now()`). When consolidating to plain objects, this side effect needs to either become a dedicated function or be handled at the call site.
- **Step 4 (projectileSystem):** At 1,490 lines this is the riskiest split. Need to map out all module-level `let` variables and their mutation patterns before cutting. Should read the full file at the start of that session.
- **Step 7 (circular deps):** The `ui → systems` imports (`applyDeferredBalance`, `clearMushroomShield`, `isSpectatorMode`) may be deeper than just moving a flag. Need to check if those functions have side effects or depend on other system state.

---

### Session B — 2026-05-18 (Step 3)

**What changed:**
- `uiState.ts` rewritten from 401 LOC → 296 LOC (~105 lines removed). ~60 `let` variables + ~120 getter/setter functions replaced with 13 plain exported state objects: `musicState`, `cinematicState`, `creditsState`, `blessingState`, `earnedState`, `popupState`, `metricsState`, `splashState`, `serverDownState`, `attackState`, `countdownState`, `mobileState`, `miscState`.
- Kept `uiScaleState` with helper functions (`getUIScaleFlash`, `flashUIScale`) since they have computed logic.
- `setBlessingCompleted(v)` (which had a side effect stamping `completedAt`) replaced with explicit `markBlessingCompleted(v)` helper.
- `setCinematicFade(opacity)` kept as a function since it clamps to [0,1].
- Popup show/hide functions kept since `hide*` calls `notifyOverlayClosed()` as a side effect.
- `hover`, `scroll`, `tabs` were already plain objects — unchanged.
- Re-exports from `ui.tsx` updated: now exports `cinematicState`, `creditsState`, `popupState`, `splashState` objects for systems that need direct access.
- 14 consumer files updated (all mechanical `sed` replacements + manual import rewrites).

**Files changed:** `ui/uiState.ts`, `ui/uiSystems.ts`, `ui.tsx`, `systems/boomboxSystem.ts`, `systems/pedestalSystem.ts`, `systems/cinematicSystem.ts`, `systems/chestSystem.ts`, `systems/gravestoneSystem.ts`, `systems/mailboxSystem.ts`, `ui/components/StatsRow.tsx`, `ui/layouts/DesktopLayout.tsx`, `ui/layouts/MobileLayout.tsx`, `ui/screens/HowToPlay.tsx`, `ui/screens/LeaderboardOverlay.tsx`, `ui/screens/RoundEndSplash.tsx`

### UI Click Responsiveness Fix — 2026-05-18 (during Session B)

**Problem:** UI buttons frequently required 2-4 clicks to register. Most frustrating UX issue in the game.

**Root cause:** Overlay backdrops (full-screen `UiEntity` wrappers) were missing `uiBackground` and/or `onMouseDown={() => {}}`. Without a background, Decentraland's UI engine doesn't register the element as a click target — clicks pass through to 3D world entities underneath (`pointerEventsSystem` handlers on chests, mailboxes, pedestals, etc.), which consume the click event before the UI button can process it.

**Fix:** Added `uiBackground={{ color: CLICK_BLOCKER }}` (`rgba(0,0,0,0.001)` — nearly invisible) and `onMouseDown={() => {}}` to all 13 full-screen overlay backdrops:

| Overlay | Had bg | Had onMouseDown | Fixed |
|---------|--------|-----------------|-------|
| Cinematic fade | ✅ dynamic | ❌ | Added onMouseDown |
| Blessing active | ❌ | ❌ | Added both |
| Blessing completed | ❌ | ❌ | Added both |
| Server down | ✅ 0.6 black | ❌ | Added onMouseDown |
| Mailbox | ❌ | ❌ | Added both |
| Gravestone | ❌ | ✅ | Added uiBackground |
| Chest | ❌ | ✅ | Added uiBackground |
| Title splash | ❌ | ✅ functional | Added uiBackground |
| StatusPopup | ❌ | ❌ | Added both |
| MetricsOverlay | ❌ | ❌ | Added both |
| HowToPlay | ❌ | ❌ | Added both |
| AnalyticsOverlay | ❌ | ❌ | Added both |
| RoundEndSplash | ❌ | ❌ | Added both |
| Mobile scoreboard | ❌ | ❌ | Added both |
| Mobile status | ❌ | ❌ | Added both |

`CreditsScreen` has no blocker but is always rendered inside the cinematic fade overlay which already blocks.

**Also cleaned up:**
- Removed 150ms overlay grace period (`isInOverlayGracePeriod`, `notifyOverlayClosed` timer, `OVERLAY_CLOSE_GRACE_MS`). Was designed to prevent accidental boomerang throws on menu close, but boomerang is E-key not click — entirely pointless.
- Removed dead attack flicker system (`attackState.lastPressMs` was written every frame but never read anywhere).
- `notifyOverlayClosed()` kept as an empty hook — callers still invoke it, no need to update call sites.

**Result:** Noticeably improved but user reports "not perfect." Remaining click issues may be related to the SDK's own UI event processing or z-order conflicts between overlapping absolute-positioned elements (e.g., the ability bar at the bottom overlapping with popups). Worth investigating further if complaints persist.

**Concerns:**
- `CLICK_BLOCKER` at `alpha=0.001` — need to confirm the SDK doesn't cull fully transparent backgrounds. If clicks stop working, try increasing to `0.01`.
- The `onMouseDown={() => {}}` empty handlers on backdrops block clicks from reaching 3D entities, but they also prevent the player from interacting with the world while overlays are open. This is intentional but worth noting.
- Some overlays (HowToPlay) had `onMouseDown={() => {}}` only on inner card elements, not the full-screen wrapper — clicks in the gaps between cards still leaked to 3D. Now fixed with the wrapper-level blocker.

**Files changed:** `ui/uiConstants.ts` (new `CLICK_BLOCKER` constant), `ui/uiState.ts` (grace period removal, dead code removal), `ui/uiSystems.ts` (attack flicker removal), `ui.tsx`, `ui/screens/ChestPopup.tsx`, `ui/screens/HowToPlay.tsx`, `ui/screens/LeaderboardOverlay.tsx`, `ui/screens/AnalyticsOverlay.tsx`, `ui/screens/RoundEndSplash.tsx`, `ui/layouts/MobileLayout.tsx`

**Commits:** `8e933be`, `ccf34ec`, `69f9474`

---

## Post-Refactor Verification Checklist
- [ ] `npm run build` passes with zero errors
- [ ] Preview: flag pickup/drop works
- [ ] Preview: boomerang fire/charge works
- [ ] Preview: traps deploy and trigger
- [ ] Preview: pedestal blessing flow works (first time + already-blessed)
- [ ] Preview: round end splash + leaderboard display
- [ ] Preview: coin pickup + store purchase
- [ ] Preview: ghost spawns and chases
- [ ] Preview: UI overlays open/close (leaderboard, chest, mailbox)
- [ ] Deploy to flagtag.dcl.eth and smoke test
