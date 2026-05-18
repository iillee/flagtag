/**
 * uiState.ts — All UI state in one place.
 *
 * State is organized into plain exported objects grouped by feature.
 * Other systems mutate fields directly; the UI renderer reads them.
 *
 * This file has ZERO rendering logic — it's pure state.
 */
import type { Entity } from '@dcl/sdk/ecs'
import type { RoundEarnings } from '../gameState/roundEarnings'

// ═══════════════════════════════════════════════════════════
// MUSIC
// ═══════════════════════════════════════════════════════════
export const musicState = {
  muted: false,
}

// ═══════════════════════════════════════════════════════════
// CINEMATIC / TRANSITIONS
// ═══════════════════════════════════════════════════════════
export const cinematicState = {
  fadeOpacity: 0,
  titleSplashVisible: true,
  showing: false,
}

/** Clamp fade opacity to [0, 1] */
export function setCinematicFade(opacity: number) {
  cinematicState.fadeOpacity = Math.max(0, Math.min(1, opacity))
}

// ═══════════════════════════════════════════════════════════
// CREDITS / NEXT ROUND SCREEN
// ═══════════════════════════════════════════════════════════
export const CREDIT_LINES = [
  'Oskar Stålberg and argonlightray2, the gods of townscaping',
  'Dylan Taylor and Authr, the gods of divine music',
  'Stom, Lastraum, and Baseddev, the gods of arcane knowledge',
]
export const CREDIT_LINE_DURATION = 3 // seconds per line

export const creditsState = {
  nextRoundVisible: false,
  noScorersVisible: false,
  countdown: 0,
  lineIndex: 0,
  lineTimer: 0,
}

// ═══════════════════════════════════════════════════════════
// BLESSING (pedestal daily reward)
// ═══════════════════════════════════════════════════════════
export const blessingState = {
  active: false,
  timer: 0,
  lineIndex: 0,
  lineTimer: 0,
  completed: false,
  completedAt: 0,
  alreadyUsed: false,
  preCheckDone: false,
  fadeOut: 0,
  coinProgress: 0,
  coinSoundsPlayed: 0,
}

/** Set completed and auto-stamp completedAt when true */
export function markBlessingCompleted(v: boolean) {
  blessingState.completed = v
  if (v) blessingState.completedAt = Date.now()
}

// ═══════════════════════════════════════════════════════════
// ROUND-END EARNINGS UI
// ═══════════════════════════════════════════════════════════
export type EarnedUiPhase = 'idle' | 'text' | 'coins' | 'fly' | 'done'

export const EARNED_TEXT_DELAY = 0.4
export const EARNED_COIN_DELAY = 0.8
export const EARNED_FLY_DURATION = 1.0
export const COIN_SOUND_INTERVAL = 0.12

export const earnedState = {
  activeRoundEarnings: null as RoundEarnings | null,
  visible: false,
  timer: 0,
  phase: 'idle' as EarnedUiPhase,
  coinsFlyProgress: 0,
  soundPlayed: false,
  coinSoundsPlayed: 0,
  coinSoundTimer: 0,
  pendingLocal: null as RoundEarnings | null,
  displayedWins: null as number | null,
  winsFrozen: false,
  wasNextRoundVisible: false,
}

// ═══════════════════════════════════════════════════════════
// OVERLAY CLOSE NOTIFICATION
// ═══════════════════════════════════════════════════════════

/** Called when an overlay closes. Currently a no-op hook for future use. */
export function notifyOverlayClosed() {
  // Intentionally empty — kept as a hook point for callers.
}

// ═══════════════════════════════════════════════════════════
// POPUPS
// ═══════════════════════════════════════════════════════════
export const popupState = {
  chest: false,
  mailbox: false,
  gravestone: false,
  mailboxStatusMessage: '',
  mailboxStatusTime: 0,
}

export function showChestPopup() { popupState.chest = true }
export function hideChestPopup() { popupState.chest = false; notifyOverlayClosed() }

export function showMailboxPopup() { popupState.mailbox = true }
export function hideMailboxPopup() { popupState.mailbox = false; notifyOverlayClosed() }

export function showGravestonePopup() { popupState.gravestone = true }
export function hideGravestonePopup() { popupState.gravestone = false; notifyOverlayClosed() }

export function getMailboxStatus(): string {
  if (Date.now() - popupState.mailboxStatusTime > 5000) return ''
  return popupState.mailboxStatusMessage
}

