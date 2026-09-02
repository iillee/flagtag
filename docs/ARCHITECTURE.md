# Architecture

Flag Tag is a **server-authoritative** Decentraland SDK7 scene. This doc explains how the bundle is structured, how the client and server communicate, and where to find things.

---

## The One-Bundle Split

Decentraland's authoritative-multiplayer mode ships a single JS bundle that runs in two contexts:

- **Server** — a headless QuickJS runtime hosted by Decentraland. No renderer, no `~system/RestrictedActions`, no player-attached APIs.
- **Client** — every connected player's Explorer. Runs the renderer, input, UI, VFX, and prediction.

`src/index.ts` is that shared bundle. It branches on `isServer()`:

```ts
export async function main() {
  if (isServer()) {
    const { setupServer } = await import('./server/server')
    await setupServer()
    return
  }
  // …dynamic imports of all client-only systems
}
```

**Rule:** anything that touches `~system/RestrictedActions`, `~system/Runtime` (for player context), or the renderer **must** be behind a dynamic import gated by the client branch. Static imports of client-only modules will crash the server.

Modules that are safe for both sides (component definitions, message schemas, constants, pure utilities) live in `src/shared/` and are imported statically at the top of `index.ts` so components are registered before the engine seals.

---

## Directory Map

### `src/server/` — Authoritative game logic

| File | Responsibility |
|---|---|
| `server.ts` | Setup + orchestrator; wires every subsystem |
| `serverState.ts` | In-memory canonical state (players, flag, rounds) |
| `flagLogic.ts` | Flag pickup / drop / steal / hold-time accounting |
| `combat.ts` | Boomerang & banana hit resolution |
| `combatValidation.ts` | Anti-cheat: are hits geometrically plausible? |
| `actionValidation.ts` | Anti-cheat: are requested actions legal right now? |
| `cooldownValidation.ts` | Per-player action cooldown enforcement |
| `roundManager.ts` | Round countdown, end-of-round, lightning, updraft |
| `roundAccounting.ts` | Per-round score/hold-time bookkeeping |
| `scoreRoundId.ts` | UTC-aligned round IDs |
| `economy.ts` | Coin wallets, upgrade purchases, store |
| `coinClaimLifecycle.ts` | Coin spawn, claim, cleanup |
| `ghostSystem.ts` | Ghost AI (night only) |
| `ghostTargeting.ts` | Ghost target selection |
| `mushroomSystem.ts` | Mushroom pickup buffs |
| `stealCandidate.ts` | Steal-eligibility ring queries |
| `positionHistory.ts` | Recent-position ring buffer (validation + rewind) |
| `playerTracking.ts` | Join/leave lifecycle |
| `playerDoc.ts` | Per-player `player:{addr}` persistence doc |
| `persistence.ts` | Write-behind flushing to Server-Side Storage |
| `safeStorage.ts` | Retry/backoff wrapper around raw storage |
| `identitySweep.ts` | Periodic reconciliation of connected identities |
| `leaderboard.ts` / `leaderboardData.ts` / `leaderboardLifecycle.ts` | Daily/monthly/all-time leaderboards |
| `analytics.ts` / `posthog.ts` | Visitor tracking + Discord/PostHog reporting |
| `rejectionStats.ts` | Metrics for rejected client requests |
| `asyncSerialQueue.ts` | Ordered async work queue primitive |

### `src/systems/` — Client rendering & input

Each file is an ECS system registered through `systemManager.ts`. Highlights:

- **Flag visuals** — `flagSystem.ts`, `beaconSystem.ts`
- **Combat** — `combatSystem.ts`, `projectile/` (boomerang: charge, flight, orbit, return), `remoteBoomerangSystem.ts`, `trapSystem.ts` (bananas), `bombSystem.ts`
- **Environment** — `waterSystem.ts` (drowning, air meter), `terrainSetup.ts`, `boundaryWalls.ts`, `interiorSystem.ts`, `ladderSystem.ts`, `portalSystem.ts`, `teleportOrbs.ts`
- **Round flow** — `cinematicSystem.ts` (podium camera), `lightningSystem.ts`, `updraftSystem.ts`, `spectatorSystem.ts`
- **Rewards & UX** — `coinBobSpinSystem.ts`, `coinPickupSystem.ts`, `chestSystem.ts`, `mailboxSystem.ts`, `pedestalSystem.ts`, `terminalSystem.ts`, `boomboxSystem.ts`
- **Player VFX** — `shieldSystem.ts`, `speedBoostSystem.ts`, `boostTrailSystem.ts`, `deathPenaltySystem.ts`, `gravestoneSystem.ts`, `handBoomerangSetup.ts`, `avatarEmotes.ts`, `avatarModifierSetup.ts`, `proximityLights.ts`
- **Ghosts** — `ghostSystem.ts` (rendering + scare meter)
- **Infrastructure** — `systemManager.ts` (registration + throttling), `vfxLifetime.ts` (auto-destroy VFX entities), `nameRetrySystem.ts` (player name resolution), `worldLeaderboard.ts` (in-world board rendering), `musicSetup.ts`

