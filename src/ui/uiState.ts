/**
 * uiState.ts — All UI state in one place.
 *
 * Groups every mutable flag, timer, and scroll offset that the UI reads.
 * Other systems set state via the exported functions; the UI renderer reads it.
 *
 * This file has ZERO rendering logic — it's pure state + getters/setters.
 */
import type { Entity } from '@dcl/sdk/ecs'
import type { RoundEarnings } from '../gameState/roundEarnings'

// ═══════════════════════════════════════════════════════════
// MUSIC
// ═══════════════════════════════════════════════════════════
let _musicMuted = false
export function isMusicMuted(): boolean { return _musicMuted }
export function setMusicMuted(v: boolean) { _musicMuted = v }
export function toggleMusicMuted() { _musicMuted = !_musicMuted }

// ═══════════════════════════════════════════════════════════
// CINEMATIC / TRANSITIONS
// ═══════════════════════════════════════════════════════════
let _cinematicFadeOpacity = 0
export function getCinematicFadeOpacity(): number { return _cinematicFadeOpacity }
export function setCinematicFade(opacity: number) {
  _cinematicFadeOpacity = Math.max(0, Math.min(1, opacity))
}

let _titleSplashVisible = true
export function isTitleSplashVisible(): boolean { return _titleSplashVisible }
export function setTitleSplashVisible(v: boolean) { _titleSplashVisible = v }

let _cinematicShowing = false
export function getCinematicShowing(): boolean { return _cinematicShowing }
export function setCinematicShowing(showing: boolean) { _cinematicShowing = showing }

// ═══════════════════════════════════════════════════════════
// CREDITS / NEXT ROUND SCREEN
// ═══════════════════════════════════════════════════════════
let _nextRoundStartingVisible = false
export function isNextRoundStartingVisible(): boolean { return _nextRoundStartingVisible }
export function setNextRoundStartingVisible(visible: boolean) { _nextRoundStartingVisible = visible }

let _noScorersCreditsVisible = false
export function isNoScorersCreditsVisible(): boolean { return _noScorersCreditsVisible }
export function setNoScorersCreditsVisible(visible: boolean) { _noScorersCreditsVisible = visible }

let _creditsCountdown = 0
export function getCreditsCountdown(): number { return _creditsCountdown }
export function setCreditsCountdown(seconds: number) { _creditsCountdown = seconds }

export const CREDIT_LINES = [
  'Oskar Stålberg and argonlightray2, the gods of townscaping',
  'Dylan Taylor and Authr, the gods of divine music',
  'Stom, Lastraum, and Baseddev, the gods of arcane knowledge',
]
export const CREDIT_LINE_DURATION = 3 // seconds per line

let _creditLineIndex = 0
let _creditLineTimer = 0
export function getCreditLineIndex(): number { return _creditLineIndex }
export function setCreditLineIndex(v: number) { _creditLineIndex = v }
export function getCreditLineTimer(): number { return _creditLineTimer }
export function setCreditLineTimer(v: number) { _creditLineTimer = v }

// ═══════════════════════════════════════════════════════════
// BLESSING (pedestal daily reward)
// ═══════════════════════════════════════════════════════════
let _blessingActive = false
let _blessingTimer = 0
let _blessingLineIndex = 0
let _blessingLineTimer = 0
let _blessingCompleted = false   // true if player stayed for entire duration
let _blessingAlreadyUsed = false // true if server said already_blessed today

export function isBlessingActive(): boolean { return _blessingActive }
export function setBlessingActive(v: boolean) { _blessingActive = v }

export function getBlessingTimer(): number { return _blessingTimer }
export function setBlessingTimer(v: number) { _blessingTimer = v }

export function getBlessingLineIndex(): number { return _blessingLineIndex }
export function setBlessingLineIndex(v: number) { _blessingLineIndex = v }

export function getBlessingLineTimer(): number { return _blessingLineTimer }
export function setBlessingLineTimer(v: number) { _blessingLineTimer = v }

