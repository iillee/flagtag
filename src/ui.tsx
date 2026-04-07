import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { getPlayer } from '@dcl/sdk/players'
import {
  getPlayersWithHoldTimes,
  getCurrentFlagCarrierUserId,
  getKnownPlayerName
} from './gameState/flagHoldTime'
import { isBananaOnCooldown, getBananaCooldownRemaining } from './systems/bananaSystem'
import { isShellOnCooldown, getShellCooldownRemaining } from './systems/shellSystem'
import { clearMushroomShield } from './systems/mushroomSystem'
import { getAllVisitors, getTodayVisitorCount, getCurrentOnlineCount } from './gameState/sceneTime'
import { getLeaderboardEntries } from './gameState/roundsWon'
import { getCountdownSeconds, CountdownTimer, Flag } from './shared/components'
import { engine, AudioSource, Transform, inputSystem, InputAction, PointerEventType, PointerEvents, executeTask, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { getWinConditionOverlayVisible, toggleWinConditionOverlay, setWinConditionOverlayVisible } from './components/winConditionOverlayState'
import { getLeaderboardOverlayVisible, toggleLeaderboardOverlay, setLeaderboardOverlayVisible } from './components/leaderboardOverlayState'
import { getAnalyticsOverlayVisible, toggleAnalyticsOverlay, setAnalyticsOverlayVisible } from './components/analyticsOverlayState'
// import { isMobile } from '@dcl/sdk/platform'  // disabled — causes crashes
import { isSpectatorMode, exitSpectatorMode } from './systems/spectatorSystem'
import { signedFetch } from '~system/SignedFetch'

const COMMUNITY_ID = 'f7d69445-4889-49a9-8b50-07100125cbdc'
const SOCIAL_API = `https://social-api.decentraland.org/v1/communities/${COMMUNITY_ID}/requests`

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
      const addr = player.userId
      console.log('[Mailbox] Sending community join request for:', addr)
      setMailboxStatus('Sending request...')
      const res = await signedFetch({
        url: SOCIAL_API,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetedAddress: addr,
            type: 'request_to_join'
          })
        }
      })
      console.log('[Mailbox] Response status:', res.status, 'body:', res.body)
      if (res.ok) {
        setMailboxStatus('Request sent! Check your notifications.')
      } else {
        setMailboxStatus(`Error ${res.status}: ${res.body?.slice(0, 100) || 'Unknown error'}`)
      }
    } catch (err) {
      console.error('[Mailbox] Failed to send community request:', err)
      setMailboxStatus('Error: ' + String(err))
    }
  })
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
  return getWinConditionOverlayVisible()
    || getLeaderboardOverlayVisible()
    || getAnalyticsOverlayVisible()
    || splashVisible
    || serverDownVisible
    || mobileScoreboardOverlayVisible
    || mailboxPopupVisible
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

let squareIconHovered = false
let questionIconHovered = false
let analyticsIconHovered = false
let closeSplashHovered = false
let closeWinConditionHovered = false
let closeLeaderboardHovered = false
let closeAnalyticsHovered = false
let closeMailboxHovered = false
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

// ── Round-end splash state ──
let splashVisible = false
let splashHideTime = 0
let trumpetEntity: Entity | null = null
const SPLASH_DURATION_MS = 5000

interface SplashPlayer {
  name: string
  seconds: number
}

