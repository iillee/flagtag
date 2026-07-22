# Known Bugs

Last updated: 2026-07-22

Currently tracked open issues in Flag Tag. Anything resolved gets moved out (either deleted if trivial, or into `docs/history/` if it has post-mortem value worth preserving).

---

## Open

_None currently tracked._

---

## Recently resolved (2026-07-22)

- **CRDT cross-wire on player Transforms** — server-side `Transform.get(remotePlayerEntity)` lockstep-tracked another player's position, causing phantom trap hits, wrong steal targets, and "flag teleporting" symptoms. Root cause is a platform-level identity/routing bug in the Multiplayer Server / LiveKit layer (see `BUG_stale-crdt-transform-in-combat.md` and `BUG_handover_summary.md`). Foundation has been notified; in-scene defenses shipped in PR #10 neutralize the impact by preferring a client-reported position heartbeat over the CRDT view, requiring client corroboration for proximity steals, and enumerating victims from the heartbeat-union roster. Look for `🔀 CRDT/heartbeat disagreement` in server logs — that signature is the platform bug firing and being caught.

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
