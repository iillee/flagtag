# Server Refactor Plan

**Goal:** Split `src/server/server.ts` (3,584 lines) into focused modules for readability, reduced complexity, and reusability as an open-source reference project.

**Starting commit:** `813f6a6` (bug fixes for memory leaks + visitor time precision already applied).

---

## Target Structure

```
src/server/
├── server.ts              (~150 lines) — setupServer entry point + system registration
├── serverState.ts         (~80 lines)  — shared mutable state exported for cross-module access
├── persistence.ts         (~80 lines)  — Storage get/set wrapper helpers
├── flagLogic.ts           (~350 lines) — flag pickup/drop/steal, gravity, flagServerSystem
├── combat.ts              (~650 lines) — traps, projectiles, orbits, proximity steal systems
├── economy.ts             (~350 lines) — coins, wallets, upgrades, store purchases
├── analytics.ts           (~500 lines) — visitor tracking, Discord webhooks, daily reports
├── leaderboard.ts         (~300 lines) — daily/monthly/all-time boards, resets, name patching
├── roundManager.ts        (~250 lines) — countdown system, handleRoundEnd orchestration
├── zombieSystem.ts        (~250 lines) — ghost AI, spawning, collisions
├── mushroomSystem.ts      (~100 lines) — mushroom spawning/pickup
├── playerTracking.ts      (~150 lines) — join/leave detection, name resolution, visitor sessions
```

## Dependency Graph (acyclic)

```
serverState.ts          ← foundation, no imports from other server/ modules
persistence.ts          ← imports serverState
leaderboard.ts          ← imports serverState, persistence
analytics.ts            ← imports serverState, persistence, leaderboard
economy.ts              ← imports serverState, persistence
flagLogic.ts            ← imports serverState, persistence
combat.ts               ← imports serverState, flagLogic (handleDrop)
zombieSystem.ts         ← imports serverState, combat (activeProjectiles)
mushroomSystem.ts       ← imports serverState
playerTracking.ts       ← imports serverState, persistence, economy, analytics
roundManager.ts         ← imports EVERYTHING (orchestrator, extracted last)
server.ts               ← imports all modules, wires them together
```

## Critical Patterns to Preserve

These are non-obvious implementation details that must survive the refactor:

1. **Synchronous-before-await in `handleRoundEnd()`**: All state mutations that affect `holdTimeServerSystem` (flag reset, score reads, score zeroing, accumulator clear) MUST happen synchronously BEFORE any `await`. During `await` gaps the engine runs systems — if the flag is still `Carried`, `holdTimeServerSystem` keeps accumulating time and can write it back AFTER scores are reset.

2. **`holdTimeAccum` / `holdTimeCarrierKey` flush pattern**: Hold time accumulates in a local buffer and flushes to the ECS component every 0.5s. `flushHoldTimeAccum()` MUST be called before any carrier change (drop, steal, round end) or accumulated time is lost/credited to wrong player.

3. **`lastDropperId` gates `reportGroundY`**: When the flag is dropped, only the player who dropped it can report the ground Y via raycast. This prevents other clients from overriding with stale data.

4. **`getOrCreateHoldTimeEntity()` is the single entry point** for creating hold-time entities. Both `playerTrackingSystem` and `holdTimeServerSystem` need these entities — the centralized function prevents duplicate entity creation races.

5. **Combat → flag coupling**: `bananaServerSystem`, `shellServerSystem`, and `orbitServerSystem` all call `handleDrop()` when a victim is carrying the flag. This is the one cross-domain dependency that makes `combat.ts` depend on `flagLogic.ts`.

6. **`zombieServerSystem` reads `activeProjectiles`** for projectile-zombie collision checks. This is why `zombieSystem.ts` depends on `combat.ts` (or the projectile list needs to live in shared state).

7. **Round-end cleanup order matters**: Flag reset → score read → score zero → flush accumulator → clear traps/projectiles/orbits → clear lightning → respawn mushrooms → send respawn message — all synchronous. THEN await coin awards, leaderboard updates, persistence.

---

## Session Instructions

Each step is designed as one session. Start each session by saying:

> "Read REFACTOR_PLAN.md and do Step N of the server refactor."

After completing a step, commit and push before ending the session.

---

## Step 1: `serverState.ts` — Shared state

**Session prompt:** "Read REFACTOR_PLAN.md and do Step 1 of the server refactor."

**What to do:** Create `src/server/serverState.ts` and move all module-level state that is accessed by 2+ domains out of `server.ts`. Update `server.ts` to import from `serverState.ts`.

