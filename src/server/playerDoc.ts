/**
 * playerDoc.ts — consolidated per-player persistence (memory-authoritative).
 *
 * The storage service takes ~2s per round trip, so per-stat keys (coins:x,
 * upgrades:x, lifetimeWins:x, lifetimeHoldTime:x, blessing:x) cost one trip EACH —
 * five reads before a player's first purchase and one write per stat mutated.
 * This module makes the in-memory caches (serverState) authoritative and persists
 * ONE `player:{addr}` document per player behind them:
 *
 * - ensurePlayerHydrated() loads the doc once — kicked off at JOIN time from
 *   playerTracking so every later handler answers from memory. Players who
 *   predate the doc fall back to the legacy per-stat keys, read in PARALLEL
 *   (one trip's latency instead of five), and are migrated forward by writing
 *   the doc. Hydration is strict: it rejects on storage failure (callers abort
 *   rather than default) and is retried on the next call.
 * - Mutations update the caches, then the doc is snapshotted into pendingDocs
 *   (values, not cache references — playerTracking deletes the caches on
 *   disconnect BEFORE the final flush lands) and flushed through a per-player
 *   chain: debounced for high-frequency coin pickups, immediate write-behind for
 *   penalties/awards/lifetime stats, and transactional (commitPlayerDocTx) for
 *   purchases and blessings. All of a player's stats live in one doc, so a
 *   purchase's coin deduction and item grant — or a blessing's award and
 *   used-marker — are snapshotted together and hit storage ATOMICALLY, which the
 *   old per-key writes never were.
 * - Failed flushes stay pending and retry from coinServerSystem
 *   (flushDuePlayerDocs). Re-hydration prefers pendingDocs over storage, so a
 *   quick rejoin can never read stale data past an in-flight flush.
 *
 * Two write modes:
 * - markPlayerDirty(): fire-and-forget write-behind, for value where a ~2s
 *   teardown window is acceptable (coin pickups, death penalties, round awards,
 *   lifetime stats).
 * - commitPlayerDocTx(): TRANSACTIONAL — applies a synchronous multi-field
 *   mutation, snapshots the doc exactly once (so no partial intermediate doc can
 *   ever hit storage), and resolves only when the write durably landed. On
 *   failure it rolls the mutation back field-wise and rejects, so the caller
 *   reports failure instead of acknowledging state that may never persist.
 *   Purchases and blessings use this; they accept one storage round trip of
 *   latency in exchange for never confirming a lost or partial transaction.
 *
 * Full architecture rationale, durability tiers, and the rollback policy for the
 * one-way legacy-key migration: docs/STORAGE.md.
 */
import { storageGet, storageSet } from './safeStorage'
import {
  playerCoinBalances, playerUpgradeData,
  playerLifetimeWinsCache, playerLifetimeHoldTimeCache,
} from './serverState'
import { parseUpgrades, serializeUpgrades } from '../shared/upgrades'
import { MAX_COINS } from '../shared/coins'

interface PlayerDocV1 {
  v: 1
  coins: number
  /** Serialized UpgradeData — same format as the legacy `upgrades:` key. */
  upgrades: string
  wins: number
  holdTime: number
  /** YYYY-MM-DD of the last claimed blessing, '' if never. */
  blessing: string
}

const DOC_FLUSH_MIN_INTERVAL_MS = 5000

const hydratedPlayers = new Set<string>()
const hydrationPromises = new Map<string, Promise<void>>()
/** Last-blessing dates live here (not serverState) — they only exist for the doc. */
const playerBlessingDates = new Map<string, string>()

const pendingDocs = new Map<string, string>() // latest unpersisted serialized doc
const lastDocFlushMs = new Map<string, number>()
const docFlushChains = new Map<string, Promise<void>>()

/**
 * Thrown by commitPlayerDocTx when the transaction's outcome is INDETERMINATE:
 * the write timed out AND the compensating write failed, so the aborted
 * transaction might still persist if the server dies before a retry lands.
 * Callers should tell the player the state is uncertain instead of reporting a
 * clean failure.
 */
export interface PlayerDocTxError extends Error {
  indeterminate?: boolean
}

