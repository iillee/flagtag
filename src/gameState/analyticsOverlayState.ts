// Analytics overlay state management
// Follows the same pattern as winConditionOverlayState and leaderboardOverlayState

let analyticsOverlayVisible = false

export function getAnalyticsOverlayVisible(): boolean {
  return analyticsOverlayVisible
}

export function setAnalyticsOverlayVisible(visible: boolean): void {
  analyticsOverlayVisible = visible
}

export function toggleAnalyticsOverlay(): void {
  analyticsOverlayVisible = !analyticsOverlayVisible
}

export function createAnalyticsOverlayEntity(): void {
  // No-op: analytics overlay uses simple boolean state, no ECS entity needed
}
