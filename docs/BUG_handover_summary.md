# Handover Brief — CRDT Cross-Wire of PlayerIdentityData Transforms

**For:** Decentraland Foundation SDK / platform engineers
**From:** Flag Tag scene team
**Filed:** 2026-07-22
**Full investigation:** `docs/BUG_stale-crdt-transform-in-combat.md`

---

## One-line summary

On the authoritative server module, `Transform.get(remotePlayerEntity).position` returns values that **lockstep-follow another live player's movement**, even when the affected player's client is stationary and sending no movement updates.

## Why this matters beyond Flag Tag

Any scene that reads remote-player positions for authoritative decisions (combat, proximity triggers, escort quests, spatial analytics) will silently make wrong decisions. The victim's own client renders them in the correct place — only the server (and remote peers reading server state) sees them elsewhere. Symptom is invisible to casual playtesting.

## Related symptom: `PlayerIdentityData` entities are unreliable in remote clients' ECS

Observed in the same authoritative-server scene, same session as the Transform cross-wire above:

- Some players who are visibly connected in the comms room **never appear** in another client's `engine.getEntitiesWith(PlayerIdentityData)` iteration — their entity is apparently never delivered via CRDT.
- Players who have left the comms room **linger** in remote clients' `PlayerIdentityData` iteration until a full client reload — their entity is apparently never removed.
- Server (via comms) has the correct membership at all times. The mismatch is purely on the CRDT-observation side.

This suggests the underlying issue is not specific to `Transform` writes, but is a systemic reliability problem with how `PlayerIdentityData` entities and their components propagate through CRDT sync in the authoritative-server context. The Transform cross-wire may be one visible face of a broader `PlayerIdentityData` sync problem worth investigating as a single class of issue rather than two separate bugs.

## Reproduction environment

- **SDK:** `@dcl/sdk@7.24.6-29505165911.commit-d270434`
- **Server module:** `@dcl/hammurabi-server@next` (authoritative headless)
- **Realm:** `flagtag.dcl.eth` (World, not Genesis City)
- **Comms:** LiveKit
- **Comms room:** `world-prd-scene-room-flagtag.dcl.eth-bafkreiekmuo2jc4uyc2vfdj4vs3nh7t2nfeiyqyqlvxjp5f2xfkibws4cm`
- **Confirmed cross-machine, cross-network, desktop-to-desktop.** Not mobile-specific, not same-machine, not guest-specific.

## The evidence (four consecutive events, 15s window)

Diagnostic session at `2026-07-22T01:44:02–17Z`. Two players: `0x1e93e5…` (attacker, moving) and `0x874b9d…` (victim, stationary on their own client).

| Time (UTC) | Attacker Transform | Victim Transform (server view) | Δ (x, y, z) |
|---|---|---|---|
| 01:44:02.800 | 348.8, 60.6, 350.9 | 348.7, 61.4, 351.1 | 0.1, **0.8**, 0.2 |
| 01:44:07.314 | 332.5, 60.6, 359.6 | 332.9, 61.4, 359.3 | 0.4, **0.8**, 0.3 |
| 01:44:12.148 | 360.2, 67.7, 330.0 | 360.0, 68.5, 329.4 | 0.2, **0.8**, 0.6 |
| 01:44:17.349 | 364.3, 73.6, 328.8 | 363.9, 74.5, 329.2 | 0.4, **0.9**, 0.4 |

**Key structural clue:** the Y offset is a consistent ~0.8m across all events while X and Z deltas vary. That fingerprint looks like the difference between two different anchor projections (body vs. camera?) of the same underlying source state — not a literal duplication.

`sameRef === false` on every event, and the values differ, so this is not a Vector3 reference alias — it is two distinct Transform components receiving distinct-but-correlated writes.

## What we ruled out (with instrumentation, not guesswork)

- **Duplicate `PlayerIdentityData` entities per address** — added a 1Hz sweep, silent for the entire session. Confirmed one entity per address at all times.
- **First-match ambiguity in address lookup** — patched `getPlayerPosition` to prefer highest-entity-ID and warn on multi-match. No warnings triggered.
- **Vector3 reference aliasing** — logged `sameRef` on every proximity check; always `false`.
- **Stale/frozen Transform (CRDT saturation)** — values update every tick, they are just wrong.
- **Scene code clobbering player Transforms** — audited every `Transform.create` / `Transform.getMutable` in the server module; every write targets game entities (traps, bombs, projectiles, flag, ghosts). No writes to player entities.

## What we're asking

1. **Does `hammurabi-server` receive `PlayerIdentityData` Transform updates through the same code path as client-side scenes, or a distinct one?** The authoritative-server context is unusual; if the sync path differs, this narrows the search substantially.
2. **What field on an incoming CRDT/comms Transform message routes it to a specific entity server-side?** If that routing key can collide, misroute, or be picked from a shared source, that's likely the mechanism producing the lockstep pattern.
3. **Is `PlayerIdentityData.address` guaranteed unique per entity at the platform level**, or is that only conventionally true?
4. **Are you seeing similar reports from other authoritative-server scenes?** (Baskervill was named in prior playtest notes.) If yes, this graduates from a scene report to a known platform issue.
5. **Can you correlate against comms/CRDT server logs for the room and timestamps above?** Retention permitting, the raw participant-to-entity message routing at those moments would be dispositive.

## Attachments to expect from us

- Full investigation doc: `docs/BUG_stale-crdt-transform-in-combat.md`
- Raw log excerpts of the four `🚩 Proximity steal` events with `victimPos` / `carrierPos` / per-entity dumps
- Diagnostic patches applied (both are still live on `flagtag.dcl.eth`):
  - `sweepDuplicateIdentities` + newest-entity `getPlayerPosition` in `src/server/serverState.ts`
  - Position/entity dumps in `src/server/flagLogic.ts` (`checkProximitySteal`) and `src/server/combat.ts` (trap hit branch)
- Screen recordings of the bug reproducing (side-by-side of both clients where possible — victim's client shows them stationary, attacker's client shows the hit landing)

## Our planned defense (in-scene, until platform fix)

Client-reported position heartbeat over WebSocket at ~8Hz, server uses that as the trusted source for all authoritative proximity decisions, falls back to protected state when heartbeat is stale. Mirrors the pattern PR #6 established for shooter position with `resolveActionPosition`. This is a workaround, not a fix — we're building it because we have to ship, but the platform-side fix is what we actually need.