// Players whose transactional rollback is not yet durably confirmed (the
// compensating write failed). New transactions are refused for them until the
// retrying flusher lands ANY doc write — at that point the rollback is durable,
// and even a late-landing aborted write is covered by safeStorage's late-write
// repair (a newer write now exists for the key). Deliberately NOT cleared on
// disconnect: the indeterminacy outlives the session. Cleared in doWrite.
const unresolvedRollbacks = new Set<string>()

// The upgrades payload must PARSE and have the expected shape wherever fields
// are present: parseUpgrades silently substitutes defaults for anything
// malformed, so a corrupt-but-string payload would hydrate as defaults and the
// next flush would wipe the player's owned items. Absent fields are fine —
// '{}' is the legitimate serialization for a brand-new player.
// Owned-item lists must be arrays OF STRINGS — Array.isArray alone would accept
// [42, {}] and let corruption flow into ownership checks. Unknown-but-string ids
// are deliberately tolerated (ownership checks simply won't match them);
// validating against the store catalogs would couple this module to them.
function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isValidUpgradesJson(json: string): boolean {
  try {
    const data = JSON.parse(json) as Record<string, unknown> | null
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return false
    return (data.boomerangs === undefined || isStringArray(data.boomerangs))
      && (data.equipped === undefined || typeof data.equipped === 'string')
      && (data.tapes === undefined || isStringArray(data.tapes))
      && (data.equippedTape === undefined || data.equippedTape === null || typeof data.equippedTape === 'string')
      && (data.traps === undefined || isStringArray(data.traps))
      && (data.equippedTrap === undefined || typeof data.equippedTrap === 'string')
  } catch {
    return false
  }
}

// A v1 doc is only ever written complete (assembleDoc), so missing or mistyped
// fields mean truncation/corruption that happened to survive JSON.parse. Treat it
// exactly like unparseable JSON — refuse to hydrate, keep the doc for diagnosis.
// Silently defaulting would zero the player's balance and progression, and the
// next flush would persist those zeros over the real data. Negative and
// non-integer coins/wins get the same treatment: no writer in this codebase can
// produce them (every award path floors to integers, balances floor at 0), and
// they flow into Schemas.Int message fields where a 1.5 or 1e100 breaks
// serialization. holdTime is the one legitimately fractional field.
function isValidDocV1(doc: PlayerDocV1): boolean {
  return doc.v === 1
    && Number.isSafeInteger(doc.coins) && doc.coins >= 0
    && typeof doc.upgrades === 'string' && isValidUpgradesJson(doc.upgrades)
    && Number.isSafeInteger(doc.wins) && doc.wins >= 0
    && Number.isFinite(doc.holdTime) && doc.holdTime >= 0
    && typeof doc.blessing === 'string'
}

// Callers guarantee a valid doc: stored docs pass isValidDocV1 first, and the
// pendingDocs / legacy-migration paths construct the object themselves.
function applyDoc(key: string, doc: PlayerDocV1): void {
  // Cap-overage is CLAMPED rather than rejected: a stored balance can
  // legitimately exceed MAX_COINS if the cap is ever tuned downward, and
  // bricking hydration over a balance-tuning change would be far worse than
  // trimming the excess (it also bounds a corrupted-huge value's impact to a
  // one-time windfall of the cap). Integer-kind corruption is still rejected
  // upstream by isValidDocV1.
  if (doc.coins > MAX_COINS) {
    console.error('[PlayerDoc] Coins over MAX_COINS for', key.slice(0, 8), '(', doc.coins, ') — clamping to', MAX_COINS)
  }
  playerCoinBalances.set(key, Math.min(doc.coins, MAX_COINS))
  playerUpgradeData.set(key, parseUpgrades(doc.upgrades || '{}'))
  playerLifetimeWinsCache.set(key, doc.wins)
  playerLifetimeHoldTimeCache.set(key, doc.holdTime)
  playerBlessingDates.set(key, doc.blessing)
}

function assembleDoc(key: string): string {
  const doc: PlayerDocV1 = {
    v: 1,
    coins: playerCoinBalances.get(key) ?? 0,
    upgrades: serializeUpgrades(playerUpgradeData.get(key) ?? parseUpgrades('{}')),
    wins: playerLifetimeWinsCache.get(key) ?? 0,
    holdTime: playerLifetimeHoldTimeCache.get(key) ?? 0,
    blessing: playerBlessingDates.get(key) ?? '',
  }
  return JSON.stringify(doc)
}

