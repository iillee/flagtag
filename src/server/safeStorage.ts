/**
 * safeStorage.ts — Storage.get/set wrappers with a hard timeout.
 *
 * The raw Storage promises have no timeout: a wedged storage connection makes them
 * hang FOREVER, silently freezing every handler that awaits them (observed as traps
 * that never drop while the client cooldown ticks — the handler's first await never
 * settles, so no deny, no broadcast, no log). A timeout converts that silent death
 * into a rejection that existing catch paths already know how to degrade from.
 *
 * The timeout is driven by a server system (safeStorageSystem, registered in
 * server.ts) instead of setTimeout, which is not guaranteed to exist in the server
 * runtime. If the system is somehow not registered, calls behave exactly like raw
 * Storage — never worse.
 *
 * Ordering caveat: a call that times out may still COMPLETE later inside the storage
 * layer. A later write can therefore land before an earlier timed-out one. Callers
 * keep authoritative state in memory and rewrite on the next change, so a stale
 * persisted value self-heals; strict read-modify-write paths must instead ABORT on
 * rejection (never write a fallback-derived value — see loadPlayerCoinBalance).
 */
import { Storage } from '@dcl/sdk/server'

const STORAGE_TIMEOUT_MS = 2000

interface PendingOp {
  deadline: number
  label: string
  reject: (err: Error) => void
}
const pending: PendingOp[] = []

/** Server system: rejects any storage call that exceeded its deadline. */
export function safeStorageSystem(_dt: number): void {
  if (pending.length === 0) return
  const now = Date.now()
  for (let i = pending.length - 1; i >= 0; i--) {
    const op = pending[i]
    if (now >= op.deadline) {
      pending.splice(i, 1)
      console.error('[SafeStorage] ⏱️ Storage call timed out after', STORAGE_TIMEOUT_MS, 'ms:', op.label)
      op.reject(new Error(`Storage timeout: ${op.label}`))
    }
  }
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const op: PendingOp = { deadline: Date.now() + STORAGE_TIMEOUT_MS, label, reject }
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

export function storageGet<T>(key: string): Promise<T | null> {
  return withTimeout(Storage.get<T>(key), `get ${key}`)
}

export function storageSet(key: string, value: unknown): Promise<boolean> {
  return withTimeout(Storage.set(key, value), `set ${key}`)
}
