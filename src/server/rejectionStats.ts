/**
 * rejectionStats.ts — Aggregate counters for rejected client requests.
 *
 * Handlers that refuse a request need to be visible in the log, or a failure looks identical to
 * a request that never arrived. That cost real diagnostic time on this scene: the removed
 * `requestSteal` handler had four silent `return`s, so when steals stopped working the logs
 * showed nothing about requests being dropped and the cause had to be inferred from the ABSENCE
 * of another line.
 *
 * But most rejections are routine, not anomalies — `reportGroundY` refuses every non-dropper's
 * report, which is one rejection per observer per drop. Logging those individually would bury
 * the tripwires the log exists to surface. So: COUNT the routine ones by reason and emit a
 * single line on the existing periodic DIAG cadence (the same shape as the `ghostTouching diag`
 * line, which reports sent vs throttled), and log immediately only the genuinely anomalous
 * ones — malformed payloads, exhausted budgets, rate limits.
 *
 * Pure module: no engine imports, so it stays unit-testable under jest.
 */

export type RejectionCounts = Map<string, number>

/**
 * Bump the counter for one rejection. `key` should read `handler:reason`
 * (e.g. `reportGroundY:not-dropper`) so the emitted line groups by handler.
 */
export function recordRejection(counts: RejectionCounts, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

/**
 * Render the counters as `key=count | key=count`, busiest first so the dominant reason is
 * readable at a glance. Returns null when nothing was rejected, so the caller can skip the log
 * line entirely rather than emitting an empty one every interval.
 *
 * Ties break alphabetically, so the output is stable for a given set of counts and does not
 * churn between intervals purely from Map insertion order.
 */
export function formatRejections(counts: RejectionCounts): string | null {
  if (counts.size === 0) return null
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([key, n]) => `${key}=${n}`)
    .join(' | ')
}

/** Reset for the next interval. Counts are per-interval, not cumulative. */
export function clearRejections(counts: RejectionCounts): void {
  counts.clear()
}
