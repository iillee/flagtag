# Bug: Stale CRDT Transform causes phantom trap hits and false flag steals

**Status:** open · investigated, not fixed · reproducible in multiplayer
**Filed:** 2026-07-21
**Severity:** high — breaks fair play; wrong player gets stunned, flag "teleports" between players
**Related:** PR #6 (partial fix — same class), PR #8 (aware of "documented saturation class")

---

## Summary

Every server-side proximity check for combat and flag steals reads player
positions from `getPlayerPosition(addr)`, which returns the CRDT-synced
`Transform` component. Under CRDT saturation this value can be **stale by
seconds or entirely frozen** for individual players. Any code path that
matches "victim near X" using this stale view will register hits or steals
against a player's ghost position rather than their true location.

PR #6 fixed the mirror-image problem for the **shooter/dropper** (item
spawn location) by having the client send its own fresh position with
`requestShell` / `requestBanana`, validated server-side by
`resolveActionPosition`. It did **not** touch victim-side position reads,
which is the residual bug documented here.

## Symptoms (observed in multiplayer playtest, flagtag.dcl.eth, 2026-07-21)

Reported by scene owner across two independent sessions (one with a
mobile tester, one with a real desktop player):

### Symptom A — Banana hits a player who isn't near you
- Drop a banana at your feet with **F** (`IA_SECONDARY`).
- Hit VFX fires immediately at your drop location, victim tag = another
  player who is visibly on the opposite side of the map.

### Symptom B — Flag "teleports" to another player on banana drop
- While carrying the flag, drop a banana with **F**.
- The flag transfers to another player (attaches above their head, they
  start accruing hold time) with no visible hit.
- The other player has flag immunity for the grace period.
- When grace expires, the pending banana hit fires on them → they drop
  the flag → flag lands at ~the banana drop location.

### Symptom C — Boomerangs (E) appear unaffected in these sessions
- Firing boomerangs with **E** (`IA_PRIMARY`) does NOT reproduce either
  symptom in the current playtests.
- Hypothesis: the projectile flies out along a chosen direction, so its
  trajectory rarely passes through the stale ghost positions of far-away
  players. Traps sit at the dropper's feet, making them a static match
  target for anyone whose ghost happens to hover near the dropper.
- Boomerang RETURN path uses the same hit code and could still misfire —
  worth explicit multiplayer testing.

## Reproduction environment

- Production `flagtag.dcl.eth`, main branch at `e8277ba`.
- Session 1: dropper on desktop, tester on mobile.
- Session 2: dropper on desktop, other real player on desktop.
- Confirmed the symptom is NOT mobile-specific.

## Suspected mechanism

Under CRDT congestion — which this scene explicitly acknowledges as a
"documented saturation class" (see comments in `src/gameState/flagHoldTime.ts`
and `src/server/economy.ts`) — the server's copy of a specific player's
`Transform` can stall indefinitely. `getPlayerPosition(addr)` continues to
return whatever the last successfully-synced position was, even if that was
minutes ago and the player has since moved far away.

Every code path that reads `getPlayerPosition(victim)` and does a proximity
check is exposed:

- **Trap hit-check** — `src/server/combat.ts:602`
  ```ts
  const playerPos = getPlayerPosition(addr)         // stale
  const dist = Vector3.distance(playerPos, trapPos)
  if (dist < TRAP_TRIGGER_RADIUS) hit               // TRAP_TRIGGER_RADIUS = 2.0m
  ```
- **Bomb explosion hit-check** — `src/server/combat.ts:691` (same pattern)
- **Projectile hit-check** — `src/server/combat.ts:895` (same pattern; also
  the boomerang return path)
- **Proximity steal** — `src/server/flagLogic.ts:398`
  ```ts
  const pos = getPlayerPosition(addr)               // stale
  const dist = Vector3.distance(carrierPos, pos)
  if (dist < closestDist) closestId = addr          // PROXIMITY_STEAL_RADIUS = 1.8m
  ```
- **Force-drop position** — `src/server/flagLogic.ts:325`
  ```ts
  const playerPos = getPlayerPosition(playerId)     // stale
  dropPos = playerPos + (0, 0.5, 0)                 // flag lands at ghost pos
  ```

`wasWithinRadius(addr, target, radius, lookbackMs)` in
`src/server/serverState.ts:191` scans a rolling position history
(`POS_HISTORY_MAX_MS = 500`) and provides ~300-500ms of lag forgiveness for
projectile hits. This is **insufficient** for the observed failure: when a
Transform is frozen for seconds or longer, the entire 500ms history is
identical stale samples.

### Why Symptoms A and B are the same bug expressed differently

**Symptom A (no flag, banana hits far player):**
Trap placed at dropper's fresh true position `P` (via `resolveActionPosition`).
Trap trigger loop iterates all players. Victim's server-view is frozen at
some position `G` that happens to be within 2m of `P`. Distance check
matches → hit fires → VFX renders at `P` (trap position), tagging the
victim who is actually far away.

