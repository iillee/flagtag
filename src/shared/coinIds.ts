/** Deterministic pickup id derived from a coin's placed world position. */
export function coinIdFromPosition(x: number, y: number, z: number): string {
  return `coin_${Math.round(x * 10)}_${Math.round(y * 10)}_${Math.round(z * 10)}`
}
