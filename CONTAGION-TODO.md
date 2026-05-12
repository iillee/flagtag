# Contagion Game — Remaining Work

## What's Been Done (Steps 1-4) ✅

### Step 1: Components & Messages (`src/shared/`)
- `components.ts`: `Flag` → `Sword` (same AtBase/Carried/Dropped states), `PlayerFlagHoldTime` → `PlayerSurvivalTime`, added `InfectionState` (global round state), `PlayerInfected` (per-player), removed `Projectile`/`Zombie` components, added infection constants (`INFECTION_RADIUS`, `SWORD_ATTACK_RADIUS`, `SLIME_RESPAWN_COOLDOWN_SEC`, `INFECTION_IMMUNITY_MS`), `SyncIds.FLAG` → `SyncIds.SWORD` + `SyncIds.INFECTION_STATE`
- `messages.ts`: Removed shell/projectile/boomerang/orbit/zombie/mushroom/shield/lightning messages. Renamed flag messages → sword messages. Added `playerInfected`, `roundStartInfection`, `lastHumanWin`, `allHumansInfected`, `requestSwordAttack`, `swordAttackVfx`, `slimeKilled`, `slimeRespawned`

### Steps 2-4: Server Logic (`src/server/server.ts`)
- `flagServerSystem` → `swordServerSystem` (same gravity/carrier tracking/disconnect detection)
- `holdTimeServerSystem` → `survivalTimeServerSystem` (all humans accumulate time, not just flag carrier)
- New `infectionServerSystem` — proximity checks slimes vs humans, respawn cooldown management
- New functions: `infectPlayer()`, `startInfectionRound()`, `handleSwordAttack()`, `handleSwordPickup/Drop/forceSwordDrop()`, `syncInfectionState()`, `getHumansRemaining()`
- `handleRoundEnd()` rewritten — scores by survival time, resets infection state
- `countdownServerSystem` updated — supports early round end when all humans infected, calls `startInfectionRound()` after splash
- Removed: lightning, projectile, orbit, zombie, mushroom systems and all their handlers
- **Server compiles with zero errors**

---

## What's Left To Do

### Step 5: Client Sword System
**Files to modify:** `src/systems/flagSystem.ts` → rename to `src/systems/swordSystem.ts`, `src/index.ts`

The client-side flag system handles:
- Visual mesh (GltfContainer) following the carrier or sitting at base/dropped position
- Bob/spin animation for the flag when not carried
- Pointer events for pickup (click to pick up)
- Client-side position interpolation

**What to do:**
1. Copy `src/systems/flagSystem.ts` → `src/systems/swordSystem.ts`
2. Find/replace all `Flag` → `Sword`, `FlagState` → `SwordState`, `flag` → `sword` references
3. Change the model path from the flag GLB to a sword GLB (need to find/download a sword model)
4. Update message names: `requestPickup` → `requestSwordPickup`, `requestDrop` → `requestSwordDrop`, `pickupConfirmed` → `swordPickupConfirmed`, `pickupSound` → `swordPickupSound`, `dropSound` → `swordDropSound`
5. Add a pointer event or key binding for sword attack (`requestSwordAttack`)
6. Only allow humans to see the pickup prompt (check `PlayerInfected` state)
7. Update `src/index.ts`:
   - Change imports from `flagSystem` → `swordSystem`
   - Remove old flag system initialization
   - Add sword system initialization
   - Fix any remaining `Flag`/`FlagState` references (line ~281)
   - Remove `colorChanged` message send (line ~198)

**Key reference:** The old `flagSystem.ts` is 663 lines. The sword version should be structurally identical but with renamed variables and the sword model.

### Step 6: Client Infection Visuals
**New file:** `src/systems/infectionSystem.ts` (client-side)

This system listens to server messages and CRDT components to show infection visuals:

1. **Listen for `roundStartInfection` message** — show "ROUND START" UI, highlight Patient Zero
2. **Listen for `playerInfected` message** — play infection VFX (green splat particles, sound) on the victim
3. **Listen for `slimeKilled` message** — play death VFX on the slime's position
4. **Listen for `slimeRespawned` message** — play respawn VFX
5. **Listen for `swordAttackVfx` message** — play sword swing effect
6. **Read `InfectionState` component** — display "HUMAN" or "INFECTED" status, humans remaining count
7. **Read `PlayerInfected` component** — determine if local player is infected (for UI/controls)
8. **Slime visual differentiation** — infected players could get:
   - A green tint or particle effect following them (tricky with SDK7 avatar limits)
   - A floating label "SLIME" above their head (TextShape entity parented above them)
   - A different movement trail color

