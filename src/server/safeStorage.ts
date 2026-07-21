/**
 * safeStorage.ts — strict Storage.get/set wrappers with a hard timeout.
 *
 * Why not the raw SDK Storage API:
 * - Raw Storage promises have no timeout: a wedged storage connection makes them
 *   hang FOREVER, silently freezing every handler that awaits them. A timeout
 *   converts that silent death into a rejection existing catch paths degrade from.
 * - Storage.set NEVER rejects — it resolves `false` on any service/HTTP error.
 *   Treating that resolution as success acknowledged purchases/awards that were
 *   never stored. storageSet() here rejects instead, so the pending/retry
 *   bookkeeping in economy.ts actually retries failed writes.
 * - Storage.get resolves `null` for BOTH "key does not exist" and "request
 *   failed", so strict read-modify-write paths couldn't tell a new player from an
 *   outage and could persist defaults over real data. storageGet() here performs
 *   the signed fetch itself: 404 resolves null (definitively missing), anything
 *   else failing REJECTS.
 *
 * The timeout is driven by a server system (safeStorageSystem, registered in
 * server.ts) instead of setTimeout, which is not guaranteed to exist in the server
 * runtime. If the system is somehow not registered, calls behave exactly like raw
 * Storage — never worse.
 *
 * Ordering: a write that times out may still COMPLETE later inside the storage
 * layer and land AFTER a newer write for the same key, leaving stale data with
 * nothing pending to correct it. storageSet() therefore tracks a per-key sequence
 * and the latest value issued: when a raw write settles successfully but a newer
 * write was issued while it was in flight, it re-issues the newest value. That
 * repair write is idempotent when ordering was fine and self-corrects when not.
 * Residual gap: a write the service APPLIED but whose response was lost never
 * settles at the JS layer, so no repair fires for it — a stale value from that
 * case stands until the next write for the same key.
 *
 * This module is the ONLY place allowed to touch the raw SDK Storage API. The
 * full storage architecture (layering, durability tiers, key inventory) is
 * documented in docs/STORAGE.md.
 */
import { Storage } from '@dcl/sdk/server'
import { getStorageServerUrl } from '@dcl/sdk/server/storage-url'
import { signedFetch } from '~system/SignedFetch'

// The timeout is a HANG detector, not a latency budget: the storage service
// routinely takes ~2s per call, so this sits at ~5x typical latency. Anything
// that needs to be fast must not await storage at all (see playerDoc.ts — memory
// is authoritative, storage is write-behind).
const STORAGE_TIMEOUT_MS = 10_000
// Reads are retried here, centrally, so call sites don't each grow their own loop.
const STORAGE_READ_ATTEMPTS = 3
// With ~2s round trips, unbounded fan-out (boot loads, a 10-player round end all
// hydrating at once) stampedes the storage service and inflates every call's
// latency. Cap in-flight calls; excess callers queue FIFO.
//
// A slot tracks the RAW call's lifetime, not the caller's wait: the runtime
// allows only 16 concurrent signed fetches scene-wide (shared with EnvVar), and
// a timed-out raw call cannot be cancelled — it keeps running and keeps counting
// against that limit. Releasing on caller-timeout would let every timeout cycle
// REPLACE hung fetches with new ones, blowing past 16 during a real hang. So:
// - the slot frees when the raw promise SETTLES (see issueRawCall). If it never
//   settles, the slot is reclaimed after RAW_CALL_RECLAIM_MS so throughput can
//   recover — but the request is moved to the ORPHAN ledger, which still counts
//   against RAW_CALL_HARD_CAP: reclamation can therefore never admit more total
//   raw requests than the platform allows (this is ENFORCED, not assumed — a
//   permanently-unsettled orphan permanently consumes capacity, throttling
//   storage to hard-cap-minus-orphans, which beats violating the limit);
// - the queue wait is BOUNDED: slots held by hung calls must not strand waiters
//   silently, so a waiter that gets no slot within STORAGE_TIMEOUT_MS rejects
//   with a timeout-tagged error, which feeds the circuit breaker exactly like a
//   call timeout (both are evidence of a hung service);
// - the caller-facing timeout clock still only starts once the call is ISSUED,
//   so queue wait can't cause false call timeouts.
const MAX_INFLIGHT_STORAGE_CALLS = 6
const RAW_CALL_RECLAIM_MS = 60_000
// Hard ceiling on raw requests in existence at once: held slots + orphans.
// 12 leaves headroom under the platform's 16 for EnvVar and future users.
const RAW_CALL_HARD_CAP = 12

let inflightStorageCalls = 0
let orphanedRawCalls = 0

