# Server Storage Architecture

How the Flag Tag server persists state to Decentraland's Server-Side Storage, why
it is layered the way it is, and which trade-offs were made deliberately. This
documents the storage overhaul of July 2026 (strict wrappers → consolidated
player docs → write-behind persistence).

## The constraints that shaped everything

1. **Storage round trips take ~2 seconds.** Every design decision below follows
   from this. A handler that awaits one read blocks a player interaction for 2s;
   a flow with five sequential calls blocks it for 10s.
2. **The SDK's raw `Storage` API swallows failures.** `Storage.get()` resolves
   `null` for *both* "key does not exist" and "request failed", so callers cannot
   tell a new player from an outage. `Storage.set()` never rejects — it resolves
   `false` on any service error. Code written naively against this API acknowledged
   purchases that were never stored, and re-persisted empty defaults over real
   data during outages (wallet wipes, leaderboard wipes, double-claimed daily
   blessings).
3. **The server can be torn down at any moment with no shutdown signal** (e.g.
   once the world empties). There is no "flush on exit" — durability must be
   continuous.
4. **The runtime does not guarantee `setTimeout`.** Anything time-based on the
   server (timeouts, retry backoff, debounce) must be driven by an engine system.
5. **One authoritative server instance per world.** There are no concurrent
   writers to a player's data, which is what makes memory-authoritative
   persistence (below) safe at all.
6. **The runtime allows at most 16 concurrent signed fetches**, shared by
   everything that talks to the storage service (`storageGet`/`storageSet` and
   the SDK's `EnvVar.get`) — and a timed-out request cannot be cancelled, so it
   keeps counting against that limit until the network stack gives up on it.

## Layering

```
domain code (economy, flagLogic, roundManager, leaderboard, analytics, persistence)
        │            │
        │      playerDoc.ts      ← per-player data: memory-authoritative, write-behind
        │            │
        └──── safeStorage.ts     ← the ONLY module that touches @dcl/sdk/server Storage
                     │
        Decentraland Server-Side Storage (signed fetch, key-value)
```

Nothing outside `safeStorage.ts` may call the raw SDK `Storage` API, and nothing
outside `playerDoc.ts` may read or write per-player keys.

## Layer 1 — `safeStorage.ts`: strict, bounded, ordered

| Change | Reason |
| --- | --- |
| **Strict reads.** `storageGet()` performs the signed fetch itself: HTTP 404 resolves `null` (the one definitive "key does not exist" signal); *any other* failure rejects — including a 2xx whose body lacks a **string** `value` (every value this codebase persists is a string, so a missing/`null`/non-string value is corruption, not absence). | Distinguishes "new player" from "outage". Read-modify-write callers must abort on rejection instead of writing defaults over real data — and a malformed success body must never masquerade as "definitively missing", which would trigger the player-doc legacy fallback. |
| **Strict writes.** `storageSet()` rejects on service error or timeout instead of resolving `false`. | Failures become visible to retry machinery instead of being silently dropped. |
| **Timeout raised 2s → 10s, as a hang detector.** Driven by `safeStorageSystem` (engine tick), not `setTimeout`. | At ~2s typical latency, a 2s timeout rejects healthy calls. The timeout exists only to convert a *wedged* connection (which otherwise hangs a handler forever) into a rejection. Latency-sensitivity is solved by not awaiting storage at all (Layer 2), never by tightening the timeout. |
| **Centralized read retry** — up to 3 attempts with 1s/2s backoff inside `storageGet()`. | Every call site needs the same policy; before this, call sites grew their own ad-hoc loops. Writes are deliberately **not** retried here — the pending/flush queues (Layer 2) own write retry, and a second retry layer could reorder writes. |
| **Concurrency cap tied to the RAW call's lifetime, with an orphan ledger** — at most 6 raw calls, FIFO queue. A slot frees when the underlying request *settles* (not when the caller's timeout abandons it). A request that never settles has its slot reclaimed after 60s so throughput can recover — but it moves to an **orphan ledger** that still counts against a hard cap of 12 (slots + orphans), so reclamation can never admit more total raw requests than the platform allows. Enforced, not assumed: permanently-hung orphans permanently consume capacity (they cannot be cancelled), throttling storage to cap-minus-orphans. Queue waits are bounded (a waiter with no slot within the timeout rejects, tagged as a timeout). The caller-facing timeout clock still starts only when a call is issued. | Boot and round end fan out heavily (see "Parallelism"), and constraint #6 caps signed fetches at 16 scene-wide. Releasing slots on *caller* timeout would let every timeout cycle replace hung fetches with new ones — bookkeeping says 6 while reality climbs past 16 during a hang. Bounded queue waits stop callers stranding silently behind hung slots — and feed the breaker, since a starved queue is evidence of a hung service. |
| **Circuit breaker** — after 3 consecutive timeouts (call *or* queue timeouts), new calls fail fast for a 15s cool-down. Re-checked when a queued waiter is granted a slot, so a pre-queued wave can't launch into an open breaker. Any response from the service (success *or* an HTTP error) proves it isn't hung and resets the count; breaker-open rejections never reached the service, so they neither count nor reset. | During a hang, fail-fast beats queueing: pending write queues keep their values and simply retry after the cool-down, and interactive callers degrade immediately instead of stacking up for tens of seconds. |
| **Per-key late-write repair.** Every `storageSet` records a per-key sequence and latest value; if an old write settles successfully *after* a newer write was issued for the same key, the newest value is re-issued. | A timed-out write can still complete inside the storage layer and land *after* a newer write, silently leaving stale data. Residual gap (documented in the header): a write whose HTTP response is lost never settles JS-side, so no repair fires for it — the stale value stands until the next write for that key. |
| **`storageDelay(ms)`** — engine-tick-driven delay helper. | Retry backoff needs a timer and `setTimeout` isn't guaranteed to exist. |

