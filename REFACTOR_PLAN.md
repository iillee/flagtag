# Server Refactor Plan

**Goal:** Split `src/server/server.ts` (3,584 lines) into focused modules for readability, reduced complexity, and reusability as an open-source reference project.

**Commit:** Starting from `813f6a6` (bug fixes for memory leaks + visitor time precision already applied).

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

---

## Extraction Order

Order matters — extract leaf dependencies first, then modules that depend on them. Each step should compile and be testable in preview.

### Step 1: `serverState.ts` — Shared state
Extract all module-level variables that are accessed across multiple domains:
- Entity references: `flagEntity`, `countdownEntity`, `leaderboardEntity`, `allTimeLeaderboardEntity`, `monthlyLeaderboardEntity`, `visitorAnalyticsEntity`, `monthlyVisitorAnalyticsEntity`, `coinStateEntity`
- Per-player maps: `holdTimeEntities`, `knownPlayers`, `playerNames`, `walletEntities`, `upgradeEntities`, `lifetimeWinsEntities`, `playerBoomerangColors`, `playerCoinBalances`, `playerUpgradeData`, `playerLifetimeWinsCache`, `deathPenaltyCooldowns`
- Session maps: `visitorSessions`, `monthlyVisitorSessions`, `currentlyConnected`
- Constants shared across modules: `PICKUP_RADIUS`, `STEAL_IMMUNITY_MS`, `FLAG_GRAVITY`, `FLAG_MIN_Y`, etc.
- Helper: `isRealName()`, `getPlayerPosition()`

**Why first:** Every other module imports from here. No dependencies on other new modules.

### Step 2: `persistence.ts` — Storage helpers
Extract:
- `persistFlagState()`, `persistLeaderboard()`, `persistAllTimeLeaderboard()`, `persistMonthlyLeaderboard()`
- `persistPlayerNames()`, `loadPlayerNames()`
- `persistVisitorData()`, `loadVisitorData()`

**Depends on:** `serverState.ts`

### Step 3: `leaderboard.ts` — Leaderboard logic
Extract:
- `LeaderboardEntry` type, `parseLeaderboardJson()`, `incrementLeaderboardWins()`
- `patchLeaderboardNames()`, `patchAllLeaderboardNames()`
- `checkLeaderboardDailyReset()`, `checkMonthlyLeaderboardReset()`
- `updatePlayerName()` (updates leaderboards + visitor sessions + player names)

**Depends on:** `serverState.ts`, `persistence.ts`

### Step 4: `analytics.ts` — Visitor tracking + Discord
Extract:
- Concurrent tracking: `updateConcurrentTracking()`, `hourlyPeakConcurrent`, `peakConcurrent`, `peakConcurrentTime`
- Discord: `loadDiscordWebhookUrl()`, `sendDailyAnalyticsToDiscord()`, `sendDiscordFallbackText()`, `buildDailyReport()`
- Pending reports: `snapshotPendingReport()`, `sendPendingReport()`, `checkPreMidnightReport()`, `loadDailyReportSentDay()`
- Visitor sync: `syncVisitorAnalytics()`, `syncMonthlyVisitorAnalytics()`, `checkVisitorDailyReset()`, `checkMonthlyVisitorReset()`
- System: `visitorTrackingServerSystem()`

**Depends on:** `serverState.ts`, `persistence.ts`, `leaderboard.ts`

### Step 5: `economy.ts` — Coins, wallets, upgrades, store
Extract:
- Coin helpers: `loadPlayerCoinBalance()`, `setPlayerCoinBalance()`, `addPlayerCoins()`, `getOrCreateWalletEntity()`
- Upgrade helpers: `loadPlayerUpgrades()`, `savePlayerUpgrades()`, `getOrCreateUpgradeEntity()`
- Lifetime wins: `loadPlayerLifetimeWins()`, `addPlayerLifetimeWin()`, `getOrCreateLifetimeWinsEntity()`
- Store: `handleBuyBoomerang()`
- Coin state: `updateCoinStateCRDT()`, `coinServerSystem()`, `awardRoundCoins()`
- Coin/upgrade-related message handlers (from `registerHandlers`)

**Depends on:** `serverState.ts`, `persistence.ts`