export function isBlessingCompleted(): boolean { return _blessingCompleted }
export function setBlessingCompleted(v: boolean) { _blessingCompleted = v; if (v) _blessingCompletedAt = Date.now() }

let _blessingCompletedAt = 0
export function getBlessingCompletedAt(): number { return _blessingCompletedAt }

let _blessingCoinProgress = 0
export function getBlessingCoinProgress(): number { return _blessingCoinProgress }
export function setBlessingCoinProgress(v: number) { _blessingCoinProgress = v }

let _blessingCoinSoundsPlayed = 0
export function getBlessingCoinSoundsPlayed(): number { return _blessingCoinSoundsPlayed }
export function setBlessingCoinSoundsPlayed(v: number) { _blessingCoinSoundsPlayed = v }

export function isBlessingAlreadyUsed(): boolean { return _blessingAlreadyUsed }
export function setBlessingAlreadyUsed(v: boolean) { _blessingAlreadyUsed = v }

// ═══════════════════════════════════════════════════════════
// ROUND-END EARNINGS UI
// ═══════════════════════════════════════════════════════════
export type EarnedUiPhase = 'idle' | 'text' | 'coins' | 'fly' | 'done'

let _activeRoundEarnings: RoundEarnings | null = null
let _earnedUiVisible = false
let _earnedUiTimer = 0
let _earnedUiPhase: EarnedUiPhase = 'idle'
let _earnedCoinsFlyProgress = 0
let _earnedSoundPlayed = false
let _earnedCoinSoundsPlayed = 0
let _earnedCoinSoundTimer = 0
let _pendingEarningsLocal: RoundEarnings | null = null
let _displayedWins: number | null = null
let _winsFrozen = false
let _wasNextRoundVisible = false

export const EARNED_TEXT_DELAY = 0.6
export const EARNED_COIN_DELAY = 1.2
export const EARNED_FLY_DURATION = 1.0
export const COIN_SOUND_INTERVAL = 0.18

export function getActiveRoundEarnings(): RoundEarnings | null { return _activeRoundEarnings }
export function setActiveRoundEarnings(v: RoundEarnings | null) { _activeRoundEarnings = v }

export function isEarnedUiVisible(): boolean { return _earnedUiVisible }
export function setEarnedUiVisible(v: boolean) { _earnedUiVisible = v }

export function getEarnedUiTimer(): number { return _earnedUiTimer }
export function setEarnedUiTimer(v: number) { _earnedUiTimer = v }
export function addEarnedUiTimer(dt: number) { _earnedUiTimer += dt }

export function getEarnedUiPhase(): EarnedUiPhase { return _earnedUiPhase }
export function setEarnedUiPhase(v: EarnedUiPhase) { _earnedUiPhase = v }

export function getEarnedCoinsFlyProgress(): number { return _earnedCoinsFlyProgress }
export function setEarnedCoinsFlyProgress(v: number) { _earnedCoinsFlyProgress = v }

export function isEarnedSoundPlayed(): boolean { return _earnedSoundPlayed }
export function setEarnedSoundPlayed(v: boolean) { _earnedSoundPlayed = v }

export function getEarnedCoinSoundsPlayed(): number { return _earnedCoinSoundsPlayed }
export function setEarnedCoinSoundsPlayed(v: number) { _earnedCoinSoundsPlayed = v }

export function getEarnedCoinSoundTimer(): number { return _earnedCoinSoundTimer }
export function setEarnedCoinSoundTimer(v: number) { _earnedCoinSoundTimer = v }
export function addEarnedCoinSoundTimer(dt: number) { _earnedCoinSoundTimer += dt }

export function getPendingEarningsLocal(): RoundEarnings | null { return _pendingEarningsLocal }
export function setPendingEarningsLocal(v: RoundEarnings | null) { _pendingEarningsLocal = v }

export function getDisplayedWins(): number | null { return _displayedWins }
export function setDisplayedWins(v: number | null) { _displayedWins = v }