## Layer 2 — `playerDoc.ts`: memory-authoritative, write-behind, one doc per player

### The change

Per-player data used to live in five keys (`coins:{addr}`, `upgrades:{addr}`,
`lifetimeWins:{addr}`, `lifetimeHoldTime:{addr}`, `blessing:{addr}`), read lazily
on first use and written key-by-key, with several paths *awaiting* the write
before responding to the client. It now lives in **one document**:

```jsonc
// key: player:{addr}
{
  "v": 1,
  "coins": 900,
  "upgrades": "{...}",   // serialized UpgradeData, same format as the legacy key
  "wins": 12,
  "holdTime": 3541.2,
  "blessing": "2026-07-20" // date of last claimed daily blessing, '' if never
}
```

- **Hydration at join.** `playerTracking` calls `ensurePlayerHydrated()` the
  moment a player connects; one read fills all the in-memory caches. By the time
  the player opens the store or steps on the blessing pedestal, every handler
  answers from memory. Hydration is strict (rejects rather than defaults) and
  concurrent callers share a single in-flight promise; a failed hydration
  self-clears so the next handler retries it. Multi-field request handlers
  (`requestUpgrades`) hydrate **once** per request and then degrade all fields
  together — per-field retries would multiply a full hydration-retry budget per
  displayed field during an outage.
- **Corrupt docs never fall back to legacy keys.** If `player:{addr}` *exists*
  but is unparseable, has an unsupported version, or fails deep validation —
  missing/mistyped/negative numeric fields, or an upgrades payload that doesn't
  parse to the expected shape (parseUpgrades silently substitutes defaults,
  which would wipe owned items on the next flush) — hydration FAILS and the doc
  is left untouched for diagnosis. The legacy keys froze at migration time —
  falling back to them would silently roll the player back to pre-migration
  state, and the next flush would overwrite the (possibly recoverable) doc with
  it. Legacy fallback happens only when storage definitively reports the doc
  absent (404).
