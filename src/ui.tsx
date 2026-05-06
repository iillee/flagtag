import { Color4, Vector3 } from '@dcl/sdk/math'
import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { getPlayer } from '@dcl/sdk/players'
import {
  getPlayersWithHoldTimes,
  getCurrentFlagCarrierUserId,
  getKnownPlayerName
} from './gameState/flagHoldTime'
import { isTrapOnCooldown, getTrapCooldownRemaining, triggerTrapFromUI } from './systems/trapSystem'
import { isProjectileOnCooldown, getProjectileCooldownRemaining, triggerProjectileFromUI, getChargeFraction, getIsCharging, getBurnoutFlash } from './systems/projectileSystem'
import { clearMushroomShield } from './systems/mushroomSystem'
import { isCinematicActive } from './cinematicState'
import { room } from './shared/messages'
import { getAllVisitors, getTodayVisitorCount, getCurrentOnlineCount, getMonthlyVisitors, getMonthlyVisitorCount, getMonthlyOnlineCount } from './gameState/sceneTime'
import { getLeaderboardEntries, getAllTimeLeaderboardEntries, getMonthlyLeaderboardEntries } from './gameState/roundsWon'
import { getCountdownSeconds, CountdownTimer, Flag } from './shared/components'
import { engine, AudioSource, Transform, inputSystem, InputAction, PointerEventType, PointerEvents, executeTask, type Entity } from '@dcl/sdk/ecs'
import { getWinConditionOverlayVisible, toggleWinConditionOverlay, setWinConditionOverlayVisible } from './components/winConditionOverlayState'
import { getLeaderboardOverlayVisible, toggleLeaderboardOverlay, setLeaderboardOverlayVisible } from './components/leaderboardOverlayState'
import { getBoomerangColor, setBoomerangColor, type BoomerangColor } from './gameState/boomerangColor'
import {
  WHITE, BRIGHT_WHITE, MUTED, LIGHT_GREY, GREY, CLOSE_GREY,
  GOLD, BRIGHT_GOLD, SILVER, BRONZE, CORAL_RED,
  PANEL_BG, PANEL_BG_SEMI,
  S, getUIScale, getUIScaleLabel, cycleUIScale, getServerConnectionStatus,
  formatCountdown, formatUTCTime, formatUTCDate, formatUTCMonth, formatPlaytime, formatVisitorTime,
  _PANEL_WIDTH, _ROW_HEIGHT, VISITORS_PER_PAGE, LEADERBOARD_PER_PAGE,
  _TITLE_FONT, _ROW_FONT, _PADDING, _BORDER_RADIUS,
  _ICON_FONT_QUESTION, _ICON_FONT_ANALYTICS,
  _ABILITY_BTN_SIZE, _ABILITY_ICON_SIZE,
  _OVERLAY_PANEL_WIDTH, _OVERLAY_PANEL_HEIGHT,
  sortVisitorsWithBotSection, getSortedLeaderboardEntries,
  isLikelyBot, type VisitorEntry, type VisitorOrSeparator,
} from './ui/uiConstants'
import { getAnalyticsOverlayVisible, toggleAnalyticsOverlay, setAnalyticsOverlayVisible } from './components/analyticsOverlayState'
import { musicEntity } from './index'
import { getCoinBalance, applyDeferredBalance } from './systems/coinPickupSystem'
import { isMobile } from '@dcl/sdk/platform'

// ── Music mute state ──
let musicMuted = false
let discordReportSent = false
let discordReportTimer: ReturnType<typeof setTimeout> | null = null
const ADMIN_ADDRESS = '0x1e93e534c5e26b01ed242410b43ae23dd0faa52b'
let spectatorExitBlink = false
function toggleMusicMute() {
  musicMuted = !musicMuted
  try {
    const audio = AudioSource.getMutable(musicEntity)
    audio.volume = musicMuted ? 0 : 0.175
  } catch (e) {
    console.error('[UI] Failed to toggle music mute:', e)
  }
}
import { isSpectatorMode, isSpectatorTransitioning, exitSpectatorMode } from './systems/spectatorSystem'
import { getDrownFraction, isDrownBarVisible, getRespawnCountdown, getDrownFadeOpacity, isDrownTextVisible } from './systems/waterSystem'
import { isLightningRespawning, getLightningFadeOpacity, getLightningRespawnCountdown, isLightningTextVisible } from './systems/lightningSystem'
import { isGhostDeathRespawning, getGhostDeathFadeOpacity, getGhostDeathRespawnCountdown, isGhostDeathTextVisible, getScareFraction, isScareBarVisible } from './systems/zombieSystem'
import { signedFetch } from '~system/SignedFetch'

const COMMUNITY_ID = 'f7d69445-4889-49a9-8b50-07100125cbdc'
// Public community — direct join via POST /members

let mailboxStatusMessage = ''
let mailboxStatusTime = 0

function getMailboxStatus(): string {
  if (Date.now() - mailboxStatusTime > 5000) return ''
  return mailboxStatusMessage
}

function setMailboxStatus(msg: string) {
  mailboxStatusMessage = msg
  mailboxStatusTime = Date.now()
}

function joinCommunity() {
  executeTask(async () => {
    try {
      const player = getPlayer()
      if (!player?.userId) {
        console.log('[Mailbox] No player data available')
        setMailboxStatus('Error: No player data')
        return
      }
      console.log('[Mailbox] Joining community for:', player.userId)
      setMailboxStatus('Joining...')

      // Use signedFetch for ADR-44 authenticated request
      const joinRes = await signedFetch({
        url: `https://social-api.decentraland.org/v1/communities/${COMMUNITY_ID}/members`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({})
        }
      })
      console.log('[Mailbox] Join response - status:', joinRes.status, 'ok:', joinRes.ok, 'body:', joinRes.body)
      let data: any = {}
      try { data = JSON.parse(joinRes.body) } catch (_) {}
      console.log('[Mailbox] Parsed response:', JSON.stringify(data))
      if (joinRes.status >= 200 && joinRes.status < 300) {
        setMailboxStatus('Joined! Welcome to the community.')
      } else {
        const body = joinRes.body || ''
        let msg = 'Error ' + joinRes.status
        try {
          const parsed = JSON.parse(body)
          msg = parsed.message || parsed.error || body
        } catch (_) {}
        // If already a member, treat as success
        if (body.includes('already') || body.includes('Already')) {
          setMailboxStatus('You are already a member!')
        } else {
          console.log('[Mailbox] Join error:', body)
          setMailboxStatus(msg)
        }
      }
    } catch (err) {
      console.error('[Mailbox] Failed to send community request:', err)
      setMailboxStatus('Error: ' + String(err))
    }
  })
}

// ── Cinematic fade overlay ──
let cinematicFadeOpacity = 0 // 0 = transparent, 1 = fully black
export function setCinematicFade(opacity: number) {
  cinematicFadeOpacity = Math.max(0, Math.min(1, opacity))
}

/** @deprecated Currently unused — kept for potential future use */
// ── Title splash (on load → click → How to Play) ──
let titleSplashVisible = true

// ── Cinematic showing flag (true while cinematic view is revealed) ──
let cinematicShowing = false

export function setCinematicShowing(showing: boolean) {
  cinematicShowing = showing
}

export function getCinematicShowing(): boolean {
  return cinematicShowing
}

// ── "Next Round Starting..." overlay (shown on black screen before fade-out) ──
let nextRoundStartingVisible = false
let noScorersCreditsVisible = false // set by cinematic system when no one scored
let creditsCountdown = 0
const creditLines = [
  'Oskar Stålberg and Townscaper for generating the level',
  'Dylann Taylor for the track SpriteSprint',
  'Lastraum, Stom, and Baseddev for resources and support',
  'All playtesters and bughunters',
]
let creditLineIndex = 0
let creditLineTimer = 0
const CREDIT_LINE_DURATION = 3 // seconds per line

engine.addSystem((dt: number) => {
  if (!nextRoundStartingVisible && !noScorersCreditsVisible) {
    creditLineTimer = 0
    creditLineIndex = 0
    return
  }
  creditLineTimer += dt
  if (creditLineTimer >= CREDIT_LINE_DURATION && creditLineIndex < creditLines.length - 1) {
    creditLineTimer = 0
    creditLineIndex = creditLineIndex + 1
  }
})

export function setNextRoundStartingVisible(visible: boolean) {
  nextRoundStartingVisible = visible
}

export function setNoScorersCreditsVisible(visible: boolean) {
  noScorersCreditsVisible = visible
}

export function setCreditsCountdown(seconds: number) {
  creditsCountdown = seconds
}

// ── "You Earned" round-end coin breakdown UI ──
import { type RoundEarnings, consumePendingRoundEarnings } from './gameState/roundEarnings'

let activeRoundEarnings: RoundEarnings | null = null  // currently displaying
let earnedUiVisible = false
let earnedUiTimer = 0
let earnedUiPhase: 'idle' | 'text' | 'coins' | 'fly' | 'done' = 'idle'
const EARNED_TEXT_DELAY = 0.6   // seconds before showing text
const EARNED_COIN_DELAY = 1.2   // seconds after text before coins start flying
const EARNED_FLY_DURATION = 1.0 // seconds for coin fly animation
let earnedCoinsFlyProgress = 0  // 0 to 1
let earnedSoundPlayed = false
let earnedCoinSoundsPlayed = 0   // how many coin sounds have played so far
let earnedCoinSoundTimer = 0     // timer for spacing coin sounds
const COIN_SOUND_INTERVAL = 0.18 // seconds between each coin sound


let pendingEarningsLocal: RoundEarnings | null = null
let displayedWins: number | null = null  // cached win count, frozen during round-end
let winsFrozen = false
let wasNextRoundVisible = false

// System to manage "You Earned" UI timing (shown during credits/next-round screen)
engine.addSystem((dt: number) => {
  // Check for new earnings from server
  const pending = consumePendingRoundEarnings()
  if (pending) {
    pendingEarningsLocal = pending
    winsFrozen = true  // freeze displayed wins until coin animation
  }
  
  // Detect credits screen appearing (nextRoundStartingVisible becomes true)
  const creditsShowing = nextRoundStartingVisible && !cinematicShowing
  if (!wasNextRoundVisible && creditsShowing && pendingEarningsLocal) {
    // Credits screen just appeared — show the "You Earned" display
    activeRoundEarnings = pendingEarningsLocal
    pendingEarningsLocal = null
    earnedUiVisible = true
    earnedUiTimer = 0
    earnedUiPhase = 'text'
    earnedCoinsFlyProgress = 0
    earnedSoundPlayed = false
  }
  // Clear when credits screen hides
  if (wasNextRoundVisible && !creditsShowing && earnedUiVisible) {
    earnedUiPhase = 'done'
    earnedUiVisible = false
    activeRoundEarnings = null
  }
  wasNextRoundVisible = creditsShowing
  
  if (!earnedUiVisible || !activeRoundEarnings) return
  
  earnedUiTimer += dt
  
  if (earnedUiPhase === 'text' && earnedUiTimer >= EARNED_TEXT_DELAY + EARNED_COIN_DELAY) {
    earnedUiPhase = 'coins'
    earnedUiTimer = 0
    earnedCoinSoundsPlayed = 0
    earnedCoinSoundTimer = 0
    // Apply deferred balance
    if (!earnedSoundPlayed) {
      earnedSoundPlayed = true
      applyDeferredBalance(activeRoundEarnings.newBalance)
      winsFrozen = false  // unfreeze wins display
      displayedWins = null  // reset so it reads live value
    }
  } else if (earnedUiPhase === 'coins') {
    const totalCoins = activeRoundEarnings.total
    const totalSoundDuration = Math.max(EARNED_FLY_DURATION, totalCoins * COIN_SOUND_INTERVAL)
    // Play coin sounds one at a time
    earnedCoinSoundTimer += dt
    if (earnedCoinSoundsPlayed < totalCoins && earnedCoinSoundTimer >= COIN_SOUND_INTERVAL) {
      earnedCoinSoundTimer -= COIN_SOUND_INTERVAL
      earnedCoinSoundsPlayed++
      const snd = engine.addEntity()
      Transform.create(snd, { position: Vector3.Zero() })
      AudioSource.create(snd, {
        audioClipUrl: 'assets/sounds/coin.mp3',
        playing: true,
        volume: 0.7,
        loop: false,
        global: true,
      })
    }
    earnedCoinsFlyProgress = Math.min(1, earnedUiTimer / totalSoundDuration)
    if (earnedCoinsFlyProgress >= 1) {
      earnedUiPhase = 'fly'
      earnedUiTimer = 0
    }
  } else if (earnedUiPhase === 'fly') {
    // Stay visible for entire credits duration — cleared when credits screen hides
  }
})

export function setupUi() {
  ReactEcsRenderer.setUiRenderer(PlayerListUi)
}

/** Returns true if any UI overlay is currently visible (How to Play, Leaderboard, Analytics, Splash, etc.) */
let overlayClosedAt = 0
const OVERLAY_CLOSE_GRACE_MS = 150 // ignore clicks for this long after closing an overlay

export function notifyOverlayClosed() {
  overlayClosedAt = Date.now()
}

export function isAnyOverlayOpen(): boolean {
  // Also return true briefly after an overlay was closed, so the same click doesn't trigger an attack
  if (Date.now() - overlayClosedAt < OVERLAY_CLOSE_GRACE_MS) return true
  return titleSplashVisible
    || getWinConditionOverlayVisible()
    || getLeaderboardOverlayVisible()
    || getAnalyticsOverlayVisible()
    || splashVisible
    || serverDownVisible
    || mobileScoreboardOverlayVisible
    || mailboxPopupVisible
    || chestPopupVisible
}

// ── Chest popup state ──
let chestPopupVisible = false

export function showChestPopup() {
  chestPopupVisible = true
}

export function hideChestPopup() {
  chestPopupVisible = false
  notifyOverlayClosed()
}

export function isChestPopupVisible() {
  return chestPopupVisible
}

// ── Mailbox popup state ──
let mailboxPopupVisible = false

export function showMailboxPopup() {
  mailboxPopupVisible = true
}

export function hideMailboxPopup() {
  mailboxPopupVisible = false
  notifyOverlayClosed()
}

export function isMailboxPopupVisible() {
  return mailboxPopupVisible
}

// ── UI click sound (preloaded) ──
const uiClickSoundEntity = engine.addEntity()
Transform.create(uiClickSoundEntity, { position: Vector3.Zero() })
AudioSource.create(uiClickSoundEntity, {
  audioClipUrl: 'assets/sounds/click.wav',
  playing: true,
  loop: false,
  volume: 0.0,
  global: true
})

function playClickSound(): void {
  const a = AudioSource.getMutable(uiClickSoundEntity)
  a.volume = 0.35
  a.currentTime = 0
  a.playing = true
}

// ── UI hover sound (preloaded) ──
const uiHoverSoundEntity = engine.addEntity()
Transform.create(uiHoverSoundEntity, { position: Vector3.Zero() })
AudioSource.create(uiHoverSoundEntity, {
  audioClipUrl: 'assets/sounds/hover.wav',
  playing: true,
  loop: false,
  volume: 0.0,
  global: true
})

function playHoverSound(): void {
  const a = AudioSource.getMutable(uiHoverSoundEntity)
  a.playing = false
  a.volume = 0.25
  a.currentTime = 0
  a.playing = true
}

// ── Countdown tick sound (last 30 seconds) ──
const tickSoundEntity = engine.addEntity()
Transform.create(tickSoundEntity, { position: Vector3.Zero() })
AudioSource.create(tickSoundEntity, {
  audioClipUrl: 'assets/sounds/click.wav',
  playing: false,
  loop: false,
  volume: 0.0,
  global: true
})

let lastTickSecond = -1
engine.addSystem(() => {
  const seconds = getCountdownSeconds()
  if (seconds > 0 && seconds <= 10 && seconds !== lastTickSecond) {
    lastTickSecond = seconds
    const a = AudioSource.getMutable(tickSoundEntity)
    a.volume = 0.25
    a.currentTime = 0
    a.playing = true
  }
  if (seconds > 30) {
    lastTickSecond = -1
  }
})