export function isWinsFrozen(): boolean { return _winsFrozen }
export function setWinsFrozen(v: boolean) { _winsFrozen = v }

export function getWasNextRoundVisible(): boolean { return _wasNextRoundVisible }
export function setWasNextRoundVisible(v: boolean) { _wasNextRoundVisible = v }

// ═══════════════════════════════════════════════════════════
// OVERLAY CLOSE GRACE PERIOD
// ═══════════════════════════════════════════════════════════
const OVERLAY_CLOSE_GRACE_MS = 150
let _overlayClosedAt = 0

export function notifyOverlayClosed() {
  _overlayClosedAt = Date.now()
}

export function isInOverlayGracePeriod(): boolean {
  return Date.now() - _overlayClosedAt < OVERLAY_CLOSE_GRACE_MS
}

// ═══════════════════════════════════════════════════════════
// POPUPS
// ═══════════════════════════════════════════════════════════

// ── Chest / Store ──
let _chestPopupVisible = false
export function isChestPopupVisible(): boolean { return _chestPopupVisible }
export function showChestPopup() { _chestPopupVisible = true }
export function hideChestPopup() { _chestPopupVisible = false; notifyOverlayClosed() }

// ── Mailbox ──
let _mailboxPopupVisible = false
export function isMailboxPopupVisible(): boolean { return _mailboxPopupVisible }
export function showMailboxPopup() { _mailboxPopupVisible = true }
export function hideMailboxPopup() { _mailboxPopupVisible = false; notifyOverlayClosed() }

// ── Gravestone ──
let _gravestonePopupVisible = false
export function isGravestonePopupVisible(): boolean { return _gravestonePopupVisible }
export function showGravestonePopup() { _gravestonePopupVisible = true }
export function hideGravestonePopup() { _gravestonePopupVisible = false; notifyOverlayClosed() }

// ── Mailbox status message ──
let _mailboxStatusMessage = ''
let _mailboxStatusTime = 0

export function getMailboxStatus(): string {
  if (Date.now() - _mailboxStatusTime > 5000) return ''
  return _mailboxStatusMessage
}

export function setMailboxStatus(msg: string) {
  _mailboxStatusMessage = msg
  _mailboxStatusTime = Date.now()
}

// ═══════════════════════════════════════════════════════════
// METRICS / TERMINAL
// ═══════════════════════════════════════════════════════════
let _metricsOpenedFromTerminal = false

export function isMetricsOpenedFromTerminal(): boolean { return _metricsOpenedFromTerminal }
export function setMetricsOpenedFromTerminal(v: boolean) { _metricsOpenedFromTerminal = v }

// ═══════════════════════════════════════════════════════════
// ROUND-END SPLASH (winner podium)
// ═══════════════════════════════════════════════════════════
export interface SplashPlayer {
  name: string
  seconds: number
}

export const SPLASH_DURATION_MS = 10000

let _splashVisible = false
let _splashHideTime = 0
let _trumpetEntity: Entity | null = null
let _splashPlayers: SplashPlayer[] = []
let _splashWinnerUserId: string | null = null
let _lastSplashRoundWinnerJson = ''

export function isSplashVisible(): boolean { return _splashVisible }
export function setSplashVisible(v: boolean) { _splashVisible = v }

export function getSplashHideTime(): number { return _splashHideTime }
export function setSplashHideTime(v: number) { _splashHideTime = v }

export function getTrumpetEntity(): Entity | null { return _trumpetEntity }
export function setTrumpetEntity(v: Entity | null) { _trumpetEntity = v }

export function getSplashPlayers(): SplashPlayer[] { return _splashPlayers }
export function setSplashPlayers(v: SplashPlayer[]) { _splashPlayers = v }

export function getSplashWinnerUserId(): string | null { return _splashWinnerUserId }
export function setSplashWinnerUserId(v: string | null) { _splashWinnerUserId = v }