**UI updates needed** (in whatever UI file handles the HUD):
- Show "Humans: X remaining" counter
- Show "YOU ARE INFECTED" or "YOU ARE HUMAN" status
- Show sword carrier indicator
- Update round-end splash to show "Last Survivor Wins" instead of "Most Hold Time Wins"

### Step 7: Remove Dead Client Systems
**Files to delete entirely:**
- `src/systems/zombieSystem.ts` — AI enemies replaced by player slimes
- `src/systems/lightningSystem.ts` — no flag carrier to punish
- `src/systems/projectileSystem.ts` — boomerangs removed
- `src/systems/remoteBoomerangSystem.ts` — boomerangs removed
- `src/systems/mushroomSystem.ts` — mushroom pickups removed
- `src/systems/shieldSystem.ts` — shields removed
- `src/systems/combatSystem.ts` — old combat system (charges, VFX) replaced

**Files to update (remove references to deleted systems):**
- `src/index.ts` — remove imports and system registrations for all deleted systems
- `src/gameState/flagHoldTime.ts` — rename to `survivalTime.ts` or delete if UI handles it differently
- `src/gameState/boomerangColor.ts` — may be able to delete if boomerang store is removed
- `src/gameState/lightningState.ts` — delete
- `src/gameState/playerUpgradeState.ts` — keep if store stays, otherwise delete

**Files that reference old messages (grep for errors):**
- Any file using `requestPickup`, `requestDrop`, `pickupConfirmed`, `pickupSound`, `dropSound`, `hitVfx`, `missVfx`, `shellDropped`, `shellTriggered`, `shellReturned`, `orbitStarted`, `orbitHit`, `orbitEnded`, `lightningWarning`, `lightningStrike`, `playerChargeStart`, `playerChargeStop`, `zombieKilled`, `ghostTouching`, `mushroomPositions`, `mushroomPickedUp`, `flagImmunity`, `playerShieldActive`, `playerColorChanged`, `colorChanged`, `chargeBurnout`, etc.

To find all broken files:
```bash
npx tsc --noEmit 2>&1 | grep "src/" | grep -v "node_modules/"
```

### Step 8: Balance & Testing
- Tune `INFECTION_RADIUS` (currently 2m) — may need to be larger/smaller
- Tune `SWORD_ATTACK_RADIUS` (currently 3m)
- Tune `SLIME_RESPAWN_COOLDOWN_SEC` (currently 8s)
- Tune slime speed — consider giving slimes a small speed boost (maybe 10-20% faster?)
- Solo mode: if only 1 player, don't start infection (currently handled — `startInfectionRound()` requires 2+ players)
- Edge case: Patient Zero disconnects immediately — should pick a new one
- Edge case: Sword carrier disconnects — sword drops (already handled by `swordServerSystem`)
- Test early round end (all humans infected before timer)
- Test sword attack killing a slime and respawn cooldown

---

## Architecture Quick Reference

### Component Flow (Server → Client)
```
Server creates/mutates:
  Sword (SyncIds.SWORD) ──────────► Client reads for sword position/state
  InfectionState (SyncIds.INFECTION_STATE) ► Client reads for round state/humans remaining
  PlayerInfected (per-player sync) ────────► Client reads for infection status per player
  PlayerSurvivalTime (per-player sync) ────► Client reads for scoreboard

Server sends messages:
  playerInfected ──────► Client plays infection VFX
  roundStartInfection ─► Client shows round start UI
  slimeKilled ─────────► Client plays death VFX
  slimeRespawned ──────► Client plays respawn VFX
  swordAttackVfx ──────► Client plays sword swing VFX
  swordPickupConfirmed ► Client updates sword carrier tracking
  stagger ─────────────► Client plays stagger animation on victim
  respawnPlayers ──────► Client teleports all players to spawn

Client sends messages:
  requestSwordPickup ──► Server validates proximity, human status
  requestSwordDrop ────► Server drops sword
  requestSwordAttack ──► Server checks carrier, proximity to slimes
  requestBanana ───────► Server drops trap (humans only)
```

### Key Files
- `src/shared/components.ts` — All shared component definitions & constants
- `src/shared/messages.ts` — All client↔server message definitions
- `src/server/server.ts` — Authoritative server logic (2,758 lines)
- `src/systems/flagSystem.ts` → needs to become `swordSystem.ts` (663 lines to adapt)
- `src/index.ts` — Client entry point, system registration (410 lines, needs updates)

### Current Compilation Status
- `src/server/server.ts` — ✅ **0 errors**
- `src/shared/components.ts` — ✅ **0 errors**
- `src/shared/messages.ts` — ✅ **0 errors**
- Client files — ❌ **Many errors** (expected — still reference old Flag/projectile/zombie/etc.)

Run `npx tsc --noEmit 2>&1 | grep "src/" | grep -v "node_modules/"` to see all remaining client errors.
