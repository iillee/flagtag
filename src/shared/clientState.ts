// ── Shared client state ──
// State that both ui/ and systems/ need to read/write.
// Lives here to avoid circular imports between the two layers.

/** Spectator camera state */
export const spectatorState = {
  active: false,
}

/**
 * Deferred balance applier — registered by coinPickupSystem at init.
 * Called by UI when round-end coin animation triggers.
 * Lives here to avoid ui/ importing from systems/.
 */
let _applyDeferredBalance: (newBalance: number) => void = () => {}

export function applyDeferredBalance(newBalance: number): void {
  _applyDeferredBalance(newBalance)
}

export function registerDeferredBalanceApplier(fn: (newBalance: number) => void): void {
  _applyDeferredBalance = fn
}