let splashPlayers: SplashPlayer[] = []
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
      } catch {
        splashPlayers = []
      }

      // Play trumpet sound once
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
    break
  }

  // Hide splash after duration
  if (splashVisible && now >= splashHideTime) {
    splashVisible = false
    splashPlayers = []
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

function PlayerListUi() {
  const mobile = false // isMobile() — disabled
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'relative' }}>
      {mobile ? <MobileLayout /> : <DesktopLayout />}

      {/* Server-down overlay */}
      {serverDownVisible && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 0, left: 0 },
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
              width: 460,
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 16,
              padding: { top: 36, bottom: 32, left: 40, right: 40 },
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            {/* Close button */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 8, right: 8 },
                width: 56,
                height: 56,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={() => { closeServerDownHovered = true }}
              onMouseLeave={() => { closeServerDownHovered = false }}
              onMouseDown={() => { playClickSound(); serverDownDismissedAt = Date.now(); serverDownVisible = false; closeServerDownHovered = false }}
            >
              <Label value="×" fontSize={44} color={closeServerDownHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>

            <Label value="Server Disconnected" fontSize={28} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: 12 }} />
            <Label value="all players please leave scene for 5 minutes while server resets" fontSize={18} color={LIGHT_GREY} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      )}
      {/* Mailbox popup */}
      {mailboxPopupVisible && (
        <UiEntity uiTransform={{
          positionType: 'absolute',
          position: { top: 0, left: 0 },
          width: '100%',
          height: '100%',
          justifyContent: 'center',
          alignItems: 'center',
        }}
        >
          <UiEntity uiTransform={{
            width: 420,
            flexDirection: 'column',
            alignItems: 'center',
            padding: { top: 24, bottom: 24, left: 24, right: 24 },
            borderRadius: 20,
          }}
          uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 12, right: 12 },
                width: 56,
                height: 56,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={() => { closeMailboxHovered = true }}
              onMouseLeave={() => { closeMailboxHovered = false }}
              onMouseDown={() => { playClickSound(); hideMailboxPopup(); closeMailboxHovered = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={44} color={closeMailboxHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Leave a Message" fontSize={28} color={Color4.create(0.2, 0.6, 1, 1)} font="sans-serif" uiTransform={{ margin: { bottom: 8 } }} />
            <Label value={"Join the Flagtag community to\nleave a review or report a bug"} fontSize={16} color={LIGHT_GREY} uiTransform={{ margin: { top: 4, bottom: 20 }, width: 360, height: 50 }} textAlign="middle-center" />
            <UiEntity
              uiTransform={{ width: 240, height: 44, borderRadius: 8, justifyContent: 'center', alignItems: 'center' }}
              uiBackground={{ color: Color4.create(0.2, 0.6, 1, 1) }}
              onMouseDown={() => {
                playClickSound()
                joinCommunity()
              }}
            >
              <Label value="Join Community" fontSize={18} color={Color4.White()} uiTransform={{ width: '100%', height: '100%' }} textAlign="middle-center" />
            </UiEntity>
            {getMailboxStatus() ? (
              <Label value={getMailboxStatus()} fontSize={13} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { top: 12 }, width: 360 }} textAlign="middle-center" />
            ) : null}
          </UiEntity>
        </UiEntity>
      )}
      {/* Spectator mode overlay */}
      {isSpectatorMode() && (
        <UiEntity uiTransform={{
          positionType: 'absolute',
          position: { bottom: 20, left: 0 },
          width: '100%',
          flexDirection: 'column',
          alignItems: 'center',
        }}>
          <Label value="👁 SPECTATOR MODE" fontSize={28} color={Color4.White()} />
          <Label value="WASD = Pan  |  E/F = Up/Down  |  1 = Exit" fontSize={14} color={Color4.create(1, 1, 1, 0.8)} />
          <UiEntity
            uiTransform={{ width: 160, height: 40, margin: { top: 8 } }}
            uiBackground={{ color: Color4.create(1, 1, 1, 0.9) }}
            onMouseDown={() => exitSpectatorMode()}
          >
            <Label value="Exit (1)" fontSize={18} color={Color4.Black()} uiTransform={{ width: '100%', height: '100%' }} />
          </UiEntity>
        </UiEntity>
      )}
    </UiEntity>
  )
}

// ═══════════════════════════════════════════════════════════
// DESKTOP LAYOUT (unchanged from original)
// ═══════════════════════════════════════════════════════════

