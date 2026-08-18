# Bug: `@dcl/ecs` hands scenes renderer-reserved entity IDs, which collide exactly with remote-player avatar entities

**Filed by:** Flag Tag team (ile)
**Original filing:** 2026-08-15 · **Root cause corrected:** 2026-08-17
**Confirmed on SDK:** `@dcl/ecs@7.24.6-29505165911.commit-d270434` and `7.26.1-31714079767.commit-96e9a29` — the two versions `auth-server` pointed at while this was open. `packages/@dcl/ecs/src/engine/entity.ts` is byte-identical between them — `git diff d270434..96e9a29` on that file is empty.
**Fixed upstream:** `@dcl/ecs@7.26.1-32160793830.commit-0b97733` (`auth-server` as of 2026-08-18, now installed) carries all four changes in [The fix](#the-fix). Everything below describes the pre-fix versions.
**Runtime:** `hammurabi-headless@main` (274b256)
**Severity:** High — permanently and silently removes a live player from the authoritative scene's world model.

---

> ## ⚠️ This document supersedes its first version. Two central claims in v1 were wrong.
>
> **v1 said:** "the runtime marks the avatar entity as reserved on peer disconnect and starts blocking scene CRDT ops against it… the new peer's Transform writes are silently dropped by the runtime."
>
> **That is backwards.** Remote-player Transforms are written by the host's avatar system, which is not `sceneSourced` and is *never* touched by the write guard (`scene-context.ts:462`). Every blocked op in our logs is **our own scene's write**. The guard is working correctly; it is refusing writes we should never have been able to address in the first place.
>
> **v1 also said** the one-shot `PlayerIdentityData` PUT loses an LWW race to the 30 Hz `Transform` PUTs. **Impossible** — every component owns a separate `timestamps` map (`lww-element-set-component-definition.ts:282`), so `Transform`'s timestamp cannot arbitrate a `PlayerIdentityData` PUT. Verified: an identity PUT at timestamp 1 lands normally on an entity whose `Transform` the scene already owns. The identity does not lose a race; it is **deleted**, by us, and never re-sent.
>
> v1's two suspected root causes ("reserved-entity accounting bug", "ownership handoff race") are both incorrect. The real cause is in the SDK's entity allocator and is reproducible in isolation with no runtime involved.

---

## TL;DR

`@dcl/ecs`'s entity container recycles entity IDs from a free list keyed by entity **number**, and that free list is fed by *every* inbound `DELETE_ENTITY` — including the runtime's own tombstones for departed remote players. Neither the recycling loop nor the function that records the tombstone filters the renderer-reserved range. So after any peer disconnects, `engine.addEntity()` returns an ID inside the avatar range `[32, 256)`.

The collision is **exact, not merely overlapping**. Both allocators compute the same recurrence from the same stored version:

| | | |
|---|---|---|
| Runtime | `player-entity-manager.ts:92` | `toEntityId(number, storedVersion + 1)` |
| SDK | `entity.ts:147` | `toEntityId(number, storedVersion + 1)` |

They produce the identical 32-bit value at every version. The version bits that were supposed to separate scene entities from avatar slots are precisely what synchronises them.

---

## Root cause — three defects in `packages/@dcl/ecs/src/engine/entity.ts`

Line numbers are pre-patch (`96e9a29`).

**(1) `generateEntity()`'s recycling loop has no reserved-range filter — load-bearing.**
`entity.ts:145`. The only guard is `version < MAX_U16`. It returns `toEntityId(number, version + 1)` for whatever number sits first in the free list's insertion order, including avatar numbers.

**(2) `updateRemovedEntity()` records reserved numbers — the feed.**
`entity.ts:187`, called unconditionally from the CRDT receive path at `systems/crdt/index.ts:153` for every `DELETE_ENTITY`. Note `crdt/index.ts:100` pushes the ID into `entitiesShouldBeCleaned` *before* any entity-state check, so the `DELETE_ENTITY` branch never consults entity state at all — there is no `Reserved` check to skip it.

**(3) `removeEntity()` compares the packed ID, not the entity number — turns a collision into a player wipe.**
`entity.ts:161`: `if (entity < reservedStaticEntities) return false`. The version lives in the high 16 bits, so this only catches version 0. Entity number 32 at version 1 packs to **65568** and sails straight through. Contrast `getEntityState` at `entity.ts:218`, which decomposes correctly. This also makes each poisoned slot **renewable**: removing it re-arms the same number at version+1, forever.

**(4) `engine.removeEntity()` purges components before asking the container.**
`engine/index.ts:51-61` runs `component.entityDeleted(entity, true)` for every component and *then* calls `entityContainer.removeEntity`. So even with defect (3) fixed, the component purge still happens on a refused removal.

### Why the free list is reachable at all

`generateEntity()` only scans the free list when `usedEntities.size + reservedStaticEntities < entityCounter`. Two things put us there:

- **A standing deficit from the composite build.** `assets/scene/main.composite` has max entity number 745, so `sdk-commands` injects `DCL_MAX_COMPOSITE_ENTITY=745` (`sdk-commands/src/logic/bundle.ts:323`) and `entityCounter` starts at 746 while `main.crdt` populates only 230 entities. That is a permanent deficit of 4, present with zero scene-side removals. Confirmed in the **deployed** `bin/index.js`, which contains the minified container with the define already substituted (`let n=…,l=745,t=Math.max(n,l>0?l+1:0)`).
- **One further slot per scene-side removal** thereafter.

Measured against the real installed allocator:

```
phase 1 (no scene removals): 4 reserved of 20   <- the standing head start
phase 2 (10 removals, 30 allocations): 7 reserved of 30
```

---

## Minimal executable repro

No runtime, no world — just the SDK:

```
scene pool at boot:        512 (#512 v0), 513 (#513 v0), 514 (#514 v0)
after host DELETE_ENTITY(#32 v0) + one scene-side removeEntity:
>>> engine.addEntity() ->  65568 (#32 v1)
>>> in host reserved range (<512)? true
>>> in host AVATAR range [32,256)? true
player B gets host avatar entity 65568 (#32 v1) === scene entity? true
```

`65568` is the exact ID from our original field report (`Reused entity 32 version 1 (id: 65568)`).

Defect (3) as its own repro — note zero CRDT involvement:

```
removeEntity(196640 (n=32, v=3)) -> true
   guard is `packed < 512`; packed = 196640 -> guard PASSES
>>> generateEntity() -> 262176 (n=32, v=4) | RESERVED? true
>>> reserved number entered the free list with ZERO inbound CRDT
```

Over 5000 randomized alloc/remove ops, 7 seeded reserved numbers produced **244** reserved-range allocations, versions climbing to 24–45.

---

## Consequences, by component

Once a scene entity and a live avatar share an ID:

**Scene → host writes are dropped with no correction.** `isDeniedSceneCrdtOp` (`scene-crdt-guard.ts:33-39`) denies component ops on `[32, 256)` and `DELETE_ENTITY` on `[0, 512)`. Unlike a normal LWW rejection, nothing is written back, so the scene is never told and never re-converges. The object exists and ticks server-side while being **invisible on every client**.

**`engine.removeEntity()` on such an ID erases a live player from the scene's world model.** Verified end-to-end:

```
=== scene calls engine.removeEntity( 65571 (#35 v1) ) on the LIVE player ===
   outbound: type=2 entity=65571 component=1, type=2 entity=65571 component=1089, type=3 entity=65571
   players visible to getEntitiesWith(PlayerIdentityData, Transform): 0
   after 8 more host Transform packets:
     Transform          -> back (y=82)
     PlayerIdentityData -> STILL GONE
```

`PlayerIdentityData` is sent **once per peer** (`dumpCrdtDeltas` skips entities whose `updatedAtTick <= fromTick`, `last-write-win-element-set.ts:246-248`), so it never returns. The player becomes a moving Transform with no identity — invisible to every `getEntitiesWith(PlayerIdentityData, …)` query. In a scene where all proximity decisions run through one such lookup, that player can no longer pick up, steal, be hit, or anchor a beacon. Recovery needs either that peer reconnecting (they are allocated a fresh packed id the scene holds no purged state for) or the scene's subscription being recreated (`createSubscription` seeds every component cursor at `-1`, so the next `getUpdates` pushes a full snapshot). Neither happens on its own during a session.

**Which component dies depends on the interleaving, and `Transform` is not always the lucky one.** `entityDeleted` clears `data` and `lastSentData` but never `timestamps`, so if the scene held the id *first* and wrote it before the runtime reissued it, the runtime's `Transform` PUTs lose until its own timestamp climbs past the one the scene left behind — roughly one host packet per scene write. Measured, with 7 scene writes:

```
scene allocated 655395 (#35 v10)   <- 7 writes, retained timestamp = 7
  host Transform ts=1 -> ABSENT
  host Transform ts=3 -> ABSENT
  host Transform ts=9 -> 59        <- recovers only here
```

That is ~270 ms of blank position for 7 writes, and the ratio is ~1:1 — an in-flight projectile writing at 30 Hz for ten seconds blanks that player's position for ~ten seconds, and a scene that keeps writing the id blanks it indefinitely. Either ordering surfaces as `no position for <addr>`, which is the 84-occurrence rejection in the log above.

---

## Reading the `Blocked scene CRDT op` log lines

Useful taxonomy, because the three types carry very different evidential weight. All are throttled to 1/s globally with a suppressed count (`scene-context.ts:410-424`).

| Type | Meaning | What it proves |
|---|---|---|
| **`type=3`** DELETE_ENTITY | Only the scene's own `engine.removeEntity()` can emit this. Host `DELETE_ENTITY`s are echo-suppressed (`crdt/index.ts:215`), and reserved IDs at version 0 fail the container guard so emit nothing. | **Conclusive** — the scene owns an avatar-range ID. |
| **`type=1`** PUT_COMPONENT | The scene wrote a component to an ID it believes it owns. | **Conclusive.** |
| **`type=2`** DELETE_COMPONENT | *Ambiguous — do not use as evidence.* A host `DELETE_ENTITY` for a departing peer makes the scene auto-emit these: `crdt/index.ts:151` calls `entityDeleted(entity, markAsDirty=true)`, dirtying every component that held data, and the same tick flushes a `DELETE_COMPONENT` for each. Reproduced: a host `DELETE_ENTITY` on avatar `#35 v0` yields `type=2 … component=1, component=1089, component=1087` with the scene doing nothing at all. | Nothing. Ordinary disconnect noise. |

`component=1` is `Transform`, `1087` is `AvatarBase`, `1089` is `PlayerIdentityData`. `entity=` prints the **packed** ID, not the entity number, so a large value is not evidence of a scene-range entity: `#32 v21` prints as `1376288`.

---

## Production evidence (`flagtag.dcl.eth`, 2026-08-15, 2 h 55 m)

**1. Direction of causation — the scene allocated the ID before the runtime minted it.**

```
22:00:21.417  Reused entity 32 version 20 (id: 1310752) for 0xac28e3…   <- runtime: #32 is at v20
22:01:50.006  💣⚠️ Replaced dead bomb pool entity at slot 0             <- scene: engine.addEntity()
22:01:50.006  💣 Bomb dropped by 0x1e93e5 at 361.7 50.4 298.6
22:01:53.063  [STDERR] Blocked scene CRDT op … type=1 entity=1376288 component=1
22:01:53.063  💣 Bomb exploded at 361.7 50.5 298.6 — victims: 1
22:01:58.820  Reused entity 32 version 21 (id: 1376288) for 0x5c61f3…   <- runtime mints THE SAME ID, 5.7s LATER
22:02:09.126  [PEER_DISCONNECTED] { address: '0x5c61f3…' }
22:02:44.142  💣⚠️ Replaced dead bomb pool entity at slot 0             <- pool entity dead again
```

The scene wrote `Transform` to `#32 v21` **5.7 seconds before the runtime ever allocated that ID**. This cannot be the scene reacting to an avatar. The bomb dealt damage server-side while no client received its Transform. Then the peer's departure deleted the shared ID, killing the pool entity again.

**2. Silent player removal, at population scale.** Of 223 `Player left` events, 16 have no `[PEER_DISCONNECTED]` within the preceding 3 s. **15 of those 16 land in the same millisecond as a blocked CRDT op** (the 16th is the first line after a log-capture blackout). **Zero occur without one.** Dose-response on the round-end cleanup that calls `engine.removeEntity`: boundaries producing a blocked op cleaned a mean of 2.86 entities vs 1.75 for those that didn't; 6/6 boundaries cleaning ≥4 produced one, 2/7 cleaning exactly 1 did.

**3. The breakage is total and permanent.** 13 identifiable victims. **13/13 had zero position-dependent successes after their wipe** — no trap drop, no pickup accept, no steal, no coin — over windows up to **1438 s**. **0/13 recovered.** Of the 7 who kept playing, 7/7 broke. Example:

```
21:39:59.163  🚩 Proximity steal: 0xe19d6d <- 0x9b9c1c | carrierPos= (416.9,52.4,363.7)   <- last good position
21:40:00.020  ⏰ Round end!
21:40:00.021  Cleaned up 6 hold-time entities for disconnected players
21:40:00.054  [STDERR] Blocked scene CRDT op … type=2 entity=589860 component=1 (+4 suppressed)
21:40:00.054  Player left: Sage Raveneye session: 956 s        <- server drops them; client keeps playing
21:40:25.480  ⚠️ handlePickup REJECT: no position for 0xe19d6d  <- and never works again
21:42:59.107  [PEER_DISCONNECTED] { address: '0xe19d6d…' }      <- REAL disconnect, 2m59s later
```

`0xe19d6d` was the round winner. Entity `589860` = `#36 v9` — the entity in the blocked op.

**4. Slot churn.** 208 recycles across only 11 distinct slot numbers (`#32`–`#42`), versions to 40 — slot `#33` burned 40 generations in under 2 h. 222 disconnects; one flaky client contributed 42 % of them in 94 sessions of 8–13 s each.

---

## The fix

**Shipped in `@dcl/ecs@7.26.1-32160793830.commit-0b97733`** — all four items, plus a refinement we had missed: the three named static entities (`RootEntity`/`PlayerEntity`/`CameraEntity`) must still purge locally, because the renderer *does* apply scene deletes on those — that is how `InputModifier.deleteFrom(engine.PlayerEntity)` clears an input lock. The shipped `removeEntity` skips the purge for the avatar range only.

Patch in `packages/@dcl/ecs/src/engine/`:

1. **`entity.ts` — `generateEntity()`**: skip free-list entries whose number is `< reservedStaticEntities`.
2. **`entity.ts` — `removeEntity()`**: decompose before comparing; reject any reserved entity **number**, at any version.
3. **`entity.ts` — `updateRemovedEntity()` / `updateUsedEntity()`**: refuse reserved numbers, so the free list only ever holds numbers the container owns. Reserved numbers need no tombstone — `getEntityState` reports them as `Reserved` before it consults `removedEntities`, so `Removed` is unreachable for them.
4. **`engine/index.ts` — `removeEntity()`**: ask the container **first** and purge components only if it accepts. Without this, a refused removal still wipes the live player's components.

Fixing (2) alone is not sufficient — defect (1) is the load-bearing one, and (4) is what actually stops the player wipe.

Regression coverage is in `test/ecs/reserved-entity-range.spec.ts` (11 tests). It fails 5/11 against unpatched source and passes 11/11 patched, with no change to the rest of the suite (61 → 72 passing).

### Scene-side mitigation we shipped

`src/shared/reservedEntityGuard.ts` wraps `engine.addEntity`/`engine.removeEntity` and is imported first in `src/index.ts`. A reserved ID is **abandoned, never removed** — removing it would re-arm the slot at version+1 via defect (3) and make things worse. Counters surface in our 60 s `DIAG` line as `reservedIdsAbandoned` / `reservedRemovalsBlocked`, reported per interval.

**This is mitigation, not a fix, and we want to be precise about why — it bears on how urgent the SDK change is.** `Engine()` assigns `addEntity: partialEngine.addEntity`, a copied function reference, and hands `partialEngine` (not the public object) to `crdtSceneSystem`. So when an inbound `PUT_COMPONENT_NETWORK` names a network entity the VM has not seen, `systems/crdt/index.ts:145` calls `engine.addEntity()` and writes to the result at `:147`, entirely behind any property patch a scene can install. Every client hits that path for every `syncEntity`'d entity. **There is no reachable reference for a scene to wrap, so only the SDK fix closes it.**

That fix is now installed, so the guard is redundant on this SDK and both counters should read zero. It is kept for one release as a tripwire; removing it is a separate change.

Two corrections to earlier drafts of this section, in case they were read:

- Abandoning an ID does **not** permanently retire that `(number, version)` pair. The next inbound `DELETE_ENTITY` for that number deletes `usedEntities` entries for versions `0..v`, so the slot can be offered again at a higher version. The retry bound is sound for a different reason — it covers the whole reserved number space in one call.
- **"Counters at zero" is not a valid signal that the SDK was fixed.** The allocator only misbehaves while `entityCounter - 512 - usedEntities.size > 0`, and that quantity saturates to zero on its own once enough distinct slots have been consumed. A broken SDK and a fixed one both report zero from then on. The guard should be deleted on the installed `@dcl/ecs` version, not on a quiet counter.

---

## Scope: what this bug does *not* explain

Stated explicitly so nobody over-attributes to it.

- **Beacon detaching from the flag carrier.** Not decidable from a server log — the beacon is client-side and appears zero times. A likely independent cause is **ours**: `getCarrierWorldPos()` and `selectNewestPerAddress` pick the maximum *raw* entity ID, which is version-dominant rather than recency-dominant, so a corpse at `#40 v3` (196648) beats the live entity at `#32 v1` (65568). Since the runtime hands reconnecting players an arbitrary vacated slot, that misfires routinely. Filed separately; a client log would discriminate.
- **"Ghost turned invisible."** Not present in this session. `activeGhosts = 0` in **295/295** samples across both restarts on a single scene CID; `GHOST_DISABLED` has been set since 2026-08-13. If a ghost were live, the same mechanism would apply — `spawnGhost` uses `engine.addEntity()` with no range check — but this log cannot support that.
- **Entity-pool exhaustion.** Not present in this session either: `shellDenials = 0` across all 147 `DIAG` samples, and no exhaustion line of any kind. Earlier notes framing exhaustion as a symptom of this bug are not supported by this log.

---

## Instrumentation asks

Two changes would have turned our last inferential step into a direct observation:

1. **`HAMMURABI_DEBUG_ENTITY_PROVENANCE` should be on by default in world servers, or at least documented.** `scene-context.ts:83-103` logs `[ENTITY-PROVENANCE]` for every op on an entity number `< 512`. It was off; with it on, "the allocator returned an avatar ID" is logged rather than inferred.
2. **The 1 s guard-log throttle hid 69 of 92 ops** in this session. A per-batch entity-ID histogram, or a higher cap, would let us enumerate which components were wiped per victim instead of attributing some wipes to a suppressed op.

Also worth considering upstream: when the write guard denies a scene op on a reserved entity, consider writing a corrective message back the way a normal LWW rejection does. Silent denial is what lets a scene diverge from the host indefinitely with no signal.

---

## Contact

Ping ile in Discord or comment on the PR. Happy to reproduce live with server logs streaming.