### `src/ui/` and `src/ui2/` — React-ECS screen UI

`ui/` holds the current HUD, menus, and dialogs. `ui2/` is a newer implementation being migrated to piece by piece; both render simultaneously today.

### `src/shared/`

- `components.ts` — every custom ECS component definition
- `messages.ts` — client↔server request/broadcast schemas (source of truth for the wire protocol)
- `constants.ts` — tunable gameplay values
- `coins.ts` / `coinLocations.ts` / `coinIds.ts` — coin economy definitions
- `upgrades.ts` — store items and unlocks
- `clientState.ts` — bridging types
- `flagFall.ts`, `ghostContactState.ts`, `syncIdPool.ts`, `entityRange.ts`, `dateUtils.ts`, `interiorGeometry.ts` — shared helpers
- `reservedEntityGuard.ts` — patches `engine.addEntity/removeEntity` to refuse renderer-reserved IDs (must be imported first)

### `src/gameState/`

Client-side reactive state that UI reads from (React-ECS-style stores):

`boomerangColor`, `cinematicState`, `flagHoldTime`, `flagImmunityState`, `hitFlashState`, `holdTimeScores`, `lightningState`, `overlayState`, `playerUpgradeState`, `roundEarnings`, `roundsWon`.

---

## Message Flow

All client → server communication uses typed messages defined in `src/shared/messages.ts`:

```
Client                     Server
  │  requestPickup(flagId)   │
  │ ───────────────────────> │  actionValidation ✓
  │                          │  flagLogic.pickup()
  │  flagState broadcast     │  serverState mutation
  │ <─────────────────────── │
  │  flagSystem re-renders   │
```

Every synced component in `shared/components.ts` is defined with `validateBeforeChange()` returning `false` for non-server writers — clients cannot forge state even if they modify their own bundle.

---

## Round Lifecycle

Rounds are **5 minutes**, UTC-aligned (`scoreRoundId.ts` computes the ID from wall-clock time). `roundManager.ts` runs the countdown, triggers the podium cinematic at end-of-round, applies lightning to dominant holders as a catch-up mechanic, and starts the next round automatically. The server is always live — there is no lobby.

---

## Anti-Cheat Layers

1. **Component-level** — `validateBeforeChange()` on every synced component.
2. **Action-level** — `actionValidation.ts` checks whether a request is legal in the current game state (alive, in bounds, not on cooldown).
3. **Physics-level** — `combatValidation.ts` and `positionHistory.ts` verify hits are geometrically plausible against recent positions (rewind).
4. **Rate-level** — `cooldownValidation.ts` per-action cooldowns.
5. **Persistence-level** — economy writes go through validated request handlers only; the client cannot directly deposit coins.

Every rejection is tallied in `rejectionStats.ts` for anomaly detection.

---

## Where to Add a New Feature

- **A new player action** → add message in `shared/messages.ts`, handler in `server/`, cooldown in `cooldownValidation.ts`, client system in `systems/`, UI in `ui/`.
- **A new visual effect** → new system in `systems/`, register with `systemManager`, use `vfxLifetime` for auto-cleanup.
- **A new persistent value** → extend `playerDoc.ts` schema, write through `persistence.ts` (never call `safeStorage` directly from game logic).
- **A new UI screen** → add to `ui/screens/` (or `ui2/`) and wire from `ui/layouts/`.

---

## See Also

- [GAME_DESIGN_DOCUMENT.md](GAME_DESIGN_DOCUMENT.md) — mechanics & tuning rationale
- [STORAGE.md](STORAGE.md) — persistence schema and migration
- [DEPLOYMENT.md](DEPLOYMENT.md) — how to ship
- [KNOWN_BUGS.md](KNOWN_BUGS.md) — current issues