// Loads the player's doc and returns it WITHOUT touching the caches — all side
// effects (applyDoc, migration flush, hydrated flag) happen in
// ensurePlayerHydrated's identity-guarded completion handler, so an abandoned
// hydration (player disconnected mid-load) can be discarded completely.
async function hydratePlayer(key: string): Promise<{ doc: PlayerDocV1; migrated: boolean }> {
  // A flush may still be pending or in flight from a just-ended session — it is
  // newer than whatever storage holds.
  const pending = pendingDocs.get(key)
  if (pending !== undefined) {
    return { doc: JSON.parse(pending) as PlayerDocV1, migrated: false }
  }

  const raw = await storageGet<string>(`player:${key}`)
  if (raw !== null) {
    // The doc EXISTS: it is the only live copy of this player's data (the legacy
    // keys froze at migration time). If it can't be used — corrupt JSON or an
    // unsupported version (e.g. this build rolled back below a future v2) — FAIL
    // hydration and leave the doc untouched for diagnosis. Falling back to the
    // stale legacy keys here would silently roll the player back to their
    // pre-migration state and then markPlayerDirty would OVERWRITE the doc with
    // it, converting a transient corruption into permanent progress loss.
    let doc: PlayerDocV1
    try {
      doc = JSON.parse(raw) as PlayerDocV1
    } catch (err) {
      throw new Error(`[PlayerDoc] Corrupt doc for ${key.slice(0, 8)} — refusing to hydrate (kept for diagnosis): ${err}`)
    }
    if (doc.v !== 1) {
      throw new Error(`[PlayerDoc] Unsupported doc version ${String(doc.v)} for ${key.slice(0, 8)} — refusing to hydrate`)
    }
    if (!isValidDocV1(doc)) {
      throw new Error(`[PlayerDoc] Invalid v1 doc for ${key.slice(0, 8)} (missing/mistyped fields) — refusing to hydrate (kept for diagnosis)`)
    }
    return { doc, migrated: false }
  }

  // Legacy path — ONLY when storage definitively reports the doc absent (404):
  // a pre-consolidation player or a brand-new one. Read the old per-stat keys in
  // parallel. Strict — any failure rejects the whole hydration rather than
  // seeding partial defaults over real data.
  const [coins, upgrades, wins, holdTime, blessing] = await Promise.all([
    storageGet<string>(`coins:${key}`),
    storageGet<string>(`upgrades:${key}`),
    storageGet<string>(`lifetimeWins:${key}`),
    storageGet<string>(`lifetimeHoldTime:${key}`),
    storageGet<string>(`blessing:${key}`),
  ])
  // Sanitize at the boundary so migration's output domain is a SUBSET of what
  // isValidDocV1 accepts — otherwise a bad legacy value mints a doc that the
  // NEXT hydration rejects, permanently bricking the player. Per-field domains
  // must match the validator's: coins/wins are safe integers (a huge legacy
  // digit string parses to a finite-but-unsafe float like 1e20, which would
  // pass a mere isFinite check), holdTime is a float; garbage parses to NaN
  // and negatives can't come from any writer, so all collapse to 0. (A corrupt
  // legacy upgrades string needs no equivalent guard: applyDoc runs it through
  // parseUpgrades and assembleDoc re-serializes the result, so the flushed doc
  // is always structurally valid.)
  const sanitizeInt = (n: number) => (Number.isSafeInteger(n) && n > 0 ? n : 0)
  const sanitizeFloat = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0)
  return {
    doc: {
      v: 1,
      coins: Math.min(sanitizeInt(coins ? parseInt(coins, 10) : 0), MAX_COINS),
      upgrades: upgrades || '{}',
      wins: sanitizeInt(wins ? parseInt(wins, 10) : 0),
      holdTime: sanitizeFloat(holdTime ? parseFloat(holdTime) : 0),
      blessing: blessing || '',
    },
    migrated: true,
  }
}

/**
 * Resolve once the player's stats are in the in-memory caches. Instant for
 * hydrated players; concurrent callers share one in-flight hydration; a FAILED
 * hydration clears itself so the next call retries; an ABANDONED hydration
 * (disconnect cleanup deleted the map entry mid-load) completes without
 * touching anything. Strict: rejects on storage failure — mutating callers
 * must abort, display callers catch and degrade.
 */
