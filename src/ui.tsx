import { Color4, Vector3 } from '@dcl/sdk/math'
import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { getPlayer } from '@dcl/sdk/players'
import { UiCanvasInformation } from '@dcl/sdk/ecs'
import {
  getPlayersWithHoldTimes,
  getCurrentFlagCarrierUserId,
  getKnownPlayerName
} from './gameState/flagHoldTime'
import { isTrapOnCooldown, getTrapCooldownRemaining } from './systems/trapSystem'
import { isProjectileOnCooldown, getProjectileCooldownRemaining } from './systems/projectileSystem'
import { clearMushroomShield } from './systems/mushroomSystem'
import { getAllVisitors, getTodayVisitorCount, getCurrentOnlineCount } from './gameState/sceneTime'
import { getLeaderboardEntries, getAllTimeLeaderboardEntries } from './gameState/roundsWon'
import { getCountdownSeconds, CountdownTimer, Flag } from './shared/components'
import { engine, AudioSource, Transform, inputSystem, InputAction, PointerEventType, PointerEvents, executeTask, type Entity } from '@dcl/sdk/ecs'
import { getWinConditionOverlayVisible, toggleWinConditionOverlay, setWinConditionOverlayVisible } from './components/winConditionOverlayState'
import { getLeaderboardOverlayVisible, toggleLeaderboardOverlay, setLeaderboardOverlayVisible } from './components/leaderboardOverlayState'
import { getBoomerangColor, setBoomerangColor, type BoomerangColor } from './gameState/boomerangColor'
import { getAnalyticsOverlayVisible, toggleAnalyticsOverlay, setAnalyticsOverlayVisible } from './components/analyticsOverlayState'
import { musicEntity } from './index'
// import { isMobile } from '@dcl/sdk/platform'  // disabled — causes crashes

// ── Music mute state ──
let musicMuted = false
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
function getCinematicFade(): number {
  return cinematicFadeOpacity
}

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
const ATTACK_FLICKER_MS = 150
let lastAttackPressMs = 0

function attackFlickerSystem(): void {
  if (inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_DOWN) && !isAnyOverlayOpen()) {
    // Don't flicker if clicking an interactive object (bench, scope, etc.)
    const cmd = inputSystem.getInputCommand(InputAction.IA_POINTER, PointerEventType.PET_DOWN)
    const hitEntity = cmd?.hit?.entityId
    if (hitEntity && PointerEvents.has(hitEntity as Entity)) return
    lastAttackPressMs = Date.now()
  }
}

function isAttackFlickering(): boolean {
  return Date.now() - lastAttackPressMs < ATTACK_FLICKER_MS
}

