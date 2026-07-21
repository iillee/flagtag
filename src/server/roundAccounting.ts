export interface RoundPlayerScore { userId: string; seconds: number }

export function buildRoundAwardPlayers(
  participantIds: Iterable<string>,
  secondsByPlayer: ReadonlyMap<string, number>
): RoundPlayerScore[] {
  const awardPlayerIds = new Set<string>()
  for (const userId of participantIds) awardPlayerIds.add(userId.toLowerCase())
  for (const userId of secondsByPlayer.keys()) awardPlayerIds.add(userId.toLowerCase())
  return Array.from(awardPlayerIds, userId => ({
    userId,
    seconds: secondsByPlayer.get(userId) ?? 0,
  }))
}