export function getLastSplashRoundWinnerJson(): string { return _lastSplashRoundWinnerJson }
export function setLastSplashRoundWinnerJson(v: string) { _lastSplashRoundWinnerJson = v }

// ═══════════════════════════════════════════════════════════
// SERVER-DOWN DETECTION
// ═══════════════════════════════════════════════════════════
export const SERVER_DOWN_GRACE_SEC = 20
export const SERVER_DOWN_CONFIRM_SEC = 10
export const SERVER_DOWN_RESHOW_SEC = 60

let _sceneLoadElapsed = 0
let _serverDownTimer = 0
let _serverDownVisible = false
let _serverDownDismissedAt = 0

export function getSceneLoadElapsed(): number { return _sceneLoadElapsed }
export function addSceneLoadElapsed(dt: number) { _sceneLoadElapsed += dt }

export function getServerDownTimer(): number { return _serverDownTimer }
export function setServerDownTimer(v: number) { _serverDownTimer = v }
export function addServerDownTimer(dt: number) { _serverDownTimer += dt }

export function isServerDownVisible(): boolean { return _serverDownVisible }
export function setServerDownVisible(v: boolean) { _serverDownVisible = v }

export function getServerDownDismissedAt(): number { return _serverDownDismissedAt }
export function setServerDownDismissedAt(v: number) { _serverDownDismissedAt = v }

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
  folder: 'leaderboards' as 'leaderboards' | 'metrics' | 'status',
  leaderboard: 'daily' as 'daily' | 'monthly' | 'alltime' | 'metrics',
  metrics: 'daily' as 'daily' | 'monthly',
}

// ═══════════════════════════════════════════════════════════
// ATTACK FLICKER
// ═══════════════════════════════════════════════════════════
export const ATTACK_FLICKER_MS = 150
let _lastAttackPressMs = 0
export function getLastAttackPressMs(): number { return _lastAttackPressMs }
export function setLastAttackPressMs(v: number) { _lastAttackPressMs = v }

// ═══════════════════════════════════════════════════════════
// UI SCALE FLASH
// ═══════════════════════════════════════════════════════════
let _uiScaleFlashUntil = 0
export function getUIScaleFlash(): boolean { return Date.now() < _uiScaleFlashUntil }
export function flashUIScale() { _uiScaleFlashUntil = Date.now() + 2000 }

// ═══════════════════════════════════════════════════════════
// COUNTDOWN TICK
// ═══════════════════════════════════════════════════════════
let _lastTickSecond = -1
export function getLastTickSecond(): number { return _lastTickSecond }
export function setLastTickSecond(v: number) { _lastTickSecond = v }

// ═══════════════════════════════════════════════════════════
// MOBILE
// ═══════════════════════════════════════════════════════════
let _mobileScoreboardOverlayVisible = false
export function isMobileScoreboardVisible(): boolean { return _mobileScoreboardOverlayVisible }
export function setMobileScoreboardVisible(v: boolean) { _mobileScoreboardOverlayVisible = v }

// ═══════════════════════════════════════════════════════════
// MISC
// ═══════════════════════════════════════════════════════════
let _spectatorExitBlink = false
export function isSpectatorExitBlink(): boolean { return _spectatorExitBlink }
export function setSpectatorExitBlink(v: boolean) { _spectatorExitBlink = v }

let _discordReportSent = false
export function isDiscordReportSent(): boolean { return _discordReportSent }
export function setDiscordReportSent(v: boolean) { _discordReportSent = v }

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
  if (isInOverlayGracePeriod()) return true
  return _titleSplashVisible
    || _getWinConditionOverlayVisible()
    || _getLeaderboardOverlayVisible()
    || _getAnalyticsOverlayVisible()
    || _splashVisible
    || _serverDownVisible
    || _mobileScoreboardOverlayVisible
    || _mailboxPopupVisible
    || _chestPopupVisible
    || _gravestonePopupVisible
    || _blessingActive
    || _blessingCompleted
}
