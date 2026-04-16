// Simple boolean state — no ECS component needed for a local UI toggle

let leaderboardOverlayVisible = false

export function getLeaderboardOverlayVisible(): boolean {
  return leaderboardOverlayVisible
}

export function setLeaderboardOverlayVisible(visible: boolean): void {
  leaderboardOverlayVisible = visible
}

export function toggleLeaderboardOverlay(): void {
  leaderboardOverlayVisible = !leaderboardOverlayVisible
}

export function createLeaderboardOverlayEntity(): void {
  // No-op: overlay uses simple boolean state, no ECS entity needed
}