export function ensurePlayerHydrated(walletAddress: string): Promise<void> {
  const key = walletAddress.toLowerCase()
  if (hydratedPlayers.has(key)) return Promise.resolve()
  let promise = hydrationPromises.get(key)
  if (!promise) {
    promise = hydratePlayer(key).then(({ doc, migrated }) => {
      // Identity guard (same pattern as the flush chains): clearPlayerDocState
      // ABANDONS an in-flight hydration by deleting this map entry — the player
      // is gone, and applying the result would repopulate the caches
      // playerTracking just cleaned and mark a disconnected player hydrated. A
      // reconnect starts a fresh hydration whose own completion passes this
      // check. All side effects live here, inside the guard, so an abandoned
      // completion touches nothing — and it must REJECT, not resolve: a caller
      // already awaiting it (e.g. a round-end award racing the disconnect)
      // would otherwise proceed over empty caches and flush fallback-derived
      // values over the real doc. Rejection routes them to their abort paths.
      if (hydrationPromises.get(key) !== promise) {
        throw new Error(`[PlayerDoc] Hydration abandoned for ${key.slice(0, 8)} (player disconnected mid-load)`)
      }
      applyDoc(key, doc)
      // Migrate forward: persist the consolidated doc so the next session is one
      // read. NOTE: migration is one-way — the legacy keys are never written
      // again, so code rolled back past this module would read stale legacy values.
      if (migrated) markPlayerDirty(key)
      hydratedPlayers.add(key)
      hydrationPromises.delete(key)
    })
    hydrationPromises.set(key, promise)
    // Failure cleanup: clear the entry so the next call retries — but only if
    // this promise still owns it (abandonment + reconnect may have replaced it).
    promise.catch(() => {
      if (hydrationPromises.get(key) === promise) hydrationPromises.delete(key)
    })
  }
  return promise
}

// ── Blessing accessors (callers must have hydrated first) ──

export function getPlayerBlessingDate(walletAddress: string): string {
  return playerBlessingDates.get(walletAddress.toLowerCase()) ?? ''
}

/** Set the last-blessing date. Caller is responsible for markPlayerDirty(). */
export function setPlayerBlessingDate(walletAddress: string, date: string): void {
  playerBlessingDates.set(walletAddress.toLowerCase(), date)
}

// ── Write-behind flushing ──

// The single not-yet-started flush attempt per player. Entries remove
// themselves the moment their doWrite begins executing.
const docFlushQueuedAttempt = new Map<string, Promise<void>>()

function queueDocFlush(key: string): Promise<void> {
  // Coalesce to at most ONE trailing attempt per player: if an attempt is
  // already queued (not yet started), return it. This is correct for every
  // caller — doWrite reads pendingDocs at EXECUTION time, so a queued attempt
  // carries every snapshot set before it runs, including a transaction's
  // (commitPlayerDocTx sets pendingDocs synchronously before calling here).
  // Without this, flushDuePlayerDocs appends a closure every 5s for as long as
  // a slow write is in flight — an unbounded promise backlog under degraded
  // storage. With it, the chain is bounded at one ACTIVE write + one TRAILING
  // attempt, and writes remain serialized per player as before.
  const queued = docFlushQueuedAttempt.get(key)
  if (queued) return queued
  lastDocFlushMs.set(key, Date.now())
  const doWrite = async (): Promise<void> => {
    // Now ACTIVE — release the queued-attempt slot (identity-checked, purely
    // defensive) so exactly one new trailing attempt may queue behind us.
    if (docFlushQueuedAttempt.get(key) === attempt) docFlushQueuedAttempt.delete(key)
    const doc = pendingDocs.get(key)
    if (doc === undefined) return // an earlier chained write already carried the latest snapshot
    await storageSet(`player:${key}`, doc) // throws on failure
    if (pendingDocs.get(key) === doc) pendingDocs.delete(key)
    unresolvedRollbacks.delete(key) // a landed write durably resolves any prior rollback
  }
  const prev = docFlushChains.get(key) ?? Promise.resolve()
  const attempt = prev.then(doWrite, doWrite)
  docFlushQueuedAttempt.set(key, attempt)
  // The CHAIN stores the settled (caught) version: failures are logged here, the
  // snapshot stays pending for flushDuePlayerDocs to retry, and fire-and-forget
  // callers can never surface an unhandled rejection. Durable callers
  // (commitPlayerDocTx) await `attempt` itself and observe the rejection.
  const settled = attempt.catch(err => {
    console.error('[PlayerDoc] Failed to persist for', key.slice(0, 8), err)
  })
  docFlushChains.set(key, settled)
  return attempt
}

