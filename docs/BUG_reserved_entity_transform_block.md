# Bug: Runtime blocks Transform writes on recycled avatar entity slots, freezing server-side view of new occupant

**Filed by:** Flag Tag team (ile)
**Date:** 2026-08-15
**Confirmed on SDK:** `@dcl/sdk@7.26.1-31714079767.commit-96e9a29` (auth-server dist-tag)
**Also observed on:** `@dcl/sdk@7.24.6-29505165911.commit-d270434`
**Severity:** High — breaks position-based gameplay (proximity damage, targeting, action origin) for any player assigned a recycled avatar slot.

---

## TL;DR

When a peer disconnects, the runtime begins emitting `[SceneContext] Blocked scene CRDT op on reserved entity: type=1 entity=<id> component=1` at 30 Hz against that peer's avatar entity slot, and continues emitting it **after the slot is reassigned to a new peer**. The new peer's Transform writes are silently dropped by the runtime. The authoritative server-side scene code reads the frozen last-known Transform for the new peer, so every position-based system (proximity triggers, damage, targeting, action-origin validation) treats them as a phantom at the previous occupant's last coordinates.

`type=1 component=1` = Transform. The block persists across sessions (the same reserved entity id can carry the frozen Transform through multiple round-trips of the address).

---

## Repro (minimum viable)

1. Player A joins the scene. Runtime assigns avatar entity slot `E` (e.g. `65568`, `262177`).
2. Player A moves around, then disconnects.
3. From the moment A disconnects, `Blocked scene CRDT op on reserved entity: type=1 entity=E component=1` starts firing at 30 Hz.
4. Player B joins. Runtime logs `Reused entity <n> version <v> (id: E) for <B_address>` — B is assigned the **same** slot `E`.
5. B's client sends Transform updates for their real position, but the runtime's block continues; the scene's local CRDT view of entity `E` remains frozen at A's last known Transform.
6. Any position-based gameplay against B now uses A's frozen coordinates.

In our scene we detect step 4 with a tripwire that fires once per address on join:

```
[Server] ♻️ avatar entity is a RECYCLED slot: 0x874b9d | 262177 (#33 v4) — cross-wire risk, positions for this address may be wrong
```

`#33 v4` = version 4 of entity slot 33 → this slot has been recycled at least 4 times.

---

## Observable symptoms in gameplay

All of the following have been observed in production sessions. Each one traces to a server-side proximity check (or client-side visual read) against the recycled-slot player's frozen phantom Transform.