**Symptom B (with flag, banana "moves" flag to far player):**
Carrier walks near where the far player's frozen ghost position is. Each
tick, `checkProximitySteal` compares carrier position to every player's
`getPlayerPosition`. Ghost is within `PROXIMITY_STEAL_RADIUS = 1.8m` →
steal fires → far player receives the flag (attaches to their client's
avatar, they gain hold time). Far player gets flag immunity grace.
Simultaneously the dropped banana sits at `P` near the ghost. When grace
expires, trap trigger fires on the far player → `safeForceDrop(farPlayer)`.
Force-drop calls `handleDrop` which uses `getPlayerPosition(farPlayer)`
(still the frozen ghost, near `P`) as the drop position. Flag "returns
to" `P` — which is where the banana was dropped.

The F key is not causally involved in Symptom B. The steal and drop happen
independently of the banana; the timing correlation is coincidence (or the
player noticing the flag missing at the moment they took an action).
**Predicted:** the same steal will fire without any item usage if the
carrier simply walks past a frozen player's ghost position.

## What PR #6 fixed vs. what it left open

**Fixed:** shooter/dropper's stale server-view was causing items to spawn
at the wrong location (e.g., boomerang flying from where the shooter used
to be). PR #6 added `resolveActionPosition` (`src/server/combat.ts:376`)
which prefers the client-reported fresh position with an 8m tolerance for
traps / 16m for projectiles.

**Left open:** all hit-detection and proximity checks read
`getPlayerPosition(victim)` unchanged. Same "CRDT saturation" root cause
applies to victims. PR #6's writeup did not mention this asymmetry.

## PR #8 relevance

PR #8 (`deep-review-fixes`) explicitly addresses CRDT saturation elsewhere
(hold-time scoreboard, per-round IDs, leaderboard mutations) and its
codebase-wide comments repeatedly reference "the documented saturation
class." The combat/steal paths were **not** in scope for PR #8. This bug
is the last major surface where CRDT staleness is unhandled.

## Suggested next steps

### Step 1 — Diagnose (add logging, no gameplay change)

Confirm the mechanism and quantify staleness distribution before shipping
a fix. Small edit to log the victim's server-view coords + trap coords +
position-history freshness at every trap hit and proximity steal event.

Example log line to add in the trap hit branch (`src/server/combat.ts:~613`):
```ts
console.log('[Server] 🪤 hit check:', addr.slice(0, 8),
  'view=', playerPos.x.toFixed(1), playerPos.z.toFixed(1),
  'trap=', trapPos.x.toFixed(1), trapPos.z.toFixed(1),
  'ageMs=', getPositionAgeMs(addr))
```

Requires a small helper in `src/server/serverState.ts` that returns the age
of the newest sample in `positionHistory` for a given address.

Playtest 10 min with 2+ players. Tail with `npm run server-logs`. Look for
hits where `ageMs` is >1000. That is the signature of the bug in the wild.

### Step 2 — Fix (choose based on Step 1 findings)

**Option A (small, low-risk): staleness guard**
Skip any proximity check against a victim whose latest position sample is
older than a threshold (~1500 ms). Trades an occasional missed legitimate
hit against a lagged player for zero phantom hits on frozen ghosts.
Estimated ~20 lines across `combat.ts` and `flagLogic.ts`. Very easy to
revert.

**Option B (bigger, cures root cause): 10Hz position heartbeat**
Every client sends its Transform via a WebSocket message at 10Hz alongside
CRDT sync. Server maintains a fresh position view independent of CRDT
saturation. All proximity checks use the fresh view. Requires anti-cheat
validation (client can't teleport-lie beyond `resolveActionPosition`-style
tolerance vs. CRDT). Adds ~10 msg/sec per player of network load. ~50-80
lines across server + client.

Option A first; Option B if Option A leaves gaps.

## Affected files summary

| File | Line | Concern |
|------|------|---------|
| `src/server/combat.ts` | 602 | Trap hit uses `getPlayerPosition(victim)` |
| `src/server/combat.ts` | 691 | Bomb explosion hit — same pattern |
| `src/server/combat.ts` | 875-895 | Projectile hit (outbound + return) — same pattern |
| `src/server/flagLogic.ts` | 398 | `checkProximitySteal` — same pattern |
| `src/server/flagLogic.ts` | 325 | Force-drop position = victim's stale server-view |
| `src/server/serverState.ts` | 148 | `getPlayerPosition` — the shared stale read |
| `src/server/serverState.ts` | 162-186 | `positionHistory` — 500ms rolling window, needs age helper |
| `src/server/serverState.ts` | 191 | `wasWithinRadius` — insufficient for multi-second stalls |
| `src/server/combat.ts` | 376 | `resolveActionPosition` — reference implementation of client-reported position with validation, from PR #6 |

## Non-goals for this fix

- Redesigning the CRDT sync itself (that's an SDK concern).
- Fixing peer-to-peer perception of laggy players (this is a server
  authority concern; clients still see each other via CRDT).
- Anti-cheat overhaul (the fix must not open a new spoofing vector; keep
  the `resolveActionPosition`-style validation pattern).