// Snapshot/restore of the doc-backed cache fields, for transactional rollback.
function snapshotFields(key: string) {
  return {
    coins: playerCoinBalances.get(key),
    upgrades: playerUpgradeData.get(key),
    wins: playerLifetimeWinsCache.get(key),
    holdTime: playerLifetimeHoldTimeCache.get(key),
    blessing: playerBlessingDates.get(key),
  }
}

function forceRestore<T>(map: Map<string, T>, key: string, val: T | undefined): void {
  if (val === undefined) map.delete(key)
  else map.set(key, val)
}

// Restore one field to its pre-transaction value — but ONLY if it still holds the
// value the transaction wrote. A concurrent writer (e.g. a round-end lifetime
// update landing during the flush await) must win over the rollback.
function restoreField<T>(map: Map<string, T>, key: string, afterVal: T | undefined, beforeVal: T | undefined): void {
  if (map.get(key) !== afterVal) return
  forceRestore(map, key, beforeVal)
}

// Unconditional restore of every doc-backed field. Only safe when nothing can
// have interleaved since the snapshot — i.e. inside a synchronous window.
function restoreSnapshot(key: string, snap: ReturnType<typeof snapshotFields>): void {
  forceRestore(playerCoinBalances, key, snap.coins)
  forceRestore(playerUpgradeData, key, snap.upgrades)
  forceRestore(playerLifetimeWinsCache, key, snap.wins)
  forceRestore(playerLifetimeHoldTimeCache, key, snap.holdTime)
  forceRestore(playerBlessingDates, key, snap.blessing)
}

/**
 * Transactional commit for multi-field mutations (purchases, blessings).
 *
 * Applies the SYNCHRONOUS `mutate` callback (which updates the doc-backed
 * caches), snapshots the doc exactly ONCE — so storage can never observe a
 * partial intermediate state like "coins deducted, item not owned" — and
 * resolves only when the write durably landed.
 *
 * On failure: the mutation is rolled back field-wise (concurrent writers win,
 * see restoreField), the pending snapshot is re-assembled from the rolled-back
 * caches so the background retry persists the ROLLED-BACK state (this also
 * repairs a timed-out write that landed late with the aborted transaction), and
 * the promise rejects — the caller must report failure and MUST NOT acknowledge.
 *
 * `mutate` must be synchronous: an await inside it would reintroduce the
 * partial-snapshot window this function exists to close.
 */
