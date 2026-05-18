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

## Step 3 — Consolidate uiState.ts into Typed State Objects ⬜
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