- **"Invisible ghost" kills anyone who joins.** A ghost NPC spawned near the phantom position of a recycled-slot player triggers proximity damage against every new joiner who inherits that slot — because the server sees them standing on top of the ghost, regardless of where they actually are.
- **Bombs proximity-trigger against phantoms.** A bomb dropped anywhere on the map is instantly triggered "by" the recycled-slot player, from ~30 ms after the drop, regardless of the ~real distance between attacker and phantom.
- **Traps/bananas dropped by the phantom.** When the recycled-slot player themself tries to act, our server-side `Client action position rejected (too far from server view)` fires because the client-reported position (real) doesn't match the server-view Transform (phantom). We fall back to a sentinel `(0, -500, 0)` drop, which is harmless-but-visible in logs.
- **Projectiles targeting phantoms.** Same class — auto-aim or proximity-hit checks land on the phantom instead of the real player.
- **Beacon (client-side visual) anchors to phantom.** Observers see the flag beacon disconnected from the actual flag carrier, drifting to some far coordinate, then snapping back when the carrier drops the flag (the drop path reads authoritative flag fields, not the carrier lookup).
- **`ghostServerSystem error: [mutable] Component core::Transform for <reserved_id>`** — when the ghost's own entity id collides with a reserved/blocked slot, `Transform.getMutable` throws every tick and log-spams thousands of stack traces.
- **Projectile / trap / bomb entity pools silently exhaust after long uptime (added 2026-08-15).** Server pre-creates a fixed pool of 30 projectile entities (and similar for traps/bombs) at startup, holding entity id references for the world's lifetime. Every peer reconnect burns a new version of the same avatar slot ids (`Reused entity 32 version 1 → v2 → v3 …`). After enough version churn, a recycled avatar's packed `(slot, version)` `Entity` id numerically **collides** with a pool-held id. From then on, `Transform.has(poolEntity)` still returns true (it's now pointing at the live avatar), so the self-heal path never triggers — but scene-side `Transform.getMutable(poolEntity).position = spawnPos` writes are dropped by the reservation block, so the projectile never moves. The pool slot appears "in use" forever from the pool's perspective, `activeProjectiles.length` stays at 0, and eventually every acquire returns null with `🎯 Projectile entity pool exhausted!` — no player can throw a boomerang until the server process is restarted. Same failure mode almost certainly applies to the trap and bomb pools on long-uptime worlds. Diagnostic dump added in `acquireProjectileEntity` on 2026-08-15 to capture the pool state (per-slot entity id, Transform-present flag, in-use flag) the next time it recurs.

The recovery window is typically 15–30 seconds after join, during which the new peer's actions are all rejected and any incoming proximity fires against the phantom. In some sessions the block never clears within the peer's session lifetime. **Pool-exhaustion class symptoms do not self-recover — they require a server restart.**

---

## Log snippets

### 1. Ghost death-loop (2026-08-13, pre-mitigation)

Two players joined, one disconnected, ghost spawned near their frozen position, second joiner was assigned the same slot and died on repeat:

```
20:54:20  Schneeflocke (0x5c61f3) joins → gets avatar entity 65568
20:54:27  Schneeflocke disconnects (6s session)
20:54:30  🧟 Ghost spawned at 347 49.25 381
20:54:30  [STDERR] [SceneContext] Blocked scene CRDT op on reserved entity: type=1 entity=65568 component=1
20:54:30  [STDERR] [SceneContext] Blocked scene CRDT op on reserved entity: type=1 entity=65568 component=1 (+30 suppressed since last log)
          ... [continues at 30 Hz for 17 seconds while nobody owns 65568] ...
20:54:47  ile (0x1e93e5) joins → Reused entity 32 version 1 (id: 65568) for 0x1e93e5
20:54:47  ♻️ RECYCLED slot: 0x1e93e5 | 65568 (#32 v1) — cross-wire risk
20:54:51  ⚠️ Client action position rejected (too far from server view) for 0x1e93e5
20:54:51+ 💀 Death penalty: 0x1e93e5 lost 10 coins  ← every 3–8 seconds, forever
20:54:51+ 👻 ghostTouching diag (30s): sent= 130 | throttled= 781 | activeVictims= 1
```

ile took 20+ death penalties in ~90s while standing still. Every `sceneRuntime.sendMessage` for a real action was rejected as `too far from server view`.

### 2. Same class, on latest `auth-server` SDK (2026-08-15)

Confirmed the platform bug is unchanged after upgrading from `commit-d270434` (months old) to `commit-96e9a29` (current `auth-server` tag).

Bomb dropped by ile, triggered 33 ms later "by" tester (recycled-slot player) at a location tester was not standing at:

```
01:30:34  💣 Bomb dropped by 0x1e93e5 at 368.0 98.5 384.7
          [STDERR] [SceneContext] Blocked scene CRDT op on reserved entity: type=1 entity=262177 component=1
          [STDERR] (+30 suppressed since last log)   ← 30Hz block continues
01:30:55  Reused entity 33 version 4 (id: 262177) for 0x874b9d062b060e004c3167974c42f5e6878fae0c
01:30:55  ♻️ RECYCLED slot: 0x874b9d | 262177 (#33 v4) — cross-wire risk
01:30:59  🪤 requestBanana from 0x874b9d
01:30:59  ⚠️ Client action position rejected (too far from server view) for 0x874b9d
01:30:59  🪤 Trap dropped by 0x874b9d at 0.0 -500.2 0.0   ← sentinel fallback
01:31:02  ⚠️ Client action position rejected (too far from server view) for 0x874b9d
01:31:05  ⚠️ Client action position rejected (too far from server view) for 0x874b9d
01:31:11  ⚠️ Client action position rejected (too far from server view) for 0x874b9d
01:31:21  🪤 Trap dropped by 0x874b9d at 328.0 68.1 385.4   ← 22s after join, real pos finally lands
```

Later in the same session, bombs proximity-fire on the phantom:

```
01:32:53.195  💣 Bomb dropped by 0x1e93e5 at 384.7 55.4 343.8
01:32:53.228  💣 Bomb proximity triggered by 0x874b9d           ← 33ms after drop
01:32:53.228  🛡️ Bomb ignored — player has flag immunity
01:32:53.228  💣 Bomb exploded at 384.7 55.4 343.8 — victims: 1

01:33:03.647  💣 Bomb dropped by 0x1e93e5 at 337.3 60.4 362.0
01:33:03.679  💣 Bomb proximity triggered by 0x874b9d           ← 32ms after drop
01:33:03.679  💣 Bomb victim was carrying flag — forcing drop!
01:33:03.679  💣 Bomb exploded at 337.3 60.4 362.0 — victims: 2
```

The `Blocked scene CRDT op on reserved entity: type=1 entity=262177` warnings continue firing throughout both events.

### 3. `ghostServerSystem` crash from reserved-slot collision

When a ghost entity's own id lands on a reserved/blocked slot:

```
[STDERR] [09:12:30 PM] ❌ [Server] ❌ ghostServerSystem error: Error: [mutable] Component core::Transform for 6556…
[STDERR]     at Object.getMutable (bin/index.js:1:240258)
[STDERR]     at cH (bin/index.js:2:175121)
[STDERR]     at Object.fn (bin/index.js:2:192071)
[STDERR]     at Object.o [as update] (bin/index.js:1:249188)
[STDERR]     at async r9e (bin/index.js:22:111974)
```

Fires every frame until the ghost is removed.

---

## What we tried on the scene side

### `selectNewestPerAddress` in `getPlayerPosition`

The scene-side `getPlayerPosition(address)` iterates `PlayerIdentityData` entities matching an address and returns the newest by entity id (highest = latest reissue). This handles the case where the CRDT holds duplicate identity entities for the same address; it does **not** help when there is only one identity for the address (the recycled slot) and its Transform is frozen by the runtime block.

```ts
let bestEntity: Entity | null = null
for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
  if (identity.address.toLowerCase() === needle) {
    if (bestEntity === null || (entity as number) > (bestEntity as number)) bestEntity = entity
  }
}
if (bestEntity === null) return null
return Transform.get(bestEntity).position
```

### Tripwire diagnostics

We added a 1 Hz sweep (`sweepDuplicateIdentities`) that edge-triggers on three signatures:
- Address with more than one `PlayerIdentityData` entity
- Recycled/reissued avatar entity id (the trigger)
- Two addresses whose Transforms move as one (the symptom)

These give us hard timestamps for when the runtime bug fires vs. when downstream gameplay breaks.

### Ghost kill-switch + `Transform.getMutable` try/catch

To stop the "invisible ghost kills everyone" symptom and the tick-crash log-spam:

```ts
const GHOST_DISABLED = true   // temporary until platform fix
// ...
try {
  const t = Transform.getMutable(z.entity)
  t.position = Vector3.create(z.posX, z.posY, z.posZ)
} catch (err) {
  console.error('[Server] 🧟 Transform.getMutable failed on ghost entity', z.entity, '— skipping frame:', err)
  continue
}
```

Deployed 2026-08-13. Since then no ghost-related deaths, no `ghostServerSystem error` spam. Bomb / projectile / beacon symptoms remain because they don't go through this code path.

### Client-action position guard

Server-side `too far from server view` rejection prevents phantom-origin traps and bombs from the *acting* recycled-slot player, but does not help when the recycled-slot player is a *victim* of another player's action (bomb proximity, projectile hit search, etc.).

---

## What we deliberately did NOT patch

We considered adding a "staleness guard" to `getPlayerPosition` — return `null` if the chosen identity's Transform hasn't changed in >N seconds while the identity is present. We chose **not** to ship this because:

1. It's a symptom fix that would hide the exact platform behavior you need to see.
2. It converts wrong-target damage into silent "action denied" behavior, which is harder to diagnose in the wild.
3. We'd rather leave the raw failure visible so we (and you) can verify a fix at the platform level actually lands.

We're happy to add this at any point if you'd like a temporary mitigation while a proper fix is in flight.

---

## Suspected root cause (guess, please correct)

Two hypotheses, not mutually exclusive:

1. **Reserved-entity accounting bug.** The runtime marks the avatar entity as "reserved" on peer disconnect and starts blocking scene CRDT ops against it. When the slot is reused for a new peer, the reservation isn't cleared, so writes from the new peer's Transform stream are dropped by the same block.
2. **Ownership handoff race.** New peer's `PlayerIdentityData` is created on the reused entity id before the previous owner's Transform ownership is released. The scene sees the address change but reads the Transform that was locked in by the previous owner and never overwritten.

The 30 Hz cadence of the block message is suspicious — it looks like a per-tick CRDT reconciliation loop that keeps rejecting the same op class rather than clearing state and moving on.

---

## Environment / reproducibility

- **World:** `flagtag.dcl.eth` (production) and `baskervill.dcl.eth` (test)
- **Client:** Both native Windows explorer and web (`play.decentraland.org`) observed the same server-side symptoms.
- **Peers:** Both desktop and mobile peers trigger the recycled-slot condition. Mobile peers appeared *more* likely to hit it in our sessions, possibly due to shorter/flakier session lifetimes.
- **Frequency:** In multi-session testing, roughly 30–50% of reconnects into an active world assign a recycled slot with the block already in flight. Once assigned, the phantom-position window lasts 15–30s typically, sometimes for the entire session.

---

## Contact

Ping ile in Discord or drop a comment on the PR when you have a repro on your side. Happy to jump on a call and reproduce live with server logs streaming.