export function setMailboxStatus(msg: string) {
  popupState.mailboxStatusMessage = msg
  popupState.mailboxStatusTime = Date.now()
}

// ═══════════════════════════════════════════════════════════
// METRICS / TERMINAL
// ═══════════════════════════════════════════════════════════
export const metricsState = {
  openedFromTerminal: false,
}

// ═══════════════════════════════════════════════════════════
// ROUND-END SPLASH (winner podium)
// ═══════════════════════════════════════════════════════════
export interface SplashPlayer {
  name: string
  seconds: number
}

export const SPLASH_DURATION_MS = 10000

export const splashState = {
  visible: false,
  hideTime: 0,
  trumpetEntity: null as Entity | null,
  players: [] as SplashPlayer[],
  winnerUserId: null as string | null,
  lastRoundWinnerJson: '',
}

// ═══════════════════════════════════════════════════════════
// SERVER-DOWN DETECTION
// ═══════════════════════════════════════════════════════════
export const SERVER_DOWN_GRACE_SEC = 20
export const SERVER_DOWN_CONFIRM_SEC = 10
export const SERVER_DOWN_RESHOW_SEC = 60

export const serverDownState = {
  sceneLoadElapsed: 0,
  timer: 0,
  visible: false,
  dismissedAt: 0,
}

// ═══════════════════════════════════════════════════════════
// HOVER STATES
// ═══════════════════════════════════════════════════════════
export const hover = {
  squareIcon: false,
  questionIcon: false,
  analyticsIcon: false,
  closeWinCondition: false,
  closeLeaderboard: false,
  closeAnalytics: false,
  closeMailbox: false,
  closeChest: false,
  closeServerDown: false,
}

// ═══════════════════════════════════════════════════════════
// SCROLL & TAB STATE
// ═══════════════════════════════════════════════════════════
export const scroll = {
  visitorOffset: 0,
  leaderboardOffset: 0,
}

export const tabs = {
  folder: 'status' as 'leaderboards' | 'metrics' | 'status',
  leaderboard: 'daily' as 'daily' | 'monthly' | 'alltime' | 'metrics',
  metrics: 'daily' as 'daily' | 'monthly',
}

// ═══════════════════════════════════════════════════════════
// UI SCALE FLASH
// ═══════════════════════════════════════════════════════════
export const uiScaleState = {
  flashUntil: 0,
}

export function getUIScaleFlash(): boolean { return Date.now() < uiScaleState.flashUntil }
export function flashUIScale() { uiScaleState.flashUntil = Date.now() + 2000 }

// ═══════════════════════════════════════════════════════════
// COUNTDOWN TICK
// ═══════════════════════════════════════════════════════════
export const countdownState = {
  lastTickSecond: -1,
}

// ═══════════════════════════════════════════════════════════
// MOBILE
// ═══════════════════════════════════════════════════════════
export const mobileState = {
  scoreboardVisible: false,
}

// ═══════════════════════════════════════════════════════════
// MISC
// ═══════════════════════════════════════════════════════════
export const miscState = {
  spectatorExitBlink: false,
  discordReportSent: false,
}

// ═══════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════
export const ADMIN_ADDRESS = '0x1e93e534c5e26b01ed242410b43ae23dd0faa52b'
export const COMMUNITY_ID = 'f7d69445-4889-49a9-8b50-07100125cbdc'

// ═══════════════════════════════════════════════════════════
// COMPOSITE QUERIES
// ═══════════════════════════════════════════════════════════

// Lazy imports to avoid circular deps — these are set by ui.tsx at init time
let _getWinConditionOverlayVisible: () => boolean = () => false
let _getLeaderboardOverlayVisible: () => boolean = () => false
let _getAnalyticsOverlayVisible: () => boolean = () => false

export function registerOverlayChecks(
  winFn: () => boolean,
  lbFn: () => boolean,
  analyticsFn: () => boolean,
) {
  _getWinConditionOverlayVisible = winFn
  _getLeaderboardOverlayVisible = lbFn
  _getAnalyticsOverlayVisible = analyticsFn
}

/** Returns true if any UI overlay is currently visible */
export function isAnyOverlayOpen(): boolean {
  return cinematicState.titleSplashVisible
    || _getWinConditionOverlayVisible()
    || _getLeaderboardOverlayVisible()
    || _getAnalyticsOverlayVisible()
    || splashState.visible
    || serverDownState.visible
    || mobileState.scoreboardVisible
    || popupState.mailbox
    || popupState.chest
    || popupState.gravestone
    || blessingState.active
    || blessingState.completed
}