### Step 6: `flagLogic.ts` — Flag pickup/drop/steal/gravity
Extract:
- Flag state: `flagFalling`, `flagFallVelocity`, `flagGravityTargetY`, `carrierYSamples`, `lastDropperId`, `lastKnownCarrierPos`, `lastCarrierPositionMs`
- Gravity: `computeGravityTarget()`, `resetGravityState()`, `resetCarrierTracking()`
- Handlers: `handlePickup()`, `handleDrop()`, `handleFlagSteal()`
- Hold time: `flushHoldTimeAccum()`, `holdTimeServerSystem()`, `getOrCreateHoldTimeEntity()`
- System: `flagServerSystem()`
- Proximity steal: `checkProximitySteal()`

**Depends on:** `serverState.ts`, `persistence.ts`

### Step 7: `combat.ts` — Traps, projectiles, orbits
Extract:
- Trap state + types: `ActiveTrap`, `activeTraps`, `lastTrapDropTime`
- Trap functions: `handleTrapDrop()`, `removeTrap()`, `bananaServerSystem()`
- Projectile state + types: `ActiveProjectile`, `activeProjectiles`, `lastProjectileFireTime`
- Projectile functions: `handleProjectileFire()`, `removeProjectile()`, `shellServerSystem()`
- Orbit state + types: `ActiveOrbit`, `activeOrbits`, `lastOrbitTime`
- Orbit functions: `handleOrbitRequest()`, `orbitServerSystem()`
- Combat-related message handlers (from `registerHandlers`)

**Depends on:** `serverState.ts`, `flagLogic.ts` (calls `handleDrop` when victim is carrying flag)

### Step 8: `zombieSystem.ts` — Ghost AI
Extract:
- Zombie state: `ActiveZombie`, `activeZombies`, `zombieSpawnTimer`, `zombieRespawnCooldown`
- Functions: `spawnZombie()`, `despawnAllZombies()`, `zombieServerSystem()`
- Zombie message handler (`zombieHit`)

**Depends on:** `serverState.ts`, `combat.ts` (reads `activeProjectiles` for projectile-zombie collisions)

### Step 9: `mushroomSystem.ts` — Mushroom spawning
Extract:
- Mushroom state: `ServerMushroom`, `activeMushrooms`, `mushroomIdCounter`
- Functions: `randomMushroomCandidates()`, `mushroomToPayload()`, `spawnOneMushroom()`, `spawnMushrooms()`
- Mushroom message handlers

**Depends on:** `serverState.ts`

### Step 10: `playerTracking.ts` — Join/leave + name resolution
Extract:
- `playerTrackingSystem()` (the big join/leave detector)
- `nameResolverServerSystem()`

**Depends on:** `serverState.ts`, `persistence.ts`, `economy.ts` (loads wallet on join), `analytics.ts` (syncs visitor data on change)

### Step 11: `roundManager.ts` — Countdown + round end
Extract:
- `countdownServerSystem()`
- `handleRoundEnd()` — this is the nexus function that calls into nearly every other module
- `lightningServerSystem()`, `getLightningStrikeChance()`, `getCarrierHoldSeconds()`
- Lightning state variables
- `updraftServerSystem()` + updraft state

**Depends on:** Everything (flag, combat, economy, leaderboard, analytics, mushroom, zombie). This is extracted last because it orchestrates all domains.

### Step 12: `server.ts` — Thin orchestrator
Reduce to:
- `setupServer()` — calls each module's init/setup, registers all systems
- `registerHandlers()` — delegates to per-module handler registration, or each module registers its own handlers during setup

---

## Circular Dependency Strategy

The main risk is `combat.ts` ↔ `flagLogic.ts` (combat calls `handleDrop` when projectile/trap hits carrier, flag logic is otherwise independent).

**Solution:** `flagLogic.ts` exports `handleDrop()`. `combat.ts` imports it. No reverse dependency needed — flag logic doesn't need to know about combat.

`roundManager.ts` imports from everything but nothing imports from it (except `server.ts` for system registration). This keeps the dependency graph acyclic.

---

## Verification After Each Step

1. `npx tsc --noEmit` — must compile clean
2. `grep -rn` for any remaining references to moved functions/variables in old locations
3. Preview test if gameplay-adjacent code was moved

---

## Notes

- Each module should export a `register*Handlers(room)` function for its message handlers, called from `server.ts`
- Each module should export its system functions, registered in `server.ts` via `engine.addSystem`
- The `safeSystem` wrapper stays in `server.ts` and wraps all systems at registration time
- `serverState.ts` uses mutable exported variables (`export let flagEntity`) — modules reassign them during setup via setter functions
