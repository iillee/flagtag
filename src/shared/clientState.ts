// ── Shared client state ──
// State that both ui/ and systems/ need to read/write.
// Lives here to avoid circular imports between the two layers.

/** Spectator camera modes */
export type SpectatorMode = 'orbit' | 'flag' | 'player'

/** Spectator camera state */
export const spectatorState = {
  active: false,
  mode: 'orbit' as SpectatorMode,
  /** userId of the player being followed in 'player' mode */
  followPlayerId: null as string | null,
  /** Display name of followed player */
  followPlayerName: '' as string,
  /** Whether the player-picker list is open */
  playerPickerOpen: false,
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