function canIssueRawCall(): boolean {
  return inflightStorageCalls < MAX_INFLIGHT_STORAGE_CALLS
    && inflightStorageCalls + orphanedRawCalls < RAW_CALL_HARD_CAP
}

interface SlotWaiter {
  done: boolean
  grant: () => void
}
const storageSlotWaiters: SlotWaiter[] = []

function acquireStorageSlot(label: string): Promise<void> {
  if (canIssueRawCall()) {
    inflightStorageCalls++
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: SlotWaiter = {
      done: false,
      grant: () => {
        waiter.done = true
        resolve()
      }
    }
    storageSlotWaiters.push(waiter)
    pending.push({
      deadline: Date.now() + STORAGE_TIMEOUT_MS,
      label: `queue ${label}`,
      onDeadline: () => {
        if (waiter.done) return
        waiter.done = true
        const err: TaggedError = new Error(`Storage queue timeout (no free slot): ${label}`)
        err.storageTimeout = true // slots hogged by hung calls — feed the breaker
        reject(err)
      }
    })
  })
}

// Grant queued waiters whatever capacity now exists — called when a slot frees
// AND when an orphan finally settles (capacity can appear either way under the
// hard cap). Skips waiters whose queue wait already timed out.
function grantWaiters(): void {
  while (storageSlotWaiters.length > 0 && canIssueRawCall()) {
    const next = storageSlotWaiters.shift()!
    if (next.done) continue
    inflightStorageCalls++
    next.grant()
  }
}

function releaseStorageSlot(): void {
  inflightStorageCalls--
  grantWaiters()
}

// ── Circuit breaker ──
// A timeout frees the caller's slot, but the raw signedFetch/Storage.set cannot
// be cancelled and keeps running. During a real service hang, retries and the
// periodic flushers would therefore keep REPLACING timed-out calls, piling far
// more than MAX_INFLIGHT raw operations onto a wedged service. After several
// consecutive timeouts the breaker opens: new calls fail fast for a cool-down
// instead of joining the pile. Any response from the service — success OR an
// HTTP error — proves it isn't hung and resets the count.
const BREAKER_TIMEOUT_THRESHOLD = 3
const BREAKER_COOLDOWN_MS = 15_000
let consecutiveTimeouts = 0
let breakerOpenUntil = 0

interface TaggedError extends Error {
  storageTimeout?: boolean
  breakerOpen?: boolean
}

function checkBreaker(label: string): void {
  if (Date.now() < breakerOpenUntil) {
    const err: TaggedError = new Error(`Storage circuit breaker open: ${label}`)
    err.breakerOpen = true
    throw err
  }
}

function recordOutcome(err: unknown | null): void {
  // A breaker-open rejection never reached the service — it says nothing about
  // its health, so it must neither count as a timeout nor reset the count.
  if (err !== null && (err as TaggedError)?.breakerOpen) return
  if (err !== null && (err as TaggedError)?.storageTimeout) {
    consecutiveTimeouts++
    if (consecutiveTimeouts >= BREAKER_TIMEOUT_THRESHOLD) {
      consecutiveTimeouts = 0
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS
      console.error('[SafeStorage] 🔌 Circuit breaker OPEN for', BREAKER_COOLDOWN_MS, 'ms after', BREAKER_TIMEOUT_THRESHOLD, 'consecutive timeouts')
    }
    return
  }
  consecutiveTimeouts = 0
}

interface PendingOp {
  deadline: number
  label: string
  onDeadline: () => void
}
const pending: PendingOp[] = []

/** Server system: fires the deadline action (timeout rejection / delay resolution)
 * of any pending op whose deadline passed. */
export function safeStorageSystem(_dt: number): void {
  if (pending.length === 0) return
  const now = Date.now()
  for (let i = pending.length - 1; i >= 0; i--) {
    const op = pending[i]
    if (now >= op.deadline) {
      pending.splice(i, 1)
      op.onDeadline()
    }
  }
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const op: PendingOp = {
      deadline: Date.now() + STORAGE_TIMEOUT_MS,
      label,
      onDeadline: () => {
        console.error('[SafeStorage] ⏱️ Storage call timed out after', STORAGE_TIMEOUT_MS, 'ms:', label)
        const err: TaggedError = new Error(`Storage timeout: ${label}`)
        err.storageTimeout = true // feeds the circuit breaker
        reject(err)
      }
    }
    pending.push(op)
    const settle = () => {
      const idx = pending.indexOf(op)
      if (idx !== -1) pending.splice(idx, 1)
    }
    // resolve/reject after a timeout rejection are no-ops — safe either way.
    promise.then(
      v => { settle(); resolve(v) },
      e => { settle(); reject(e) }
    )
  })
}

