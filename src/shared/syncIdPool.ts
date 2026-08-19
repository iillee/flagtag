/**
 * syncIdPool.ts — Reusable sync ID pool factory.
 *
 * Decentraland's CRDT networking needs a unique numeric ID per synced entity.
 * Using monotonically increasing IDs leaves tombstones that accumulate.
 * This pool pre-allocates a fixed set of IDs and recycles them on despawn.
 *
 * Usage:
 *   const pool = createSyncIdPool(1_000_000, 40)
 *   const id = pool.next()   // get an ID
 *   pool.recycle(id)          // return it when done
 */

export function createSyncIdPool(base: number, size: number) {
  const pool: number[] = []
  for (let i = 0; i < size; i++) pool.push(base + i)

  return {
    /**
     * Get the next available ID, or null when the pool is exhausted. Callers must treat null
     * as "cannot spawn right now" and back off. The previous behavior — returning a RANDOM
     * slot from the range — was strictly worse than failing: by construction every id in an
     * exhausted pool is either tainted (deliberately not recycled after a syncEntity failure)
     * or registered to a LIVE entity, and reusing a live one gives two entities the same
     * network identity, crossing their CRDT streams on every client.
     */
    next(): number | null {
      if (pool.length > 0) return pool.shift()!
      return null
    },
    /** Return an ID to the pool for reuse. */
    recycle(id: number): void {
      if (id >= base && id < base + size) {
        if (!pool.includes(id)) pool.push(id)
      }
    },
  }
}