const PANEL_WIDTH = 240
const ROW_HEIGHT = 32
const VISITORS_PER_PAGE = 10
const VISITOR_ROW_H = ROW_HEIGHT + 4
const LEADERBOARD_PER_PAGE = 12
const TITLE_FONT = 20
const ROW_FONT = 15
const PADDING = 14
const BORDER_RADIUS = 18
const ICON_FONT_SQUARE = 20
const ICON_FONT_QUESTION = 22
const ICON_FONT_ANALYTICS = 20
const ABILITY_BTN_SIZE = 74
const ABILITY_ICON_SIZE = 54
const OVERLAY_PANEL_WIDTH = 680
const OVERLAY_PANEL_HEIGHT = 520

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
  const rawLeaderboardEntries = getLeaderboardEntries()
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
      {/* Timer — top center */}
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { top: 24, left: 0 },
          width: '100%',
          flexDirection: 'row',
          justifyContent: 'center',
        }}
      >
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
          <Label value="Round ends in:" fontSize={16} color={WHITE} font="sans-serif" />
          <Label value={formatCountdown(countdownSeconds)} fontSize={40} color={WHITE} font="sans-serif" />
        </UiEntity>
      </UiEntity>

      {/* Round-end splash */}
      {splashVisible && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 0, left: 0 },
            width: '100%',
            height: '100%',
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
          }}
          uiBackground={{ color: Color4.create(0, 0, 0, 0.45) }}
        >
          <UiEntity
            uiTransform={{
              positionType: 'relative',
              width: 440,
              minHeight: 280,
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 16,
              padding: { top: 36, bottom: 28, left: 40, right: 40 },
              overflow: 'hidden',
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 8, right: 8 },
                width: 56,
                height: 56,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={() => { closeSplashHovered = true }}
              onMouseLeave={() => { closeSplashHovered = false }}
              onMouseDown={() => { playClickSound(); splashVisible = false; closeSplashHovered = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={44} color={closeSplashHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>

            {splashPlayers.length === 0 ? (
              <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                <Label value="Round Over!" fontSize={34} color={GOLD} font="sans-serif" />
                <UiEntity uiTransform={{ height: 24 }} />
                <Label value="Next round starting..." fontSize={15} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
            ) : (
              <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                <Label
                  value={splashPlayers.length === 1 || splashPlayers[0].seconds > (splashPlayers[1]?.seconds ?? 0)
                    ? `${splashPlayers[0].name} Wins!`
                    : 'Round Over!'}
                  fontSize={34}
                  color={GOLD}
                  font="sans-serif"
                />
                <UiEntity uiTransform={{ height: 28 }} />
                {splashPlayers.map((p, i) => {
                  const rankColor = i === 0 ? GOLD : i === 1 ? SILVER : BRONZE
                  const scoreColor = LIGHT_GREY
                  return (
                    <UiEntity
                      key={`splash-${i}`}
                      uiTransform={{
                        width: '100%',
                        height: 34,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: { left: 4, right: 4 },
                      }}
                    >
                      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Label value={`#${i + 1}`} fontSize={18} color={rankColor} font="sans-serif" />
                        <UiEntity uiTransform={{ width: 10 }} />
                        <Label value={p.name} fontSize={18} color={rankColor} font="sans-serif" />
                      </UiEntity>
                      <Label value={`${p.seconds}`} fontSize={18} color={scoreColor} font="sans-serif" />
                    </UiEntity>
                  )
                })}
                <UiEntity uiTransform={{ height: 24 }} />
                <Label value="Next round starting..." fontSize={15} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
            )}
          </UiEntity>
        </UiEntity>
      )}

      {/* How to Play overlay */}
      {winConditionOverlayVisible && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left: 0, top: 0 },
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
              width: 780,
              flexDirection: 'column',
              alignItems: 'center',
              borderRadius: 20,
              padding: { top: 32, bottom: 32, left: 40, right: 40 },
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            {/* Close button */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 12, right: 12 },
                width: 56,
                height: 56,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={() => { closeWinConditionHovered = true }}
              onMouseLeave={() => { closeWinConditionHovered = false }}
              onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); closeWinConditionHovered = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={44} color={closeWinConditionHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>

            {/* Title */}
            <Label value="Flag Tag!" fontSize={56} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: 0 }} />

            {/* Subtitle */}
            <Label
              value="A multiplayer keep away game running 24/7"
              fontSize={17}
              color={MUTED}
              font="sans-serif"
              textAlign="top-center"
            />
            <UiEntity uiTransform={{ height: 12 }} />

            {/* Two-column layout: How to Play | Controls */}
            <UiEntity
              uiTransform={{
                width: '100%',
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
              }}
            >
              {/* Left column — How to Play */}
              <UiEntity
                uiTransform={{
                  width: '62%',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                }}
              >
                <Label value="How to Play" fontSize={24} color={GOLD} font="sans-serif" />
                <UiEntity uiTransform={{ height: 12 }} />
                <Label value="•  Walk into the flag to pick it up" fontSize={16} color={MUTED} font="sans-serif" textAlign="top-left" />
                <UiEntity uiTransform={{ height: 12 }} />
                <Label value="•  Score 1 point for every 1 second you hold the flag" fontSize={16} color={MUTED} font="sans-serif" textAlign="top-left" />
                <UiEntity uiTransform={{ height: 12 }} />
                <Label value="•  Attack the carrier to steal the flag" fontSize={16} color={MUTED} font="sans-serif" textAlign="top-left" />
                <UiEntity uiTransform={{ height: 12 }} />
                <Label value="•  Deploy shells and banana traps to stun your rivals" fontSize={16} color={MUTED} font="sans-serif" textAlign="top-left" />
                <UiEntity uiTransform={{ height: 12 }} />
                <Label value="•  The player with the most points after 5 min. wins!" fontSize={16} color={MUTED} font="sans-serif" textAlign="top-left" />
              </UiEntity>

              {/* Right column — Controls */}
              <UiEntity
                uiTransform={{
                  width: '35%',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                }}
              >
                <Label value="Controls" fontSize={24} color={GOLD} font="sans-serif" />
                <UiEntity uiTransform={{ height: 12 }} />

                {/* LMB — attack/steal */}
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', height: 34 }}>
                  <UiEntity
                    uiTransform={{ width: 32, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 10 } }}
                    uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}
                  >
                    <UiEntity
                      uiTransform={{ width: 29, height: 29 }}
                      uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/cursor2.png' }, color: WHITE }}
                    />
                  </UiEntity>
                  <Label value="to attack/steal flag" fontSize={16} color={MUTED} font="sans-serif" />
                  <UiEntity
                    uiTransform={{ width: 43, height: 43, margin: { left: 8 } }}
                    uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/hit-color.png' }, color: Color4.White() }}
                  />
                </UiEntity>
                <UiEntity uiTransform={{ height: 12 }} />

                {/* E — fire shell */}
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', height: 34 }}>
                  <UiEntity
                    uiTransform={{ width: 32, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 10 } }}
                    uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}
                  >
                    <Label value="E" fontSize={16} color={WHITE} font="sans-serif" />
                  </UiEntity>
                  <Label value="to fire shell" fontSize={16} color={MUTED} font="sans-serif" />
                  <UiEntity
                    uiTransform={{ width: 41, height: 41, margin: { left: 8 } }}
                    uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/shell-color.png' }, color: Color4.White() }}
                  />
                </UiEntity>
                <UiEntity uiTransform={{ height: 12 }} />

                {/* F — drop banana */}
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', height: 34 }}>
                  <UiEntity
                    uiTransform={{ width: 32, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 10 } }}
                    uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}
                  >
                    <Label value="F" fontSize={16} color={WHITE} font="sans-serif" />
                  </UiEntity>
                  <Label value="to drop banana" fontSize={16} color={MUTED} font="sans-serif" />
                  <UiEntity
                    uiTransform={{ width: 43, height: 43, margin: { left: 8 } }}
                    uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/banana-color.png' }, color: Color4.White() }}
                  />
                </UiEntity>
                <UiEntity uiTransform={{ height: 12 }} />

                {/* 3 — drop flag */}
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', height: 34 }}>
                  <UiEntity
                    uiTransform={{ width: 32, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 10 } }}
                    uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}
                  >
                    <Label value="3" fontSize={16} color={WHITE} font="sans-serif" />
                  </UiEntity>
                  <Label value="to drop flag" fontSize={16} color={MUTED} font="sans-serif" />
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
            position: { left: 0, top: 0 },
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
              width: OVERLAY_PANEL_WIDTH,
              height: OVERLAY_PANEL_HEIGHT,
              flexDirection: 'column',
              alignItems: 'stretch',
              borderRadius: 20,
              padding: 24,
              overflow: 'hidden',
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 12, right: 12 },
                width: 56,
                height: 56,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={() => { closeLeaderboardHovered = true }}
              onMouseLeave={() => { closeLeaderboardHovered = false }}
              onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); closeLeaderboardHovered = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={44} color={closeLeaderboardHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Today's Leaderboard" fontSize={28} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: 12 }} />

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
                  <UiEntity uiTransform={{ height: ROW_HEIGHT * 2, justifyContent: 'center', alignItems: 'center' }}>
                    <Label value="No champions yet..." fontSize={ROW_FONT} color={MUTED} font="sans-serif" />
                  </UiEntity>
                ) : (
                  visibleEntries.map((entry, i) => {
                    const isSelf = localUserId !== null && entry.userId === localUserId
                    const nameColor = isSelf ? WHITE : GREY
                    const crowns = '★'.repeat(entry.roundsWon)
                    
                    return (
                      <UiEntity
                        key={`leaderboard-${entry.userId}-${leaderboardScrollOffset}-${i}`}
                        uiTransform={{
                          height: ROW_HEIGHT,
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'flex-start',
                        }}
                      >
                        <Label value={crowns ? crowns + ' ' : ''} fontSize={ROW_FONT} color={GOLD} font="sans-serif" />
                        <Label value={entry.name} fontSize={ROW_FONT} color={nameColor} font="sans-serif" />
                      </UiEntity>
                    )
                  })
                )}
              </UiEntity>

              {lbNeedsScroll && (
                <UiEntity
                  uiTransform={{
                    width: 24,
                    flexDirection: 'column',
                    alignItems: 'center',
                    margin: { left: 4 },
                  }}
                >
                  <UiEntity
                    uiTransform={{
                      width: 24, height: 28,
                      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
                      borderRadius: 4,
                    }}
                    uiBackground={{ color: lbCanScrollUp ? Color4.create(0.25, 0.25, 0.28, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                    onMouseDown={() => { if (lbCanScrollUp) leaderboardScrollOffset -= 1 }}
                  >
                    <Label value="▲" fontSize={14} color={lbCanScrollUp ? WHITE : CLOSE_GREY} font="sans-serif" />
                  </UiEntity>

                  <UiEntity
                    uiTransform={{
                      width: 10, flexGrow: 1, flexDirection: 'column',
                      borderRadius: 0, margin: { top: 2, bottom: 2 },
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
                            uiTransform={{ width: 10, flexGrow: 1, borderRadius: 0 }}
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
                      width: 24, height: 28,
                      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
                      borderRadius: 4,
                    }}
                    uiBackground={{ color: lbCanScrollDown ? Color4.create(0.25, 0.25, 0.28, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                    onMouseDown={() => { if (lbCanScrollDown) leaderboardScrollOffset += 1 }}
                  >
                    <Label value="▼" fontSize={14} color={lbCanScrollDown ? WHITE : CLOSE_GREY} font="sans-serif" />
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
            position: { left: 0, top: 0 },
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
              width: OVERLAY_PANEL_WIDTH,
              height: OVERLAY_PANEL_HEIGHT,
              flexDirection: 'column',
              alignItems: 'flex-start',
              borderRadius: 20,
              padding: 24,
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 12, right: 12 },
                width: 56,
                height: 56,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={() => { closeAnalyticsHovered = true }}
              onMouseLeave={() => { closeAnalyticsHovered = false }}
              onMouseDown={() => { playClickSound(); setAnalyticsOverlayVisible(false); closeAnalyticsHovered = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={44} color={closeAnalyticsHovered ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Daily Visitors" fontSize={28} color={GOLD} font="sans-serif" textAlign="top-left" />
            <UiEntity uiTransform={{ height: 16 }} />
            
            <UiEntity
              uiTransform={{
                width: '100%',
                height: ROW_HEIGHT,
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <UiEntity uiTransform={{ width: '20%' }}>
                <Label value={`Unique Users: ${visitorCount}`} fontSize={13} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '14%' }}>
                <Label value={`Online: ${onlineCount}`} fontSize={13} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '12%' }}>
                <Label value={`Server: ${serverConnected}`} fontSize={13} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '18%' }}>
                <Label value={`Date: ${formatUTCDate()}`} fontSize={13} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: '36%' }}>
                <Label value={`Time (UTC): ${formatUTCTime()}`} fontSize={13} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
            </UiEntity>
            
            <UiEntity uiTransform={{ height: 20 }} />
            
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
                  <UiEntity uiTransform={{ height: ROW_HEIGHT * 2, justifyContent: 'center', alignItems: 'center' }}>
                    <Label value="No visitors today" fontSize={ROW_FONT} color={MUTED} font="sans-serif" />
                  </UiEntity>
                ) : (
                  visibleVisitors.map((visitor, i) => (
                      <UiEntity
                        key={`visitor-${visitor.userId}-${visitorScrollOffset}-${i}`}
                        uiTransform={{
                          width: '100%',
                          height: VISITOR_ROW_H,
                          flexDirection: 'row',
                          alignItems: 'center',
                          padding: { left: 0, right: 8, top: 2, bottom: 2 },
                        }}
                      >
                        <UiEntity uiTransform={{ width: '5%', flexDirection: 'row', alignItems: 'center' }}>
                          <Label 
                            value={visitor.isOnline ? "●" : "○"} 
                            fontSize={14} 
                            color={visitor.isOnline ? WHITE : GREY} 
                            font="sans-serif" 
                          />
                        </UiEntity>
                        <UiEntity uiTransform={{ width: '15%', overflow: 'hidden', height: VISITOR_ROW_H }}>
                          <Label value={visitor.name} fontSize={12} color={WHITE} font="sans-serif" />
                        </UiEntity>
                        <UiEntity uiTransform={{ width: '68%', overflow: 'hidden', height: VISITOR_ROW_H, padding: { left: 16 } }}>
                          <Label value={visitor.userId} fontSize={11} color={WHITE} font="sans-serif" />
                        </UiEntity>
                        <UiEntity uiTransform={{ width: '12%', flexDirection: 'row', justifyContent: 'flex-end' }}>
                          <Label value={formatVisitorTime(visitor.totalSeconds)} fontSize={12} color={WHITE} font="sans-serif" />
                        </UiEntity>
                      </UiEntity>
                    ))
                )}
              </UiEntity>

              {needsScroll && (
                <UiEntity
                  uiTransform={{
                    width: 24,
                    flexDirection: 'column',
                    alignItems: 'center',
                    margin: { left: 4 },
                  }}
                >
                  <UiEntity
                    uiTransform={{
                      width: 24, height: 28,
                      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
                      borderRadius: 4,
                    }}
                    uiBackground={{ color: canScrollUp ? Color4.create(0.25, 0.25, 0.28, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                    onMouseDown={() => { if (canScrollUp) visitorScrollOffset -= 1 }}
                  >
                    <Label value="▲" fontSize={14} color={canScrollUp ? WHITE : CLOSE_GREY} font="sans-serif" />
                  </UiEntity>

                  <UiEntity
                    uiTransform={{
                      width: 10, flexGrow: 1, flexDirection: 'column',
                      borderRadius: 0, margin: { top: 2, bottom: 2 },
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
                            uiTransform={{ width: 10, flexGrow: 1, borderRadius: 0 }}
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
                      width: 24, height: 28,
                      flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
                      borderRadius: 4,
                    }}
                    uiBackground={{ color: canScrollDown ? Color4.create(0.25, 0.25, 0.28, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                    onMouseDown={() => { if (canScrollDown) visitorScrollOffset += 1 }}
                  >
                    <Label value="▼" fontSize={14} color={canScrollDown ? WHITE : CLOSE_GREY} font="sans-serif" />
                  </UiEntity>
                </UiEntity>
              )}
            </UiEntity>
          </UiEntity>
        </UiEntity>
        )
      })()}

      {/* ── Right-side container: ability icons row + scoreboard stacked vertically ── */}
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { right: 16, top: 14 },
          width: PANEL_WIDTH,
          flexDirection: 'column',
          alignItems: 'stretch',
        }}
      >
        {/* Ability icons row */}
        <UiEntity
          uiTransform={{
            width: PANEL_WIDTH,
            flexDirection: 'row',
            justifyContent: 'space-between',
            margin: { bottom: 6 },
          }}
        >
          {/* Attack (Left Click) */}
          <UiEntity
            uiTransform={{
              width: ABILITY_BTN_SIZE, height: ABILITY_BTN_SIZE,
              flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              borderRadius: { topLeft: 0, topRight: 38, bottomLeft: 38, bottomRight: 38 },
            }}
            uiBackground={{ color: PANEL_BG_SEMI }}
          >
            <UiEntity
              uiTransform={{ positionType: 'absolute', position: { top: 4, left: 1 }, width: 32, height: 32 }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: 'assets/images/cursor2.png' },
                color: LIGHT_GREY
              }}
            />
            <UiEntity
              uiTransform={{ width: ABILITY_ICON_SIZE, height: ABILITY_ICON_SIZE, margin: { top: 6 } }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: 'assets/images/hit-color.png' },
                color: isAttackFlickering() ? Color4.create(1, 1, 1, 0.25) : Color4.White()
              }}
            />
          </UiEntity>

          {/* Shell (E) */}
          <UiEntity
            uiTransform={{
              width: ABILITY_BTN_SIZE, height: ABILITY_BTN_SIZE,
              flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              borderRadius: { topLeft: 0, topRight: 38, bottomLeft: 38, bottomRight: 38 },
            }}
            uiBackground={{ color: PANEL_BG_SEMI }}
          >
            <Label value="E" fontSize={16} color={LIGHT_GREY} font="sans-serif"
              uiTransform={{ positionType: 'absolute', position: { top: -2, left: 5 } }}
            />
            <UiEntity
              uiTransform={{ width: ABILITY_ICON_SIZE - 6, height: ABILITY_ICON_SIZE - 6, margin: { top: 6 } }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: isShellOnCooldown() ? 'assets/images/shell-bw.png' : 'assets/images/shell-color.png' },
                color: isShellOnCooldown() ? Color4.create(1, 1, 1, 0.3) : Color4.White()
              }}
            />
            {isShellOnCooldown() && (
              <Label value={`${getShellCooldownRemaining()}`} fontSize={26} color={WHITE} font="sans-serif"
                uiTransform={{ positionType: 'absolute' }}
              />
            )}
          </UiEntity>

          {/* Banana (F) */}
          <UiEntity
            uiTransform={{
              width: ABILITY_BTN_SIZE, height: ABILITY_BTN_SIZE,
              flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              borderRadius: { topLeft: 0, topRight: 38, bottomLeft: 38, bottomRight: 38 },
            }}
            uiBackground={{ color: PANEL_BG_SEMI }}
          >
            <Label value="F" fontSize={16} color={LIGHT_GREY} font="sans-serif"
              uiTransform={{ positionType: 'absolute', position: { top: -2, left: 5 } }}
            />
            <UiEntity
              uiTransform={{ width: ABILITY_ICON_SIZE, height: ABILITY_ICON_SIZE, margin: { top: 6 } }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: isBananaOnCooldown() ? 'assets/images/banana-bw.png' : 'assets/images/banana-color.png' },
                color: isBananaOnCooldown() ? Color4.create(1, 1, 1, 0.3) : Color4.White()
              }}
            />
            {isBananaOnCooldown() && (
              <Label value={`${getBananaCooldownRemaining()}`} fontSize={26} color={WHITE} font="sans-serif"
                uiTransform={{ positionType: 'absolute' }}
              />
            )}
          </UiEntity>
        </UiEntity>

        {/* Scoreboard panel */}
        <UiEntity
          uiTransform={{
            width: PANEL_WIDTH,
            flexDirection: 'column',
            alignItems: 'stretch',
            borderRadius: BORDER_RADIUS,
            padding: PADDING,
          }}
          uiBackground={{ color: PANEL_BG }}
        >
        <UiEntity
          uiTransform={{
            height: ROW_HEIGHT,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Label value="Scoreboard" fontSize={TITLE_FONT} color={MUTED} font="sans-serif" />
          <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
            <UiEntity
              uiTransform={{ width: 28, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
              onMouseEnter={() => { squareIconHovered = true }}
              onMouseLeave={() => { squareIconHovered = false }}
              onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); setAnalyticsOverlayVisible(false); leaderboardScrollOffset = 0; toggleLeaderboardOverlay(); notifyOverlayClosed() }}
            >
              <Label value="★" fontSize={ICON_FONT_SQUARE} color={leaderboardOverlayVisible || squareIconHovered ? GOLD : WHITE} font="sans-serif" />
            </UiEntity>
            <UiEntity
              uiTransform={{ width: 28, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
              onMouseEnter={() => { questionIconHovered = true }}
              onMouseLeave={() => { questionIconHovered = false }}
              onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); setAnalyticsOverlayVisible(false); toggleWinConditionOverlay(); notifyOverlayClosed() }}
            >
              <Label value="?" fontSize={ICON_FONT_QUESTION} color={winConditionOverlayVisible || questionIconHovered ? GOLD : WHITE} font="sans-serif" />
            </UiEntity>
            <UiEntity
              uiTransform={{ width: 28, height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
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
              <Label value="#" fontSize={ICON_FONT_ANALYTICS} color={analyticsOverlayVisible || analyticsIconHovered ? GOLD : WHITE} font="sans-serif" />
            </UiEntity>
          </UiEntity>
        </UiEntity>
        {players.length === 0 ? (
          <UiEntity uiTransform={{ height: ROW_HEIGHT * 2, justifyContent: 'center', alignItems: 'center' }}>
            <Label value="Waiting for players..." fontSize={ROW_FONT} color={MUTED} font="sans-serif" />
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
                  height: ROW_HEIGHT,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: { left: 8, right: 8, top: 2, bottom: 2 },
                  borderRadius: 6
                }}
                uiBackground={{ color: rowBg }}
              >
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                  {isCarrier ? (
                    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Label value="★ " fontSize={ROW_FONT} color={GOLD} font="sans-serif" />
                      <Label value={p.name} fontSize={ROW_FONT} color={nameColor} font="sans-serif" />
                    </UiEntity>
                  ) : (
                    <Label value={p.name} fontSize={ROW_FONT} color={nameColor} font="sans-serif" />
                  )}
                </UiEntity>
                <Label value={`${p.seconds}`} fontSize={ROW_FONT} color={timeColor} font="sans-serif" />
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
  const rawLeaderboardEntries = getLeaderboardEntries()
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
                onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); setAnalyticsOverlayVisible(false); mobileScoreboardOverlayVisible = false; leaderboardScrollOffset = 0; toggleLeaderboardOverlay(); notifyOverlayClosed() }}
              >
                <Label value="★" fontSize={34} color={leaderboardOverlayVisible ? GOLD : WHITE} font="sans-serif"
                  uiTransform={{ margin: { bottom: 4 } }}
                />
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
                  <Label value=" ★" fontSize={32} color={GOLD} font="sans-serif" />
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
                    texture: { src: isBananaOnCooldown() ? 'assets/images/banana-bw.png' : 'assets/images/banana-color.png' },
                    color: isBananaOnCooldown() ? Color4.create(1, 1, 1, 0.3) : Color4.White()
                  }}
                />
                {isBananaOnCooldown() && (
                  <Label value={`${getBananaCooldownRemaining()}`} fontSize={26} color={WHITE} font="sans-serif"
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
                  uiTransform={{ width: M_ICON_SIZE - 4, height: M_ICON_SIZE - 4 }}
                  uiBackground={{
                    textureMode: 'stretch',
                    texture: { src: isShellOnCooldown() ? 'assets/images/shell-bw.png' : 'assets/images/shell-color.png' },
                    color: isShellOnCooldown() ? Color4.create(1, 1, 1, 0.3) : Color4.White()
                  }}
                />
                {isShellOnCooldown() && (
                  <Label value={`${getShellCooldownRemaining()}`} fontSize={26} color={WHITE} font="sans-serif"
                    uiTransform={{ positionType: 'absolute' }}
                  />
                )}
              </UiEntity>

              <UiEntity
                uiTransform={{
                  width: M_CIRCLE_SIZE, height: M_CIRCLE_SIZE,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
              >
                <UiEntity
                  uiTransform={{ width: M_ICON_SIZE, height: M_ICON_SIZE }}
                  uiBackground={{
                    textureMode: 'stretch',
                    texture: { src: 'assets/images/hit-color.png' },
                    color: isAttackFlickering() ? Color4.create(1, 1, 1, 0.25) : Color4.White()
                  }}
                />
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
                position: { top: 6, right: 6 },
                width: 64, height: 64,
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
                          <Label value="★ " fontSize={22} color={GOLD} font="sans-serif" />
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

      {/* ── Round-end splash — centered (safe area) ── */}
      {splashVisible && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 0, left: 0 },
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
                position: { top: 6, right: 6 },
                width: 64, height: 64,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseDown={() => { playClickSound(); splashVisible = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={52} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>

            {splashPlayers.length === 0 ? (
              <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                <Label value="Round Over!" fontSize={42} color={GOLD} font="sans-serif" />
                <UiEntity uiTransform={{ height: 20 }} />
                <Label value="Next round starting..." fontSize={22} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
            ) : (
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
            )}
          </UiEntity>
        </UiEntity>
      )}

      {/* ── How to Play overlay — centered (safe area) ── */}
      {winConditionOverlayVisible && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left: 0, top: 106 },
            width: '100%', height: 'auto',
            flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-start',
          }}
        >
          <UiEntity
            uiTransform={{
              positionType: 'relative',
              width: '65%',
              flexDirection: 'column',
              alignItems: 'center',
              padding: { top: 32, bottom: 32, left: 32, right: 32 },
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            {/* Close button */}
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 6, right: 6 },
                width: 64, height: 64,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={52} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>

            {/* Title */}
            <Label value="Flag Tag!" fontSize={64} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: 0 }} />

            {/* Subtitle */}
            <Label
              value="A multiplayer keep away game running 24/7"
              fontSize={20}
              color={MUTED}
              font="sans-serif"
              textAlign="top-center"
            />
            <UiEntity uiTransform={{ height: 12 }} />

            {/* Two-column layout: How to Play | Controls */}
            <UiEntity
              uiTransform={{
                width: '100%',
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
              }}
            >
              {/* Left column — How to Play */}
              <UiEntity
                uiTransform={{
                  width: '62%',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                }}
              >
                <Label value="How to Play" fontSize={30} color={GOLD} font="sans-serif" />
                <UiEntity uiTransform={{ height: 14 }} />
                <Label value="•  Walk into the flag to pick it up" fontSize={22} color={MUTED} font="sans-serif" textAlign="top-left" />
                <UiEntity uiTransform={{ height: 14 }} />
                <Label value="•  Score 1 point for every 1 second you hold the flag" fontSize={22} color={MUTED} font="sans-serif" textAlign="top-left" />
                <UiEntity uiTransform={{ height: 14 }} />
                <Label value="•  Attack the carrier to steal the flag" fontSize={22} color={MUTED} font="sans-serif" textAlign="top-left" />
                <UiEntity uiTransform={{ height: 14 }} />
                <Label value="•  Deploy shells and banana traps to stun your rivals" fontSize={22} color={MUTED} font="sans-serif" textAlign="top-left" />
                <UiEntity uiTransform={{ height: 14 }} />
                <Label value="•  The player with the most points after 5 min. wins!" fontSize={22} color={MUTED} font="sans-serif" textAlign="top-left" />
              </UiEntity>

              {/* Right column — Controls */}
              <UiEntity
                uiTransform={{
                  width: '35%',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                }}
              >
                <Label value="Controls" fontSize={30} color={GOLD} font="sans-serif" />
                <UiEntity uiTransform={{ height: 14 }} />

                {/* LMB — attack/steal */}
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', height: 40 }}>
                  <UiEntity
                    uiTransform={{ width: 38, height: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 10 } }}
                    uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}
                  >
                    <UiEntity
                      uiTransform={{ width: 34, height: 34 }}
                      uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/cursor2.png' }, color: WHITE }}
                    />
                  </UiEntity>
                  <Label value="to attack/steal flag" fontSize={22} color={MUTED} font="sans-serif" />
                  <UiEntity
                    uiTransform={{ width: 55, height: 55, margin: { left: 8 } }}
                    uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/hit-color.png' }, color: Color4.White() }}
                  />
                </UiEntity>
                <UiEntity uiTransform={{ height: 14 }} />

                {/* E — fire shell */}
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', height: 40 }}>
                  <UiEntity
                    uiTransform={{ width: 38, height: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 10 } }}
                    uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}
                  >
                    <Label value="E" fontSize={22} color={WHITE} font="sans-serif" />
                  </UiEntity>
                  <Label value="to fire shell" fontSize={22} color={MUTED} font="sans-serif" />
                  <UiEntity
                    uiTransform={{ width: 52, height: 52, margin: { left: 8 } }}
                    uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/shell-color.png' }, color: Color4.White() }}
                  />
                </UiEntity>
                <UiEntity uiTransform={{ height: 14 }} />

                {/* F — drop banana */}
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', height: 40 }}>
                  <UiEntity
                    uiTransform={{ width: 38, height: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 10 } }}
                    uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}
                  >
                    <Label value="F" fontSize={22} color={WHITE} font="sans-serif" />
                  </UiEntity>
                  <Label value="to drop banana" fontSize={22} color={MUTED} font="sans-serif" />
                  <UiEntity
                    uiTransform={{ width: 55, height: 55, margin: { left: 8 } }}
                    uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/banana-color.png' }, color: Color4.White() }}
                  />
                </UiEntity>
                <UiEntity uiTransform={{ height: 14 }} />

                {/* 3 — drop flag */}
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', height: 40 }}>
                  <UiEntity
                    uiTransform={{ width: 38, height: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 4, margin: { right: 10 } }}
                    uiBackground={{ color: Color4.create(0.3, 0.3, 0.32, 1) }}
                  >
                    <Label value="3" fontSize={22} color={WHITE} font="sans-serif" />
                  </UiEntity>
                  <Label value="to drop flag" fontSize={22} color={MUTED} font="sans-serif" />
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
                position: { top: 6, right: 6 },
                width: 64, height: 64,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={52} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Today's Leaderboard" fontSize={36} color={GOLD} font="sans-serif" />
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
                  const crowns = '★'.repeat(entry.roundsWon)
                  return (
                    <UiEntity
                      key={`m-lb-${entry.userId}-${leaderboardScrollOffset}-${i}`}
                      uiTransform={{
                        height: 44,
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start',
                      }}
                    >
                      <Label value={crowns ? crowns + ' ' : ''} fontSize={22} color={GOLD} font="sans-serif" />
                      <Label value={entry.name} fontSize={22} color={nameColor} font="sans-serif" />
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
                position: { top: 6, right: 6 },
                width: 64, height: 64,
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
