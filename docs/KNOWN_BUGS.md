# Known Bugs

Last updated: 2026-07-29

Currently tracked open issues in Flag Tag. Anything resolved gets moved out (either deleted if trivial, or into `docs/history/` if it has post-mortem value worth preserving).

---

## Open

### Filed 2026-07-29 (surfaced in ~1hr playtest after PR #21 shipped)

Context: playtest ran on `flagtag.dcl.eth` with ~4 players on SDK `7.24.6-29505165911.commit-d270434` (July build). Foundation had publicly asked creators to update to the current `auth-server` tag (`7.25.1`) citing "lots of improvements over the last two weeks" — the window these symptoms appeared in. SDK bump attempt tracked separately on `chore/sdk-bump-7.25`; some of these may resolve on upgrade.

- **Bombs hitting player at distance (Family A — cross-wire signature)** — in the first few games of the session, bombs (own or others') exploded on the player even when the player was not close to the blast. Flag did not teleport, so the PR #10 steal corroboration is holding, but combat proximity checks appear to be reading a stale/cross-wired position for the victim. Consistent with the upstream `BUG_stale-crdt-transform-in-combat.md` cross-wire firing directly. `🔀 CRDT/heartbeat disagreement` server log would confirm.

- **Ghost invisible** — the ghost's model did not render for at least one client during the session. PR #17 shipped a WS heartbeat fallback specifically for this failure mode; either the fallback also failed or PR #21's `ghostTouching` throttle interacts with it in a way that suppresses the fallback. Needs log-based diagnosis.

- **Beacon stuck at spawn until flag changes hands** — the drop-marker beacon frequently sat at the flag base rather than following the flag. Every time the flag changed hands (pickup or steal) the beacon snapped to the correct position. Symptom pattern ("stuck until specific state change") is a code-logic signature, not a network signature. Strong candidate for a genuine regression in the PR #21 `fix(beacon): follow flag through analytic fall` commit (8f43236) — the beacon likely reads the synced Flag entity's Transform, which is deliberately frozen at drop-start Y during the message-driven fall. **Independent of SDK version; will need its own fix regardless of the bump.**

- **Wrong-color boomerang on round start (once)** — player had a blue boomerang equipped with a blue avatar-attached model, but on round start the thrown projectile appeared red. Visiting the chest and reselecting the boomerang fixed it. Round-start is a high CRDT-burst moment; likely a component-sync race between the upgrade-color write and the round-start reset. Single occurrence; low priority.

- **Proximity steal reverting; end-of-game total pickup breakdown (Family A)** — for at least one player, most successful steals reverted to another player within ~1 second. Toward the end of the game, the pickup path degraded further and no player could reliably pick up the flag. The end-of-session degradation is the most severe symptom of the whole report. Possible causes: cross-wire firing persistently, position-heartbeat drops under sustained load, or Multiplayer Server memory/CPU ceiling hit (256MB / 60s async) after long session accumulation. Needs log-based diagnosis — `⚠️ handlePickup REJECT` and `🚩 Client proximity steal prediction` server-log volume will point at the cause.

### Unresolved from earlier work

- **Pickup radius 3m → 4.5m (`6605bc6`, merged 2026-07-29)** applies to grounded pickups, mid-air pickups, AND server steal validation. The bump was needed for mid-air grabs (during fall the flag is 2–6m above the player's feet, so 3m 3D distance left almost no horizontal reach). But the 4.5m may be too generous for the on-ground case, which felt well-tuned at 3m. Consider a state-gated radius: 3m when `state === Dropped` and not falling, 4.5m during active fall. Not urgent; playtest to confirm the on-ground feel is actually worse before changing.

---

## Diagnostic tools available

- `npx sdk-commands sdk-server-logs --world flagtag.dcl.eth` — streams live production server logs. Wallet already in `logsPermissions`. Use this for any of the above.
- Existing server log signatures: `🚩 Client proximity steal prediction`, `⚠️ handlePickup REJECT`, `✅ handlePickup ACCEPT`, `🚩⬇️ beginFall`, `🚫 Proximity steal blocked (no client corroboration)`, `⚠️ getPlayerPosition: address … has N entities`. (`🔀 CRDT/heartbeat disagreement` is gone — it was removed with the position heartbeat on 2026-08-03.)

---

## Recently resolved (2026-07-22)

- **CRDT cross-wire on player Transforms** — server-side `Transform.get(remotePlayerEntity)` lockstep-tracked another player's position, causing phantom trap hits, wrong steal targets, and "flag teleporting" symptoms. Root cause was a platform-level identity/routing bug in the Multiplayer Server / LiveKit layer (see `BUG_stale-crdt-transform-in-combat.md` and `BUG_handover_summary.md`). **The platform issue is now reported fixed, and on 2026-08-03 the in-scene position-heartbeat workaround was removed** — `getPlayerPosition` reads the CRDT Transform again, and the `🔀 CRDT/heartbeat disagreement` detector is gone with it. The `requestSteal` corroboration gate and the duplicate-entity diagnostics were kept. If phantom hits or wrong steal targets reappear in playtest, this is the first thing to suspect: there is no longer a log signature that catches it, so re-read the bug doc before re-diagnosing from scratch.

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