/**
 * Engine-tick-driven delay for retry backoff. setTimeout is not guaranteed to exist
 * in the server runtime, so this rides the same safeStorageSystem ticker as the
 * timeouts above; resolution granularity is one engine tick.
 */
export function storageDelay(ms: number): Promise<void> {
  return new Promise(resolve => {
    pending.push({ deadline: Date.now() + ms, label: `delay ${ms}ms`, onDeadline: resolve })
  })
}

/**
 * Issue a raw storage call under a concurrency slot held for the RAW call's
 * lifetime (see the slot comment above): released when the raw promise settles,
 * reclaimed after RAW_CALL_RECLAIM_MS if it never does. Also re-checks the
 * circuit breaker AT GRANT time — a waiter may have queued before the breaker
 * opened, and launching it into a service already presumed hung would defeat
 * the breaker. Returns the raw promise wrapped in an object — `await` flattens
 * nested promises, so returning it bare would make the caller wait for the raw
 * call itself to settle, bypassing its timeout. The caller applies its own
 * withTimeout to `.raw` (whose rejection abandons the caller but, deliberately,
 * NOT the slot).
 */
async function issueRawCall<T>(factory: () => Promise<T>, label: string): Promise<{ raw: Promise<T> }> {
  await acquireStorageSlot(label)
  try {
    checkBreaker(label)
  } catch (err) {
    releaseStorageSlot()
    throw err
  }
  // held: slot occupied. orphaned: slot reclaimed but the raw request still
  // exists — counted in the orphan ledger against RAW_CALL_HARD_CAP. settled:
  // the raw promise settled; all accounting done.
  let state: 'held' | 'orphaned' | 'settled' = 'held'
  const reclaimOp: PendingOp = {
    deadline: Date.now() + RAW_CALL_RECLAIM_MS,
    label: `reclaim ${label}`,
    onDeadline: () => {
      if (state !== 'held') return
      state = 'orphaned'
      orphanedRawCalls++
      console.error('[SafeStorage] 🚨 Raw call not settled after', RAW_CALL_RECLAIM_MS, 'ms — slot reclaimed, tracked as orphan (', orphanedRawCalls, 'outstanding):', label)
      releaseStorageSlot()
    }
  }
  const release = () => {
    if (state === 'settled') return
    if (state === 'orphaned') {
      // The orphan finally settled — capacity reappears under the hard cap.
      state = 'settled'
      orphanedRawCalls--
      grantWaiters()
      return
    }
    state = 'settled'
    const idx = pending.indexOf(reclaimOp)
    if (idx !== -1) pending.splice(idx, 1)
    releaseStorageSlot()
  }
  pending.push(reclaimOp)
  let raw: Promise<T>
  try {
    raw = factory()
  } catch (err) {
    release()
    throw err
  }
  raw.then(release, release)
  return { raw }
}

// The SDK's own resolution (same one Storage.get/set use), cached: the realm
// can't change for the lifetime of a server instance. Reset on failure so a
// transient getRealm error doesn't poison every later read.
let storageBaseUrl: Promise<string> | null = null

function getStorageBaseUrl(): Promise<string> {
  if (!storageBaseUrl) {
    storageBaseUrl = getStorageServerUrl()
    storageBaseUrl.catch(() => { storageBaseUrl = null })
  }
  return storageBaseUrl
}

async function strictGet<T extends string>(key: string): Promise<T | null> {
  const baseUrl = await getStorageBaseUrl()
  const response = await signedFetch({ url: `${baseUrl}/values/${encodeURIComponent(key)}` })
  if (response.status === 404) return null // the ONE definitive "key does not exist" signal
  if (!response.ok) throw new Error(`Storage get failed (${response.status} ${response.statusText}): ${key}`)
  // Strict success parsing: a 2xx MUST carry a STRING `value`. Every value this
  // codebase persists is a string (JSON blobs, stringified numbers, date
  // strings), so a missing value, an explicit null, or any other type is
  // service corruption, NOT "key missing" — treating it as null would
  // masquerade as definitively-missing, which for player docs triggers the
  // stale legacy-key fallback, the exact rollback hazard the corrupt-doc guard
  // exists to prevent. Reject instead (JSON.parse of a bad body throws too);
  // the retry layer and callers' abort paths treat it like any failure.
  const body = JSON.parse(response.body) as { value?: unknown } | null
  if (body === null || typeof body !== 'object' || !('value' in body)) {
    throw new Error(`Storage get returned ${response.status} without a value property: ${key}`)
  }
  const value = (body as { value: unknown }).value
  if (typeof value !== 'string') {
    throw new Error(`Storage get returned a non-string value (${value === null ? 'null' : typeof value}) for: ${key}`)
  }
  return value as T
}