- **Two write modes.**
  - *Write-behind* (`markPlayerDirty`): mutations update the caches, snapshot the
    assembled doc into a pending map, and flush asynchronously through a
    per-player chain. Handlers respond the moment memory commits. Death
    penalties, round awards, and lifetime stats flush immediately; the
    high-frequency +1 coin-pickup path is debounced (trailing write within 5s).
    Failed flushes stay pending and are retried every `coinServerSystem` tick;
    disconnect force-flushes. Flushes coalesce to at most one ACTIVE write plus
    one TRAILING attempt per player (the trailing attempt reads the pending
    snapshot at execution time, so it always carries the newest state) — a
    write slower than the retry interval therefore can't accumulate a backlog.
  - *Transactional* (`commitPlayerDocTx`): for purchases and blessings. Applies a
    **synchronous** multi-field mutation, snapshots the doc exactly once — so
    storage can never observe a partial state like "coins deducted, item not
    owned" (a subtle hazard: an `await` between two dirty-marks lets the first
    flush capture the half-mutated doc) — and resolves only when the write
    durably landed. On failure the mutation is rolled back field-wise (concurrent
    writers, e.g. a round-end lifetime update, win over the rollback), the
    pending snapshot is re-assembled from the rolled-back caches, and a
    **compensating write is awaited before failure is reported** — a timed-out
    write can still land late with the aborted transaction, so the failure the
    client hears is only sent once the rollback is durable. If the compensation
    *also* fails, the outcome is genuinely indeterminate and is treated as such:
    the error is tagged (`PlayerDocTxError.indeterminate`), the player's failure
    message says the purchase state is uncertain rather than cleanly failed, and
    **new transactions for that player are refused** until the retrying flusher
    durably lands the rollback (at which point even a late-landing aborted write
    is covered by the late-write repair, since a newer write now exists). The
    one irreducible residual: a teardown before any retry lands can resurrect
    the aborted-but-consistent transaction. Cost: a purchase takes ~one storage
    round trip (~2s) before `buyResult`, up to two on the failure path —
    accepted so that a confirmed purchase can never be lost or half-persisted,
    and a reported outcome is never a silent lie.
- **Snapshot semantics.** The pending map holds serialized doc *values*, never
  cache references — `playerTracking` deletes the caches on disconnect *before*
  the final flush lands, and re-hydration prefers the pending snapshot so a quick
  rejoin can never read stale storage past an in-flight flush.

### The reasons

| Reason | Detail |
| --- | --- |
| **Round trips, not payload, are the cost.** | Five keys = five ~2s reads before a player's first purchase. One doc = one. The legacy fallback (below) reads the five keys in *parallel* — one trip's latency even for unmigrated players. |
| **Interactive latency.** | A buy used to be up to three sequential reads + two awaited writes (~10s worst case) before `buyResult`. Now it's a single durable doc write (~2s) — and every non-transactional interaction (wallet reads, equips, displays, blessing checks) is memory-speed. |
| **Atomicity.** | A purchase's coin deduction and item grant — and a blessing's award and used-marker — land in ONE write. The old per-key model had a real window where the deduction persisted but the item write failed (paid-but-no-item), or a blessing awarded coins without marking itself used. |
| **Uniform write retry.** | Before, balances and upgrades had pending/retry queues but lifetime wins/hold time silently swallowed failed writes. The doc flush gives every stat the same retry path. |

### Durability by value class (revised after review)

Purchases and blessings were briefly shipped as pure write-behind (acknowledged
before durability). Review flagged two problems: acknowledgment before a durable
write meant a teardown-during-outage could lose a *confirmed* purchase, and the
`await` between the balance and upgrades mutations let the first flush capture a
partial "coins deducted, item not owned" doc. Both were fixed by
`commitPlayerDocTx` (see "Two write modes" above): buys and blessings now pay
~one storage round trip of latency and are acknowledged only after the single,
complete doc write lands, with field-wise rollback on failure. Everything
high-frequency or low-stakes (coin pickups, death penalties, round awards,
lifetime stats) remains write-behind with pending retry.

### Accepted trade-off: the migration is ONE-WAY (decision: keep it)

On a player's first hydration after this change, the code reads their five legacy
keys once, writes the consolidated doc, and **never writes the legacy keys
again**. The legacy keys stay in storage, frozen at their pre-migration values.

Consequence, spelled out: code from *before* this change knows nothing about
`player:` docs — it reads the frozen legacy keys. Rolling a deploy back past this
change resurrects week-old balances/items/stats for every player who played in
between, and the rolled-back code then writes fresh progress into the legacy keys,
making the two copies diverge further with every direction switch.