// Scroll state for lists
let visitorScrollOffset = 0
let leaderboardScrollOffset = 0
let leaderboardTab: 'daily' | 'alltime' = 'daily'

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
let splashWinnerUserId: string | null = null
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
        splashWinnerUserId = (serverData.length > 0 && serverData[0].userId) ? serverData[0].userId : null
      } catch {
        splashPlayers = []
        splashWinnerUserId = null
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
    splashWinnerUserId = null
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
    if (!isSpectatorMode()) {
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

// Tie-breaking tracking for stable leaderboard sorting
const roundWinAchievementTime = new Map<string, number>() // userId -> timestamp when they first achieved current win count
let lastKnownWins = new Map<string, number>() // userId -> last known round wins

// Stable sorting for leaderboard with tie-breaking
function getSortedLeaderboardEntries(entries: any[]): any[] {
  const now = Date.now()
  
  // Track achievement times for round wins
  entries.forEach(entry => {
    const key = entry.userId
    const currentWins = entry.roundsWon
    
    // Check if this is a new win level for this player
    const lastKnown = lastKnownWins.get(key) || 0
    if (currentWins > lastKnown) {
      roundWinAchievementTime.set(key, now)
      lastKnownWins.set(key, currentWins)
    }
    
    if (!roundWinAchievementTime.has(key)) {
      roundWinAchievementTime.set(key, now)
    }
  })
  
  // Sort: Primary by wins (desc), secondary by achievement time (asc = earlier first)
  return [...entries].sort((a, b) => {
    if (a.roundsWon !== b.roundsWon) {
      return b.roundsWon - a.roundsWon // Higher wins first
    }
    // Tie-breaker: earlier achievement time first
    const timeA = roundWinAchievementTime.get(a.userId) || now
    const timeB = roundWinAchievementTime.get(b.userId) || now
    return timeA - timeB
  })
}

// ═══════════════════════════════════════════════════════════
// SHARED CONSTANTS & HELPERS
// ═══════════════════════════════════════════════════════════

// Enhanced Color Palette
const WHITE = Color4.create(1, 1, 1, 1)
const BRIGHT_WHITE = Color4.create(1, 1, 1, 1)
const MUTED = Color4.create(0.82, 0.82, 0.85, 1)
const LIGHT_GREY = Color4.create(0.72, 0.72, 0.75, 1)
const GREY = Color4.create(0.62, 0.62, 0.68, 1)
const CLOSE_GREY = Color4.create(0.4, 0.4, 0.45, 1)

// Theme Colors
const GOLD = Color4.create(1, 0.84, 0, 1)
const BRIGHT_GOLD = Color4.create(1, 0.9, 0.1, 1)
const SILVER = Color4.create(0.75, 0.78, 0.82, 1)
const BRONZE = Color4.create(0.8, 0.5, 0.2, 1)

// Accent Colors
const LIGHT_BLUE = Color4.create(0.45, 0.75, 1, 1)
const CORAL_RED = Color4.create(1, 0.5, 0.45, 1)

// Background Colors
const PANEL_BG = Color4.create(0.1, 0.1, 0.1, 0.92)
const PANEL_BG_SEMI = Color4.create(0.08, 0.08, 0.1, 0.87)

// ═══════════════════════════════════════════════════════════
// UI SCALE — auto-detects from screen size, press 1 to fine-tune
// Base scale = screenWidth / 1920 (clamped 0.6–1.6)
// Manual adjustment adds -15% / 0% / +20% on top
// ═══════════════════════════════════════════════════════════
const UI_ADJUST_PRESETS = [
  { label: 'Small',  mult: 0.85 },
  { label: 'Medium', mult: 1.0  },
  { label: 'Large',  mult: 1.2  },
]
let uiAdjustIndex = 1 // default Medium

let autoBaseScale = 1.0 // updated each frame from canvas info

// System that reads screen size and computes auto base scale
engine.addSystem(() => {
  const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
  if (canvas && canvas.width > 0) {
    // Use logical width (accounting for device pixel ratio)
    const logicalWidth = canvas.width
    const raw = logicalWidth / 1920
    autoBaseScale = Math.max(0.6, Math.min(1.6, raw))
  }
})

function getUIScale(): number { return autoBaseScale * UI_ADJUST_PRESETS[uiAdjustIndex].mult }
function getUIScaleLabel(): string { return UI_ADJUST_PRESETS[uiAdjustIndex].label }
function cycleUIScale() {
  uiAdjustIndex = (uiAdjustIndex + 1) % UI_ADJUST_PRESETS.length
}

/** Scale a pixel value by current UI scale. Use for all desktop sizes/fonts/margins. */
function S(px: number): number {
  return Math.round(px * getUIScale())
}

function getServerConnectionStatus(): 'Y' | 'N' {
  const flagCount = [...engine.getEntitiesWith(Flag)].length
  return flagCount > 0 ? 'Y' : 'N'
}

function formatCountdown(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h === 0) return `${m}:${s.toString().padStart(2, '0')}`
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function formatUTCTime(): string {
  const now = new Date()
  return now.toUTCString().slice(17, 25)
}

function formatUTCDate(): string {
  const now = new Date()
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = now.getUTCDate().toString().padStart(2, '0')
  const year = now.getUTCFullYear().toString().slice(2)
  return `${month}/${day}/${year}`
}

function formatVisitorTime(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

// ═══════════════════════════════════════════════════════════
// ROOT UI — switches between desktop and mobile
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// DROWN BAR — 2D screen-space air meter
// ═══════════════════════════════════════════════════════════

// Drown bar dimensions (computed at render time via S())
const DROWN_BAR_WIDTH_BASE = 160
const DROWN_BAR_HEIGHT_BASE = 10
const DROWN_BORDER_BASE = 2

function DrownBar() {
  const fraction = getDrownFraction()
  const fillColor = fraction < 0.25
    ? Color4.create(1, 0.3, 0.3, 0.95)
    : Color4.create(0.2, 0.5, 1.0, 0.95)
  const barW = S(DROWN_BAR_WIDTH_BASE)
  const barH = S(DROWN_BAR_HEIGHT_BASE)
  const border = S(DROWN_BORDER_BASE)

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: S(110), left: '50%' },
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
  const mobile = false // isMobile() — disabled
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
          {/* No scorers: show centered text on black screen */}
          {splashVisible && cinematicShowing && splashPlayers.length === 0 && (
            <Label value="Round Over" fontSize={S(42)} color={GOLD} font="sans-serif" />
          )}
          {splashVisible && cinematicShowing && splashPlayers.length === 0 && (
            <UiEntity uiTransform={{ height: S(16) }} />
          )}
          {splashVisible && cinematicShowing && splashPlayers.length === 0 && (
            <Label value="Next round starting..." fontSize={S(20)} color={LIGHT_GREY} font="sans-serif" />
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
              width: S(460),
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: S(16),
              padding: { top: S(36), bottom: S(32), left: S(40), right: S(40) },
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            {/* Close button */}
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
              onMouseEnter={() => { closeServerDownHovered = true }}
              onMouseLeave={() => { closeServerDownHovered = false }}
              onMouseDown={() => { playClickSound(); serverDownDismissedAt = Date.now(); serverDownVisible = false; closeServerDownHovered = false }}
            >
              <Label value="×" fontSize={S(44)} color={closeServerDownHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>

            <Label value="Server Disconnected" fontSize={S(28)} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: S(12) }} />
            <Label value="all players please leave scene for 5 minutes while server resets" fontSize={S(18)} color={LIGHT_GREY} font="sans-serif" />
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
            width: S(420),
            flexDirection: 'column',
            alignItems: 'center',
            padding: { top: S(24), bottom: S(24), left: S(24), right: S(24) },
            borderRadius: S(20),
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
              onMouseEnter={() => { closeMailboxHovered = true }}
              onMouseLeave={() => { closeMailboxHovered = false }}
              onMouseDown={() => { playClickSound(); hideMailboxPopup(); closeMailboxHovered = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={S(44)} color={closeMailboxHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Leave a Message" fontSize={S(28)} color={Color4.create(0.2, 0.6, 1, 1)} font="sans-serif" uiTransform={{ margin: { bottom: S(8) } }} />
            <Label value={"Join the Flagtag community to\nleave a review or report a bug"} fontSize={S(16)} color={LIGHT_GREY} uiTransform={{ margin: { top: S(4), bottom: S(20) }, width: S(360), height: S(50) }} textAlign="middle-center" />
            <UiEntity
              uiTransform={{ width: S(240), height: S(44), borderRadius: S(8), justifyContent: 'center', alignItems: 'center' }}
              uiBackground={{ color: Color4.create(0.2, 0.6, 1, 1) }}
              onMouseDown={() => {
                playClickSound()
                joinCommunity()
              }}
            >
              <Label value="Join Community" fontSize={S(18)} color={Color4.White()} uiTransform={{ width: '100%', height: '100%' }} textAlign="middle-center" />
            </UiEntity>
            {getMailboxStatus() ? (
              <Label value={getMailboxStatus()} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { top: S(12) }, width: S(360) }} textAlign="middle-center" />
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
            width: S(420),
            flexDirection: 'column',
            alignItems: 'center',
            padding: { top: S(24), bottom: S(24), left: S(24), right: S(24) },
            borderRadius: S(20),
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
              onMouseEnter={() => { closeChestHovered = true }}
              onMouseLeave={() => { closeChestHovered = false }}
              onMouseDown={() => { playClickSound(); hideChestPopup(); closeChestHovered = false }}
            >
              <Label value="×" fontSize={S(44)} color={closeChestHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Chest" fontSize={S(28)} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: S(4) } }} />
            <Label value="Choose your boomerang color" fontSize={S(16)} color={LIGHT_GREY} uiTransform={{ margin: { top: S(4), bottom: S(28) }, width: S(360) }} textAlign="middle-center" />
            <UiEntity uiTransform={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', width: '100%' }}>
              {(['r', 'y', 'b', 'g'] as BoomerangColor[]).map((color) => {
                const selected = getBoomerangColor() === color
                const borderColor = selected ? GOLD : Color4.create(0.3, 0.3, 0.35, 1)
                return (
                  <UiEntity
                    key={`boom-${color}`}
                    uiTransform={{
                      width: S(80),
                      height: S(80),
                      margin: { left: S(6), right: S(6) },
                      padding: S(4),
                      borderRadius: S(12),
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                    uiBackground={{ color: selected ? Color4.create(0.45, 0.38, 0.1, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                    onMouseDown={() => { playClickSound(); setBoomerangColor(color) }}
                  >
                    <UiEntity
                      uiTransform={{ width: S(60), height: S(60) }}
                      uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${color}.png` } }}
                    />
                  </UiEntity>
                )
              })}
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}
      {/* Drown bar — screen-space, always on top */}
      {isDrownBarVisible() && <DrownBar />}

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
            <Label value="You Drowned!" fontSize={S(42)} color={CORAL_RED} font="sans-serif" />
          )}
          {isDrownTextVisible() && (
            <UiEntity uiTransform={{ height: S(12) }} />
          )}
          {isDrownTextVisible() && (
            <Label value={`Respawning in ${Math.ceil(getRespawnCountdown())}...`} fontSize={S(20)} color={LIGHT_GREY} font="sans-serif" />
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
            <Label value="You were struck by lightning!" fontSize={S(42)} color={CORAL_RED} font="sans-serif" />
          )}
          {isLightningTextVisible() && (
            <UiEntity uiTransform={{ height: S(12) }} />
          )}
          {isLightningTextVisible() && (
            <Label value={`Respawning in ${Math.ceil(getLightningRespawnCountdown())}...`} fontSize={S(20)} color={LIGHT_GREY} font="sans-serif" />
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
            padding: { top: S(14), bottom: S(14), left: S(24), right: S(24) },
            borderRadius: S(18),
          }}
            uiBackground={{ color: Color4.create(0.1, 0.1, 0.1, 0.92) }}
          >
            <Label value="SPECTATOR MODE" fontSize={S(28)} color={Color4.White()} />
            <Label value="WASD = Orbit  |  E/F = Up/Down" fontSize={S(14)} color={Color4.create(1, 1, 1, 0.8)} />
            <UiEntity
              uiTransform={{ width: S(160), height: S(40), margin: { top: S(8) }, borderRadius: S(10) }}
              uiBackground={{ color: spectatorExitBlink ? Color4.create(0.5, 0.5, 0.5, 0.9) : Color4.create(1, 1, 1, 0.9) }}
              onMouseDown={() => {
                playClickSound()
                spectatorExitBlink = true
                executeTask(async () => { await new Promise<void>(r => setTimeout(r, 120)); spectatorExitBlink = false })
                exitSpectatorMode()
              }}
            >
              <Label value="Exit" fontSize={S(18)} color={Color4.Black()} uiTransform={{ width: '100%', height: '100%' }} />
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
          uiBackground={{ color: Color4.create(0, 0, 0, 0.75) }}
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
            <Label value="A multiplayer keep away game!" fontSize={S(16)} color={MUTED} font="sans-serif" uiTransform={{ margin: { bottom: S(24) } }} />
            <Label value="Click anywhere to continue" fontSize={S(13)} color={Color4.create(1, 1, 1, 0.5)} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      )}
    </UiEntity>
  )
}

// ═══════════════════════════════════════════════════════════
// DESKTOP LAYOUT (unchanged from original)
// ═══════════════════════════════════════════════════════════

// Desktop layout base values (scaled at render time via S())
const _PANEL_WIDTH = 240
const _ROW_HEIGHT = 32
const VISITORS_PER_PAGE = 10
const LEADERBOARD_PER_PAGE = 12
const _TITLE_FONT = 20
const _ROW_FONT = 15
const _PADDING = 14
const _BORDER_RADIUS = 18
const _ICON_FONT_SQUARE = 20
const _ICON_FONT_QUESTION = 22
const _ICON_FONT_ANALYTICS = 20
const _ABILITY_BTN_SIZE = 74
const _ABILITY_ICON_SIZE = 54
const _OVERLAY_PANEL_WIDTH = 680
const _OVERLAY_PANEL_HEIGHT = 520

function DesktopLayout() {
  const rawPlayers = getPlayersWithHoldTimes()
  const players = rawPlayers
  const localUserId = getPlayer()?.userId ?? null
  const rawVisitors = getAllVisitors()
  
  const allVisitors = [...rawVisitors].sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  
  const visitorCount = getTodayVisitorCount()
  const onlineCount = getCurrentOnlineCount()
  const leaderUserId =
    players.length > 0 && players[0].seconds > 0 ? players[0].userId : null
  const carrierUserId = getCurrentFlagCarrierUserId()
  const countdownSeconds = getCountdownSeconds()

  const winConditionOverlayVisible = getWinConditionOverlayVisible()
  const leaderboardOverlayVisible = getLeaderboardOverlayVisible()
  const analyticsOverlayVisible = getAnalyticsOverlayVisible()
  const rawLeaderboardEntries = leaderboardTab === 'daily' ? getLeaderboardEntries() : getAllTimeLeaderboardEntries()
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
      {/* Timer — top center (hidden when any main overlay is open) */}
      {<UiEntity
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
              <Label value="Next round starting..." fontSize={S(15)} color={LIGHT_GREY} font="sans-serif" />
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
                  width: S(126),
                  height: S(240),
                  borderRadius: S(8),
                  margin: { top: S(4) },
                  flexGrow: 1,
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/beacon.png' } }}
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
              {/* Banana image */}
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
              <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'flex-start', padding: { left: S(32) } }}>
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
                <Label value="Drop Banana" fontSize={S(13)} color={MUTED} font="sans-serif" />
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
              alignItems: 'stretch',
              borderRadius: S(20),
              padding: S(24),
              overflow: 'hidden',
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
              onMouseEnter={() => { closeLeaderboardHovered = true }}
              onMouseLeave={() => { closeLeaderboardHovered = false }}
              onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); closeLeaderboardHovered = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={S(44)} color={closeLeaderboardHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Leaderboard" fontSize={S(28)} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: S(8) }} />
            <UiEntity uiTransform={{ flexDirection: 'row', width: '100%', height: S(32) }}>
              <UiEntity
                uiTransform={{ flexGrow: 1, height: S(32), flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: S(6) }}
                uiBackground={{ color: leaderboardTab === 'daily' ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                onMouseDown={() => { playClickSound(); leaderboardTab = 'daily'; leaderboardScrollOffset = 0 }}
              >
                <Label value="Daily" fontSize={S(16)} color={leaderboardTab === 'daily' ? WHITE : MUTED} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: S(6) }} />
              <UiEntity
                uiTransform={{ flexGrow: 1, height: S(32), flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: S(6) }}
                uiBackground={{ color: leaderboardTab === 'alltime' ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                onMouseDown={() => { playClickSound(); leaderboardTab = 'alltime'; leaderboardScrollOffset = 0 }}
              >
                <Label value="All Time" fontSize={S(16)} color={leaderboardTab === 'alltime' ? WHITE : MUTED} font="sans-serif" />
              </UiEntity>
            </UiEntity>
            <UiEntity uiTransform={{ height: S(12) }} />

            <UiEntity
              uiTransform={{
                width: '100%',
                flexGrow: 1,
                flexDirection: 'row',
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
                        {leaderboardTab === 'daily' ? (
                          <UiEntity uiTransform={{ flexDirection: "row", alignItems: "center", flexGrow: 1 }}>
                            {Array.from({ length: entry.roundsWon }, (_, ri) => (
                              <UiEntity key={`rw-${ri}`} uiTransform={{ width: S(14), height: S(14), margin: { right: S(2) } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'images/flag-icon-white.png' }, color: GOLD }} />
                            ))}
                            {entry.roundsWon > 0 && <UiEntity uiTransform={{ width: S(4) }} />}
                            <Label value={entry.name} fontSize={S(_ROW_FONT)} color={nameColor} font="sans-serif" />
                          </UiEntity>
                        ) : (
                          <UiEntity uiTransform={{ flexDirection: "row", alignItems: "center", flexGrow: 1 }}>
                            <Label value={`${rank}.`} fontSize={S(_ROW_FONT)} color={MUTED} font="sans-serif" uiTransform={{ width: S(32) }} />
                            <Label value={entry.name} fontSize={S(_ROW_FONT)} color={nameColor} font="sans-serif" uiTransform={{ flexGrow: 1 }} />
                            <Label value={`${entry.roundsWon}`} fontSize={S(_ROW_FONT)} color={GOLD} font="sans-serif" />
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
                    width: S(24),
                    flexDirection: 'column',
                    alignItems: 'center',
                    margin: { left: S(4) },
                  }}
                >
                  <UiEntity
                    uiTransform={{
                      width: S(24), height: S(28),
                      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
                      borderRadius: S(4),
                    }}
                    uiBackground={{ color: lbCanScrollUp ? Color4.create(0.25, 0.25, 0.28, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
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
                      width: S(24), height: S(28),
                      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
                      borderRadius: S(4),
                    }}
                    uiBackground={{ color: lbCanScrollDown ? Color4.create(0.25, 0.25, 0.28, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                    onMouseDown={() => { if (lbCanScrollDown) leaderboardScrollOffset += 1 }}
                  >
                    <Label value="▼" fontSize={S(14)} color={lbCanScrollDown ? WHITE : CLOSE_GREY} font="sans-serif" />
                  </UiEntity>
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
              <UiEntity uiTransform={{ width: '20%' }}>
                <Label value={`Unique Users: ${visitorCount}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '14%' }}>
                <Label value={`Online: ${onlineCount}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '12%' }}>
                <Label value={`Server: ${serverConnected}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '18%' }}>
                <Label value={`Date: ${formatUTCDate()}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '26%' }}>
                <Label value={`Time (UTC): ${formatUTCTime()}`} fontSize={S(13)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity
                uiTransform={{ width: '10%', height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
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
                          <Label value={visitor.userId} fontSize={S(11)} color={WHITE} font="sans-serif" />
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
                    width: S(24),
                    flexDirection: 'column',
                    alignItems: 'center',
                    margin: { left: S(4) },
                  }}
                >
                  <UiEntity
                    uiTransform={{
                      width: S(24), height: S(28),
                      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
                      borderRadius: S(4),
                    }}
                    uiBackground={{ color: canScrollUp ? Color4.create(0.25, 0.25, 0.28, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
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
                      width: S(24), height: S(28),
                      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
                      borderRadius: S(4),
                    }}
                    uiBackground={{ color: canScrollDown ? Color4.create(0.25, 0.25, 0.28, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
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
              borderRadius: { topLeft: S(0), topRight: S(38), bottomLeft: S(38), bottomRight: S(38) },
              margin: { right: S(8) },
            }}
            uiBackground={{ color: PANEL_BG_SEMI }}
          >
            <Label value="E" fontSize={S(16)} color={LIGHT_GREY} font="sans-serif"
              uiTransform={{ positionType: 'absolute', position: { top: S(-2), left: S(5) } }}
            />
            <UiEntity
              uiTransform={{ width: (S(_ABILITY_ICON_SIZE) - 6) * 1.5, height: (S(_ABILITY_ICON_SIZE) - 6) * 1.5, margin: { top: S(-2) } }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: isProjectileOnCooldown() ? 'assets/images/boomerang.bw.png' : `assets/images/boomerang.${getBoomerangColor()}.png` },
                color: isProjectileOnCooldown() ? Color4.create(1, 1, 1, 0.3) : Color4.White()
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
              borderRadius: { topLeft: S(0), topRight: S(38), bottomLeft: S(38), bottomRight: S(38) },
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

      {/* ── Right-side container: scoreboard stacked vertically ── */}
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { right: S(16), top: S(14) },
          width: S(_PANEL_WIDTH),
          flexDirection: 'column',
          alignItems: 'stretch',
        }}
      >
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
          <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
            <UiEntity
              uiTransform={{ width: S(28), height: S(28), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
              onMouseEnter={() => { squareIconHovered = true }}
              onMouseLeave={() => { squareIconHovered = false }}
              onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); setAnalyticsOverlayVisible(false); leaderboardScrollOffset = 0; leaderboardTab = 'daily'; toggleLeaderboardOverlay(); notifyOverlayClosed() }}
            >
              <UiEntity uiTransform={{ width: S(16), height: S(16) }} uiBackground={{ textureMode: 'stretch', texture: { src: 'images/flag-icon-white.png' }, color: leaderboardOverlayVisible || squareIconHovered ? GOLD : WHITE }} />
            </UiEntity>
            <UiEntity
              uiTransform={{ width: S(28), height: S(28), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
              onMouseEnter={() => { questionIconHovered = true }}
              onMouseLeave={() => { questionIconHovered = false }}
              onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); setAnalyticsOverlayVisible(false); toggleWinConditionOverlay(); notifyOverlayClosed() }}
            >
              <Label value="?" fontSize={S(_ICON_FONT_QUESTION)} color={winConditionOverlayVisible || questionIconHovered ? GOLD : WHITE} font="sans-serif" />
            </UiEntity>
            <UiEntity
              uiTransform={{ width: S(28), height: S(28), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
              onMouseEnter={() => { analyticsIconHovered = true }}
              onMouseLeave={() => { analyticsIconHovered = false }}
              onMouseDown={() => {
                playClickSound();
                setWinConditionOverlayVisible(false);
                setLeaderboardOverlayVisible(false);
                visitorScrollOffset = 0;
                toggleAnalyticsOverlay();
                notifyOverlayClosed();
              }}
            >
              <Label value="#" fontSize={S(_ICON_FONT_ANALYTICS)} color={analyticsOverlayVisible || analyticsIconHovered ? GOLD : WHITE} font="sans-serif" />
            </UiEntity>
          </UiEntity>
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
                      <UiEntity uiTransform={{ width: S(16), height: S(16), margin: { right: S(4) } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'images/flag-icon-white.png' }, color: GOLD }} />
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
  const rawLeaderboardEntries = leaderboardTab === 'daily' ? getLeaderboardEntries() : getAllTimeLeaderboardEntries()
  const leaderboardEntries = getSortedLeaderboardEntries(rawLeaderboardEntries)

  // Mobile circle style constants
  const M_CIRCLE_SIZE = 68
  const M_CIRCLE_TEXTURE = 'assets/images/UI_circle.png'
  const M_CIRCLE_OPACITY = Color4.create(1, 1, 1, 0.8) // 80% opacity for circle PNG
  const M_ICON_SIZE = 50
  const M_KEYBIND_FONT = 16
  const analyticsOverlayVisible = getAnalyticsOverlayVisible()

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
              position: { top: 28, left: '24%' },
              width: '58%',
              height: 68,
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            {/* Menu icons (? ★ #) — left */}
            <UiEntity
              uiTransform={{
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <UiEntity
                uiTransform={{
                  width: M_CIRCLE_SIZE, height: M_CIRCLE_SIZE,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  margin: { right: 6 },
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
                onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); setAnalyticsOverlayVisible(false); mobileScoreboardOverlayVisible = false; toggleWinConditionOverlay(); notifyOverlayClosed() }}
              >
                <Label value="?" fontSize={36} color={winConditionOverlayVisible ? GOLD : WHITE} font="sans-serif" />
              </UiEntity>
              <UiEntity
                uiTransform={{
                  width: M_CIRCLE_SIZE, height: M_CIRCLE_SIZE,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  margin: { right: 6 },
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
                onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); setAnalyticsOverlayVisible(false); mobileScoreboardOverlayVisible = false; leaderboardScrollOffset = 0; leaderboardTab = 'daily'; toggleLeaderboardOverlay(); notifyOverlayClosed() }}
              >
                <UiEntity uiTransform={{ width: 26, height: 26 }} uiBackground={{ textureMode: 'stretch', texture: { src: 'images/flag-icon-white.png' }, color: leaderboardOverlayVisible ? GOLD : WHITE }} />
              </UiEntity>
              <UiEntity
                uiTransform={{
                  width: M_CIRCLE_SIZE, height: M_CIRCLE_SIZE,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
                onMouseDown={() => {
                  playClickSound();
                  setWinConditionOverlayVisible(false);
                  setLeaderboardOverlayVisible(false);
                  mobileScoreboardOverlayVisible = false;
                  visitorScrollOffset = 0;
                  toggleAnalyticsOverlay();
                  notifyOverlayClosed();
                }}
              >
                <Label value="#" fontSize={32} color={analyticsOverlayVisible ? GOLD : WHITE} font="sans-serif" />
              </UiEntity>
            </UiEntity>

            {/* Timer + Score — center */}
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
                uiBackground={{ color: Color4.create(0, 0, 0, 0.72) }}
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
                uiBackground={{ color: Color4.create(0, 0, 0, 0.72) }}
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
                  <UiEntity uiTransform={{ width: 22, height: 22, margin: { left: 6 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'images/flag-icon-white.png' }, color: GOLD }} />
                )}
              </UiEntity>
            </UiEntity>

            {/* Ability icons — right */}
            <UiEntity
              uiTransform={{
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <UiEntity
                uiTransform={{
                  width: M_CIRCLE_SIZE, height: M_CIRCLE_SIZE,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  margin: { right: 6 },
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
              >
                <UiEntity
                  uiTransform={{ width: M_ICON_SIZE, height: M_ICON_SIZE }}
                  uiBackground={{
                    textureMode: 'stretch',
                    texture: { src: 'assets/images/banana-color.png' },
                    color: isTrapOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White()
                  }}
                />
                {isTrapOnCooldown() && (
                  <Label value={`${getTrapCooldownRemaining()}`} fontSize={26} color={WHITE} font="sans-serif"
                    uiTransform={{ positionType: 'absolute' }}
                  />
                )}
              </UiEntity>

              <UiEntity
                uiTransform={{
                  width: M_CIRCLE_SIZE, height: M_CIRCLE_SIZE,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  margin: { right: 6 },
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
              >
                <UiEntity
                  uiTransform={{ width: (M_ICON_SIZE - 4) * 1.5, height: (M_ICON_SIZE - 4) * 1.5 }}
                  uiBackground={{
                    textureMode: 'stretch',
                    texture: { src: isProjectileOnCooldown() ? 'assets/images/boomerang.bw.png' : `assets/images/boomerang.${getBoomerangColor()}.png` },
                    color: isProjectileOnCooldown() ? Color4.create(1, 1, 1, 0.3) : Color4.White()
                  }}
                />
                {isProjectileOnCooldown() && getProjectileCooldownRemaining() > 0 && (
                  <Label value={`${getProjectileCooldownRemaining()}`} fontSize={26} color={WHITE} font="sans-serif"
                    uiTransform={{ positionType: 'absolute' }}
                  />
                )}
              </UiEntity>

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
            <Label value="Scoreboard" fontSize={36} color={MUTED} font="sans-serif" />
            <UiEntity uiTransform={{ height: 12 }} />

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
                          <UiEntity uiTransform={{ width: 16, height: 16, margin: { right: 4 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'images/flag-icon-white.png' }, color: GOLD }} />
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
              <Label value="Next round starting..." fontSize={22} color={LIGHT_GREY} font="sans-serif" />
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}

      {/* ── How to Play overlay — 3-column card layout (mobile) ── */}
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
          {/* 3-column cards */}
          <UiEntity
            uiTransform={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'stretch', width: '80%', margin: { bottom: 14 } }}
            onMouseDown={() => {}}
          >
            {/* Flag Card */}
            <UiEntity uiTransform={{ width: '32%', flexDirection: 'column', alignItems: 'center', borderRadius: 14, padding: { top: 18, bottom: 18, left: 14, right: 14 }, margin: { right: 10 } }} uiBackground={{ color: Color4.create(0.15, 0.12, 0.12, 0.92) }}>
              <Label value="Flag" fontSize={28} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: 10 } }} />
              <Label value={"Find the Flag by following\nthe gold beacon"} fontSize={18} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: 8 } }} />
              <Label value={"Move close to the Flag to pickup\nor steal it from another player"} fontSize={18} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: 10 } }} />
              <UiEntity uiTransform={{ width: 120, height: 160, borderRadius: 8, flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }} uiBackground={{ color: Color4.create(0.2, 0.18, 0.14, 0.8) }}>
                <UiEntity uiTransform={{ width: 18, height: 18, margin: { bottom: 4 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'images/flag-icon-white.png' }, color: GOLD }} />
                <Label value="flag with beacon" fontSize={14} color={LIGHT_GREY} font="sans-serif" textAlign="middle-center" />
              </UiEntity>
            </UiEntity>

            {/* Combat Card */}
            <UiEntity uiTransform={{ width: '32%', flexDirection: 'column', alignItems: 'center', borderRadius: 14, padding: { top: 18, bottom: 18, left: 14, right: 14 }, margin: { right: 10 } }} uiBackground={{ color: Color4.create(0.15, 0.12, 0.12, 0.92) }}>
              <Label value="Combat" fontSize={28} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: 10 } }} />
              <Label value={"Throw your boomerang with E\nto stun other players and force\nthem to drop the flag"} fontSize={18} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: 8 } }} />
              <UiEntity uiTransform={{ width: 70, height: 70, margin: { bottom: 12 } }} uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` }, color: Color4.White() }} />
              <Label value={"Drop bananas using F to stun\npursuers and to block\nboomerangs"} fontSize={18} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: 8 } }} />
              <UiEntity uiTransform={{ width: 70, height: 70 }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/banana-color.png' }, color: Color4.White() }} />
            </UiEntity>

            {/* Environment Card */}
            <UiEntity uiTransform={{ width: '32%', flexDirection: 'column', alignItems: 'center', borderRadius: 14, padding: { top: 18, bottom: 18, left: 14, right: 14 } }} uiBackground={{ color: Color4.create(0.15, 0.12, 0.12, 0.92) }}>
              {/* Close X button (mobile) */}
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
                <Label value="×" fontSize={36} color={CLOSE_GREY} font="sans-serif" />
              </UiEntity>
              <Label value="Environment" fontSize={28} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: 10 } }} />
              <Label value={"Jump or glide into smoke stacks\nto get an updraft"} fontSize={18} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: 8 } }} />
              <UiEntity uiTransform={{ width: 90, height: 50, borderRadius: 6, flexDirection: 'column', justifyContent: 'center', alignItems: 'center', margin: { bottom: 8 } }} uiBackground={{ color: Color4.create(0.2, 0.18, 0.14, 0.8) }}>
                <Label value="smoke updraft" fontSize={14} color={LIGHT_GREY} font="sans-serif" textAlign="middle-center" />
              </UiEntity>
              <Label value={"Use the glowing orbs to teleport\nacross the map"} fontSize={18} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: 8 } }} />
              <UiEntity uiTransform={{ width: 90, height: 50, borderRadius: 6, flexDirection: 'column', justifyContent: 'center', alignItems: 'center', margin: { bottom: 8 } }} uiBackground={{ color: Color4.create(0.2, 0.18, 0.14, 0.8) }}>
                <Label value="teleportation orbs" fontSize={14} color={LIGHT_GREY} font="sans-serif" textAlign="middle-center" />
              </UiEntity>
              <Label value="Avoid water and lightning!" fontSize={18} color={CORAL_RED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: 12 } }} />
              <Label value="Win" fontSize={24} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: 6 } }} />
              <Label value={"Win the game by holding the flag\nfor the most amount in the\n5 minute round!"} fontSize={18} color={MUTED} font="sans-serif" textAlign="top-center" />
            </UiEntity>
          </UiEntity>

          {/* Controls bar */}
          <UiEntity
            uiTransform={{ width: '80%', flexDirection: 'column', alignItems: 'flex-start', borderRadius: 10, padding: { top: 10, bottom: 12, left: 18, right: 18 } }}
            uiBackground={{ color: Color4.create(0.15, 0.12, 0.12, 0.92) }}
            onMouseDown={() => {}}
          >
            <Label value="Controls" fontSize={22} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: 8 } }} />
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', width: '100%' }}>
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { right: 22 } }}>
                <UiEntity uiTransform={{ width: 32, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 6 } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}><Label value="E" fontSize={18} color={WHITE} font="sans-serif" /></UiEntity>
                <Label value="boomerang" fontSize={18} color={MUTED} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { right: 22 } }}>
                <UiEntity uiTransform={{ width: 32, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 6 } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}><Label value="F" fontSize={18} color={WHITE} font="sans-serif" /></UiEntity>
                <Label value="banana" fontSize={18} color={MUTED} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { right: 22 } }}>
                <UiEntity uiTransform={{ width: 32, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 6 } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}><Label value="3" fontSize={18} color={WHITE} font="sans-serif" /></UiEntity>
                <Label value="drop flag" fontSize={18} color={MUTED} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { right: 22 } }}>
                <UiEntity uiTransform={{ width: 32, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 6 } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}><Label value="2" fontSize={18} color={WHITE} font="sans-serif" /></UiEntity>
                <Label value={musicMuted ? "unmute" : "mute"} fontSize={18} color={MUTED} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                <UiEntity uiTransform={{ width: 32, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 6 } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}><Label value="1" fontSize={18} color={WHITE} font="sans-serif" /></UiEntity>
                <Label value="UI size" fontSize={18} color={MUTED} font="sans-serif" />
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
            <Label value="Leaderboard" fontSize={36} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: 8 }} />
            <UiEntity uiTransform={{ flexDirection: 'row', width: '100%', height: 40 }}>
              <UiEntity
                uiTransform={{ flexGrow: 1, height: 40, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: 6 }}
                uiBackground={{ color: leaderboardTab === 'daily' ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                onMouseDown={() => { playClickSound(); leaderboardTab = 'daily'; leaderboardScrollOffset = 0 }}
              >
                <Label value="Daily" fontSize={20} color={leaderboardTab === 'daily' ? WHITE : MUTED} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: 8 }} />
              <UiEntity
                uiTransform={{ flexGrow: 1, height: 40, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: 6 }}
                uiBackground={{ color: leaderboardTab === 'alltime' ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                onMouseDown={() => { playClickSound(); leaderboardTab = 'alltime'; leaderboardScrollOffset = 0 }}
              >
                <Label value="All Time" fontSize={20} color={leaderboardTab === 'alltime' ? WHITE : MUTED} font="sans-serif" />
              </UiEntity>
            </UiEntity>
            <UiEntity uiTransform={{ height: 12 }} />

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
                      {leaderboardTab === 'daily' ? (
                        <UiEntity uiTransform={{ flexDirection: "row", alignItems: "center", flexGrow: 1 }}>
                          {Array.from({ length: entry.roundsWon }, (_, ri) => (
                            <UiEntity key={`m-rw-${ri}`} uiTransform={{ width: 16, height: 16, margin: { right: 2 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'images/flag-icon-white.png' }, color: GOLD }} />
                          ))}
                          {entry.roundsWon > 0 && <UiEntity uiTransform={{ width: 4 }} />}
                          <Label value={entry.name} fontSize={22} color={nameColor} font="sans-serif" />
                        </UiEntity>
                      ) : (
                        <UiEntity uiTransform={{ flexDirection: "row", alignItems: "center", flexGrow: 1 }}>
                          <Label value={`${rank}.`} fontSize={22} color={MUTED} font="sans-serif" uiTransform={{ width: 36 }} />
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
        </UiEntity>
        )
      })()}

      {/* ── Analytics overlay — centered (safe area) ── */}
      {analyticsOverlayVisible && (() => {
        const allVisitors = [...getAllVisitors()].sort((a, b) => {
          if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        })
        const visitorCount = getTodayVisitorCount()
        const onlineCount = getCurrentOnlineCount()
        const serverConnected = getServerConnectionStatus()
        const M_VISITORS_PER_PAGE = 8
        const totalVisitors = allVisitors.length
        const maxOffset = Math.max(0, totalVisitors - M_VISITORS_PER_PAGE)
        if (visitorScrollOffset > maxOffset) visitorScrollOffset = maxOffset
        if (visitorScrollOffset < 0) visitorScrollOffset = 0
        const visibleVisitors = allVisitors.slice(visitorScrollOffset, visitorScrollOffset + M_VISITORS_PER_PAGE)
        const canScrollUp = visitorScrollOffset > 0
        const canScrollDown = visitorScrollOffset < maxOffset

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
            {/* Close button */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 4, right: 4 },
                width: 88, height: 88,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseDown={() => { playClickSound(); setAnalyticsOverlayVisible(false); notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={52} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Daily Visitors" fontSize={36} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: 8 }} />

            {/* Stats row */}
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', height: 36 }}>
              <Label value={`Unique: ${visitorCount}`} fontSize={18} color={LIGHT_GREY} font="sans-serif" />
              <UiEntity uiTransform={{ width: 16 }} />
              <Label value={`Online: ${onlineCount}`} fontSize={18} color={LIGHT_GREY} font="sans-serif" />
              <UiEntity uiTransform={{ width: 16 }} />
              <Label value={`Server: ${serverConnected}`} fontSize={18} color={LIGHT_GREY} font="sans-serif" />
              <UiEntity uiTransform={{ width: 16 }} />
              <UiEntity
                uiTransform={{ flexDirection: 'row', alignItems: 'center' }}
                onMouseDown={() => { playClickSound(); toggleMusicMute() }}
              >
                <Label value={`Mute: ${musicMuted ? 'Y' : 'N'}`} fontSize={18} color={musicMuted ? GOLD : LIGHT_GREY} font="sans-serif" />
              </UiEntity>
            </UiEntity>
            <UiEntity uiTransform={{ height: 12 }} />

            {/* Scroll up */}
            {canScrollUp && (
              <UiEntity
                uiTransform={{ width: '100%', height: 40, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
                uiBackground={{ color: Color4.create(0.2, 0.2, 0.22, 0.8) }}
                onMouseDown={() => { visitorScrollOffset -= 1 }}
              >
                <Label value="▲ More" fontSize={22} color={WHITE} font="sans-serif" />
              </UiEntity>
            )}

            <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column' }}>
              {totalVisitors === 0 ? (
                <UiEntity uiTransform={{ height: 44 * 2, justifyContent: 'center', alignItems: 'center' }}>
                  <Label value="No visitors today" fontSize={22} color={MUTED} font="sans-serif" />
                </UiEntity>
              ) : (
                visibleVisitors.map((visitor, i) => (
                  <UiEntity
                    key={`m-vis-${visitor.userId}-${visitorScrollOffset}-${i}`}
                    uiTransform={{
                      height: 44,
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                      padding: { left: 4, right: 4 },
                    }}
                  >
                    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                      <Label
                        value={visitor.isOnline ? "●" : "○"}
                        fontSize={18}
                        color={visitor.isOnline ? WHITE : GREY}
                        font="sans-serif"
                      />
                      <UiEntity uiTransform={{ width: 8 }} />
                      <Label value={visitor.name} fontSize={20} color={WHITE} font="sans-serif" />
                    </UiEntity>
                    <Label value={formatVisitorTime(visitor.totalSeconds)} fontSize={18} color={LIGHT_GREY} font="sans-serif" />
                  </UiEntity>
                ))
              )}
            </UiEntity>

            {/* Scroll down */}
            {canScrollDown && (
              <UiEntity
                uiTransform={{ width: '100%', height: 40, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
                uiBackground={{ color: Color4.create(0.2, 0.2, 0.22, 0.8) }}
                onMouseDown={() => { visitorScrollOffset += 1 }}
              >
                <Label value="▼ More" fontSize={22} color={WHITE} font="sans-serif" />
              </UiEntity>
            )}
          </UiEntity>
        </UiEntity>
        )
      })()}
    </UiEntity>
  )
}
