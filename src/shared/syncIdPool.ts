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
    /** Get the next available ID. If exhausted, returns a random slot (oldest entity may be overwritten). */
    next(): number {
      if (pool.length > 0) return pool.shift()!
      return base + Math.floor(Math.random() * size)
    },
    /** Return an ID to the pool for reuse. */
    recycle(id: number): void {
      if (id >= base && id < base + size) {
        if (!pool.includes(id)) pool.push(id)
      }
    },
  }
}