**Operational rule: never roll back past the doc migration.** Reverting later,
unrelated commits while keeping `playerDoc.ts` is completely safe. Alternatives
were considered and rejected: transitional dual-writing (five extra writes per
flush — defeats the consolidation against a ~2s service), and an offline
backfill job (no such runtime exists here). A break-glass export routine
(enumerate `player:` docs via `Storage.getValues({ prefix: 'player:' })` and
rewrite legacy keys before a planned rollback) can be written on demand if a
rollback is ever truly required.

## Scene-level data: strict read-modify-write with gating

Scene-level keys (leaderboards, flag state, visitor data) don't fit the player-doc
model but follow the same strictness rules:

- **All-time leaderboard** is strict read-modify-write at round end: read from
  storage (null only if the key has never existed), increment, persist. A failed
  read aborts the update for that round — it never substitutes `[]`, because
  persisting an empty fallback would wipe the entire history.
- **Daily leaderboard** has a *loaded flag* (`isDailyLeaderboardLoaded`,
  `leaderboard.ts`). If the boot-time seed fails, the synced board starts empty
  for display but round-end persistence stays **disabled** until a strict recovery
  read succeeds — booting with a false-empty `[]` and persisting increments
  computed from it was a daily-board wipe.
- **The midnight reset gates the daily update.** If the reset check fails at a
  midnight-crossing round end, the daily update is skipped for that round (the
  synced board may still hold yesterday's entries — updating it would mix days).
  The all-time update runs in its own independent block either way.
- **Flag state** writes are serialized through a single chain
  (`persistence.ts`) so the many fire-and-forget callers (pickup, drop, steal,
  gravity landing) can't land out of order.

## Parallelism (why the concurrency cap exists)

With calls at ~2s each, sequential awaits dominated two paths:

- **Boot** used to run ~10 storage loads strictly in sequence (~20s to ready).
  It now runs three phases with the independent loads concurrent:
  env/webhooks → flag state ∥ player names → (leaderboards + reset check) ∥
  visitor data, with the two leaderboard keys also read concurrently.
- **Round end** used to loop players sequentially for coin awards, lifetime
  wins, hold time, and stats pushes — ~2s per departed player *per step*. It now
  runs one pipeline per player (order preserved *within* a player: win → hold
  time → stats push reads post-update values), all players concurrent.

The `safeStorage` cap (6 in-flight, FIFO) is what makes this fan-out safe.

## Durability tiers (what an abrupt teardown can lose)

| Data | Worst-case loss window |
| --- | --- |
| Buys, blessings | **None once acknowledged** — success is only reported after the durable write lands (`commitPlayerDocTx`); failures roll back and report failure |
| Coin pickups (+1s) | Up to 5s of pickups (debounced flush) — unchanged from the old design |
| Death penalties, round awards | ~One storage round trip (immediate write-behind flush; retried on failure; force-flushed on disconnect) |
| Lifetime wins / hold time | Same as above (previously: silently lost forever on a failed write) |
| Leaderboards, flag state, visitor data | One round-end / one flush interval; strict RMW prevents *wipes*, so failures lose at most that round's increment |

## Storage key inventory

| Key | Writer | Notes |
| --- | --- | --- |
| `player:{addr}` | `playerDoc.ts` | Live consolidated per-player doc (v1) — the only per-player key still written |
| `coins:{addr}`, `upgrades:{addr}`, `lifetimeWins:{addr}`, `lifetimeHoldTime:{addr}`, `blessing:{addr}` | *(frozen)* | Legacy per-stat keys; read once per player as migration fallback, never written again |
| `flagState` | `persistence.ts` | Serialized single-chain writes |
| `leaderboard` | `persistence.ts` (via round end / reset / name patch) | Daily board, full format; persistence gated by the loaded flag |
| `allTimeLeaderboard` | `persistence.ts` (via round end / name patch) | Full format; strict RMW; compact `{n,w}` copy syncs via CRDT only |
| `monthlyLeaderboard` | `persistence.ts` | |
| `lastLeaderboardResetDay` | `leaderboard.ts` | Midnight-reset bookkeeping |
| `playerNames` | `persistence.ts` | Sanitized display-name directory |
| `visitorData`, `lastVisitorResetDay` | `persistence.ts` / `analytics.ts` | Daily visitor sessions |
| `monthlyVisitorData`, `monthlyVisitorResetMonth` | `analytics.ts` | Monthly visitor sessions |
