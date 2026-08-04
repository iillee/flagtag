# Known Bugs

Last updated: 2026-08-04

Currently tracked open issues in Flag Tag. Anything resolved gets moved out (either deleted if trivial, or into `docs/history/` if it has post-mortem value worth preserving).

---

## Open

### Filed 2026-07-29 (surfaced in ~1hr playtest after PR #21 shipped)

Context: playtest ran on `flagtag.dcl.eth` with ~4 players on SDK `7.24.6-29505165911.commit-d270434` (July build). Foundation had publicly asked creators to update to the current `auth-server` tag (`7.25.1`) citing "lots of improvements over the last two weeks" — the window these symptoms appeared in. SDK bump attempt tracked separately on `chore/sdk-bump-7.25`; some of these may resolve on upgrade.

- **Bombs hitting player at distance (Family A — cross-wire signature)** — in the first few games of the session, bombs (own or others') exploded on the player even when the player was not close to the blast. Flag did not teleport, so the PR #10 steal corroboration was holding at the time (that gate has since been removed — 2026-08-04), but combat proximity checks appear to be reading a stale/cross-wired position for the victim. Consistent with the upstream `BUG_stale-crdt-transform-in-combat.md` cross-wire firing directly. The `🔀 CRDT/heartbeat disagreement` log this originally pointed at no longer exists; grep `🔗 position aliasing` and the two `♻️` lines instead (see the log-signature list below).

- **Ghost invisible** — the ghost's model did not render for at least one client during the session. PR #17 shipped a WS heartbeat fallback specifically for this failure mode; either the fallback also failed or PR #21's `ghostTouching` throttle interacts with it in a way that suppresses the fallback. Needs log-based diagnosis.

- **Beacon stuck at spawn until flag changes hands** — the drop-marker beacon frequently sat at the flag base rather than following the flag. Every time the flag changed hands (pickup or steal) the beacon snapped to the correct position. Symptom pattern ("stuck until specific state change") is a code-logic signature, not a network signature. Strong candidate for a genuine regression in the PR #21 `fix(beacon): follow flag through analytic fall` commit (8f43236) — the beacon likely reads the synced Flag entity's Transform, which is deliberately frozen at drop-start Y during the message-driven fall. **Independent of SDK version; will need its own fix regardless of the bump.**

- **Wrong-color boomerang on round start (once)** — player had a blue boomerang equipped with a blue avatar-attached model, but on round start the thrown projectile appeared red. Visiting the chest and reselecting the boomerang fixed it. Round-start is a high CRDT-burst moment; likely a component-sync race between the upgrade-color write and the round-start reset. Single occurrence; low priority.

- **Proximity steal reverting; end-of-game total pickup breakdown (Family A)** — for at least one player, most successful steals reverted to another player within ~1 second. Toward the end of the game, the pickup path degraded further and no player could reliably pick up the flag. The end-of-session degradation is the most severe symptom of the whole report. Possible causes: cross-wire firing persistently, position-heartbeat drops under sustained load, or Multiplayer Server memory/CPU ceiling hit (256MB / 60s async) after long session accumulation. Needs log-based diagnosis — `⚠️ handlePickup REJECT` volume will point at the pickup half. **Update 2026-08-04:** the "steals reverting within ~1 second" half should be gone. That was client-side optimistic steal prediction being rolled back when the server didn't confirm; prediction was removed when steals became server-authoritative, so there is no longer anything to revert. Re-test before investigating further.

### Filed 2026-08-04 (found by code review during the server-authoritative steal work; NOT observed in playtest)

These three were surfaced by an adversarial review of the client→server trust boundary and then
validated by tracing the code — each mechanism below was read and confirmed, but **none has been
reproduced in a live session**, so treat exploitability as argued rather than demonstrated. All
three are **pre-existing**, not caused by making proximity steal server-authoritative; the one
exception is noted in (3).

- **A carrier can strand the flag out of everyone's reach for the rest of the round (needs a modified client).** `handleDrop` (`src/server/flagLogic.ts:434`) applies **no clamp** to the drop position — it comes straight from `getPlayerPosition`, i.e. the client-authoritative movement channel. `computeGravityTarget` then sets `flagGravityTargetY = Math.max(FLAG_MIN_Y, dropY - 0.5)` (`:123`), so the flag falls half a metre and stops at whatever Y the dropper reported. The only thing that lowers it further is a `reportGroundY`, and the handler accepts it from **the dropper only** — `if (lastDropperId) { if (from !== lastDropperId) return; ... }` (`reportGroundY` handler, `:865`), one-shot via `groundReportUsed`. The exploit is therefore *omitting a message*, not spoofing one: drop from height and never send `reportGroundY`. Honest observers do send it (`src/systems/flagSystem.ts` fires on `flagFallStart`) but the server discards all of them.
  - Confirmed: the anyone-may-LOWER fallback with its budget of 8 (`:889-894`) sits in the `else` of `if (lastDropperId)`, so it is **unreachable after any voluntary or combat drop** — only server-initiated drops that call `clearLastDropper()` reach it. Water rescue needs `currentAnchorY <= WATER_RESPAWN_Y` = 49.58 (`:708-709`), impossible for a high flag. So it persists until the round boundary resets the flag — up to 5 minutes.
  - Note the clamps guard the wrong door: `reportGroundY` is triple-clamped (`FLAG_MAX_Y`, `dropBaselineY + 5`, `FLAG_MIN_Y` — `:879`) while the drop that *sets* `dropBaselineY` is unclamped. The code already documents a milder version of this ("a mid-air dropper (updraft) can still hang the flag at their drop height +5") as an accepted residual; what that comment misses is that no other client can rescue it.
  - Suggested fix: clamp `dropPos.y` to the walkable band in `handleDrop`, and give the dropper a report deadline (~500 ms) after which the lower-only budget path opens to any client.

- **Perpetual combat *and* steal immunity via a drop / re-pickup loop (needs a modified client).** `handlePickup` (`src/server/flagLogic.ts:389`) has **no rate limit of any kind** and ends with `lastStealTime.set(playerId, Date.now())` (`:428`). That single timestamp gates *both* full combat immunity (`isFlagImmune`, `src/server/combat.ts:35`, used by the banana/bomb/boomerang/orbit paths) and proximity-steal immunity (`flagLogic.ts:522`). `handleDrop` leaves the flag at `playerPos + (0, 0.5, 0)` (`:445`), i.e. 0.5 m away versus `PICKUP_RADIUS` 4.5, and sets state to `Dropped` — so an immediate `requestPickup` passes every check.
  - Confirmed: the `requestPickup` / `requestDrop` handlers (`:833-845`) are bare passthroughs with no cooldown, and `DROP_PICKUP_COOLDOWN_MS = 2000` lives only in the client (`src/systems/flagSystem.ts:257`). Looping faster than `STEAL_IMMUNITY_MS` (3000 ms) keeps the window permanently re-armed, and `flushHoldTimeAccum` on each drop means almost no hold time is lost.
  - Suggested fix: rate-limit `handlePickup` per address using the existing `isRateLimited`, and/or stop letting a *voluntary* drop-and-regrab buy fresh combat immunity — separate the two consumers of `lastStealTime`.

- **The flag can be handed to a dead, frozen, input-disabled player.** `checkProximitySteal` builds candidates from `getActivePlayerAddresses()` (`src/server/serverState.ts:192`), which is every address with `PlayerIdentityData` + `Transform` and has **no liveness filter**; `selectClosestCandidate` excludes only the carrier. All three death respawns freeze the avatar in place with `InputModifier disableAll` — lightning for 10 s (`src/systems/lightningSystem.ts:83`), water 10 s, ghost 5 s — teleporting it to the shared literal `(385, 96, 392)` 1.5 s in and holding it there for the remainder. A carrier who comes within `PROXIMITY_STEAL_RADIUS` of a frozen player hands over the flag; the recipient cannot move away or drop it.
  - **The lightning half is FIXED (2026-08-04).** An earlier note here claimed the server had no respawn state; that was wrong. The server *chooses* the lightning victim itself (`roundManager.ts` sends `lightningStrike`), so it is authoritative. It now records `lightningStruckAt` and `checkProximitySteal` excludes anyone inside `LIGHTNING_RESPAWN_DURATION_SEC` (moved to `src/shared/constants.ts` so client freeze and server exclusion cannot drift). Cleared on disconnect and at round reset. This was also the only half that was a *regression* from the steal change — the deleted predictor was wrapped in `!isLightningRespawning()`.
  - **Water and ghost deaths remain open.** Both freeze the avatar the same way, but neither is server-initiated: the client detects the death and reports it, so there is no authoritative signal to gate on. They were already unguarded before this change (the predictor only checked lightning), so this is pre-existing rather than a regression.
  - Refuted while validating: the *bounce-back* scenario (lightning strikes the carrier, someone picks the flag up off the corpse, corpse steals it back) does **not** work. `lightningRespawnDelay` counts **down** from `10.0` and `teleportAt = 10.0 - LIGHTNING_FADE_IN` (`lightningSystem.ts:527`), so the corpse leaves the strike site after **1.5 s** — before the new carrier's 3 s immunity lapses. Three separate reviewers got this timing backwards in both directions; the countdown direction is the thing to check.
  - For water/ghost the nearest signal is `deathPenaltyCooldowns` (`src/server/serverState.ts:56`), but it is set from a **client-sent** `deathPenalty` message (`src/server/economy.ts:854`, sent by `src/systems/deathPenaltySystem.ts:15`), so a modified client simply omits it — usable as a courtesy filter, not as a guarantee. Do **not** substitute "exclude anyone who hasn't moved recently": that would also block a legitimate player standing still next to a carrier, which is normal play.

**Decisions taken 2026-08-04 — these three are deferred, not overlooked.** Each needs a
rate-limit or clamp policy that is a balance call, and none has been seen in a live session, so
they were filed rather than patched. Suggested fixes are recorded above; revisit if any shows up
in playtest.

### Watch in next playtest (2026-08-04)

- **Effective steal reach narrowed 2.7 m → 1.8 m.** The deleted `requestSteal` handler validated at `PROXIMITY_STEAL_RADIUS * 1.5` on the server's view while the client had predicted at 1.8 m on its own fresher view; only the 1.8 m server check survives. So the band "client sees ≤1.8 m but the two replicated Transforms read 1.8–2.7 m apart" no longer steals — and `src/shared/messages.ts` itself notes the server's replicated avatar transform "can lag several meters under load". **Decision: left at 1.8 pending playtest**, because the narrowing is argued rather than observed and widening changes feel for everyone. If players report running over a carrier without taking the flag, the fix is the single constant `PROXIMITY_STEAL_RADIUS` in `src/shared/constants.ts` — **not** reinstating client corroboration (which caused the bug this work removed) and **not** a position-history lookback (which inflates the radius; see the comment above `checkProximitySteal`).

### Unresolved from earlier work

- **Pickup radius 3m → 4.5m (`6605bc6`, merged 2026-07-29)** applies to grounded pickups, mid-air pickups, AND server steal validation. The bump was needed for mid-air grabs (during fall the flag is 2–6m above the player's feet, so 3m 3D distance left almost no horizontal reach). But the 4.5m may be too generous for the on-ground case, which felt well-tuned at 3m. Consider a state-gated radius: 3m when `state === Dropped` and not falling, 4.5m during active fall. Not urgent; playtest to confirm the on-ground feel is actually worse before changing.

---

## Diagnostic tools available

- `npx sdk-commands sdk-server-logs --world flagtag.dcl.eth` — streams live production server logs. Wallet already in `logsPermissions`. Use this for any of the above.
- Existing server log signatures: `⚠️ handlePickup REJECT`, `✅ handlePickup ACCEPT`, `🚩⬇️ beginFall`, `🚩 Proximity steal`, `♻️ avatar entity is a RECYCLED slot`, `♻️ avatar entity REISSUED`, `👥 duplicate PlayerIdentityData`, `🔗 position aliasing`.
- Cross-wire tripwires, all at 1Hz from `sweepDuplicateIdentities` in `serverState.ts`: the two `♻️` lines report the **trigger** (a recycled or reissued avatar entity id — note `version > 0` is necessary but not sufficient, so on a long-running server this eventually fires on most joins); `🔗 position aliasing` reports the **symptom** (two addresses moving as one). `🔗` is edge-triggered per pair and requires the pair to move together, because this scene parks players on shared fixed points routinely.
- Gone: `🔀 CRDT/heartbeat disagreement` (removed with the position heartbeat 2026-08-03 — do not confuse it with the unrelated `🔗` above); `🚩 Client proximity steal prediction` and `🚫 Proximity steal blocked (no client corroboration)` (removed 2026-08-04 when proximity steal became server-authoritative); `⚠️ getPlayerPosition: address … has N entities` (removed 2026-08-04 — it fired on every position lookup, 60-240 lines/s for one duplicated address, and buried the 1Hz tripwires above; `👥 duplicate PlayerIdentityData` reports the same condition with every entity id, edge-triggered once per change to that id set — so grep from before the duplicate appeared rather than expecting a steady stream).

---

## Recently resolved (2026-08-04)

- **Duplicate avatar entities poisoned position history.** `recordPlayerPositions` sampled per ENTITY into a per-ADDRESS history while `getPlayerPosition` picked the newest entity, so with a duplicate present a stale corpse entity's positions were interleaved with the live player's under one key — and `wasWithinRadius` accepts if ANY sample matches. A frozen corpse could therefore keep authorizing projectile hits (`combat.ts` shell path) and client action positions (`resolveActionPosition`) for the live player: the phantom-combat symptom, produced by the scene's own bookkeeping rather than the platform. Both readers now resolve through the same `selectNewestPerAddress` (`src/server/identitySweep.ts`, unit-tested), so they cannot drift.

- **Both client sound-dedup guards could stick and silence a later sound.** Each was a sticky boolean cleared only by an event a stalled Flag CRDT can lose, so a lost clear silenced a subsequent sound. Fixed with two different shapes, because the two guards scope differently: the pickup guard became **carrier-scoped** (`pickupSoundPlayedForCarrier` — a value naming X can only ever suppress X's own duplicate, plus a `flagHeartbeat` reset for a drop the client never observed), while the drop guard became **time-bounded** (`skipDropSoundUntil`, 1500 ms — a manual drop is a point-in-time event, so *when* is the right scope, and the window cannot be derived from `lastDropTimeMs` because `dropForced` sets that too and a forced drop takes its sound from the CRDT edge). `playDropSound` also gained a 250 ms cooldown mirroring `playPickupSound`. Worst case for both now degrades to one extra sound rather than permanent silence. Neither guard has test coverage — the client sound machine is engine-bound and this repo has no client test harness.

## Recently resolved (2026-07-22)

- **CRDT cross-wire on player Transforms** — server-side `Transform.get(remotePlayerEntity)` lockstep-tracked another player's position, causing phantom trap hits, wrong steal targets, and "flag teleporting" symptoms. Root cause was a platform-level identity/routing bug in the Multiplayer Server / LiveKit layer (see `BUG_stale-crdt-transform-in-combat.md` and `BUG_handover_summary.md`). **The platform issue is now reported fixed, and on 2026-08-03 the in-scene position-heartbeat workaround was removed** — `getPlayerPosition` reads the CRDT Transform again, and the `🔀 CRDT/heartbeat disagreement` detector is gone with it. The `requestSteal` corroboration gate and the duplicate-entity diagnostics were kept. **Then on 2026-08-04 the corroboration gate went too**, after it was found denying every legitimate steal against a carrier whose avatar entity had been recycled — the P3 trigger itself — while never blocking a false transfer. Proximity steal is now fully server-authoritative and the scene has no blocking cross-wire defense. Detection is three 1Hz logs in `serverState.ts`: the two `♻️` lines (trigger) and `🔗 position aliasing` (symptom). If phantom hits or wrong steal targets reappear, suspect this first, grep `🔗` and `♻️`, and re-read the bug doc before re-diagnosing from scratch.

- **Flag state persisted to Storage on every gameplay event** — PR #11 removed all Storage writes for flag state (the CRDT `syncEntity` handles live replication; nothing else about a round survives a server restart, so persisting the flag alone produced a half-consistent state and was a suspected contributor to the historical "flag stuck" bug). Cut ~75–85% of the scene's total Storage write volume.

## History

Earlier bug documentation and post-mortems (through 2026-06-09) live in `docs/history/KNOWN_BUGS-2026-06.md`. Do not treat root-cause theories in that file as current — several were revised after the cross-wire investigation.

## How to file a new one

Add an entry under **Open** with:
- Symptoms (what the player sees).
- Reproduction (steps + environment: solo / multiplayer / mobile / desktop).
- Suspected mechanism (if known).
- Relevant files / callsites.
- Any diagnostic logs already added.

If the investigation gets substantial, promote to a dedicated `docs/BUG_<slug>.md` file and link it from here.
