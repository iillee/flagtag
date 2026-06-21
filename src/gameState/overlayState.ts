/**
 * overlayState.ts — Simple boolean visibility state for all overlay panels.
 * No ECS components needed — these are local UI toggles.
 */

// ── Win Condition / How To Play ──
let winConditionOverlayVisible = false
export function getWinConditionOverlayVisible(): boolean { return winConditionOverlayVisible }
export function setWinConditionOverlayVisible(visible: boolean): void { winConditionOverlayVisible = visible }
export function toggleWinConditionOverlay(): void { winConditionOverlayVisible = !winConditionOverlayVisible }

// ── Leaderboard ──
let leaderboardOverlayVisible = false
export function getLeaderboardOverlayVisible(): boolean { return leaderboardOverlayVisible }
export function setLeaderboardOverlayVisible(visible: boolean): void { leaderboardOverlayVisible = visible }
export function toggleLeaderboardOverlay(): void { leaderboardOverlayVisible = !leaderboardOverlayVisible }