let squareIconHovered = false
let questionIconHovered = false
let analyticsIconHovered = false
// (closeSplashHovered removed — splash is now 3D TextShape)
let closeWinConditionHovered = false
let closeLeaderboardHovered = false
let closeAnalyticsHovered = false
let closeMailboxHovered = false
let closeChestHovered = false
const CLOSE_HOVER = Color4.create(0.85, 0.85, 0.9, 1)

// Attack flicker state — dims the hit icon briefly when E is pressed
const _ATTACK_FLICKER_MS = 150
let _lastAttackPressMs = 0

function attackFlickerSystem(): void {
  if (inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_DOWN) && !isAnyOverlayOpen()) {
    // Don't flicker if clicking an interactive object (bench, scope, etc.)
    const cmd = inputSystem.getInputCommand(InputAction.IA_POINTER, PointerEventType.PET_DOWN)
    const hitEntity = cmd?.hit?.entityId
    if (hitEntity && PointerEvents.has(hitEntity as Entity)) return
    _lastAttackPressMs = Date.now()
  }
}

// Scroll state for lists
let visitorScrollOffset = 0
let leaderboardScrollOffset = 0
let leaderboardTab: 'daily' | 'monthly' | 'alltime' | 'metrics' = 'daily'
let folderTab: 'leaderboards' | 'metrics' | 'status' = 'leaderboards'
let metricsTab: 'daily' | 'monthly' = 'daily'

// ── Round-end splash state ──
let splashVisible = false
let splashHideTime = 0
let trumpetEntity: Entity | null = null
const SPLASH_DURATION_MS = 10000

interface SplashPlayer {
  name: string
  seconds: number
}

let splashPlayers: SplashPlayer[] = []
let _splashWinnerUserId: string | null = null
let lastSplashRoundWinnerJson = '' // track the last roundWinnerJson we showed, to avoid re-triggering

function roundEndSplashSystem(dt: number): void {
  const now = Date.now()

  // Watch for server's roundEndTriggered flag with winner data
  for (const [, timer] of engine.getEntitiesWith(CountdownTimer)) {
    if (timer.roundEndTriggered && timer.roundWinnerJson && timer.roundWinnerJson !== lastSplashRoundWinnerJson) {
      // New round end from server — show splash with authoritative data
      lastSplashRoundWinnerJson = timer.roundWinnerJson
      splashVisible = true
      splashHideTime = now + SPLASH_DURATION_MS
      clearMushroomShield()

      try {
        const serverData = JSON.parse(timer.roundWinnerJson) as Array<{ userId?: string; name: string; seconds: number }>
        splashPlayers = serverData.slice(0, 3).map(p => ({
          name: (p.userId ? getKnownPlayerName(p.userId) : null) || p.name,
          seconds: p.seconds
        }))
        // Track winner userId for teleport logic
        _splashWinnerUserId = (serverData.length > 0 && serverData[0].userId) ? serverData[0].userId : null
      } catch {
        splashPlayers = []
        _splashWinnerUserId = null
      }

      // Play trumpet sound once (only if someone scored)
      if (splashPlayers.length > 0) {
        if (trumpetEntity) {
          engine.removeEntity(trumpetEntity)
        }
        trumpetEntity = engine.addEntity()
        Transform.create(trumpetEntity, { position: Vector3.Zero() })
        AudioSource.create(trumpetEntity, {
          audioClipUrl: 'assets/sounds/trumpets.mp3',
          playing: true,
          volume: 0.8,
          loop: false,
          global: true
        })
      }
    }
    break
  }

  // Hide splash when cinematic ends
  if (splashVisible && !getCinematicShowing() && now >= splashHideTime) {
    splashVisible = false
    splashPlayers = []
    _splashWinnerUserId = null
    if (trumpetEntity) {
      engine.removeEntity(trumpetEntity)
      trumpetEntity = null
    }
  }

}

engine.addSystem(roundEndSplashSystem)
engine.addSystem(attackFlickerSystem)

// ── Server-down detection ──
// Wait a grace period after scene load before showing the server-down screen.
// This prevents the overlay from flashing during normal scene startup when
// CRDT data hasn't arrived yet.
const SERVER_DOWN_GRACE_SEC = 20    // seconds after scene load before we check
const SERVER_DOWN_CONFIRM_SEC = 10  // consecutive seconds of Server:N after grace before showing
const SERVER_DOWN_RESHOW_SEC = 60   // re-show the overlay every 60s after dismissal
let sceneLoadElapsed = 0
let serverDownTimer = 0
let serverDownVisible = false
let serverDownDismissedAt = 0       // timestamp when user dismissed (0 = not dismissed)
let closeServerDownHovered = false

function serverDownDetectionSystem(dt: number): void {
  sceneLoadElapsed += dt

  // Don't check during the initial grace period
  if (sceneLoadElapsed < SERVER_DOWN_GRACE_SEC) return

  const connected = getServerConnectionStatus() === 'Y'

  if (connected) {
    // Server is up — reset everything
    serverDownTimer = 0
    serverDownVisible = false
    serverDownDismissedAt = 0
  } else {
    // Server is down — accumulate time
    serverDownTimer += dt
    if (serverDownTimer >= SERVER_DOWN_CONFIRM_SEC) {
      if (serverDownDismissedAt === 0) {
        serverDownVisible = true
      } else if (Date.now() - serverDownDismissedAt >= SERVER_DOWN_RESHOW_SEC * 1000) {
        serverDownVisible = true
        serverDownDismissedAt = 0
      }
    }
  }
}

engine.addSystem(serverDownDetectionSystem)

// ── Key 2 — toggle music mute ──
engine.addSystem(() => {
  if (inputSystem.isTriggered(InputAction.IA_ACTION_4, PointerEventType.PET_DOWN)) {
    toggleMusicMute()
  }
})

// ── Key 1 — cycle UI scale (Small / Medium / Large) ──
let uiScaleFlashUntil = 0
function getUIScaleFlash(): boolean { return Date.now() < uiScaleFlashUntil }

engine.addSystem(() => {
  if (inputSystem.isTriggered(InputAction.IA_ACTION_3, PointerEventType.PET_DOWN)) {
    if (!isSpectatorMode() && !isMobile()) {
      cycleUIScale()
      uiScaleFlashUntil = Date.now() + 2000
    }
  }
})

// ── Key 4 — close any open overlay ──
engine.addSystem(() => {
  if (inputSystem.isTriggered(InputAction.IA_ACTION_6, PointerEventType.PET_DOWN)) {
    let closed = false
    if (getWinConditionOverlayVisible()) { setWinConditionOverlayVisible(false); closed = true }
    if (getLeaderboardOverlayVisible()) { setLeaderboardOverlayVisible(false); closed = true }
    if (getAnalyticsOverlayVisible()) { setAnalyticsOverlayVisible(false); closed = true }
    if (closed) { playClickSound(); notifyOverlayClosed() }
  }
})

// Constants, colors, formatters, sorting imported from ./ui/uiConstants

// ═══════════════════════════════════════════════════════════
// DROWN BAR — 2D screen-space air meter
// ═══════════════════════════════════════════════════════════

// Drown bar dimensions (computed at render time via S())
const DROWN_BAR_WIDTH_BASE = 160
const DROWN_BAR_HEIGHT_BASE = 10
const DROWN_BORDER_BASE = 2

function DrownBar() {
  const mobile = isMobile()
  const fraction = getDrownFraction()
  const fillColor = fraction < 0.25
    ? Color4.create(1, 0.3, 0.3, 0.95)
    : Color4.create(0.2, 0.5, 1.0, 0.95)
  const barW = mobile ? 280 : S(DROWN_BAR_WIDTH_BASE)
  const barH = mobile ? 18 : S(DROWN_BAR_HEIGHT_BASE)
  const border = mobile ? 3 : S(DROWN_BORDER_BASE)

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: mobile ? 185 : S(110), left: '50%' },
        width: barW + border * 2,
        height: barH + border * 2,
        margin: { left: -(barW + border * 2) / 2 },
        borderRadius: (barH + border * 2) / 2,
        padding: border,
      }}
      uiBackground={{ color: PANEL_BG_SEMI }}
    >
      <UiEntity
        uiTransform={{
          width: '100%',
          height: '100%',
          borderRadius: barH / 2,
        }}
        uiBackground={{ color: Color4.create(0, 0, 0, 0) }}
      >
        <UiEntity
          uiTransform={{
            width: `${Math.max(0, Math.min(100, fraction * 100))}%`,
            height: '100%',
            borderRadius: barH / 2,
          }}
          uiBackground={{ color: fillColor }}
        />
      </UiEntity>
    </UiEntity>
  )
}

function ScareBar() {
  const mobile = isMobile()
  const fraction = getScareFraction()
  const fillColor = fraction > 0.75
    ? Color4.create(1, 0.3, 0.3, 0.95)
    : Color4.create(0.55, 0.55, 0.55, 0.95)
  const barW = mobile ? 280 : S(DROWN_BAR_WIDTH_BASE)
  const barH = mobile ? 18 : S(DROWN_BAR_HEIGHT_BASE)
  const border = mobile ? 3 : S(DROWN_BORDER_BASE)

  // Position above the drown bar if both are visible
  const bottomOffset = isDrownBarVisible()
    ? (mobile ? 215 : S(128))
    : (mobile ? 185 : S(110))

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: bottomOffset, left: '50%' },
        width: barW + border * 2,
        height: barH + border * 2,
        margin: { left: -(barW + border * 2) / 2 },
        borderRadius: (barH + border * 2) / 2,
        padding: border,
      }}
      uiBackground={{ color: PANEL_BG_SEMI }}
    >
      <UiEntity
        uiTransform={{
          width: '100%',
          height: '100%',
          borderRadius: barH / 2,
        }}
        uiBackground={{ color: Color4.create(0, 0, 0, 0) }}
      >
        <UiEntity
          uiTransform={{
            width: `${Math.max(0, Math.min(100, fraction * 100))}%`,
            height: '100%',
            borderRadius: barH / 2,
          }}
          uiBackground={{ color: fillColor }}
        />
      </UiEntity>
    </UiEntity>
  )
}