export async function commitPlayerDocTx(walletAddress: string, mutate: () => void): Promise<void> {
  const key = walletAddress.toLowerCase()
  // Refuse to stack a new transaction on an unresolved predecessor: until the
  // rolled-back doc lands, the previous outcome is uncertain and interleaving a
  // retry with it would compound the uncertainty. Resolves within one flusher
  // retry (~5s) once storage responds again.
  if (unresolvedRollbacks.has(key)) {
    const busyErr: PlayerDocTxError = new Error(`Previous transaction outcome for ${key.slice(0, 8)} not yet resolved — refusing a new one`)
    busyErr.indeterminate = true
    throw busyErr
  }
  const before = snapshotFields(key)
  try {
    mutate()
  } catch (err) {
    // The callback is synchronous, so nothing can have interleaved since the
    // snapshot — restore it unconditionally rather than leaving a partial
    // in-memory mutation behind, and surface what is necessarily a code bug.
    restoreSnapshot(key, before)
    throw err
  }
  const after = snapshotFields(key)
  pendingDocs.set(key, assembleDoc(key))
  try {
    await queueDocFlush(key)
  } catch (err) {
    restoreField(playerCoinBalances, key, after.coins, before.coins)
    restoreField(playerUpgradeData, key, after.upgrades, before.upgrades)
    restoreField(playerLifetimeWinsCache, key, after.wins, before.wins)
    restoreField(playerLifetimeHoldTimeCache, key, after.holdTime, before.holdTime)
    restoreField(playerBlessingDates, key, after.blessing, before.blessing)
    pendingDocs.set(key, assembleDoc(key))
    // AWAIT the compensating write before reporting failure: the failed write
    // was most likely a TIMEOUT, and a timed-out write can still land late
    // carrying the aborted transaction — safeStorage's late-write repair cannot
    // catch that case, because no newer write has been issued for the key yet.
    // Once this write lands, the rollback is durable and the failure we report
    // is the CONFIRMED truth. If it fails too, we are genuinely indeterminate:
    // the snapshot stays pending (flushDuePlayerDocs keeps retrying) and only a
    // teardown before a retry lands can resurrect the aborted transaction. That
    // residual is confusing but consistent — the player received exactly what
    // they paid for; a retry hits the owned/used check, so nothing is lost or
    // double-charged. Eliminating it entirely would need write-ahead intents
    // with boot-time reconciliation, which this storage service can't express.
    try {
      await queueDocFlush(key)
    } catch (compensationErr) {
      console.error('[PlayerDoc] Compensating write failed for', key.slice(0, 8), '— rolled-back state stays pending for retry:', compensationErr)
      // Both the write AND its compensation failed: the outcome is genuinely
      // indeterminate. Surface that explicitly (callers word their failure
      // message accordingly) and block further transactions for this player
      // until the retrying flusher durably lands the rollback.
      unresolvedRollbacks.add(key)
      const indeterminateErr: PlayerDocTxError = new Error(`Transaction outcome indeterminate for ${key.slice(0, 8)} — write timed out and compensation failed: ${err}`)
      indeterminateErr.indeterminate = true
      throw indeterminateErr
    }
    throw err
  }
}

/**
 * Snapshot the player's current cached stats as the latest pending doc and flush
 * it write-behind. Fire-and-forget by design: memory is authoritative, so callers
 * respond immediately and durability follows within ~one storage round trip
 * (worst case teardown loses that window — same trade-off the coin-pickup
 * debounce always made). debounce: true (coin pickups) instead coalesces writes
 * to one per DOC_FLUSH_MIN_INTERVAL_MS. Consecutive dirty-marks coalesce anyway:
 * every queued flush writes the LATEST snapshot and later ones no-op.
 */
export function markPlayerDirty(walletAddress: string, opts?: { debounce?: boolean }): void {
  const key = walletAddress.toLowerCase()
  pendingDocs.set(key, assembleDoc(key))
  if (!opts?.debounce) {
    queueDocFlush(key)
    return
  }
  if (Date.now() - (lastDocFlushMs.get(key) ?? 0) >= DOC_FLUSH_MIN_INTERVAL_MS) {
    queueDocFlush(key)
  }
}

/** Flush debounced docs whose interval elapsed and retry failed ones — every coinServerSystem tick. */
export function flushDuePlayerDocs(): void {
  if (pendingDocs.size === 0) return
  const now = Date.now()
  for (const key of pendingDocs.keys()) {
    if (now - (lastDocFlushMs.get(key) ?? 0) >= DOC_FLUSH_MIN_INTERVAL_MS) {
      queueDocFlush(key)
    }
  }
}

/** Disconnect cleanup (called via clearPlayerEconomyState). */
export function clearPlayerDocState(walletAddress: string): void {
  const key = walletAddress.toLowerCase()
  // Land any pending flush immediately — the server can be torn down without
  // warning once the world empties. pendingDocs holds the snapshot VALUE, so the
  // cache deletion playerTracking already did can't hollow the write out.
  if (pendingDocs.has(key)) queueDocFlush(key)
  lastDocFlushMs.delete(key)
  hydratedPlayers.delete(key)
  // Abandon any in-flight hydration: its completion handler checks map identity
  // (see ensurePlayerHydrated) and applies nothing once this entry is gone.
  hydrationPromises.delete(key)
  playerBlessingDates.delete(key)
  // Drop the chain only once settled, and only if no new flush was queued since
  // (a quick rejoin queues onto the same chain) — same pattern as balanceChains.
  const chain = docFlushChains.get(key)
  if (chain) {
    chain.then(() => {
      if (docFlushChains.get(key) === chain) docFlushChains.delete(key)
    })
  }
}