**Move these entity variables** (they need setter functions since they're assigned during `setupServer`):
- `flagEntity`, `countdownEntity`, `leaderboardEntity`, `allTimeLeaderboardEntity`, `monthlyLeaderboardEntity`, `visitorAnalyticsEntity`, `monthlyVisitorAnalyticsEntity`, `coinStateEntity`

**Move these per-player maps:**
- `holdTimeEntities`, `knownPlayers`, `playerNames`, `walletEntities`, `upgradeEntities`, `lifetimeWinsEntities`
- `playerBoomerangColors`, `playerCoinBalances`, `playerUpgradeData`, `playerLifetimeWinsCache`
- `deathPenaltyCooldowns`, `lastStealTime`
- `visitorSessions`, `monthlyVisitorSessions`, `currentlyConnected`

**Move these shared constants:**
- `PICKUP_RADIUS`, `PROXIMITY_STEAL_RADIUS`, `STEAL_IMMUNITY_MS`, `HOLD_TIME_SYNC_INTERVAL`
- `SPLASH_DURATION_MS`, `FLAG_GRAVITY`, `FLAG_MIN_Y`, `CARRIER_Y_WINDOW_SEC`
- `CARRIER_NO_POSITION_TIMEOUT_MS`
- Mushroom constants: `MUSHROOM_CX`, `MUSHROOM_CZ`, `MUSHROOM_RADIUS`, `MUSHROOM_CANDIDATES`

**Move these shared helpers:**
- `isRealName()`
- `getPlayerPosition()`

**Pattern for mutable entity refs:** Use `export let` + setter functions:
```typescript
export let flagEntity: Entity
export function setFlagEntity(e: Entity) { flagEntity = e }
```

**Verify:** `npx tsc --noEmit` compiles clean. `grep -rn` in `server.ts` confirms no remaining local declarations of moved items.

**Commit message:** `refactor: extract serverState.ts — shared state and constants`

### Step 1 — Completed ✅

**Commit:** `594d145` → `refactor: extract serverState.ts — shared state and constants`

**What was done:**
- Created `src/server/serverState.ts` (~80 lines) with all items listed above.
- 8 entity refs use `export let` + setter functions. `server.ts` calls `setFlagEntity(engine.addEntity())` etc. in `setupServer`.
- 12 per-player maps, 3 visitor collections, 14 constants, 2 helpers (`isRealName`, `getPlayerPosition`) moved.
- `server.ts` updated with a single grouped import from `./serverState`.
- `getOrCreateHoldTimeEntity()` left in `server.ts` for now — it will move to `flagLogic.ts` in Step 6.

**Verification:**
- `npx tsc --noEmit` — zero errors.
- `grep` confirmed no remaining local declarations of moved items in `server.ts`.
- Preview tested in Creator Hub — flag pickup, drop, scoreboard, and round timer all working. One transient clone-visibility glitch on first load resolved by reload (stale CRDT from hot-reload, not refactor-related).

**Concerns:**
- None. The `export let` + setter pattern produces live bindings in TypeScript, so all reads in `server.ts` see the correct value after `setupServer` runs. No module initialization order issues since `serverState.ts` has zero imports from other `server/` modules.

---

## Step 2: `persistence.ts` — Storage helpers

**Session prompt:** "Read REFACTOR_PLAN.md and do Step 2 of the server refactor."

**What to do:** Create `src/server/persistence.ts` and move all `Storage.get`/`Storage.set` wrapper functions out of `server.ts`.

**Move these functions:**
- `persistFlagState()` — reads `Flag` and `Transform` from `flagEntity`, writes to `Storage`
- `persistLeaderboard(json)`, `persistAllTimeLeaderboard(json)`, `persistMonthlyLeaderboard(json)`
- `persistPlayerNames()` — iterates `playerNames` map, writes to `Storage`
- `loadPlayerNames()` — reads from `Storage`, populates `playerNames` map
- `persistVisitorData(visitorDataJson)` — writes visitor data + concurrent tracking to `Storage`
- `loadVisitorData()` — reads from `Storage`, populates `visitorSessions` map and concurrent state

**Note:** `loadVisitorData()` is complex — it references `lastVisitorResetDay`, `hourlyPeakConcurrent`, `peakConcurrent`, `peakConcurrentTime`, and `playerNames`. These either come from `serverState.ts` or need to be passed as parameters. Prefer importing from `serverState.ts` where possible. Move `lastVisitorResetDay` and concurrent tracking variables to `serverState.ts` if not already there.

**Verify:** `npx tsc --noEmit` compiles clean.

**Commit message:** `refactor: extract persistence.ts — Storage wrapper helpers`

### Step 2 — Completed ✅

**Commit:** `c72987d` → `refactor: extract persistence.ts — Storage wrapper helpers`

**What was done:**
- Created `src/server/persistence.ts` (~140 lines) with all 8 Storage wrapper functions listed above.
- Moved 5 state variables to `serverState.ts` with setter functions: `lastVisitorResetDay`, `lastMonthlyVisitorResetMonth`, `hourlyPeakConcurrent`, `peakConcurrent`, `peakConcurrentTime`.
- `loadVisitorData()` imports everything it needs from `serverState.ts` — no parameter passing needed.
- `updateConcurrentTracking()` left in `server.ts` for now — it will move to `analytics.ts` in Step 4.

**Verification:**
- `npx tsc --noEmit` — zero errors.
- `grep` confirmed no remaining local declarations of moved items in `server.ts`.
- Preview tested in Creator Hub — flag pickup, drop, scoreboard, round timer, and coins all working.

**Concerns:**
- None. The `export let` + setter pattern from Step 1 extended cleanly to the new variables. `persistence.ts` only imports from `serverState` and `../shared/components` — no circular dependencies.

**Gotcha encountered:** A `sed` command intended to fix `lastMonthlyVisitorResetMonth` assignments also corrupted three unrelated `.month = currentMonth` lines (MonthlyLeaderboardState mutations). These were caught by `tsc` and fixed before commit. **Step 3 note:** avoid batch `sed` for assignment rewrites — use targeted `Edit` calls instead.

---

## Step 3: `leaderboard.ts` — Leaderboard logic

**Session prompt:** "Read REFACTOR_PLAN.md and do Step 3 of the server refactor."

**What to do:** Create `src/server/leaderboard.ts` and move leaderboard types, helpers, reset logic, and the name-update function.

**Move these:**
- `type LeaderboardEntry`
- `parseLeaderboardJson()`
- `incrementLeaderboardWins()`
- `patchLeaderboardNames()`
- `patchAllLeaderboardNames()`
- `checkLeaderboardDailyReset()` — references `leaderboardEntity`, `lastLeaderboardResetDay`, calls `snapshotPendingReport` (which will be in `analytics.ts` later — for now import from `server.ts` or accept a callback)
- `checkMonthlyLeaderboardReset()` — references `monthlyLeaderboardEntity`
- `updatePlayerName()` — the big function that patches names across leaderboards, visitor sessions, and playerNames map

**Tricky part:** `checkLeaderboardDailyReset()` calls `snapshotPendingReport()` which is analytics code not yet extracted. Options:
- Accept a callback parameter: `checkLeaderboardDailyReset(onReset: (json: string) => Promise<void>)`
- Or leave `snapshotPendingReport` in `server.ts` temporarily and import it (it moves to `analytics.ts` in Step 4)

**Move `lastLeaderboardResetDay` to `serverState.ts`** if not already there.

**Verify:** `npx tsc --noEmit` compiles clean.

**Commit message:** `refactor: extract leaderboard.ts — leaderboard types, helpers, and reset logic`

### Step 3 — Completed ✅

**Commit:** `3a8f1b0` → `refactor: extract leaderboard.ts — leaderboard types, helpers, and reset logic`

**What was done:**
- Created `src/server/leaderboard.ts` (~180 lines) with all 8 items: `LeaderboardEntry` type, `parseLeaderboardJson`, `incrementLeaderboardWins`, `patchLeaderboardNames`, `patchAllLeaderboardNames`, `checkLeaderboardDailyReset`, `checkMonthlyLeaderboardReset`, `updatePlayerName`.
- Used the callback approach for `snapshotPendingReport`: `checkLeaderboardDailyReset(onReset?: (json: string) => Promise<void>)`. Both call sites in `server.ts` pass `snapshotPendingReport` as the callback. This avoids importing analytics code and will work cleanly when `snapshotPendingReport` moves to `analytics.ts` in Step 4.
- Added `lastLeaderboardResetDay` + `setLastLeaderboardResetDay` to `serverState.ts`.
- Used targeted `Edit` calls instead of `sed` (per Step 2 gotcha note) — no corruption issues.

**Verification:**
- `npx tsc --noEmit` — zero errors.
- `grep` confirmed no remaining local declarations of moved items in `server.ts`.
- Preview tested in Creator Hub — name resolution on scoreboard, hold-time tracking, and round-end leaderboard updates all working correctly.

**Concerns:**
- None. No circular dependencies — `leaderboard.ts` imports only from `serverState`, `persistence`, `@dcl/sdk/server`, and `../shared/components`.

**Step 4 note:** When `snapshotPendingReport` moves to `analytics.ts`, the call sites in `server.ts` just need to update the import source. The callback signature in `checkLeaderboardDailyReset` stays the same — no changes needed in `leaderboard.ts`.

---

## Step 4: `analytics.ts` — Visitor tracking + Discord

**Session prompt:** "Read REFACTOR_PLAN.md and do Step 4 of the server refactor."

**What to do:** Create `src/server/analytics.ts` and move all visitor analytics, Discord webhook, and daily report code.

**Move these state variables to `serverState.ts`** (if not already there):
- `hourlyPeakConcurrent`, `peakConcurrent`, `peakConcurrentTime`
- `lastVisitorResetDay`, `lastMonthlyVisitorResetMonth`
- `dailyReportSentForDay`
- `DISCORD_WEBHOOK_URL`

**Move these functions to `analytics.ts`:**
- `updateConcurrentTracking()`
- `loadDiscordWebhookUrl()`
- `buildDailyReport(leaderboardJson)`
- `snapshotPendingReport(leaderboardJson)`
- `sendPendingReport()`
- `sendDailyAnalyticsToDiscord()`
- `sendDiscordFallbackText(summary, users)`
- `loadDailyReportSentDay()`
- `checkPreMidnightReport()`
- `syncVisitorAnalytics()`
- `syncMonthlyVisitorAnalytics()`
- `checkVisitorDailyReset()`
- `checkMonthlyVisitorReset()`
- `visitorTrackingServerSystem()`

**If `snapshotPendingReport` was left in `server.ts` during Step 3**, now move it here and update the import in `leaderboard.ts`.

**Verify:** `npx tsc --noEmit` compiles clean.

**Commit message:** `refactor: extract analytics.ts — visitor tracking, Discord webhooks, daily reports`

### Step 4 — Completed ✅

**Commit:** `eab15f8` → `refactor: extract analytics.ts — visitor tracking, Discord webhooks, daily reports`

**What was done:**
- Created `src/server/analytics.ts` (475 lines) with all 16 functions listed above.
- `DISCORD_WEBHOOK_URL`, `dailyReportSentForDay`, and `visitorSyncTimer` kept as module-local state in `analytics.ts` (not moved to `serverState.ts` — they're only used within analytics).
- `snapshotPendingReport` now exported from `analytics.ts` — `server.ts` imports it and passes it as the callback to `checkLeaderboardDailyReset()`.
- Cleaned up unused imports from `server.ts`: `EnvVar`, `persistVisitorData`, `hourlyPeakConcurrent`, `setHourlyPeakConcurrent`, `peakConcurrent`, `setPeakConcurrent`, `peakConcurrentTime`, `setPeakConcurrentTime`.
- `server.ts` reduced from 3,281 → 2,817 lines.

**Verification:**
- `npx tsc --noEmit` — zero errors.
- `grep` confirmed no remaining local declarations of moved items in `server.ts`.
- Preview tested in Creator Hub — flag pickup/drop, boomerangs, bananas, scoreboard, round timer all working.

**Concerns:**
- None. No circular dependencies — `analytics.ts` imports only from `serverState`, `persistence`, and `../shared/components`.

**⚠️ Testing note for all future steps:** After code changes, you MUST restart the preview server (not just reload the browser). The Creator Hub preview compiles server code at startup — a browser reload picks up new client code but keeps the OLD server running. This caused a false alarm in Step 4 where boomerangs/bananas appeared to spawn at wrong positions (stale server had old `getPlayerPosition` location, new client had updated message handling). A full preview restart resolved it immediately.

---

## Step 5: `economy.ts` — Coins, wallets, upgrades, store

**Session prompt:** "Read REFACTOR_PLAN.md and do Step 5 of the server refactor."

**What to do:** Create `src/server/economy.ts` and move all coin, wallet, upgrade, and store logic.

**Move these functions:**
- `loadPlayerCoinBalance()`, `setPlayerCoinBalance()`, `addPlayerCoins()`, `getOrCreateWalletEntity()`
- `loadPlayerUpgrades()`, `savePlayerUpgrades()`, `getOrCreateUpgradeEntity()`
- `loadPlayerLifetimeWins()`, `addPlayerLifetimeWin()`, `getOrCreateLifetimeWinsEntity()`
- `handleBuyBoomerang()`
- `updateCoinStateCRDT()`, `coinServerSystem()`
- `awardRoundCoins(players)` — called from `handleRoundEnd`, will be imported by `roundManager.ts` later
- `coinRespawnTimer` (module-local state for coin respawn)

**Move these message handlers** out of `registerHandlers()` in `server.ts`:
- `requestCoinPickup`, `requestWalletBalance`
- `requestUpgrades`, `buyBoomerang`, `equipBoomerang`
- `deathPenalty`

**Export:** `registerEconomyHandlers(room)` function + `coinServerSystem`

**Verify:** `npx tsc --noEmit` compiles clean.

**Commit message:** `refactor: extract economy.ts — coins, wallets, upgrades, store`

### Step 5 — Completed ✅

**Commit:** `5dca9e8` → `refactor: extract economy.ts — coins, wallets, upgrades, store`

**What was done:**
- Created `src/server/economy.ts` (422 lines) with all 15 functions listed above.
- Also moved `colorChanged` handler into `registerEconomyHandlers()` since it validates boomerang ownership via `loadPlayerUpgrades` — pure economy logic.
- `coinCooldowns` and `coinRespawnTimer` kept as module-local state in `economy.ts` (only used there).
- `DEATH_PENALTY_COINS` constant kept module-local in `economy.ts`.
- `server.ts` reduced from 2,817 → 2,406 lines.
- Removed unused `serializeUpgrades` import from `server.ts`.

**Verification:**
- `npx tsc --noEmit` — zero errors.
- `grep` confirmed no remaining local declarations of moved items in `server.ts`.
- Preview tested in Creator Hub — coins, store, death penalty, flag pickup/drop, round timer all working.

**Concerns:**
- None. No circular dependencies — `economy.ts` imports from `serverState`, `leaderboard` (for `parseLeaderboardJson` in lifetime wins reconciliation), shared components, and `room`.

**Step 6 note:** `economy.ts` exports `loadPlayerCoinBalance`, `getOrCreateWalletEntity`, `loadPlayerUpgrades`, `savePlayerUpgrades`, `getOrCreateUpgradeEntity`, `loadPlayerLifetimeWins`, `addPlayerLifetimeWin`, `getOrCreateLifetimeWinsEntity`, `awardRoundCoins`, `coinServerSystem`, and `registerEconomyHandlers`. The `playerTrackingSystem` in `server.ts` (future `playerTracking.ts`) still calls `loadPlayerCoinBalance` and `getOrCreateWalletEntity` on player join — these imports will transfer cleanly when that module is extracted in Step 10.

---

## Step 6: `flagLogic.ts` — Flag pickup/drop/steal/gravity

**Session prompt:** "Read REFACTOR_PLAN.md and do Step 6 of the server refactor."

**What to do:** Create `src/server/flagLogic.ts` and move all flag-related state, handlers, and systems.

**Move these module-local state variables:**
- `flagFalling`, `flagFallVelocity`, `flagGravityTargetY`
- `carrierYSamples`, `lastDropperId`, `lastKnownCarrierPos`, `lastCarrierPositionMs`
- `holdTimeAccum`, `holdTimeCarrierKey`

**Move these functions:**
- `computeGravityTarget()`, `resetGravityState()`, `resetCarrierTracking()`
- `handlePickup()`, `handleDrop()`, `handleFlagSteal()`
- `flushHoldTimeAccum()` — ⚠️ This is called from `handleRoundEnd` (roundManager), `handleDrop`, `handleFlagSteal`, and `flagServerSystem`. Must be exported.
- `getOrCreateHoldTimeEntity()` — ⚠️ Single entry point for hold-time entities. Must be exported.
- `holdTimeServerSystem()`
- `flagServerSystem()`
- `checkProximitySteal()`

**Move these message handlers:**
- `requestPickup`, `requestDrop`, `requestReloadRespawn`, `reportGroundY`

**Export:** `registerFlagHandlers(room)` + `flagServerSystem` + `holdTimeServerSystem` + `checkProximitySteal` + `handleDrop` (needed by combat.ts) + `handleFlagSteal` + `flushHoldTimeAccum` + `resetGravityState` + `getOrCreateHoldTimeEntity`

**⚠️ Critical:** `handleDrop` and `flushHoldTimeAccum` are called from outside this module (combat hits, round end). They MUST be exported.

**Verify:** `npx tsc --noEmit` compiles clean.

**Commit message:** `refactor: extract flagLogic.ts — flag pickup/drop/steal/gravity/hold-time`

### Step 6 — Completed ✅

**Commit:** `a7a7d3d` → `refactor: extract flagLogic.ts — flag pickup/drop/steal/gravity/hold-time`

**What was done:**
- Created `src/server/flagLogic.ts` (464 lines) with all items listed above.
- All 9 module-local state variables, 11 functions, and 4 message handlers (`requestPickup`, `requestDrop`, `requestReloadRespawn`, `reportGroundY`) moved and wrapped in `registerFlagHandlers()`.
- Added two small accessor helpers to avoid leaking module-local variables:
  - `getHoldTimeAccumFor(carrierKey)` — used by `getCarrierHoldSeconds()` in lightning system (reads accumulator without direct variable access).
  - `clearHoldTimeAccum()` — used by `handleRoundEnd()` for the defensive force-clear after synchronous score reset.
- Cleaned up 7 unused imports from `server.ts` (`PICKUP_RADIUS`, `PROXIMITY_STEAL_RADIUS`, `STEAL_IMMUNITY_MS`, `HOLD_TIME_SYNC_INTERVAL`, `FLAG_MIN_Y`, `CARRIER_Y_WINDOW_SEC`, `CARRIER_NO_POSITION_TIMEOUT_MS`, `getHoldTimeEntityEnumId`).
- `server.ts` reduced from 2,406 → 1,990 lines.

**Verification:**
- `npx tsc --noEmit` — zero errors.
- `grep` confirmed no remaining local declarations of moved items in `server.ts`.
- Preview tested in Creator Hub — flag pickup, drop, gravity landing, hold-time scoring, boomerang-forces-drop, banana-forces-drop, round end reset all working.

**Concerns:**
- None. No circular dependencies — `flagLogic.ts` imports only from `serverState`, `persistence`, and `../shared/components`.

**Step 7 note:** `handleDrop` is already exported from `flagLogic.ts` and imported by `server.ts` (used in `bananaServerSystem`, `shellServerSystem`, `orbitServerSystem`, and `lightningServerSystem`). When combat code moves to `combat.ts` in Step 7, those call sites just change their import source from `server.ts` internal to `import { handleDrop } from './flagLogic'` — no signature changes needed. The `activeZombies` array is referenced by `bananaServerSystem` for ghost-trap collision — this cross-dependency is noted in the Step 7/8 plan.

---

## Step 7: `combat.ts` — Traps, projectiles, orbits

**Session prompt:** "Read REFACTOR_PLAN.md and do Step 7 of the server refactor."

**What to do:** Create `src/server/combat.ts` and move all trap, projectile, and orbit logic.

**Move these types and state:**
- `ActiveTrap` interface, `activeTraps` array, `lastTrapDropTime` map
- `ActiveProjectile` interface, `activeProjectiles` array, `lastProjectileFireTime` map
- `ActiveOrbit` interface, `activeOrbits` array, `lastOrbitTime` map
- Orbit constants: `ORBIT_DURATION_MS`, `ORBIT_RADIUS`, `ORBIT_HIT_RADIUS`, `ORBIT_COOLDOWN_SEC`

**Move these functions:**
- `removeTrap()`, `handleTrapDrop()`, `bananaServerSystem()`
- `removeProjectile()`, `handleProjectileFire()`, `shellServerSystem()`
- `handleOrbitRequest()`, `orbitServerSystem()`

**Move these message handlers:**
- `requestBanana`, `reportBananaGroundY`
- `requestShell`, `reportShellWallDist`, `reportShellGroundY`
- `requestOrbit`, `orbitHitWall`
- `chargeBurnout`, `reportBoost`, `chargeStart`, `chargeStop`

**Import from `flagLogic.ts`:** `handleDrop` (called when projectile/trap/orbit hits the flag carrier)

**⚠️ Export `activeProjectiles`** (or a getter) — `zombieSystem.ts` needs to read it for projectile-zombie collision checks.

**⚠️ Export `activeTraps`** — `zombieSystem.ts` checks trap-zombie collisions in `bananaServerSystem`, but that system stays in combat.ts. Actually, re-check: the ghost-trap collision is inside `bananaServerSystem` which stays here. So `activeTraps` may not need exporting. But `activeProjectiles` does (zombie system iterates it).

**Export:** `registerCombatHandlers(room)` + `bananaServerSystem` + `shellServerSystem` + `orbitServerSystem` + `activeProjectiles` + `activeTraps` + `activeOrbits` + cleanup functions for round end

**Verify:** `npx tsc --noEmit` compiles clean.

**Commit message:** `refactor: extract combat.ts — traps, projectiles, orbits`

---

## Step 8: `zombieSystem.ts` — Ghost AI

**Session prompt:** "Read REFACTOR_PLAN.md and do Step 8 of the server refactor."

**What to do:** Create `src/server/zombieSystem.ts` and move all ghost/zombie logic.

**Move these types and state:**
- `ActiveZombie` interface, `activeZombies` array
- `zombieSpawnTimer`, `zombieRespawnCooldown`
- `ZOMBIE_SPAWN_POS`, `ZOMBIE_RESPAWN_COOLDOWN`, `ZOMBIE_STAGGER_COOLDOWN_MS`, `ZOMBIE_IDLE_ORBIT_SPEED`

**Move these functions:**
- `spawnZombie()`
- `despawnAllZombies()`
- `zombieServerSystem()` — ⚠️ This reads `activeProjectiles` from combat.ts for projectile-zombie collision. Import it.

**Move the `zombieHit` message handler** (currently registered directly via `room.onMessage` at module level, not inside `registerHandlers`)

**Export:** `registerZombieHandlers(room)` + `zombieServerSystem` + `despawnAllZombies` + `activeZombies` (roundManager needs to know about them? check — actually roundManager doesn't touch zombies directly, but `bananaServerSystem` in combat.ts checks ghost-trap collision by reading `activeZombies`. So export `activeZombies`.)

**⚠️ Re-check cross-references:** `bananaServerSystem` in `combat.ts` iterates `activeZombies` for ghost-trap collisions and calls `recycleZombieSyncId`. This means `combat.ts` needs to import from `zombieSystem.ts`, creating a `combat ↔ zombie` dependency. Solutions:
- Move the ghost-trap collision check from `bananaServerSystem` into `zombieSystem.ts` (cleaner)
- Or accept the bidirectional import since it's not truly circular (both import specific exports, not each other's initialization)

**Preferred:** Move ghost-trap collision to zombie system or accept it as a one-way dependency where combat exports traps, zombie reads them.

**Verify:** `npx tsc --noEmit` compiles clean.

**Commit message:** `refactor: extract zombieSystem.ts — ghost AI, spawning, collisions`

---

## Step 9: `mushroomSystem.ts` — Mushroom spawning

**Session prompt:** "Read REFACTOR_PLAN.md and do Step 9 of the server refactor."

**What to do:** Create `src/server/mushroomSystem.ts` and move all mushroom logic.

**Move these types and state:**
- `ServerMushroom` interface, `activeMushrooms` array, `mushroomIdCounter`

**Move these functions:**
- `randomMushroomCandidates()`
- `mushroomToPayload()`
- `spawnOneMushroom()`
- `spawnMushrooms()` — called from `setupServer` and `handleRoundEnd`. Must be exported.

**Move these message handlers:**
- `requestMushroomPositions`, `pickupMushroom`

**Export:** `registerMushroomHandlers(room)` + `spawnMushrooms`

**Verify:** `npx tsc --noEmit` compiles clean.

**Commit message:** `refactor: extract mushroomSystem.ts — mushroom spawning and pickup`

---

## Step 10: `playerTracking.ts` — Join/leave + name resolution

**Session prompt:** "Read REFACTOR_PLAN.md and do Step 10 of the server refactor."

**What to do:** Create `src/server/playerTracking.ts` and move player join/leave detection and name resolution.

**Move these functions:**
- `playerTrackingSystem()` — the big system that detects joins/leaves, creates hold-time entities, loads wallets, tracks visitor sessions
- `nameResolverServerSystem()`

**This system calls into multiple modules on join:**
- `getOrCreateHoldTimeEntity(userKey)` — from `flagLogic.ts`
- `loadPlayerCoinBalance(userKey)` + `getOrCreateWalletEntity(userKey)` — from `economy.ts`
- `updateConcurrentTracking()` + `syncVisitorAnalytics()` + `syncMonthlyVisitorAnalytics()` — from `analytics.ts`
- `updatePlayerName()` — from `leaderboard.ts`
- `persistPlayerNames()` — from `persistence.ts`

**All accessed via imports — no circular dependencies** since nothing imports from `playerTracking.ts`.

**Export:** `playerTrackingSystem` + `nameResolverServerSystem`

**Verify:** `npx tsc --noEmit` compiles clean.

**Commit message:** `refactor: extract playerTracking.ts — join/leave detection, name resolution`

---

## Step 11: `roundManager.ts` — Countdown + round end + lightning + updraft

**Session prompt:** "Read REFACTOR_PLAN.md and do Step 11 of the server refactor."

**What to do:** Create `src/server/roundManager.ts` and move the round lifecycle, countdown, lightning, and updraft systems. This is the trickiest step because `handleRoundEnd` touches every domain.

**Move these state variables:**
- `lastProcessedRoundEndTime`, `lastTimerDebugLog`
- Lightning: `lightningRollTimer`, `lightningStrikeScheduled`, `lightningWarningTimer`, `_lightningOriginalCarrierId`, `LIGHTNING_ROLL_INTERVAL`, `LIGHTNING_WARNING_DURATION`
- Updraft: `updraftActiveIndex`, `updraftTimer`, `UPDRAFT_CHIMNEY_COUNT`, `UPDRAFT_ROTATE_SEC`

**Move these functions:**
- `getLightningStrikeChance()`, `getCarrierHoldSeconds()`
- `lightningServerSystem()`
- `countdownServerSystem()`
- `handleRoundEnd()` — the nexus function
- `updraftServerSystem()`

**Move these message handlers:**
- `requestUpdraftLocation`
- `testDiscord` (admin trigger — or move to analytics)

**`handleRoundEnd()` imports from everywhere:**
- `flagLogic`: `flushHoldTimeAccum()`, `resetGravityState()`, `getOrCreateHoldTimeEntity()`
- `combat`: `activeTraps`, `activeProjectiles`, `activeOrbits`, `removeTrap()`, `removeProjectile()`
- `economy`: `awardRoundCoins()`
- `leaderboard`: `parseLeaderboardJson()`, `incrementLeaderboardWins()`, `checkLeaderboardDailyReset()`, `checkMonthlyLeaderboardReset()`
- `persistence`: `persistLeaderboard()`, etc.
- `mushroom`: `spawnMushrooms()`
- `analytics`: (indirectly via leaderboard reset)

**⚠️ CRITICAL:** Preserve the synchronous-before-await order in `handleRoundEnd()`. All flag resets, score reads, score zeros, accumulator clears, trap/projectile cleanup, and respawn messages MUST happen before the first `await`. Do NOT introduce any `await` before the comment line `// Safe to await now`.

**Export:** `countdownServerSystem` + `lightningServerSystem` + `updraftServerSystem` + `registerRoundHandlers(room)`

**Verify:** `npx tsc --noEmit` compiles clean. This is the step most likely to break things — double-check all imports resolve.

**Commit message:** `refactor: extract roundManager.ts — countdown, round end, lightning, updraft`

---

## Step 12: `server.ts` — Final cleanup

**Session prompt:** "Read REFACTOR_PLAN.md and do Step 12 of the server refactor."

**What to do:** Clean up `server.ts` to be a thin orchestrator. By now, most code should already be extracted. What remains:

- `setupServer()` — calls each module's setup/init, creates entities, registers systems
- The `safeSystem` wrapper
- The `registerHandlers()` call that delegates to per-module `register*Handlers(room)` functions
- Entity creation code (flag, countdown, leaderboard, coin state, visitor analytics entities) — these can stay in `server.ts` since they're one-time setup

**Verify the final state:**
- `server.ts` should be ~150-200 lines
- No function longer than ~30 lines
- All game logic lives in domain modules
- `npx tsc --noEmit` compiles clean
- Start preview and screenshot to verify the game works

**Commit message:** `refactor: finalize server.ts as thin orchestrator — refactor complete`

---

## Post-Refactor Checklist

After all 12 steps are done:

- [ ] `npx tsc --noEmit` — zero errors
- [ ] Preview test: flag pickup/drop works
- [ ] Preview test: boomerang throw + return works
- [ ] Preview test: scoreboard updates during round
- [ ] Preview test: round end triggers, scores reset, flag respawns
- [ ] Preview test: coin pickup works
- [ ] Preview test: store UI opens, can browse items
- [ ] No circular imports (check with `grep -rn "import.*from.*server/" src/server/`)
- [ ] Each module file has a brief header comment explaining its responsibility
- [ ] Delete this file (`REFACTOR_PLAN.md`) or move to `docs/`