function PlayerListUi() {
  const mobile = isMobile()
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'relative' }}>
      {mobile ? <MobileLayout /> : <DesktopLayout />}

      {/* Cinematic fade overlay (black screen for transitions) */}
      {cinematicFadeOpacity > 0 && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: S(0), left: S(0) },
            width: '100%',
            height: '100%',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
          }}
          uiBackground={{ color: Color4.create(0, 0, 0, cinematicFadeOpacity) }}
        >
          {/* Next Round / Credits screen (no-scorers OR after cinematic podium) */}
          {(noScorersCreditsVisible || (nextRoundStartingVisible && !cinematicShowing)) && (
            <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, flexDirection: 'column', alignItems: 'center', width: '100%', height: '100%' }}>
              
              {/* "You Earned" coin breakdown — upper area */}
              {activeRoundEarnings && (
                <UiEntity uiTransform={{ positionType: 'absolute', width: '100%', position: { top: '15%' }, flexDirection: 'column', alignItems: 'center' }}>
                <UiEntity
                  uiTransform={{ width: mobile ? 420 : S(320), padding: { top: mobile ? 28 : S(22), bottom: mobile ? 36 : S(28), left: mobile ? 24 : S(18), right: mobile ? 24 : S(18) }, flexDirection: 'column', alignItems: 'center' }}
                  uiBackground={{ textureMode: 'nine-slices', texture: { src: 'assets/images/rounded-outline.png' }, textureSlices: { top: 0.25, bottom: 0.25, left: 0.25, right: 0.25 }, color: Color4.White() }}
                >
                  <Label value="You Earned" fontSize={mobile ? 72 : S(46)} color={GOLD} font="sans-serif" />
                  <UiEntity uiTransform={{ height: mobile ? 24 : S(18) }} />
                  <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                    <UiEntity
                      uiTransform={{ width: mobile ? 56 : S(48), height: mobile ? 56 : S(48), margin: { right: mobile ? 16 : S(14) } }}
                      uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.White() }}
                    />
                    <Label value={`+${activeRoundEarnings.total}`} fontSize={mobile ? 96 : S(62)} color={GOLD} font="sans-serif" />
                  </UiEntity>
                  <UiEntity uiTransform={{ height: mobile ? 28 : S(20) }} />
                  <Label value={`Participation: +${activeRoundEarnings.participation}`} fontSize={mobile ? 34 : S(21)} color={LIGHT_GREY} font="sans-serif" />
                  {activeRoundEarnings.holdTime > 0 && (
                    <Label value={`Flag Hold Time: +${activeRoundEarnings.holdTime}`} fontSize={mobile ? 34 : S(21)} color={LIGHT_GREY} font="sans-serif" />
                  )}
                  {activeRoundEarnings.placement > 0 && (
                    <Label value={`${activeRoundEarnings.rank === 1 ? '1st' : activeRoundEarnings.rank === 2 ? '2nd' : '3rd'} Place Bonus: +${activeRoundEarnings.placement}`} fontSize={mobile ? 34 : S(21)} color={activeRoundEarnings.rank === 1 ? GOLD : activeRoundEarnings.rank === 2 ? SILVER : BRONZE} font="sans-serif" />
                  )}
                  {activeRoundEarnings.rank === 1 && (
                    <Label value={`Winning: +1 Flag`} fontSize={mobile ? 34 : S(21)} color={GOLD} font="sans-serif" />
                  )}
                </UiEntity>

                  {/* Flying coins animation */}
                  {(earnedUiPhase === 'coins' || earnedUiPhase === 'fly') && (() => {
                    const numCoins = Math.min(activeRoundEarnings!.total, 10)
                    const coins = []
                    for (let i = 0; i < numCoins; i++) {
                      const angle = (i / numCoins) * Math.PI * 2
                      const startX = Math.cos(angle) * 80
                      const startY = 60 + Math.sin(angle) * 40
                      const progress = Math.min(1, earnedCoinsFlyProgress * 1.5 - (i * 0.05))
                      const clampedProgress = Math.max(0, Math.min(1, progress))
                      const eased = 1 - Math.pow(1 - clampedProgress, 3)
                      const x = startX * (1 - eased)
                      const y = startY * (1 - eased) - (300 * eased)
                      const opacity = clampedProgress < 0.1 ? clampedProgress * 10 : (clampedProgress > 0.85 ? (1 - clampedProgress) * 6.67 : 1)
                      coins.push(
                        <UiEntity
                          key={`fly-coin-${i}`}
                          uiTransform={{
                            positionType: 'absolute',
                            position: { top: y, left: x + (mobile ? 180 : S(200)) },
                            width: mobile ? 28 : S(24),
                            height: mobile ? 28 : S(24),
                          }}
                          uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.create(1, 1, 1, Math.max(0, Math.min(1, opacity))) }}
                        />
                      )
                    }
                    return <UiEntity uiTransform={{ positionType: 'relative', width: 1, height: 1 }}>{coins}</UiEntity>
                  })()}
                </UiEntity>
              )}

              {/* Credits — lower area, title fixed */}
              <UiEntity uiTransform={{ positionType: 'absolute', width: '100%', position: { top: '62%' }, flexDirection: 'column', alignItems: 'center' }}>
                <Label value="Special Thanks to:" fontSize={mobile ? 52 : S(34)} color={GOLD} font="sans-serif" />
                <UiEntity uiTransform={{ height: mobile ? 14 : S(12) }} />
                {creditLines.slice(0, creditLineIndex + 1).map((line, i) => (
                  <Label key={i} value={line} fontSize={mobile ? 32 : S(20)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { top: mobile ? 6 : S(4) } }} />
                ))}
              </UiEntity>

              {creditsCountdown > 0 && (
                <Label value={`Next round in ${Math.ceil(creditsCountdown)}...`} fontSize={mobile ? 42 : S(26)} color={GOLD} font="sans-serif" uiTransform={{ positionType: 'absolute', position: { bottom: '3%' }, width: '100%', justifyContent: 'center' }} />
              )}
            </UiEntity>
          )}
        </UiEntity>
      )}

      {/* Server-down overlay */}
      {serverDownVisible && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: S(0), left: S(0) },
            width: '100%',
            height: '100%',
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
          }}
          uiBackground={{ color: Color4.create(0, 0, 0, 0.6) }}
        >
          <UiEntity
            uiTransform={{
              width: mobile ? 400 : S(460),
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: mobile ? 20 : S(16),
              padding: mobile
                ? { top: 36, bottom: 32, left: 20, right: 20 }
                : { top: S(36), bottom: S(32), left: S(40), right: S(40) },
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            {/* Close button */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: mobile ? 4 : S(4), right: mobile ? 4 : S(4) },
                width: mobile ? 80 : S(80),
                height: mobile ? 80 : S(80),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={() => { closeServerDownHovered = true }}
              onMouseLeave={() => { closeServerDownHovered = false }}
              onMouseDown={() => { playClickSound(); serverDownDismissedAt = Date.now(); serverDownVisible = false; closeServerDownHovered = false }}
            >
              <Label value="×" fontSize={mobile ? 52 : S(44)} color={closeServerDownHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>

            <Label value="Server Disconnected" fontSize={mobile ? 36 : S(28)} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: mobile ? 12 : S(12) }} />
            <Label value={mobile ? "all players please leave scene\nfor 5 minutes while server resets" : "all players please leave scene for 5 minutes while server resets"} fontSize={mobile ? 20 : S(18)} color={LIGHT_GREY} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      )}
      {/* Mailbox popup */}
      {mailboxPopupVisible && (
        <UiEntity uiTransform={{
          positionType: 'absolute',
          position: { top: S(0), left: S(0) },
          width: '100%',
          height: '100%',
          justifyContent: 'center',
          alignItems: 'center',
        }}
        >
          <UiEntity uiTransform={{
            width: mobile ? 400 : S(420),
            flexDirection: 'column',
            alignItems: 'center',
            padding: mobile
              ? { top: 28, bottom: 28, left: 20, right: 20 }
              : { top: S(24), bottom: S(24), left: S(24), right: S(24) },
            borderRadius: mobile ? 20 : S(20),
          }}
          uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: mobile ? 4 : S(4), right: mobile ? 4 : S(4) },
                width: mobile ? 80 : S(80),
                height: mobile ? 80 : S(80),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={() => { closeMailboxHovered = true }}
              onMouseLeave={() => { closeMailboxHovered = false }}
              onMouseDown={() => { playClickSound(); hideMailboxPopup(); closeMailboxHovered = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={mobile ? 52 : S(44)} color={closeMailboxHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Leave a Message" fontSize={mobile ? 36 : S(28)} color={Color4.create(0.2, 0.6, 1, 1)} font="sans-serif" uiTransform={{ margin: { bottom: mobile ? 8 : S(8) } }} />
            <Label value={mobile ? "Join the Flagtag community to\nleave a review or report a bug" : "Join the Flagtag community to\nleave a review or report a bug"} fontSize={mobile ? 20 : S(16)} color={LIGHT_GREY} uiTransform={{ margin: { top: mobile ? 4 : S(4), bottom: mobile ? 20 : S(20) }, width: mobile ? '95%' : S(360), height: mobile ? 65 : S(50) }} textAlign="middle-center" />
            <UiEntity
              uiTransform={{ width: mobile ? 240 : S(240), height: mobile ? 44 : S(44), borderRadius: mobile ? 8 : S(8), justifyContent: 'center', alignItems: 'center' }}
              uiBackground={{ color: Color4.create(0.2, 0.6, 1, 1) }}
              onMouseDown={() => {
                playClickSound()
                joinCommunity()
              }}
            >
              <Label value="Join Community" fontSize={mobile ? 20 : S(18)} color={Color4.White()} uiTransform={{ width: '100%', height: '100%' }} textAlign="middle-center" />
            </UiEntity>
            {getMailboxStatus() ? (
              <Label value={getMailboxStatus()} fontSize={mobile ? 16 : S(13)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { top: mobile ? 12 : S(12) }, width: mobile ? '95%' : S(360) }} textAlign="middle-center" />
            ) : null}
          </UiEntity>
        </UiEntity>
      )}
      {/* Chest popup */}
      {chestPopupVisible && (
        <UiEntity uiTransform={{
          positionType: 'absolute',
          position: { top: S(0), left: S(0) },
          width: '100%',
          height: '100%',
          justifyContent: 'center',
          alignItems: 'center',
        }}
        onMouseDown={() => {}}
        >
          <UiEntity uiTransform={{
            width: mobile ? 400 : S(420),
            flexDirection: 'column',
            alignItems: 'center',
            padding: mobile
              ? { top: 28, bottom: 28, left: 20, right: 20 }
              : { top: S(24), bottom: S(24), left: S(24), right: S(24) },
            borderRadius: mobile ? 20 : S(20),
          }}
          uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: mobile ? 4 : S(4), right: mobile ? 4 : S(4) },
                width: mobile ? 80 : S(80),
                height: mobile ? 80 : S(80),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={() => { closeChestHovered = true }}
              onMouseLeave={() => { closeChestHovered = false }}
              onMouseDown={() => { playClickSound(); hideChestPopup(); closeChestHovered = false }}
            >
              <Label value="×" fontSize={mobile ? 52 : S(44)} color={closeChestHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Chest" fontSize={mobile ? 36 : S(28)} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: mobile ? 4 : S(4) } }} />
            <Label value="Choose your boomerang" fontSize={mobile ? 20 : S(16)} color={LIGHT_GREY} uiTransform={{ margin: { top: mobile ? 4 : S(4), bottom: mobile ? 24 : S(28) }, width: mobile ? '90%' : S(360) }} textAlign="middle-center" />
            <UiEntity uiTransform={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', width: '100%' }}>
              {(['r', 'y', 'b', 'g'] as BoomerangColor[]).map((color) => {
                const selected = getBoomerangColor() === color
                const label = color === 'r' ? 'Base' : color === 'y' ? 'Dubs' : color === 'b' ? 'Charge' : 'Orbit'
                return (
                  <UiEntity
                    key={`boom-${color}`}
                    uiTransform={{
                      width: mobile ? 80 : S(80),
                      height: mobile ? 105 : S(105),
                      margin: { left: mobile ? 6 : S(6), right: mobile ? 6 : S(6) },
                      padding: mobile ? 4 : S(4),
                      borderRadius: mobile ? 12 : S(12),
                      justifyContent: 'center',
                      alignItems: 'center',
                      flexDirection: 'column',
                    }}
                    uiBackground={{ color: selected ? Color4.create(0.45, 0.38, 0.1, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                    onMouseDown={() => { playClickSound(); setBoomerangColor(color) }}
                  >
                    <UiEntity
                      uiTransform={{ width: mobile ? 60 : S(60), height: mobile ? 60 : S(60) }}
                      uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${color}.png` } }}
                    />
                    <Label value={label} fontSize={mobile ? 18 : S(15)} color={selected ? GOLD : LIGHT_GREY} uiTransform={{ margin: { top: mobile ? 2 : S(2) } }} />
                  </UiEntity>
                )
              })}
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}
      {/* Drown bar — screen-space, always on top */}
      {isDrownBarVisible() && <DrownBar />}
      {isScareBarVisible() && <ScareBar />}

      {/* UI Scale toast */}
      {getUIScaleFlash() && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { bottom: S(140), left: '50%' },
            margin: { left: S(-80) },
            width: S(160),
            height: S(32),
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
            borderRadius: S(8),
          }}
          uiBackground={{ color: PANEL_BG }}
        >
          <Label value={`UI: ${getUIScaleLabel()}`} fontSize={S(16)} color={WHITE} font="sans-serif" />
        </UiEntity>
      )}

      {/* Drown death overlay */}
      {getRespawnCountdown() > 0 && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: S(0), left: S(0) },
            width: '100%',
            height: '100%',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
          }}
          uiBackground={{ color: Color4.create(0, 0, 0, getDrownFadeOpacity()) }}
        >
          {isDrownTextVisible() && (
            <Label value="You Drowned!" fontSize={mobile ? 72 : S(42)} color={CORAL_RED} font="sans-serif" />
          )}
          {isDrownTextVisible() && (
            <UiEntity uiTransform={{ height: S(12) }} />
          )}
          {isDrownTextVisible() && (
            <Label value={`Respawning in ${Math.ceil(getRespawnCountdown())}...`} fontSize={mobile ? 36 : S(20)} color={LIGHT_GREY} font="sans-serif" />
          )}
        </UiEntity>
      )}

      {/* Lightning death overlay */}
      {isLightningRespawning() && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: S(0), left: S(0) },
            width: '100%',
            height: '100%',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
          }}
          uiBackground={{ color: Color4.create(0, 0, 0, getLightningFadeOpacity()) }}
        >
          {isLightningTextVisible() && (
            <Label value="You were struck by lightning!" fontSize={mobile ? 72 : S(42)} color={CORAL_RED} font="sans-serif" />
          )}
          {isLightningTextVisible() && (
            <UiEntity uiTransform={{ height: S(12) }} />
          )}
          {isLightningTextVisible() && (
            <Label value={`Respawning in ${Math.ceil(getLightningRespawnCountdown())}...`} fontSize={mobile ? 36 : S(20)} color={LIGHT_GREY} font="sans-serif" />
          )}
        </UiEntity>
      )}

      {/* Ghost death overlay */}
      {isGhostDeathRespawning() && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: S(0), left: S(0) },
            width: '100%',
            height: '100%',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
          }}
          uiBackground={{ color: Color4.create(0, 0, 0, getGhostDeathFadeOpacity()) }}
        >
          {isGhostDeathTextVisible() && (
            <Label value="You were scared to death!" fontSize={mobile ? 72 : S(42)} color={CORAL_RED} font="sans-serif" />
          )}
          {isGhostDeathTextVisible() && (
            <UiEntity uiTransform={{ height: S(12) }} />
          )}
          {isGhostDeathTextVisible() && (
            <Label value={`Respawning in ${Math.ceil(getGhostDeathRespawnCountdown())}...`} fontSize={mobile ? 36 : S(20)} color={LIGHT_GREY} font="sans-serif" />
          )}
        </UiEntity>
      )}

      {/* Spectator mode overlay */}
      {isSpectatorMode() && (
        <UiEntity uiTransform={{
          positionType: 'absolute',
          position: { bottom: S(20), left: S(0) },
          width: '100%',
          flexDirection: 'column',
          alignItems: 'center',
        }}>
          <UiEntity uiTransform={{
            flexDirection: 'column',
            alignItems: 'center',
            padding: mobile
              ? { top: 10, bottom: 10, left: 18, right: 18 }
              : { top: S(14), bottom: S(14), left: S(24), right: S(24) },
            borderRadius: mobile ? 14 : S(18),
          }}
            uiBackground={{ color: Color4.create(0.1, 0.1, 0.1, 0.92) }}
          >
            <Label value="SPECTATOR MODE" fontSize={mobile ? 24 : S(28)} color={Color4.White()} />
            <Label value="WASD = Orbit  |  E/F = Up/Down" fontSize={mobile ? 12 : S(14)} color={Color4.create(1, 1, 1, 0.8)} />
            <UiEntity
              uiTransform={{ width: mobile ? 120 : S(160), height: mobile ? 32 : S(40), margin: { top: mobile ? 6 : S(8) }, borderRadius: mobile ? 8 : S(10) }}
              uiBackground={{ color: spectatorExitBlink ? Color4.create(0.5, 0.5, 0.5, 0.9) : Color4.create(1, 1, 1, 0.9) }}
              onMouseDown={() => {
                playClickSound()
                spectatorExitBlink = true
                executeTask(async () => { await new Promise<void>(r => setTimeout(r, 120)); spectatorExitBlink = false })
                exitSpectatorMode()
              }}
            >
              <Label value="Exit" fontSize={mobile ? 16 : S(18)} color={Color4.Black()} uiTransform={{ width: '100%', height: '100%' }} />
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}

      {/* ── Title Splash Screen ── */}
      {titleSplashVisible && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left: 0, top: 0 },
            width: '100%',
            height: '100%',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
          }}
          onMouseDown={() => {
            playClickSound()
            titleSplashVisible = false
            setWinConditionOverlayVisible(true)
          }}
        >
          <UiEntity
            uiTransform={{
              width: S(420),
              padding: { top: S(32), bottom: S(32), left: S(24), right: S(24) },
              borderRadius: S(16),
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
            }}
            uiBackground={{ color: Color4.create(0.12, 0.10, 0.10, 0.95) }}
            onMouseDown={() => {
              playClickSound()
              titleSplashVisible = false
              setWinConditionOverlayVisible(true)
            }}
          >
            <Label value="FLAG TAG!" fontSize={S(56)} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: S(6) } }} />
            <Label value="A multiplayer keep away game!" fontSize={S(22)} color={MUTED} font="sans-serif" uiTransform={{ margin: { bottom: S(24) } }} />
            <Label value="Click anywhere to continue" fontSize={S(18)} color={Color4.create(1, 1, 1, 0.5)} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      )}
    </UiEntity>
  )
}

// ═══════════════════════════════════════════════════════════
// DESKTOP LAYOUT (unchanged from original)
// ═══════════════════════════════════════════════════════════

// Desktop layout constants imported from ./ui/uiConstants

function DesktopLayout() {
  const rawPlayers = getPlayersWithHoldTimes()
  const players = rawPlayers
  const localUserId = getPlayer()?.userId ?? null
  const rawVisitors = getAllVisitors()
  
  const allVisitors = sortVisitorsWithBotSection(rawVisitors)
  
  const visitorCount = getTodayVisitorCount()
  const onlineCount = getCurrentOnlineCount()
  const totalPlaytimeMin = Math.floor(allVisitors.reduce((sum, v) => sum + v.totalSeconds, 0) / 60)
  const leaderUserId =
    players.length > 0 && players[0].seconds > 0 ? players[0].userId : null
  const carrierUserId = getCurrentFlagCarrierUserId()
  const countdownSeconds = getCountdownSeconds()



  const winConditionOverlayVisible = getWinConditionOverlayVisible()
  const leaderboardOverlayVisible = getLeaderboardOverlayVisible()
  const analyticsOverlayVisible = getAnalyticsOverlayVisible()
  const rawLeaderboardEntries = leaderboardTab === 'monthly' ? getMonthlyLeaderboardEntries() : leaderboardTab === 'alltime' ? getAllTimeLeaderboardEntries() : getLeaderboardEntries()
  const leaderboardEntries = getSortedLeaderboardEntries(rawLeaderboardEntries)

  const serverConnected = getServerConnectionStatus()

  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: '100%',
        positionType: 'relative',
      }}
    >
      {/* Timer — top center (hidden during entire cinematic sequence) */}
      {!isCinematicActive() && !splashVisible && cinematicFadeOpacity === 0 && countdownSeconds > 0 && <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { top: S(14), left: S(0) },
          width: '100%',
          flexDirection: 'row',
          justifyContent: 'center',
        }}
      >
        <UiEntity
          uiTransform={{
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: S(2 * _ROW_HEIGHT + 2 * _PADDING),
            padding: { left: S(20), right: S(20) },
            borderRadius: S(_BORDER_RADIUS),
          }}
          uiBackground={{ color: PANEL_BG }}
        >
          <Label value="Round ends in:" fontSize={S(16)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { bottom: S(-6) } }} />
          <Label value={formatCountdown(countdownSeconds)} fontSize={S(40)} color={countdownSeconds <= 10 ? GOLD : WHITE} font="sans-serif" uiTransform={{ margin: { top: S(-6) } }} />
        </UiEntity>
      </UiEntity>}

      {/* Round-end splash — bottom of screen over cinematic camera (only when there are scorers) */}
      {splashVisible && cinematicShowing && splashPlayers.length > 0 && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: S(0), left: S(0) },
            width: '100%',
            height: '100%',
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'flex-end',
            padding: { bottom: S(40) },
          }}
        >
          <UiEntity
            uiTransform={{
              positionType: 'relative',
              width: S(440),
              minHeight: S(280),
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: S(16),
              padding: { top: S(36), bottom: S(28), left: S(40), right: S(40) },
              overflow: 'hidden',
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
              <Label
                value={splashPlayers.length === 1 || splashPlayers[0].seconds > (splashPlayers[1]?.seconds ?? 0)
                  ? `${splashPlayers[0].name} Wins!`
                  : 'Round Over!'}
                fontSize={S(34)}
                color={GOLD}
                font="sans-serif"
              />
              <UiEntity uiTransform={{ height: S(28) }} />
              {splashPlayers.map((p, i) => {
                const rankColor = i === 0 ? GOLD : i === 1 ? SILVER : BRONZE
                const scoreColor = LIGHT_GREY
                return (
                  <UiEntity
                    key={`splash-${i}`}
                    uiTransform={{
                      width: '100%',
                      height: S(34),
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: { left: S(4), right: S(4) },
                    }}
                  >
                    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Label value={`#${i + 1}`} fontSize={S(18)} color={rankColor} font="sans-serif" />
                      <UiEntity uiTransform={{ width: S(10) }} />
                      <Label value={p.name} fontSize={S(18)} color={rankColor} font="sans-serif" />
                    </UiEntity>
                    <Label value={`${p.seconds}`} fontSize={S(18)} color={scoreColor} font="sans-serif" />
                  </UiEntity>
                )
              })}
              <UiEntity uiTransform={{ height: S(24) }} />
              <Label value="Next round starting..." fontSize={S(15)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ width: S(440), flexShrink: 0 }} textAlign="middle-center" />
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}

      {/* How to Play overlay — 3-column card layout */}
      {winConditionOverlayVisible && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left: S(0), top: S(0) },
            width: '100%',
            height: '100%',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          {/* 3-column cards row */}
          <UiEntity
            uiTransform={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'stretch',
              width: S(880),
              margin: { bottom: S(12) },
            }}
            onMouseDown={() => {}}
          >
            {/* ── Flag Card ── */}
            <UiEntity
              uiTransform={{
                width: S(280),
                height: S(480),
                flexDirection: 'column',
                alignItems: 'center',
                borderRadius: S(16),
                padding: { top: S(14), bottom: S(14), left: S(16), right: S(16) },
                margin: { right: S(8) },
              }}
              uiBackground={{ color: Color4.create(0.15, 0.12, 0.12, 0.92) }}
            >
              <Label value="Flag" fontSize={S(28)} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: S(12) } }} />
              <Label value={"Find the Flag by following\nthe gold beacon"} fontSize={S(13)} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: S(4) } }} />
              {/* Flag beacon image */}
              <UiEntity
                uiTransform={{
                  width: S(160),
                  flexGrow: 1,
                  borderRadius: S(8),
                  margin: { top: S(4) },
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/beacon2.png' } }}
              />
              <Label value={"Move close to the Flag to pickup\nor steal it from another player"} fontSize={S(13)} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { top: S(8) } }} />
            </UiEntity>

            {/* ── Combat Card ── */}
            <UiEntity
              uiTransform={{
                width: S(280),
                height: S(480),
                flexDirection: 'column',
                alignItems: 'center',
                borderRadius: S(16),
                padding: { top: S(14), bottom: S(14), left: S(16), right: S(16) },
                margin: { left: S(4), right: S(4) },
              }}
              uiBackground={{ color: Color4.create(0.15, 0.12, 0.12, 0.92) }}
            >
              <Label value="Combat" fontSize={S(28)} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: S(12) } }} />
              <Label value={"Throw your boomerang (E) to\nstun rivals and force them\nto drop the Flag"} fontSize={S(13)} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: S(10) } }} />
              {/* Boomerang image */}
              <UiEntity
                uiTransform={{ width: S(120), height: S(120), margin: { bottom: S(14) } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` }, color: Color4.White() }}
              />
              <Label value={"Drop bananas (F) to block\nboomerangs and stun pursuers"} fontSize={S(13)} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: S(10) } }} />
              {/* Trap image */}
              <UiEntity
                uiTransform={{ width: S(120), height: S(120) }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/banana-color.png' }, color: Color4.White() }}
              />
            </UiEntity>

            {/* ── Win + Controls Card ── */}
            <UiEntity
              uiTransform={{
                width: S(280),
                height: S(480),
                flexDirection: 'column',
                alignItems: 'center',
                borderRadius: S(16),
                padding: { top: S(14), bottom: S(14), left: S(16), right: S(16) },
                margin: { left: S(8) },
              }}
              uiBackground={{ color: Color4.create(0.15, 0.12, 0.12, 0.92) }}
              onMouseDown={() => {}}
            >
              {/* Close X button */}
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { top: S(4), right: S(4) },
                  width: S(44),
                  height: S(44),
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onMouseEnter={() => { closeWinConditionHovered = true }}
                onMouseLeave={() => { closeWinConditionHovered = false }}
                onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); closeWinConditionHovered = false; notifyOverlayClosed() }}
              >
                <Label value="×" fontSize={S(44)} color={closeWinConditionHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
                <Label value="Win" fontSize={S(28)} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: S(12) } }} />
                <Label value={"Score 1 point for every\nsecond you hold the Flag"} fontSize={S(13)} color={MUTED} font="sans-serif" textAlign="middle-center" uiTransform={{ margin: { bottom: S(6) } }} />
                <Label value={"Win the round by holding\nthe Flag for the longest!"} fontSize={S(13)} color={MUTED} font="sans-serif" textAlign="middle-center" uiTransform={{ margin: { bottom: S(20) } }} />
                <Label value="Controls" fontSize={S(28)} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: S(16) } }} />
              </UiEntity>
              <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'flex-start', padding: { left: S(32) }, margin: { bottom: S(12) } }}>
              {/* E */}
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: S(10) } }}>
                <UiEntity uiTransform={{ width: S(34), height: S(30), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: S(5), margin: { right: S(8) } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}>
                  <Label value="E" fontSize={S(16)} color={WHITE} font="sans-serif" />
                </UiEntity>
                <Label value="Throw Boomerang" fontSize={S(13)} color={MUTED} font="sans-serif" />
              </UiEntity>
              {/* F */}
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: S(10) } }}>
                <UiEntity uiTransform={{ width: S(34), height: S(30), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: S(5), margin: { right: S(8) } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}>
                  <Label value="F" fontSize={S(16)} color={WHITE} font="sans-serif" />
                </UiEntity>
                <Label value="Drop Trap" fontSize={S(13)} color={MUTED} font="sans-serif" />
              </UiEntity>
              {/* 3 */}
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: S(10) } }}>
                <UiEntity uiTransform={{ width: S(34), height: S(30), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: S(5), margin: { right: S(8) } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}>
                  <Label value="3" fontSize={S(16)} color={WHITE} font="sans-serif" />
                </UiEntity>
                <Label value="Drop Flag" fontSize={S(13)} color={MUTED} font="sans-serif" />
              </UiEntity>
              {/* 2 */}
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: S(10) } }}>
                <UiEntity uiTransform={{ width: S(34), height: S(30), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: S(5), margin: { right: S(8) } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}>
                  <Label value="2" fontSize={S(16)} color={WHITE} font="sans-serif" />
                </UiEntity>
                <Label value={musicMuted ? "Unmute Music" : "Mute Music"} fontSize={S(13)} color={MUTED} font="sans-serif" />
              </UiEntity>
              {/* 1 */}
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                <UiEntity uiTransform={{ width: S(34), height: S(30), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: S(5), margin: { right: S(8) } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}>
                  <Label value="1" fontSize={S(16)} color={WHITE} font="sans-serif" />
                </UiEntity>
                <Label value="Toggle UI Size" fontSize={S(13)} color={MUTED} font="sans-serif" />
              </UiEntity>
              </UiEntity>
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}

      {/* Leaderboard overlay */}
      {leaderboardOverlayVisible && (() => {
        const totalEntries = leaderboardEntries.length
        const lbMaxOffset = Math.max(0, totalEntries - LEADERBOARD_PER_PAGE)
        if (leaderboardScrollOffset > lbMaxOffset) leaderboardScrollOffset = lbMaxOffset
        if (leaderboardScrollOffset < 0) leaderboardScrollOffset = 0
        const visibleEntries = leaderboardEntries.slice(leaderboardScrollOffset, leaderboardScrollOffset + LEADERBOARD_PER_PAGE)
        const lbCanScrollUp = leaderboardScrollOffset > 0
        const lbCanScrollDown = leaderboardScrollOffset < lbMaxOffset
        const lbNeedsScroll = totalEntries > LEADERBOARD_PER_PAGE
        const lbThumbRatio = totalEntries > 0 ? Math.max(0.15, LEADERBOARD_PER_PAGE / totalEntries) : 1

        const _FOLDER_TAB_WIDTH = 270
        const _FOLDER_TAB_HEIGHT = 56
        const _FOLDER_RADIUS = 16
        const _FOLDER_GAP = 5
        const FOLDER_ACTIVE = Color4.create(0.1, 0.1, 0.1, 1)
        const FOLDER_INACTIVE = Color4.create(0.065, 0.065, 0.07, 1)
        return (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left: S(0), top: S(0) },
            width: '100%',
            height: '100%',
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          {/* Folder wrapper — sized to fit tabs + body */}
          <UiEntity
            uiTransform={{
              positionType: 'relative',
              width: S(_OVERLAY_PANEL_WIDTH),
              height: S(_OVERLAY_PANEL_HEIGHT + _FOLDER_TAB_HEIGHT),
              flexDirection: 'column',
              alignItems: 'stretch',
            }}
          >
            {/* Filler patches — cover rounded corner dips where active tab meets body */}
            {/* Left bottom corner of active tab */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: S(_FOLDER_TAB_HEIGHT - 2), left: S(folderTab === 'status' ? 0 : folderTab === 'leaderboards' ? (_FOLDER_TAB_WIDTH + _FOLDER_GAP) : (_FOLDER_TAB_WIDTH + _FOLDER_GAP) * 2) },
                width: S(_FOLDER_RADIUS + 2),
                height: S(_FOLDER_RADIUS + 4),
              }}
              uiBackground={{ color: FOLDER_ACTIVE }}
            />
            {/* Right bottom corner of active tab */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: S(_FOLDER_TAB_HEIGHT), left: S((folderTab === 'status' ? 0 : folderTab === 'leaderboards' ? (_FOLDER_TAB_WIDTH + _FOLDER_GAP) : (_FOLDER_TAB_WIDTH + _FOLDER_GAP) * 2) + _FOLDER_TAB_WIDTH - _FOLDER_RADIUS) },
                width: S(_FOLDER_RADIUS),
                height: S(_FOLDER_RADIUS),
              }}
              uiBackground={{ color: FOLDER_ACTIVE }}
            />
            {/* Folder tab 1 — Status */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: S(0), left: S(0) },
                width: S(_FOLDER_TAB_WIDTH),
                height: S(_FOLDER_TAB_HEIGHT + _FOLDER_RADIUS),
                borderRadius: S(_FOLDER_RADIUS),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                padding: { bottom: S(_FOLDER_RADIUS) },
              }}
              uiBackground={{ color: folderTab === 'status' ? FOLDER_ACTIVE : FOLDER_INACTIVE }}
              onMouseDown={() => { playClickSound(); folderTab = 'status' }}
            >
              <Label value="Status" fontSize={S(28)} color={folderTab === 'status' ? GOLD : MUTED} font="sans-serif" />
            </UiEntity>
            {/* Folder tab 2 — Leaderboards */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: S(0), left: S(_FOLDER_TAB_WIDTH + _FOLDER_GAP) },
                width: S(_FOLDER_TAB_WIDTH),
                height: S(_FOLDER_TAB_HEIGHT + _FOLDER_RADIUS),
                borderRadius: S(_FOLDER_RADIUS),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                padding: { bottom: S(_FOLDER_RADIUS) },
              }}
              uiBackground={{ color: folderTab === 'leaderboards' ? FOLDER_ACTIVE : FOLDER_INACTIVE }}
              onMouseDown={() => { playClickSound(); folderTab = 'leaderboards'; leaderboardTab = 'daily'; leaderboardScrollOffset = 0 }}
            >
              <Label value="Leaderboards" fontSize={S(28)} color={folderTab === 'leaderboards' ? GOLD : MUTED} font="sans-serif" />
            </UiEntity>
            {/* Folder tab 3 — Metrics */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: S(0), left: S((_FOLDER_TAB_WIDTH + _FOLDER_GAP) * 2) },
                width: S(_FOLDER_TAB_WIDTH),
                height: S(_FOLDER_TAB_HEIGHT + _FOLDER_RADIUS),
                borderRadius: S(_FOLDER_RADIUS),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                padding: { bottom: S(_FOLDER_RADIUS) },
              }}
              uiBackground={{ color: folderTab === 'metrics' ? FOLDER_ACTIVE : FOLDER_INACTIVE }}
              onMouseDown={() => { playClickSound(); folderTab = 'metrics'; leaderboardTab = 'metrics'; metricsTab = 'daily'; leaderboardScrollOffset = 0; visitorScrollOffset = 0 }}
            >
              <Label value="Metrics" fontSize={S(28)} color={folderTab === 'metrics' ? GOLD : MUTED} font="sans-serif" />
            </UiEntity>
            {/* Folder body — main panel area */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: S(_FOLDER_TAB_HEIGHT), left: S(0) },
                width: S(_OVERLAY_PANEL_WIDTH),
                height: S(_OVERLAY_PANEL_HEIGHT),
                flexDirection: 'column',
                alignItems: 'stretch',
                padding: S(24),
                overflow: 'hidden',
                borderRadius: S(_FOLDER_RADIUS),
              }}
              uiBackground={{ color: FOLDER_ACTIVE }}
            >
            <UiEntity uiTransform={{ flexDirection: 'row', width: '100%', height: S(32), alignItems: 'center' }}>
              {folderTab === 'leaderboards' && (
                <UiEntity
                  uiTransform={{ flexGrow: 1, height: S(32), flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: S(6) }}
                  uiBackground={{ color: leaderboardTab === 'daily' ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                  onMouseDown={() => { playClickSound(); leaderboardTab = 'daily'; leaderboardScrollOffset = 0 }}
                >
                  <Label value="Daily" fontSize={S(16)} color={leaderboardTab === 'daily' ? WHITE : MUTED} font="sans-serif" />
                </UiEntity>
              )}
              {folderTab === 'leaderboards' && <UiEntity uiTransform={{ width: S(6) }} />}
              {folderTab === 'leaderboards' && (
                <UiEntity
                  uiTransform={{ flexGrow: 1, height: S(32), flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: S(6) }}
                  uiBackground={{ color: leaderboardTab === 'monthly' ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                  onMouseDown={() => { playClickSound(); leaderboardTab = 'monthly'; leaderboardScrollOffset = 0 }}
                >
                  <Label value="Monthly" fontSize={S(16)} color={leaderboardTab === 'monthly' ? WHITE : MUTED} font="sans-serif" />
                </UiEntity>
              )}
              {folderTab === 'leaderboards' && <UiEntity uiTransform={{ width: S(6) }} />}
              {folderTab === 'leaderboards' && (
                <UiEntity
                  uiTransform={{ flexGrow: 1, height: S(32), flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: S(6) }}
                  uiBackground={{ color: leaderboardTab === 'alltime' ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                  onMouseDown={() => { playClickSound(); leaderboardTab = 'alltime'; leaderboardScrollOffset = 0 }}
                >
                  <Label value="All Time" fontSize={S(16)} color={leaderboardTab === 'alltime' ? WHITE : MUTED} font="sans-serif" />
                </UiEntity>
              )}
              {folderTab === 'metrics' && (
                <UiEntity
                  uiTransform={{ flexGrow: 1, height: S(32), flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: S(6) }}
                  uiBackground={{ color: metricsTab === 'daily' ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                  onMouseDown={() => { playClickSound(); metricsTab = 'daily'; visitorScrollOffset = 0 }}
                >
                  <Label value="Daily Metrics" fontSize={S(16)} color={metricsTab === 'daily' ? WHITE : MUTED} font="sans-serif" />
                </UiEntity>
              )}
              {folderTab === 'metrics' && <UiEntity uiTransform={{ width: S(6) }} />}
              {folderTab === 'metrics' && (
                <UiEntity
                  uiTransform={{ flexGrow: 1, height: S(32), flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: S(6) }}
                  uiBackground={{ color: metricsTab === 'monthly' ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                  onMouseDown={() => { playClickSound(); metricsTab = 'monthly'; visitorScrollOffset = 0 }}
                >
                  <Label value="Monthly Metrics" fontSize={S(16)} color={metricsTab === 'monthly' ? WHITE : MUTED} font="sans-serif" />
                </UiEntity>
              )}
              {folderTab === 'status' && (
                <UiEntity uiTransform={{ flexGrow: 1, height: S(32) }} />
              )}
              <UiEntity uiTransform={{ width: S(12) }} />
              <UiEntity
                uiTransform={{
                  width: S(44),
                  height: S(44),
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: S(6),
                  margin: { top: S(-6) },
                }}
                onMouseEnter={() => { closeLeaderboardHovered = true }}
                onMouseLeave={() => { closeLeaderboardHovered = false }}
                onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); closeLeaderboardHovered = false; notifyOverlayClosed() }}
              >
                <Label value="×" fontSize={S(38)} color={closeLeaderboardHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
              </UiEntity>
            </UiEntity>
            <UiEntity uiTransform={{ height: S(12) }} />

            {/* Column header for Daily tab - absolutely positioned */}
            {folderTab !== 'status' && leaderboardTab === 'daily' && totalEntries > 0 && (
              <UiEntity uiTransform={{
                positionType: 'absolute',
                position: { top: S(72), left: S(24), right: S(24 + (totalEntries > LEADERBOARD_PER_PAGE ? 18 : 0)) },
                flexDirection: 'row',
                alignItems: 'center',
                height: S(28),
              }}>
                <Label value="#" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: S(32), height: S(28) }} textAlign="middle-left" />
                <Label value="Player" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: '18%', height: S(28) }} textAlign="middle-left" />
                <Label value={`Wins (${leaderboardEntries.reduce((s, e) => s + (e.roundsWon || 0), 0)})`} fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(28) }} textAlign="middle-left" />
              </UiEntity>
            )}

            {/* Column header for Monthly tab - absolutely positioned */}
            {folderTab !== 'status' && leaderboardTab === 'monthly' && totalEntries > 0 && (
              <UiEntity uiTransform={{
                positionType: 'absolute',
                position: { top: S(72), left: S(24), right: S(24 + (totalEntries > LEADERBOARD_PER_PAGE ? 18 : 0)) },
                flexDirection: 'row',
                alignItems: 'center',
                height: S(28),
              }}>
                <Label value="#" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: S(32), height: S(28) }} textAlign="middle-left" />
                <Label value="Player" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: '18%', height: S(28) }} textAlign="middle-left" />
                <Label value="Address" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(28) }} textAlign="middle-left" />
                <Label value={`Wins (${leaderboardEntries.reduce((s, e) => s + (e.roundsWon || 0), 0)})`} fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: '12%', height: S(28) }} textAlign="middle-left" />
              </UiEntity>
            )}

            {/* Column header for All Time tab - absolutely positioned to stay above data */}
            {folderTab !== 'status' && leaderboardTab === 'alltime' && totalEntries > 0 && (
              <UiEntity uiTransform={{
                positionType: 'absolute',
                position: { top: S(72), left: S(24), right: S(24 + (totalEntries > LEADERBOARD_PER_PAGE ? 18 : 0)) },
                flexDirection: 'row',
                alignItems: 'center',
                height: S(28),
              }}>
                <Label value="#" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: S(32), height: S(28) }} textAlign="middle-left" />
                <Label value="Player" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: '18%', height: S(28) }} textAlign="middle-left" />
                <Label value="Address" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(28) }} textAlign="middle-left" />
                <Label value={`Wins (${leaderboardEntries.reduce((s, e) => s + (e.roundsWon || 0), 0)})`} fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: '12%', height: S(28) }} textAlign="middle-left" />
              </UiEntity>
            )}

            {/* Column header for Metrics tab - absolutely positioned to match All Time tab */}
            {folderTab !== 'status' && leaderboardTab === 'metrics' && (() => {
              const metricsVisitors = metricsTab === 'monthly'
                ? sortVisitorsWithBotSection(getMonthlyVisitors())
                : allVisitors
              const totalVisitors = metricsVisitors.length
              const metricsHasScroll = totalVisitors > VISITORS_PER_PAGE
              return (
              <UiEntity uiTransform={{
                positionType: 'absolute',
                position: { top: S(72), left: S(24), right: S(24 + (metricsHasScroll ? 18 : 0)) },
                flexDirection: 'row',
                alignItems: 'center',
                height: S(28),
              }}>
                <Label value="" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: S(32), height: S(28) }} textAlign="middle-left" />
                <Label value="Player" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: '18%', height: S(28) }} textAlign="middle-left" />
                <Label value="Address" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(28) }} textAlign="middle-left" />
                <Label value="Playtime" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: '12%', height: S(28) }} textAlign="middle-left" />
              </UiEntity>
              )
            })()}

            {/* Metrics tab content (daily or monthly) */}
            {folderTab !== 'status' && leaderboardTab === 'metrics' && (() => {
              const metricsVisitors = metricsTab === 'monthly'
                ? sortVisitorsWithBotSection(getMonthlyVisitors())
                : allVisitors
              const mBotCount = metricsVisitors.filter(v => !('_isSeparator' in v && v._isSeparator) && isLikelyBot(v)).length
              const mVisitorCount = metricsVisitors.filter(v => !('_isSeparator' in v && v._isSeparator)).length - mBotCount
              const mOnlineCount = metricsTab === 'monthly' ? getMonthlyOnlineCount() : onlineCount
              const mTotalPlaytimeMin = Math.floor(metricsVisitors.reduce((sum, v) => sum + v.totalSeconds, 0) / 60)
              const emptyMessage = metricsTab === 'monthly' ? 'No visitors this month' : 'No visitors today'
              const totalVisitors = metricsVisitors.length
              const metricsMaxOffset = Math.max(0, totalVisitors - VISITORS_PER_PAGE)
              if (visitorScrollOffset > metricsMaxOffset) visitorScrollOffset = metricsMaxOffset
              if (visitorScrollOffset < 0) visitorScrollOffset = 0
              const visibleVisitors = metricsVisitors.slice(visitorScrollOffset, visitorScrollOffset + VISITORS_PER_PAGE)
              const metricsCanScrollUp = visitorScrollOffset > 0
              const metricsCanScrollDown = visitorScrollOffset < metricsMaxOffset
              const metricsNeedsScroll = totalVisitors > VISITORS_PER_PAGE
              const metricsThumbRatio = totalVisitors > 0 ? Math.max(0.15, VISITORS_PER_PAGE / totalVisitors) : 1

              return (
              <UiEntity uiTransform={{ width: '100%', flexGrow: 1, flexDirection: 'column' }}>
              <UiEntity uiTransform={{ width: '100%', flexGrow: 1, flexDirection: 'row', margin: { top: S(32) } }}>
                  <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column' }}>
                    {totalVisitors === 0 ? (
                      <UiEntity uiTransform={{ height: S(_ROW_HEIGHT) * 2, justifyContent: 'center', alignItems: 'center' }}>
                        <Label value={emptyMessage} fontSize={S(_ROW_FONT)} color={MUTED} font="sans-serif" />
                      </UiEntity>
                    ) : (
                      visibleVisitors.map((visitor, i) => (
                        (visitor as VisitorOrSeparator)._isSeparator ? (
                          <UiEntity key={`metric-sep-${i}`} uiTransform={{ height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                            <UiEntity uiTransform={{ flexGrow: 1, height: 1, margin: { right: S(8) } }} uiBackground={{ color: Color4.create(0.35, 0.35, 0.4, 0.8) }} />
                            <Label value="Likely Bots" fontSize={S(11)} color={GREY} font="sans-serif" />
                            <UiEntity uiTransform={{ flexGrow: 1, height: 1, margin: { left: S(8) } }} uiBackground={{ color: Color4.create(0.35, 0.35, 0.4, 0.8) }} />
                          </UiEntity>
                        ) : (
                        <UiEntity
                          key={`metric-visitor-${visitor.userId}-${visitorScrollOffset}-${i}`}
                          uiTransform={{
                            height: S(_ROW_HEIGHT),
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'flex-start',
                          }}
                        >
                          <UiEntity uiTransform={{ width: S(32), height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center' }}>
                            <Label value={visitor.isOnline ? "●" : "○"} fontSize={S(14)} color={visitor.isOnline ? WHITE : GREY} font="sans-serif" />
                          </UiEntity>
                          <Label value={visitor.name} fontSize={S(12)} color={WHITE} font="sans-serif" uiTransform={{ width: '18%', height: S(_ROW_HEIGHT) }} textAlign="middle-left" />
                          <Label value={visitor.userId} fontSize={S(12)} color={MUTED} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(_ROW_HEIGHT) }} textAlign="middle-left" />
                          <Label value={formatVisitorTime(visitor.totalSeconds)} fontSize={S(12)} color={WHITE} font="sans-serif" uiTransform={{ width: '12%', height: S(_ROW_HEIGHT) }} textAlign="middle-left" />
                        </UiEntity>
                        )
                      ))
                    )}
                  </UiEntity>

                  {metricsNeedsScroll && (
                    <UiEntity uiTransform={{ width: S(10), flexDirection: 'column', alignItems: 'center', margin: { left: S(8), bottom: S(28) } }}>
                      <UiEntity
                        uiTransform={{ width: S(10), height: S(28), flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
                        onMouseDown={() => { if (metricsCanScrollUp) visitorScrollOffset -= 1 }}
                      >
                        <Label value="▲" fontSize={S(14)} color={metricsCanScrollUp ? WHITE : CLOSE_GREY} font="sans-serif" />
                      </UiEntity>
                      <UiEntity
                        uiTransform={{ width: S(10), flexGrow: 1, flexDirection: 'column', borderRadius: S(0), margin: { top: S(2), bottom: S(2) } }}
                        uiBackground={{ color: Color4.create(0.18, 0.18, 0.2, 1) }}
                      >
                        {(() => {
                          const TRACK_SEGMENTS = 8
                          const segments: any[] = []
                          for (let s = 0; s < TRACK_SEGMENTS; s++) {
                            const segFraction = s / TRACK_SEGMENTS
                            const segTarget = Math.round(segFraction * metricsMaxOffset)
                            const segTopFrac = s / TRACK_SEGMENTS
                            const segBotFrac = (s + 1) / TRACK_SEGMENTS
                            const thumbTopFrac = metricsMaxOffset > 0 ? visitorScrollOffset / metricsMaxOffset * (1 - metricsThumbRatio) : 0
                            const thumbBotFrac = thumbTopFrac + metricsThumbRatio
                            const isThumb = thumbTopFrac < segBotFrac && thumbBotFrac > segTopFrac
                            segments.push(
                              <UiEntity
                                key={`metrics-track-seg-${s}`}
                                uiTransform={{ width: S(10), flexGrow: 1, borderRadius: S(0) }}
                                uiBackground={{ color: isThumb ? Color4.create(0.45, 0.45, 0.5, 1) : Color4.create(0, 0, 0, 0) }}
                                onMouseDown={() => { visitorScrollOffset = segTarget }}
                              />
                            )
                          }
                          return segments
                        })()}
                      </UiEntity>
                      <UiEntity
                        uiTransform={{ width: S(10), height: S(28), flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
                        onMouseDown={() => { if (metricsCanScrollDown) visitorScrollOffset += 1 }}
                      >
                        <Label value="▼" fontSize={S(14)} color={metricsCanScrollDown ? WHITE : CLOSE_GREY} font="sans-serif" />
                      </UiEntity>
                    </UiEntity>
                  )}
                </UiEntity>

            {/* Stats row — absolutely positioned at bottom */}
              <UiEntity
                uiTransform={{
                  height: S(_ROW_HEIGHT),
                  flexDirection: 'row',
                  alignItems: 'center',
                  flexShrink: 0,
                }}
              >
                <UiEntity uiTransform={{ width: '12.5%' }}>
                  <Label value={`Users: ${mVisitorCount}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
                </UiEntity>
                <UiEntity uiTransform={{ width: '12.5%' }}>
                  <Label value={`Bots: ${mBotCount}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
                </UiEntity>
                <UiEntity uiTransform={{ width: '12.5%' }}>
                  <Label value={`Online: ${mOnlineCount}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
                </UiEntity>
                <UiEntity uiTransform={{ width: '12.5%' }}>
                  <Label value={`Server: ${serverConnected}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
                </UiEntity>
                <UiEntity uiTransform={{ width: '12.5%', height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center' }}
                  onMouseDown={localUserId !== null && localUserId.toLowerCase() === ADMIN_ADDRESS ? () => {
                    playClickSound()
                    room.send('testDiscord', { t: Date.now() })
                    discordReportSent = true
                    setTimeout(() => { discordReportSent = false }, 200)
                  } : undefined}
                >
                  <Label value={metricsTab === 'monthly' ? `${formatUTCMonth()}` : `${formatUTCDate()}`} fontSize={S(13)} color={discordReportSent ? GOLD : LIGHT_GREY} font="sans-serif" />
                </UiEntity>
                <UiEntity uiTransform={{ width: '12.5%' }}>
                  <Label value={`${formatUTCTime()}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
                </UiEntity>
                <UiEntity uiTransform={{ width: '12.5%' }}>
                  <Label value={`Play: ${formatPlaytime(mTotalPlaytimeMin)}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
                </UiEntity>
                <UiEntity
                  uiTransform={{ width: '12.5%', height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
                  onMouseDown={() => { playClickSound(); toggleMusicMute() }}
                >
                  <Label value={`Mute: ${musicMuted ? 'Y' : 'N'}`} fontSize={S(13)} color={musicMuted ? GOLD : LIGHT_GREY} font="sans-serif" />
                </UiEntity>

              </UiEntity>
              </UiEntity>
              )
            })()}

            {/* Status tab content */}
            {folderTab === 'status' && (() => {
              const localPlayer = getPlayer()
              const localName = localPlayer?.name ?? 'Unknown'
              const localId = localPlayer?.userId?.toLowerCase() ?? ''
              const coins = getCoinBalance()
              const liveWinsStatus = getLeaderboardEntries().find(e => e.userId.toLowerCase() === localId)?.roundsWon ?? 0
              const myFlags = winsFrozen ? (displayedWins ?? liveWinsStatus) : liveWinsStatus
              const boomerang = getBoomerangColor()
              const boomerangLabel = boomerang === 'r' ? 'Base' : boomerang === 'y' ? 'Dubs' : boomerang === 'b' ? 'Charge' : 'Orbit'

              const STAT_ROW = 34
              const STAT_ICON = 24
              const STAT_FONT = 16
              const SECTION_FONT = 16

              const sectionHeader = (title: string, first: boolean = false) => (
                <UiEntity uiTransform={{ width: '100%', height: S(first ? 28 : 36), flexDirection: 'row', alignItems: 'flex-end', padding: { left: S(10) } }}>
                  <Label value={title} fontSize={S(SECTION_FONT)} color={GOLD} font="sans-serif" />
                </UiEntity>
              )
              const iconRow = (label: string, value: string, iconSrc: string, valueColor: Color4 = WHITE, iconColor: Color4 = Color4.White()) => (
                <UiEntity uiTransform={{ width: '100%', height: S(STAT_ROW), flexDirection: 'row', alignItems: 'center', padding: { left: S(10), right: S(10) } }}>
                  <Label value={label} fontSize={S(STAT_FONT)} color={GREY} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(STAT_ROW) }} textAlign="middle-left" />
                  <Label value={value} fontSize={S(STAT_FONT)} color={valueColor} font="sans-serif" uiTransform={{ height: S(STAT_ROW), margin: { right: S(6) } }} textAlign="middle-right" />
                  <UiEntity uiTransform={{ width: S(STAT_ICON), height: S(STAT_ICON) }} uiBackground={{ textureMode: 'stretch', texture: { src: iconSrc }, color: iconColor }} />
                </UiEntity>
              )

              return (
                <UiEntity uiTransform={{ width: '100%', flexGrow: 1, flexDirection: 'column', padding: { top: S(6), bottom: S(6) } }}>
                  <UiEntity uiTransform={{ width: '100%', padding: { left: S(10), right: S(10), top: S(4), bottom: S(2) } }}>
                    <Label value={localName} fontSize={S(20)} color={WHITE} font="sans-serif" />
                  </UiEntity>

                  {sectionHeader('INVENTORY', true)}
                  {iconRow('Coins', `${coins}`, 'assets/images/coin.png', GOLD, GOLD)}
                  {iconRow('Flags', `${myFlags}`, 'assets/images/flag-icon-white.png', GOLD, GOLD)}

                  {sectionHeader('EQUIPMENT')}
                  {iconRow('Projectile', boomerangLabel, `assets/images/boomerang.${boomerang}.png`)}
                  {iconRow('Trap', 'Banana', 'assets/images/banana-color.png')}
                </UiEntity>
              )
            })()}

            {/* Leaderboard tab content (daily + alltime) */}
            {leaderboardTab !== 'metrics' && folderTab !== 'status' && (
            <UiEntity
              uiTransform={{
                width: '100%',
                flexGrow: 1,
                flexDirection: 'row',
                margin: (leaderboardTab === 'alltime' || leaderboardTab === 'daily' || leaderboardTab === 'monthly') && totalEntries > 0 ? { top: S(32) } : undefined,
              }}
            >
              <UiEntity
                uiTransform={{
                  flexGrow: 1,
                  flexDirection: 'column',
                }}
              >
                {totalEntries === 0 ? (
                  <UiEntity uiTransform={{ height: S(_ROW_HEIGHT) * 2, justifyContent: 'center', alignItems: 'center' }}>
                    <Label value="No champions yet..." fontSize={S(_ROW_FONT)} color={MUTED} font="sans-serif" />
                  </UiEntity>
                ) : (
                  visibleEntries.map((entry, i) => {
                    const isSelf = localUserId !== null && entry.userId === localUserId
                    const nameColor = isSelf ? WHITE : GREY
                    const rank = leaderboardScrollOffset + i + 1
                    return (
                      <UiEntity
                        key={`leaderboard-${entry.userId}-${leaderboardScrollOffset}-${i}`}
                        uiTransform={{
                          height: S(_ROW_HEIGHT),
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'flex-start',
                        }}
                      >
                        {(leaderboardTab === 'daily') ? (
                          <UiEntity uiTransform={{ width: '100%', height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center' }}>
                            <Label value={`${rank}.`} fontSize={S(12)} color={MUTED} font="sans-serif" uiTransform={{ width: S(32), height: S(_ROW_HEIGHT) }} textAlign="middle-left" />
                            <Label value={entry.name} fontSize={S(12)} color={nameColor} font="sans-serif" uiTransform={{ width: '18%', height: S(_ROW_HEIGHT) }} textAlign="middle-left" />
                            <UiEntity uiTransform={{ flexDirection: "row", alignItems: "center", flexGrow: 1, height: S(_ROW_HEIGHT), overflow: 'hidden' }}>
                              {Array.from({ length: entry.roundsWon }, (_, ri) => (
                                <UiEntity key={`rw-${ri}`} uiTransform={{ width: S(14), height: S(14), margin: { right: S(2) } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />
                              ))}
                            </UiEntity>
                          </UiEntity>
                        ) : (
                          <UiEntity uiTransform={{ width: '100%', height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center' }}>
                            <Label value={`${rank}.`} fontSize={S(12)} color={MUTED} font="sans-serif" uiTransform={{ width: S(32), height: S(_ROW_HEIGHT) }} textAlign="middle-left" />
                            <Label value={entry.name} fontSize={S(12)} color={nameColor} font="sans-serif" uiTransform={{ width: '18%', height: S(_ROW_HEIGHT) }} textAlign="middle-left" />
                            <Label value={entry.userId || ''} fontSize={S(12)} color={MUTED} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(_ROW_HEIGHT) }} textAlign="middle-left" />
                            <Label value={`${entry.roundsWon}`} fontSize={S(12)} color={GOLD} font="sans-serif" uiTransform={{ width: '12%', height: S(_ROW_HEIGHT) }} textAlign="middle-left" />
                          </UiEntity>
                        )}
                      </UiEntity>
                    )
                  })
                )}
              </UiEntity>

              {lbNeedsScroll && (
                <UiEntity
                  uiTransform={{
                    width: S(10),
                    flexDirection: 'column',
                    alignItems: 'center',
                    margin: { left: S(8) },
                  }}
                >
                  <UiEntity
                    uiTransform={{
                      width: S(10), height: S(28),
                      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
                    }}
                    onMouseDown={() => { if (lbCanScrollUp) leaderboardScrollOffset -= 1 }}
                  >
                    <Label value="▲" fontSize={S(14)} color={lbCanScrollUp ? WHITE : CLOSE_GREY} font="sans-serif" />
                  </UiEntity>

                  <UiEntity
                    uiTransform={{
                      width: S(10), flexGrow: 1, flexDirection: 'column',
                      borderRadius: S(0), margin: { top: S(2), bottom: S(2) },
                    }}
                    uiBackground={{ color: Color4.create(0.18, 0.18, 0.2, 1) }}
                  >
                    {(() => {
                      const TRACK_SEGMENTS = 8
                      const segments: any[] = []
                      for (let s = 0; s < TRACK_SEGMENTS; s++) {
                        const segFraction = s / TRACK_SEGMENTS
                        const segTarget = Math.round(segFraction * lbMaxOffset)
                        const segTopFrac = s / TRACK_SEGMENTS
                        const segBotFrac = (s + 1) / TRACK_SEGMENTS
                        const thumbTopFrac = lbMaxOffset > 0 ? leaderboardScrollOffset / lbMaxOffset * (1 - lbThumbRatio) : 0
                        const thumbBotFrac = thumbTopFrac + lbThumbRatio
                        const isThumb = thumbTopFrac < segBotFrac && thumbBotFrac > segTopFrac
                        segments.push(
                          <UiEntity
                            key={`lb-track-seg-${s}`}
                            uiTransform={{ width: S(10), flexGrow: 1, borderRadius: S(0) }}
                            uiBackground={{ color: isThumb ? Color4.create(0.45, 0.45, 0.5, 1) : Color4.create(0, 0, 0, 0) }}
                            onMouseDown={() => { leaderboardScrollOffset = segTarget }}
                          />
                        )
                      }
                      return segments
                    })()}
                  </UiEntity>

                  <UiEntity
                    uiTransform={{
                      width: S(10), height: S(28),
                      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
                    }}
                    onMouseDown={() => { if (lbCanScrollDown) leaderboardScrollOffset += 1 }}
                  >
                    <Label value="▼" fontSize={S(14)} color={lbCanScrollDown ? WHITE : CLOSE_GREY} font="sans-serif" />
                  </UiEntity>
                </UiEntity>
              )}
            </UiEntity>
            )}
          </UiEntity>
          </UiEntity>
        </UiEntity>
        )
      })()}

      {/* Analytics overlay */}
      {analyticsOverlayVisible && (() => {
        const totalVisitors = allVisitors.length
        const maxOffset = Math.max(0, totalVisitors - VISITORS_PER_PAGE)
        if (visitorScrollOffset > maxOffset) visitorScrollOffset = maxOffset
        if (visitorScrollOffset < 0) visitorScrollOffset = 0
        const visibleVisitors = allVisitors.slice(visitorScrollOffset, visitorScrollOffset + VISITORS_PER_PAGE)
        const canScrollUp = visitorScrollOffset > 0
        const canScrollDown = visitorScrollOffset < maxOffset
        const needsScroll = totalVisitors > VISITORS_PER_PAGE

        const thumbRatio = totalVisitors > 0 ? Math.max(0.15, VISITORS_PER_PAGE / totalVisitors) : 1

        return (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left: S(0), top: S(0) },
            width: '100%',
            height: '100%',
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <UiEntity
            uiTransform={{
              positionType: 'relative',
              width: S(_OVERLAY_PANEL_WIDTH),
              height: S(_OVERLAY_PANEL_HEIGHT),
              flexDirection: 'column',
              alignItems: 'flex-start',
              borderRadius: S(20),
              padding: S(24),
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: S(4), right: S(4) },
                width: S(80),
                height: S(80),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={() => { closeAnalyticsHovered = true }}
              onMouseLeave={() => { closeAnalyticsHovered = false }}
              onMouseDown={() => { playClickSound(); setAnalyticsOverlayVisible(false); closeAnalyticsHovered = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={S(44)} color={closeAnalyticsHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Daily Visitors" fontSize={S(28)} color={GOLD} font="sans-serif" textAlign="top-left" />
            <UiEntity uiTransform={{ height: S(16) }} />
            
            <UiEntity
              uiTransform={{
                width: '100%',
                height: S(_ROW_HEIGHT),
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <UiEntity uiTransform={{ width: '12.5%' }}>
                <Label value={`Users: ${allVisitors.filter(v => !isLikelyBot(v)).length}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '12.5%' }}>
                <Label value={`Bots: ${allVisitors.filter(v => isLikelyBot(v)).length}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '12.5%' }}>
                <Label value={`Online: ${onlineCount}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '12.5%' }}>
                <Label value={`Server: ${serverConnected}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '12.5%', height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center' }}
                onMouseDown={localUserId !== null && localUserId.toLowerCase() === ADMIN_ADDRESS ? () => {
                  playClickSound()
                  room.send('testDiscord', { t: Date.now() })
                  discordReportSent = true
                  setTimeout(() => { discordReportSent = false }, 200)
                } : undefined}
              >
                <Label value={`${formatUTCDate()}`} fontSize={S(13)} color={discordReportSent ? GOLD : LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '12.5%' }}>
                <Label value={`${formatUTCTime()}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '12.5%' }}>
                <Label value={`Play: ${formatPlaytime(totalPlaytimeMin)}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity
                uiTransform={{ width: '12.5%', height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
                onMouseDown={() => { playClickSound(); toggleMusicMute() }}
              >
                <Label value={`Mute: ${musicMuted ? 'Y' : 'N'}`} fontSize={S(13)} color={musicMuted ? GOLD : LIGHT_GREY} font="sans-serif" />
              </UiEntity>
            </UiEntity>
            
            <UiEntity uiTransform={{ height: S(20) }} />
            
            <UiEntity
              uiTransform={{
                width: '100%',
                flexDirection: 'row',
              }}
            >
              <UiEntity
                uiTransform={{
                  flexGrow: 1,
                  flexDirection: 'column',
                }}
              >
                {totalVisitors === 0 ? (
                  <UiEntity uiTransform={{ height: S(_ROW_HEIGHT) * 2, justifyContent: 'center', alignItems: 'center' }}>
                    <Label value="No visitors today" fontSize={S(_ROW_FONT)} color={MUTED} font="sans-serif" />
                  </UiEntity>
                ) : (
                  visibleVisitors.map((visitor, i) => (
                      <UiEntity
                        key={`visitor-${visitor.userId}-${visitorScrollOffset}-${i}`}
                        uiTransform={{
                          width: '100%',
                          height: (S(_ROW_HEIGHT) + S(4)),
                          flexDirection: 'row',
                          alignItems: 'center',
                          padding: { left: S(0), right: S(8), top: S(2), bottom: S(2) },
                        }}
                      >
                        <UiEntity uiTransform={{ width: '5%', flexDirection: 'row', alignItems: 'center' }}>
                          <Label 
                            value={visitor.isOnline ? "●" : "○"} 
                            fontSize={S(14)} 
                            color={visitor.isOnline ? WHITE : GREY} 
                            font="sans-serif" 
                          />
                        </UiEntity>
                        <UiEntity uiTransform={{ width: '22%', overflow: 'hidden', height: (S(_ROW_HEIGHT) + S(4)), maxHeight: (S(_ROW_HEIGHT) + S(4)) }}>
                          <Label value={visitor.name} fontSize={S(12)} color={WHITE} font="sans-serif" />
                        </UiEntity>
                        <UiEntity uiTransform={{ width: '61%', overflow: 'hidden', height: (S(_ROW_HEIGHT) + S(4)), maxHeight: (S(_ROW_HEIGHT) + S(4)), padding: { left: S(16) } }}>
                          <Label value={visitor.userId} fontSize={S(12)} color={WHITE} font="sans-serif" />
                        </UiEntity>
                        <UiEntity uiTransform={{ width: '12%', flexDirection: 'row', justifyContent: 'flex-end' }}>
                          <Label value={formatVisitorTime(visitor.totalSeconds)} fontSize={S(12)} color={WHITE} font="sans-serif" />
                        </UiEntity>
                      </UiEntity>
                    ))
                )}
              </UiEntity>

              {needsScroll && (
                <UiEntity
                  uiTransform={{
                    width: S(10),
                    flexDirection: 'column',
                    alignItems: 'center',
                    margin: { left: S(4) },
                  }}
                >
                  <UiEntity
                    uiTransform={{
                      width: S(10), height: S(28),
                      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
                    }}
                    onMouseDown={() => { if (canScrollUp) visitorScrollOffset -= 1 }}
                  >
                    <Label value="▲" fontSize={S(14)} color={canScrollUp ? WHITE : CLOSE_GREY} font="sans-serif" />
                  </UiEntity>

                  <UiEntity
                    uiTransform={{
                      width: S(10), flexGrow: 1, flexDirection: 'column',
                      borderRadius: S(0), margin: { top: S(2), bottom: S(2) },
                    }}
                    uiBackground={{ color: Color4.create(0.18, 0.18, 0.2, 1) }}
                  >
                    {(() => {
                      const TRACK_SEGMENTS = 8
                      const segments: any[] = []
                      for (let s = 0; s < TRACK_SEGMENTS; s++) {
                        const segFraction = s / TRACK_SEGMENTS
                        const segTarget = Math.round(segFraction * maxOffset)
                        const segTopFrac = s / TRACK_SEGMENTS
                        const segBotFrac = (s + 1) / TRACK_SEGMENTS
                        const thumbTopFrac = maxOffset > 0 ? visitorScrollOffset / maxOffset * (1 - thumbRatio) : 0
                        const thumbBotFrac = thumbTopFrac + thumbRatio
                        const isThumb = thumbTopFrac < segBotFrac && thumbBotFrac > segTopFrac
                        segments.push(
                          <UiEntity
                            key={`track-seg-${s}`}
                            uiTransform={{ width: S(10), flexGrow: 1, borderRadius: S(0) }}
                            uiBackground={{ color: isThumb ? Color4.create(0.45, 0.45, 0.5, 1) : Color4.create(0, 0, 0, 0) }}
                            onMouseDown={() => { visitorScrollOffset = segTarget }}
                          />
                        )
                      }
                      return segments
                    })()}
                  </UiEntity>

                  <UiEntity
                    uiTransform={{
                      width: S(10), height: S(28),
                      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
                    }}
                    onMouseDown={() => { if (canScrollDown) visitorScrollOffset += 1 }}
                  >
                    <Label value="▼" fontSize={S(14)} color={canScrollDown ? WHITE : CLOSE_GREY} font="sans-serif" />
                  </UiEntity>
                </UiEntity>
              )}
            </UiEntity>
          </UiEntity>
        </UiEntity>
        )
      })()}

      {/* ── Ability icons — bottom center (hidden during cinematic/overlays) ── */}
      {!cinematicShowing && !isSpectatorMode() && !isSpectatorTransitioning() && <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { bottom: S(24) },
          width: '100%',
          flexDirection: 'row',
          justifyContent: 'center',
          display: 'flex',
        }}
      >
        <UiEntity
          uiTransform={{
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          {/* Projectile (E) */}
          <UiEntity
            uiTransform={{
              width: S(_ABILITY_BTN_SIZE), height: S(_ABILITY_BTN_SIZE),
              flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              borderRadius: S(_BORDER_RADIUS),
              margin: { right: S(8) },
            }}
            uiBackground={{ color: PANEL_BG_SEMI }}
          >
            <Label value="E" fontSize={S(16)} color={LIGHT_GREY} font="sans-serif"
              uiTransform={{ positionType: 'absolute', position: { top: S(-2), left: S(5) } }}
            />
            {/* Charge fill — behind icon, in front of background */}
            {(getIsCharging() || getBurnoutFlash()) && (() => {
              const burnout = getBurnoutFlash()
              const cf = burnout ? 1 : getChargeFraction()
              const fillPct = Math.round(cf * 100)
              const fillColor = burnout
                ? Color4.create(1, 0.15, 0.1, 0.9)
                : cf >= 1.25 / 1.5
                ? Color4.create(1, 0.84, 0, 0.85)
                : Color4.create(1, 1, 1, 0.5)
              const inset = S(6)
              return (
                <UiEntity uiTransform={{
                  positionType: 'absolute',
                  position: { bottom: inset, left: inset, right: inset },
                  height: `${fillPct}%`,
                  maxHeight: S(_ABILITY_BTN_SIZE) - inset * 2,
                  borderRadius: S(_BORDER_RADIUS),
                }}
                uiBackground={{ color: fillColor }}
                />
              )
            })()}
            <UiEntity
              uiTransform={{ width: (S(_ABILITY_ICON_SIZE) - 6) * 1.5, height: (S(_ABILITY_ICON_SIZE) - 6) * 1.5, margin: { top: S(-2) }, positionType: 'absolute' }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` },
                color: isProjectileOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White()
              }}
            />
            {isProjectileOnCooldown() && getProjectileCooldownRemaining() > 0 && (
              <Label value={`${getProjectileCooldownRemaining()}`} fontSize={S(26)} color={WHITE} font="sans-serif"
                uiTransform={{ positionType: 'absolute' }}
              />
            )}


          </UiEntity>

          {/* Trap (F) */}
          <UiEntity
            uiTransform={{
              width: S(_ABILITY_BTN_SIZE), height: S(_ABILITY_BTN_SIZE),
              flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              borderRadius: S(_BORDER_RADIUS),
              margin: { left: S(8) },
            }}
            uiBackground={{ color: PANEL_BG_SEMI }}
          >
            <Label value="F" fontSize={S(16)} color={LIGHT_GREY} font="sans-serif"
              uiTransform={{ positionType: 'absolute', position: { top: S(-2), left: S(5) } }}
            />
            <UiEntity
              uiTransform={{ width: S(_ABILITY_ICON_SIZE) * 1.3, height: S(_ABILITY_ICON_SIZE) * 1.3, margin: { top: S(2) } }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: 'assets/images/banana-color.png' },
                color: isTrapOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White()
              }}
            />
            {isTrapOnCooldown() && (
              <Label value={`${getTrapCooldownRemaining()}`} fontSize={S(26)} color={WHITE} font="sans-serif"
                uiTransform={{ positionType: 'absolute' }}
              />
            )}
          </UiEntity>
        </UiEntity>
      </UiEntity>}

      {/* ── Right-side container: scoreboard + icon buttons ── */}
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { right: S(16), top: S(14) },
          flexDirection: 'row',
          alignItems: 'flex-start',
        }}
      >
        {/* Icon buttons — to the left of scoreboard */}
        <UiEntity
          uiTransform={{
            width: S(46),
            height: S(2 * _ROW_HEIGHT + 2 * _PADDING),
            flexDirection: 'column',
            alignItems: 'center',
            margin: { right: S(4) },
          }}
        >
          <UiEntity uiTransform={{ positionType: 'relative', width: S(46), height: S(_ROW_HEIGHT + _PADDING - 2) }}>
            {squareIconHovered && (
              <UiEntity
                uiTransform={{ positionType: 'absolute', position: { right: 0, top: 0 }, width: S(140), height: S(_ROW_HEIGHT + _PADDING - 2), borderRadius: S(_BORDER_RADIUS), flexDirection: 'row', alignItems: 'center' }}
                uiBackground={{ color: PANEL_BG }}
              >
                <Label value="Menus" fontSize={S(_TITLE_FONT)} color={GOLD} font="sans-serif" uiTransform={{ width: S(100), height: S(_ROW_HEIGHT + _PADDING - 2), margin: { top: S(-2), left: S(18) } }} textAlign="middle-left" />
              </UiEntity>
            )}
            <UiEntity
              uiTransform={{ positionType: 'absolute', position: { top: 0, right: 0 }, width: S(46), height: S(_ROW_HEIGHT + _PADDING - 2), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: S(_BORDER_RADIUS) }}
              uiBackground={{ color: PANEL_BG }}
              onMouseEnter={() => { squareIconHovered = true; playHoverSound() }}
              onMouseLeave={() => { squareIconHovered = false }}
              onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); setAnalyticsOverlayVisible(false); leaderboardScrollOffset = 0; leaderboardTab = 'daily'; folderTab = 'leaderboards'; toggleLeaderboardOverlay(); notifyOverlayClosed() }}
            >
              <UiEntity uiTransform={{ width: S(17), height: S(17) }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: leaderboardOverlayVisible || squareIconHovered ? GOLD : WHITE }} />
            </UiEntity>
          </UiEntity>
          <UiEntity uiTransform={{ height: S(4) }} />
          <UiEntity uiTransform={{ positionType: 'relative', width: S(46), height: S(_ROW_HEIGHT + _PADDING - 2) }}>
            {questionIconHovered && (
              <UiEntity
                uiTransform={{ positionType: 'absolute', position: { right: 0, top: 0 }, width: S(140), height: S(_ROW_HEIGHT + _PADDING - 2), borderRadius: S(_BORDER_RADIUS), flexDirection: 'row', alignItems: 'center' }}
                uiBackground={{ color: PANEL_BG }}
              >
                <Label value="Help" fontSize={S(_TITLE_FONT)} color={GOLD} font="sans-serif" uiTransform={{ width: S(100), height: S(_ROW_HEIGHT + _PADDING - 2), margin: { top: S(-2), left: S(18) } }} textAlign="middle-left" />
              </UiEntity>
            )}
            <UiEntity
              uiTransform={{ positionType: 'absolute', position: { top: 0, right: 0 }, width: S(46), height: S(_ROW_HEIGHT + _PADDING - 2), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: S(_BORDER_RADIUS) }}
              uiBackground={{ color: PANEL_BG }}
              onMouseEnter={() => { questionIconHovered = true; playHoverSound() }}
              onMouseLeave={() => { questionIconHovered = false }}
              onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); setAnalyticsOverlayVisible(false); toggleWinConditionOverlay(); notifyOverlayClosed() }}
            >
              <Label value="?" fontSize={S(24)} color={winConditionOverlayVisible || questionIconHovered ? GOLD : WHITE} font="sans-serif" />
            </UiEntity>
          </UiEntity>
        </UiEntity>
        {/* ── Stats square — coin + flag win counters ── */}
        {(() => {
          const panelH = S(2 * _ROW_HEIGHT + 2 * _PADDING)
          const panelW = S(3 * _ROW_HEIGHT + 2 * _PADDING)
          const localId = getPlayer()?.userId?.toLowerCase() ?? ''
          const liveWins = getLeaderboardEntries().find(e => e.userId.toLowerCase() === localId)?.roundsWon ?? 0
          if (!winsFrozen) displayedWins = liveWins
          const myWins = displayedWins ?? liveWins
          return (
            <UiEntity
              uiTransform={{
                width: panelW, height: panelH,
                flexDirection: 'column',
                alignItems: 'flex-start',
                justifyContent: 'center',
                padding: { left: S(_PADDING) },
                margin: { right: S(4) },
                borderRadius: S(_BORDER_RADIUS),
              }}
              uiBackground={{ color: PANEL_BG }}
            >
              {/* Coin counter */}
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: S(0) } }}>
                <UiEntity
                  uiTransform={{ width: S(20), height: S(20), margin: { right: S(6) } }}
                  uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.White() }}
                />
                <Label value={`${getCoinBalance()}`} fontSize={S(18)} color={WHITE} font="sans-serif" />
              </UiEntity>
              {/* Flag wins counter */}
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { top: S(0) } }}>
                <UiEntity
                  uiTransform={{ width: S(18), height: S(18), margin: { right: S(6) } }}
                  uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }}
                />
                <Label value={`${myWins}`} fontSize={S(18)} color={WHITE} font="sans-serif" />
              </UiEntity>
            </UiEntity>
          )
        })()}
        {/* Scoreboard panel */}
        <UiEntity
          uiTransform={{
            width: S(_PANEL_WIDTH),
            flexDirection: 'column',
            alignItems: 'stretch',
            borderRadius: S(_BORDER_RADIUS),
            padding: S(_PADDING),
          }}
          uiBackground={{ color: PANEL_BG }}
        >
        <UiEntity
          uiTransform={{
            height: S(_ROW_HEIGHT),
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Label value="Scoreboard" fontSize={S(_TITLE_FONT)} color={MUTED} font="sans-serif" />
        </UiEntity>
        {players.length === 0 ? (
          <UiEntity uiTransform={{ height: S(_ROW_HEIGHT) * 2, justifyContent: 'center', alignItems: 'center' }}>
            <Label value="Waiting for players..." fontSize={S(_ROW_FONT)} color={MUTED} font="sans-serif" />
          </UiEntity>
        ) : (
          players.map((p, i) => {
            const isLeader = leaderUserId !== null && p.userId === leaderUserId
            const isSelf = localUserId !== null && p.userId === localUserId
            const isCarrier = carrierUserId !== null && p.userId === carrierUserId
            const nameColor = isLeader ? BRIGHT_GOLD : isSelf ? BRIGHT_WHITE : LIGHT_GREY
            const timeColor = isLeader ? GOLD : p.seconds > 0 ? WHITE : MUTED
            const rowBg = isLeader ? Color4.create(0.3, 0.25, 0.1, 0.3) : Color4.create(0, 0, 0, 0)
            
            return (
              <UiEntity
                key={`${p.userId}-${i}`}
                uiTransform={{
                  height: S(_ROW_HEIGHT),
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: { left: S(8), right: S(8), top: S(2), bottom: S(2) },
                  borderRadius: S(6)
                }}
                uiBackground={{ color: rowBg }}
              >
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                  {isCarrier ? (
                    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                      <UiEntity uiTransform={{ width: S(16), height: S(16), margin: { right: S(4) } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />
                      <Label value={p.name} fontSize={S(_ROW_FONT)} color={nameColor} font="sans-serif" />
                    </UiEntity>
                  ) : (
                    <Label value={p.name} fontSize={S(_ROW_FONT)} color={nameColor} font="sans-serif" />
                  )}
                </UiEntity>
                <Label value={`${p.seconds}`} fontSize={S(_ROW_FONT)} color={timeColor} font="sans-serif" />
              </UiEntity>
            )
          })
        )}
        </UiEntity>
        
      </UiEntity>
    </UiEntity>
  )
}

// ═══════════════════════════════════════════════════════════
// MOBILE LAYOUT
// ═══════════════════════════════════════════════════════════
// Safe area: center 50% width (25%-75%), full height in center.
// Top-right 25% x 23% blocked (profile/camera).
// Bottom-right 25% x 45% blocked (action buttons 1-4, E, F).
// Left 25% x 100% blocked (chat, joystick, emotes).
// No border-radius on mobile. Fonts scaled ~2-3× for readability.

// (Mobile constants cleaned up — using inline values now)

// Mobile scoreboard overlay (full scoreboard popup)
let mobileScoreboardOverlayVisible = false

function MobileLayout() {
  const rawPlayers = getPlayersWithHoldTimes()
  const players = rawPlayers
  const localUserId = getPlayer()?.userId ?? null
  const leaderUserId =
    players.length > 0 && players[0].seconds > 0 ? players[0].userId : null
  const carrierUserId = getCurrentFlagCarrierUserId()
  const countdownSeconds = getCountdownSeconds()

  const winConditionOverlayVisible = getWinConditionOverlayVisible()
  const leaderboardOverlayVisible = getLeaderboardOverlayVisible()
  const rawLeaderboardEntries = leaderboardTab === 'monthly' ? getMonthlyLeaderboardEntries() : leaderboardTab === 'alltime' ? getAllTimeLeaderboardEntries() : getLeaderboardEntries()
  const leaderboardEntries = getSortedLeaderboardEntries(rawLeaderboardEntries)

  // Mobile circle style constants
  const M_CIRCLE_SIZE = 68
  const M_CIRCLE_TEXTURE = 'assets/images/UI_circle.png'
  const M_CIRCLE_OPACITY = Color4.create(1, 1, 1, 0.8) // 80% opacity for circle PNG
  const M_ICON_SIZE = 50

  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: '100%',
        positionType: 'relative',
      }}
    >
      {/* ── Top bar: [? ★ #] left — [timer] [score] center — [🍌 🐚 ⚔] right ── */}
      {(() => {
        const localPlayer = players.find(p => localUserId !== null && p.userId === localUserId)
        const myScore = localPlayer ? localPlayer.seconds : 0
        const isLeader = localPlayer && leaderUserId !== null && localPlayer.userId === leaderUserId
        const hasFlag = localPlayer && carrierUserId !== null && localPlayer.userId === carrierUserId
        const scoreColor = isLeader ? GOLD : WHITE

        return (
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: 28 },
              width: '100%',
              height: 68,
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            {/* Timer + Score + Menu icons — all centered */}
            <UiEntity
              uiTransform={{
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <UiEntity
                uiTransform={{
                  height: 68,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  padding: { left: 28, right: 28 },
                  borderRadius: 34,
                  margin: { right: 10 },
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/UI_pill_timer.png' } }}
              >
                <Label value={formatCountdown(countdownSeconds)} fontSize={32} color={WHITE} font="sans-serif" />
              </UiEntity>

              <UiEntity
                uiTransform={{
                  height: 68,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  padding: { left: 18, right: 30 },
                  borderRadius: 34,
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/UI_pill_score.png' } }}
                onMouseDown={() => {
                  playClickSound()
                  setWinConditionOverlayVisible(false)
                  setAnalyticsOverlayVisible(false)
                  setLeaderboardOverlayVisible(false)
                  mobileScoreboardOverlayVisible = !mobileScoreboardOverlayVisible
                }}
              >
                <UiEntity
                  uiTransform={{
                    width: 34,
                    height: 34,
                    margin: { right: 8 },
                  }}
                  uiBackground={{
                    textureMode: 'stretch',
                    texture: { src: 'assets/images/expand.png' },
                    color: Color4.White()
                  }}
                />
                <Label value="Score:" fontSize={32} color={scoreColor} font="sans-serif" />
                <UiEntity uiTransform={{ width: 6 }} />
                <Label value={`${myScore}`} fontSize={32} color={scoreColor} font="sans-serif" />
                {hasFlag && (
                  <UiEntity uiTransform={{ width: 22, height: 22, margin: { left: 6 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />
                )}
              </UiEntity>

              {/* ? icon */}
              <UiEntity
                uiTransform={{
                  width: M_CIRCLE_SIZE, height: M_CIRCLE_SIZE,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  margin: { left: 10 },
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
                onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); setAnalyticsOverlayVisible(false); mobileScoreboardOverlayVisible = false; toggleWinConditionOverlay(); notifyOverlayClosed() }}
              >
                <Label value="?" fontSize={36} color={winConditionOverlayVisible ? GOLD : WHITE} font="sans-serif" />
              </UiEntity>

              {/* Leaderboard (flag) icon */}
              <UiEntity
                uiTransform={{
                  width: M_CIRCLE_SIZE, height: M_CIRCLE_SIZE,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  margin: { left: 6 },
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
                onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); setAnalyticsOverlayVisible(false); mobileScoreboardOverlayVisible = false; leaderboardScrollOffset = 0; leaderboardTab = 'daily'; folderTab = 'leaderboards'; toggleLeaderboardOverlay(); notifyOverlayClosed() }}
              >
                <UiEntity uiTransform={{ width: 26, height: 26 }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: leaderboardOverlayVisible ? GOLD : WHITE }} />
              </UiEntity>
            </UiEntity>

          </UiEntity>
        )
      })()}

      {/* Coin wallet removed — moved into stats square next to ability bar */}

      {/* ── Mobile Ability Bar — bottom center, clickable, 2x size ── */}
      {!isSpectatorMode() && (() => {
        const AB_SIZE = Math.round(M_CIRCLE_SIZE * 1.65)
        const AB_ICON = Math.round(M_ICON_SIZE * 1.65)
        return (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { bottom: 44, left: '50%' },
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            margin: { left: -(AB_SIZE + 10) },
          }}
        >
          {/* Banana */}
          <UiEntity
            uiTransform={{
              width: AB_SIZE, height: AB_SIZE,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              margin: { right: 20 },
            }}
            uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
            onMouseDown={() => { triggerTrapFromUI() }}
          >
            <UiEntity
              uiTransform={{ width: Math.round(AB_ICON * 1.25), height: Math.round(AB_ICON * 1.25) }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: 'assets/images/banana-color.png' },
                color: isTrapOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White()
              }}
            />
            {isTrapOnCooldown() && (
              <Label value={`${getTrapCooldownRemaining()}`} fontSize={52} color={WHITE} font="sans-serif"
                uiTransform={{ positionType: 'absolute' }}
              />
            )}
          </UiEntity>

          {/* Boomerang */}
          <UiEntity
            uiTransform={{
              width: AB_SIZE, height: AB_SIZE,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
            }}
            uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
            onMouseDown={() => { triggerProjectileFromUI() }}
          >
            <UiEntity
              uiTransform={{ width: (AB_ICON - 8) * 1.5, height: (AB_ICON - 8) * 1.5, margin: { top: -8 } }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` },
                color: isProjectileOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White()
              }}
            />
            {isProjectileOnCooldown() && getProjectileCooldownRemaining() > 0 && (
              <Label value={`${getProjectileCooldownRemaining()}`} fontSize={52} color={WHITE} font="sans-serif"
                uiTransform={{ positionType: 'absolute' }}
              />
            )}
          </UiEntity>
        </UiEntity>
        )
      })()}

      {/* ── Mobile Scoreboard Overlay — full scoreboard in center ── */}
      {mobileScoreboardOverlayVisible && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left: 0, top: 0 },
            width: '100%', height: '100%',
            flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
          }}
        >
          <UiEntity
            uiTransform={{
              positionType: 'relative',
              width: '42%',
              height: '62%',
              flexDirection: 'column',
              alignItems: 'stretch',
              padding: 28,
              overflow: 'hidden',
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            {/* Close button */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 4, right: 4 },
                width: 88, height: 88,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseDown={() => { playClickSound(); mobileScoreboardOverlayVisible = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={52} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Scoreboard" fontSize={36} color={MUTED} font="sans-serif" uiTransform={{ height: 44, flexShrink: 0 }} />
            <UiEntity uiTransform={{ height: 12, flexShrink: 0 }} />

            <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column' }}>
              {players.length === 0 ? (
                <UiEntity uiTransform={{ height: 44 * 2, justifyContent: 'center', alignItems: 'center' }}>
                  <Label value="Waiting for players..." fontSize={22} color={MUTED} font="sans-serif" />
                </UiEntity>
              ) : (
                players.map((p, i) => {
                  const isPlayerLeader = leaderUserId !== null && p.userId === leaderUserId
                  const isSelf = localUserId !== null && p.userId === localUserId
                  const isCarrier = carrierUserId !== null && p.userId === carrierUserId
                  const nameColor = isPlayerLeader ? BRIGHT_GOLD : isSelf ? BRIGHT_WHITE : LIGHT_GREY
                  const timeColor = isPlayerLeader ? GOLD : p.seconds > 0 ? WHITE : MUTED
                  const rowBg = isPlayerLeader ? Color4.create(0.3, 0.25, 0.1, 0.3) : Color4.create(0, 0, 0, 0)
                  
                  return (
                    <UiEntity
                      key={`m-sb-${p.userId}-${i}`}
                      uiTransform={{
                        height: 44,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: { left: 8, right: 8, top: 2, bottom: 2 },
                      }}
                      uiBackground={{ color: rowBg }}
                    >
                      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                        {isCarrier && (
                          <UiEntity uiTransform={{ width: 16, height: 16, margin: { right: 4 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />
                        )}
                        <Label value={p.name} fontSize={22} color={nameColor} font="sans-serif" />
                      </UiEntity>
                      <Label value={`${p.seconds}`} fontSize={22} color={timeColor} font="sans-serif" />
                    </UiEntity>
                  )
                })
              )}
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}

      {/* ── Round-end splash — bottom of screen (safe area) ── */}
      {splashVisible && cinematicShowing && splashPlayers.length > 0 && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 0, left: 0 },
            width: '100%',
            height: '100%',
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'flex-end',
            padding: { bottom: 114 },
          }}
        >
          <UiEntity
            uiTransform={{
              positionType: 'relative',
              width: '40%',
              minHeight: 300,
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: { top: 36, bottom: 28, left: 32, right: 32 },
              overflow: 'hidden',
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 4, right: 4 },
                width: 88, height: 88,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseDown={() => { playClickSound(); splashVisible = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={52} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>

            <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
              <Label
                value={splashPlayers.length === 1 || splashPlayers[0].seconds > (splashPlayers[1]?.seconds ?? 0)
                  ? `${splashPlayers[0].name} Wins!`
                  : 'Round Over!'}
                fontSize={42}
                color={GOLD}
                font="sans-serif"
              />
              <UiEntity uiTransform={{ height: 24 }} />
              {splashPlayers.map((p, i) => {
                const rankColor = i === 0 ? GOLD : i === 1 ? SILVER : BRONZE
                return (
                  <UiEntity
                    key={`m-splash-${i}`}
                    uiTransform={{
                      width: '100%', height: 42,
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                      padding: { left: 8, right: 8 },
                    }}
                  >
                    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Label value={`#${i + 1}`} fontSize={26} color={rankColor} font="sans-serif" />
                      <UiEntity uiTransform={{ width: 10 }} />
                      <Label value={p.name} fontSize={26} color={rankColor} font="sans-serif" />
                    </UiEntity>
                    <Label value={`${p.seconds}`} fontSize={26} color={LIGHT_GREY} font="sans-serif" />
                  </UiEntity>
                )
              })}
              <UiEntity uiTransform={{ height: 20 }} />
              <Label value="Next round starting..." fontSize={22} color={LIGHT_GREY} font="sans-serif" uiTransform={{ width: 500, flexShrink: 0 }} textAlign="middle-center" />
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}

      {/* ── How to Play overlay — 3-column card layout (mobile, matches desktop) ── */}
      {winConditionOverlayVisible && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left: 0, top: 0 },
            width: '100%', height: '100%',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          {/* 3-column cards row */}
          <UiEntity
            uiTransform={{
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'stretch',
              width: '56%',
              margin: { bottom: 14 },
            }}
            onMouseDown={() => {}}
          >
            {/* ── Flag Card ── */}
            <UiEntity
              uiTransform={{
                width: '32%',
                height: 480,
                flexDirection: 'column',
                alignItems: 'center',
                borderRadius: 16,
                padding: { top: 14, bottom: 14, left: 16, right: 16 },
                margin: { right: 4 },
              }}
              uiBackground={{ color: Color4.create(0.15, 0.12, 0.12, 0.92) }}
            >
              <Label value="Flag" fontSize={28} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: 12 } }} />
              <Label value={"Find the Flag by following\nthe gold beacon"} fontSize={13} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: 4 } }} />
              {/* Flag beacon image */}
              <UiEntity
                uiTransform={{
                  width: 160,
                  flexGrow: 1,
                  borderRadius: 8,
                  margin: { top: 4 },
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/beacon2.png' } }}
              />
              <Label value={"Move close to the Flag to pickup\nor steal it from another player"} fontSize={13} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { top: 8 } }} />
            </UiEntity>

            {/* ── Combat Card ── */}
            <UiEntity
              uiTransform={{
                width: '32%',
                height: 480,
                flexDirection: 'column',
                alignItems: 'center',
                borderRadius: 16,
                padding: { top: 14, bottom: 14, left: 16, right: 16 },
                margin: { left: 4, right: 4 },
              }}
              uiBackground={{ color: Color4.create(0.15, 0.12, 0.12, 0.92) }}
            >
              <Label value="Combat" fontSize={28} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: 12 } }} />
              <Label value={"Throw your boomerang (E) to\nstun rivals and force them\nto drop the Flag"} fontSize={13} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: 10 } }} />
              {/* Boomerang image */}
              <UiEntity
                uiTransform={{ width: 120, height: 120, margin: { bottom: 14 } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` }, color: Color4.White() }}
              />
              <Label value={"Drop bananas (F) to block\nboomerangs and stun pursuers"} fontSize={13} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: 10 } }} />
              {/* Trap image */}
              <UiEntity
                uiTransform={{ width: 120, height: 120 }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/banana-color.png' }, color: Color4.White() }}
              />
            </UiEntity>

            {/* ── Win + Controls Card ── */}
            <UiEntity
              uiTransform={{
                width: '32%',
                height: 480,
                flexDirection: 'column',
                alignItems: 'center',
                borderRadius: 16,
                padding: { top: 14, bottom: 14, left: 16, right: 16 },
                margin: { left: 4 },
              }}
              uiBackground={{ color: Color4.create(0.15, 0.12, 0.12, 0.92) }}
              onMouseDown={() => {}}
            >
              {/* Close X button */}
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { top: 4, right: 4 },
                  width: 44,
                  height: 44,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); notifyOverlayClosed() }}
              >
                <Label value="×" fontSize={44} color={CLOSE_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
                <Label value="Win" fontSize={28} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: 12 } }} />
                <Label value={"Score 1 point for every\nsecond you hold the Flag"} fontSize={13} color={MUTED} font="sans-serif" textAlign="middle-center" uiTransform={{ margin: { bottom: 6 } }} />
                <Label value={"Win the round by holding\nthe Flag for the longest!"} fontSize={13} color={MUTED} font="sans-serif" textAlign="middle-center" uiTransform={{ margin: { bottom: 20 } }} />
                <Label value="Controls" fontSize={28} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: 16 } }} />
              </UiEntity>
              <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'flex-start', padding: { left: 32 } }}>
              {/* E */}
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: 10 } }}>
                <UiEntity uiTransform={{ width: 34, height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 5, margin: { right: 8 } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}>
                  <Label value="E" fontSize={16} color={WHITE} font="sans-serif" />
                </UiEntity>
                <Label value="Throw Boomerang" fontSize={13} color={MUTED} font="sans-serif" />
              </UiEntity>
              {/* F */}
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: 10 } }}>
                <UiEntity uiTransform={{ width: 34, height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 5, margin: { right: 8 } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}>
                  <Label value="F" fontSize={16} color={WHITE} font="sans-serif" />
                </UiEntity>
                <Label value="Drop Trap" fontSize={13} color={MUTED} font="sans-serif" />
              </UiEntity>
              {/* 3 */}
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: 10 } }}>
                <UiEntity uiTransform={{ width: 34, height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 5, margin: { right: 8 } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}>
                  <Label value="3" fontSize={16} color={WHITE} font="sans-serif" />
                </UiEntity>
                <Label value="Drop Flag" fontSize={13} color={MUTED} font="sans-serif" />
              </UiEntity>
              {/* 2 */}
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: 10 } }}>
                <UiEntity uiTransform={{ width: 34, height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 5, margin: { right: 8 } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}>
                  <Label value="2" fontSize={16} color={WHITE} font="sans-serif" />
                </UiEntity>
                <Label value={musicMuted ? "Unmute Music" : "Mute Music"} fontSize={13} color={MUTED} font="sans-serif" />
              </UiEntity>
              </UiEntity>
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}

      {/* ── Leaderboard overlay — centered (safe area) ── */}
      {leaderboardOverlayVisible && (() => {
        const M_LB_PER_PAGE = 8
        const totalEntries = leaderboardEntries.length
        const lbMaxOffset = Math.max(0, totalEntries - M_LB_PER_PAGE)
        if (leaderboardScrollOffset > lbMaxOffset) leaderboardScrollOffset = lbMaxOffset
        if (leaderboardScrollOffset < 0) leaderboardScrollOffset = 0
        const visibleEntries = leaderboardEntries.slice(leaderboardScrollOffset, leaderboardScrollOffset + M_LB_PER_PAGE)
        const lbCanScrollUp = leaderboardScrollOffset > 0
        const lbCanScrollDown = leaderboardScrollOffset < lbMaxOffset

        return (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left: 0, top: 0 },
            width: '100%', height: '100%',
            flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
          }}
        >
          <UiEntity
            uiTransform={{
              positionType: 'relative',
              width: '42%',
              height: '62%',
              flexDirection: 'column',
              alignItems: 'stretch',
              padding: 28,
              overflow: 'hidden',
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 4, right: 4 },
                width: 88, height: 88,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={52} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            {(() => { folderTab = 'leaderboards'; leaderboardTab = leaderboardTab === 'metrics' ? 'daily' : leaderboardTab; return null })()}
            {(
            <UiEntity uiTransform={{ flexDirection: 'row', width: '100%', height: 40 }}>
              <UiEntity
                uiTransform={{ flexGrow: 1, height: 40, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: 6 }}
                uiBackground={{ color: leaderboardTab === 'daily' ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                onMouseDown={() => { playClickSound(); leaderboardTab = 'daily'; leaderboardScrollOffset = 0 }}
              >
                <Label value="Daily" fontSize={16} color={leaderboardTab === 'daily' ? WHITE : MUTED} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: 6 }} />
              <UiEntity
                uiTransform={{ flexGrow: 1, height: 40, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: 6 }}
                uiBackground={{ color: leaderboardTab === 'monthly' ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                onMouseDown={() => { playClickSound(); leaderboardTab = 'monthly'; leaderboardScrollOffset = 0 }}
              >
                <Label value="Monthly" fontSize={16} color={leaderboardTab === 'monthly' ? WHITE : MUTED} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: 6 }} />
              <UiEntity
                uiTransform={{ flexGrow: 1, height: 40, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: 6 }}
                uiBackground={{ color: leaderboardTab === 'alltime' ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                onMouseDown={() => { playClickSound(); leaderboardTab = 'alltime'; leaderboardScrollOffset = 0 }}
              >
                <Label value="All Time" fontSize={16} color={leaderboardTab === 'alltime' ? WHITE : MUTED} font="sans-serif" />
              </UiEntity>
            </UiEntity>
            )}
            <UiEntity uiTransform={{ height: 12 }} />

            {/* Leaderboard content (daily + alltime) */}
            {(
            <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column' }}>
            {/* Scroll up */}
            {lbCanScrollUp && (
              <UiEntity
                uiTransform={{ width: '100%', height: 40, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
                uiBackground={{ color: Color4.create(0.2, 0.2, 0.22, 0.8) }}
                onMouseDown={() => { leaderboardScrollOffset -= 1 }}
              >
                <Label value="▲ More" fontSize={22} color={WHITE} font="sans-serif" />
              </UiEntity>
            )}

            <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column' }}>
              {totalEntries === 0 ? (
                <UiEntity uiTransform={{ height: 44 * 2, justifyContent: 'center', alignItems: 'center' }}>
                  <Label value="No champions yet..." fontSize={22} color={MUTED} font="sans-serif" />
                </UiEntity>
              ) : (
                visibleEntries.map((entry, i) => {
                  const isSelf = localUserId !== null && entry.userId === localUserId
                  const nameColor = isSelf ? WHITE : GREY
                  const rank = leaderboardScrollOffset + i + 1
                  return (
                    <UiEntity
                      key={`m-lb-${entry.userId}-${leaderboardScrollOffset}-${i}`}
                      uiTransform={{
                        height: 44,
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start',
                      }}
                    >
                      {(leaderboardTab === 'daily') ? (
                        <UiEntity uiTransform={{ flexDirection: "row", alignItems: "center", flexGrow: 1 }}>
                          {Array.from({ length: entry.roundsWon }, (_, ri) => (
                            <UiEntity key={`m-rw-${ri}`} uiTransform={{ width: 16, height: 16, margin: { right: 2 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />
                          ))}
                          {entry.roundsWon > 0 && <UiEntity uiTransform={{ width: 4 }} />}
                          <Label value={entry.name} fontSize={22} color={nameColor} font="sans-serif" />
                        </UiEntity>
                      ) : (
                        <UiEntity uiTransform={{ flexDirection: "row", alignItems: "center", flexGrow: 1 }}>
                          <Label value={`${rank}.`} fontSize={22} color={MUTED} font="sans-serif" uiTransform={{ width: 36 }} textAlign="middle-left" />
                          <Label value={entry.name} fontSize={22} color={nameColor} font="sans-serif" uiTransform={{ flexGrow: 1 }} />
                          <Label value={`${entry.roundsWon}`} fontSize={22} color={GOLD} font="sans-serif" />
                        </UiEntity>
                      )}
                    </UiEntity>
                  )
                })
              )}
            </UiEntity>

            {/* Scroll down */}
            {lbCanScrollDown && (
              <UiEntity
                uiTransform={{ width: '100%', height: 40, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
                uiBackground={{ color: Color4.create(0.2, 0.2, 0.22, 0.8) }}
                onMouseDown={() => { leaderboardScrollOffset += 1 }}
              >
                <Label value="▼ More" fontSize={22} color={WHITE} font="sans-serif" />
              </UiEntity>
            )}
            </UiEntity>
            )}
          </UiEntity>
        </UiEntity>
        )
      })()}

      {/* Analytics overlay removed on mobile for simplicity */}
    </UiEntity>
  )
}
