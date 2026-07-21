export type CoinClaimToken = number

/** Reserve a coin while its wallet award is still in flight. */
export function reserveCoinClaim(
  cooldowns: Set<string>,
  pendingClaims: Map<string, CoinClaimToken>,
  coinId: string,
  token: CoinClaimToken
): void {
  cooldowns.add(coinId)
  pendingClaims.set(coinId, token)
}

/** Mark the matching reservation durable; stale completions cannot affect newer claims. */
export function completeCoinClaim(
  pendingClaims: Map<string, CoinClaimToken>,
  coinId: string,
  token: CoinClaimToken
): boolean {
  if (pendingClaims.get(coinId) !== token) return false
  pendingClaims.delete(coinId)
  return true
}

/** Restore only the coin reserved by this failed award. */
export function rollbackCoinClaim(
  cooldowns: Set<string>,
  pendingClaims: Map<string, CoinClaimToken>,
  coinId: string,
  token: CoinClaimToken
): boolean {
  if (!completeCoinClaim(pendingClaims, coinId, token)) return false
  return cooldowns.delete(coinId)
}

/** Pending wallet awards are hidden but cannot respawn or be evicted yet. */
export function getRespawnableCoinIds(
  cooldowns: ReadonlySet<string>,
  pendingClaims: ReadonlyMap<string, CoinClaimToken>
): string[] {
  return Array.from(cooldowns).filter(coinId => !pendingClaims.has(coinId))
}

export function releaseCoinForRespawn(
  cooldowns: Set<string>,
  pendingClaims: ReadonlyMap<string, CoinClaimToken>,
  coinId: string
): boolean {
  if (pendingClaims.has(coinId)) return false
  return cooldowns.delete(coinId)
}

/** A failed final claim must not donate its elapsed cooldown time to the next coin. */
export function coinRespawnTimerAfterRollback(
  currentTimerSeconds: number,
  cooldowns: ReadonlySet<string>
): number {
  return cooldowns.size === 0 ? 0 : currentTimerSeconds
}
