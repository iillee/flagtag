export interface DailyLeaderboardResetLifecycle {
  isLoaded: () => boolean
  recover: () => Promise<void>
  reset: () => Promise<boolean>
}

export interface DailyLeaderboardResetCommit {
  persistEmptyLeaderboard: () => Promise<void>
  persistResetDay: () => Promise<void>
  publishEmptyLeaderboard: () => void
  markResetDay: () => void
}

/** Ensure persisted leaderboard data is validated before any reset is allowed to write. */
export async function resetDailyLeaderboardAfterRecovery(
  lifecycle: DailyLeaderboardResetLifecycle
): Promise<boolean> {
  if (!lifecycle.isLoaded()) await lifecycle.recover()
  if (!lifecycle.isLoaded()) {
    throw new Error('Daily leaderboard is not loaded; refusing to reset persisted data')
  }
  return lifecycle.reset()
}

/** Run a round mutation only after recovery and any required calendar reset succeed. */
export async function mutateDailyLeaderboardAfterRecovery(
  lifecycle: DailyLeaderboardResetLifecycle,
  mutate?: () => Promise<void>
): Promise<boolean> {
  const didReset = await resetDailyLeaderboardAfterRecovery(lifecycle)
  if (mutate) await mutate()
  return didReset
}

/** Publish reset state only after both durable writes have succeeded. */
export async function commitDailyLeaderboardReset(commit: DailyLeaderboardResetCommit): Promise<void> {
  await commit.persistEmptyLeaderboard()
  await commit.persistResetDay()
  commit.publishEmptyLeaderboard()
  commit.markResetDay()
}
