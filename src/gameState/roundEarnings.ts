/**
 * Round Earnings State
 * 
 * Stores pending round-end coin earnings from the server,
 * consumed by the UI after the cinematic ends.
 */

export interface RoundEarnings {
  total: number
  participation: number
  holdTime: number
  placement: number
  rank: number
  newBalance: number
}

let pendingRoundEarnings: RoundEarnings | null = null

export function setPendingRoundEarnings(earnings: RoundEarnings) {
  pendingRoundEarnings = earnings
}

export function consumePendingRoundEarnings(): RoundEarnings | null {
  const e = pendingRoundEarnings
  pendingRoundEarnings = null
  return e
}