/**
 * Strict read: resolves the stored STRING value, or null ONLY when storage
 * definitively reports the key does not exist (404 — a success, never retried).
 * Any failure (network, HTTP error, timeout, malformed body, non-string value)
 * is retried with backoff up to STORAGE_READ_ATTEMPTS times, then REJECTS —
 * callers on read-modify-write paths must abort, never substitute a default.
 * Writes are NOT retried here: the pending/flush queues own write retry, and a
 * second retry layer could reorder.
 */
export async function storageGet<T extends string = string>(key: string): Promise<T | null> {
  for (let attempt = 1; ; attempt++) {
    checkBreaker(`get ${key}`) // fail fast while the service is presumed hung
    try {
      // Slot lifecycle is owned by issueRawCall (released when the RAW call
      // settles) — a caller timeout here abandons the wait, not the slot.
      const { raw } = await issueRawCall(() => strictGet<T>(key), `get ${key}`)
      const value = await withTimeout(raw, `get ${key}`)
      recordOutcome(null)
      return value
    } catch (err) {
      recordOutcome(err)
      // Breaker-open: retrying within the cool-down is pointless — fail the call now.
      if ((err as TaggedError)?.breakerOpen || attempt >= STORAGE_READ_ATTEMPTS) throw err
      console.error('[SafeStorage] get', key, 'failed (attempt', attempt, 'of', STORAGE_READ_ATTEMPTS, ') — retrying:', err)
    }
    await storageDelay(1000 * attempt)
  }
}

// Per-key write bookkeeping for the late-write repair described in the header.
// keyLatestValue entries are kept for the server's lifetime (one small value per
// distinct key — same order of growth as the in-memory caches in economy.ts).
const keyWriteSeq = new Map<string, number>()
const keyLatestValue = new Map<string, string>()

/**
 * Strict write: resolves only when storage confirmed the write; rejects on
 * service error or timeout so caller retry paths (pending maps / flushers) keep
 * the value queued. A timed-out write that lands late behind a newer one triggers
 * a repair write of the newest value (see header).
 *
 * `value` is a string on purpose (every persisted value in this codebase is a
 * serialized string): the repair's `latest !== value` check needs VALUE equality,
 * which `!==` only gives for primitives. Widening to objects would silently turn
 * it into an identity check — don't, without reworking that comparison.
 */
export function storageSet(key: string, value: string): Promise<void> {
  // The sequence is claimed at CALL time (caller ordering intent), even though the
  // raw write may wait for a concurrency slot before it is issued.
  const seq = (keyWriteSeq.get(key) ?? 0) + 1
  keyWriteSeq.set(key, seq)
  keyLatestValue.set(key, value)
  return (async () => {
    checkBreaker(`set ${key}`) // fail fast — the pending queues keep the value and retry after cool-down
    let raw: Promise<boolean>
    try {
      // Slot lifecycle is owned by issueRawCall (released when the RAW call settles).
      ({ raw } = await issueRawCall(() => Storage.set(key, value), `set ${key}`))
    } catch (err) {
      recordOutcome(err) // a queue timeout is hung-service evidence; breaker-open is ignored
      throw err
    }
    raw.then(ok => {
      // This write landed, but a newer write for the key was issued while it was in
      // flight (a timeout rejection lets caller chains advance past it) — the service
      // may now hold this older value. Re-issue the newest known value. The value
      // inequality check is what makes this terminate: a late write carrying the SAME
      // value as the latest is harmless whatever order it landed in, and repair writes
      // always carry the latest value, so a repair can only trigger another repair if
      // a caller issued genuinely new data meanwhile — never from the repairs alone.
      const latest = keyLatestValue.get(key)
      if (ok && keyWriteSeq.get(key) !== seq && latest !== undefined && latest !== value) {
        console.error('[SafeStorage] Late write landed behind a newer one for', key, '— re-issuing latest value')
        storageSet(key, latest).catch(() => { /* best-effort; its own late-settle hook re-checks */ })
      }
    }, () => { /* raw rejections surface through the wrapper below */ })
    let ok: boolean
    try {
      ok = await withTimeout(raw, `set ${key}`)
    } catch (err) {
      recordOutcome(err)
      throw err
    }
    recordOutcome(null)
    if (!ok) throw new Error(`Storage set failed: ${key}`)
  })()
}
