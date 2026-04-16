// Simple boolean state — no ECS component needed for a local UI toggle

let winConditionOverlayVisible = false

export function getWinConditionOverlayVisible(): boolean {
  return winConditionOverlayVisible
}

export function setWinConditionOverlayVisible(visible: boolean): void {
  winConditionOverlayVisible = visible
}

export function toggleWinConditionOverlay(): void {
  winConditionOverlayVisible = !winConditionOverlayVisible
}

export function createWinConditionOverlayEntity(): void {
  // No-op: overlay uses simple boolean state, no ECS entity needed
}
