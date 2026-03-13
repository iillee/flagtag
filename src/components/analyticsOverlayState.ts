// Analytics overlay state management
// Follows the same pattern as winConditionOverlayState and leaderboardOverlayState

import { engine } from '@dcl/sdk/ecs'

let analyticsOverlayVisible = false
let analyticsOverlayEntity: any = null

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
  if (analyticsOverlayEntity !== null) return
  analyticsOverlayEntity = engine.addEntity()
}