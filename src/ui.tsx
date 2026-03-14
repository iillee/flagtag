import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { getPlayer } from '@dcl/sdk/players'
import {
  getPlayersWithHoldTimes,
  getCurrentFlagCarrierUserId,
  getKnownPlayerName
} from './gameState/flagHoldTime'
import { getAllVisitors, getTodayVisitorCount, getCurrentOnlineCount } from './gameState/sceneTime'
import { getLeaderboardEntries } from './gameState/roundsWon'
import { getCountdownSeconds, CountdownTimer, Flag } from './shared/components'
import { engine, AudioSource, Transform, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { getWinConditionOverlayVisible, toggleWinConditionOverlay, setWinConditionOverlayVisible } from './components/winConditionOverlayState'
import { getLeaderboardOverlayVisible, toggleLeaderboardOverlay, setLeaderboardOverlayVisible } from './components/leaderboardOverlayState'
import { getAnalyticsOverlayVisible, toggleAnalyticsOverlay, setAnalyticsOverlayVisible } from './components/analyticsOverlayState'

export function setupUi() {
  ReactEcsRenderer.setUiRenderer(PlayerListUi)
}

let squareIconHovered = false
let questionIconHovered = false
let analyticsIconHovered = false

// ── Round-end splash state ──
let splashVisible = false
let splashHideTime = 0
let prevCountdown = -1
let trumpetEntity: Entity | null = null
const SPLASH_DURATION_MS = 5000

interface SplashPlayer {
  name: string
  seconds: number
}

let splashPlayers: SplashPlayer[] = []
let splashFromServer = false

function roundEndSplashSystem(dt: number): void {
  const countdown = getCountdownSeconds()
  const now = Date.now()

  // Detect the moment countdown hits 0 (was positive last frame)
  if (prevCountdown > 0 && countdown === 0) {
    splashVisible = true
    splashHideTime = now + SPLASH_DURATION_MS
    splashFromServer = false

    // Snapshot client-side scoreboard immediately (before CRDT resets arrive)
    const currentPlayers = getPlayersWithHoldTimes()
    splashPlayers = currentPlayers
      .filter(p => p.seconds > 0)
      .slice(0, 3)
      .map(p => ({ name: getKnownPlayerName(p.userId) || p.name, seconds: p.seconds }))

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

  // While splash is showing, try to upgrade to server data
  if (splashVisible && !splashFromServer) {
    for (const [, timer] of engine.getEntitiesWith(CountdownTimer)) {
      if (timer.roundWinnerJson) {
        try {
          const serverData = JSON.parse(timer.roundWinnerJson) as Array<{ userId?: string; name: string; seconds: number }>
          if (serverData.length > 0) {
            splashPlayers = serverData.slice(0, 3).map(p => ({
              name: (p.userId ? getKnownPlayerName(p.userId) : null) || p.name,
              seconds: p.seconds
            }))
            splashFromServer = true
          }
        } catch { /* ignore parse errors */ }
      }
      break
    }
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

  prevCountdown = countdown
}

engine.addSystem(roundEndSplashSystem)

// Tie-breaking tracking for stable sorting
const roundWinAchievementTime = new Map<string, number>() // userId -> timestamp when they first achieved current win count
const scoreAchievementTime = new Map<string, number>() // userId -> timestamp when they first achieved current score
let lastKnownScores = new Map<string, number>() // userId -> last known seconds
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

// Stable sorting for scoreboard with tie-breaking  
function getSortedScoreboardPlayers(players: any[]): any[] {
  const now = Date.now()
  
  // Track achievement times for scores (only when score actually increases)
  players.forEach(player => {
    const key = player.userId
    const currentSeconds = player.seconds
    
    // Only update achievement time when score INCREASES (not on every render)
    const lastKnown = lastKnownScores.get(key) || 0
    if (currentSeconds > lastKnown) {
      scoreAchievementTime.set(key, now)
      lastKnownScores.set(key, currentSeconds)
    } else if (!scoreAchievementTime.has(key)) {
      // First time seeing this player
      scoreAchievementTime.set(key, now)
      lastKnownScores.set(key, currentSeconds)
    }
  })
  
  // Sort: Primary by seconds (desc), secondary by userId (consistent tie-breaker)
  return [...players].sort((a, b) => {
    // Primary sort: higher score first
    if (a.seconds !== b.seconds) {
      return b.seconds - a.seconds
    }
    // Tie-breaker: consistent alphabetical by userId
    return a.userId.localeCompare(b.userId)
  })
}

const PANEL_WIDTH = 240
const ROW_HEIGHT = 32
const TITLE_FONT = 20
const ROW_FONT = 15
const PADDING = 14
const BORDER_RADIUS = 18
const GAP_LEFT_OF_SCOREBOARD = 8
const ICON_PANEL_HEIGHT_THREE_ICONS = PADDING * 2 + ROW_HEIGHT * 3
const ICON_FONT_SQUARE = 20
const ICON_FONT_QUESTION = 22
const ICON_FONT_ANALYTICS = 20
const ICON_PANEL_WIDTH = 48
const ICON_PANEL_PADDING = 10
const ICON_ROW_HEIGHT = (ICON_PANEL_HEIGHT_THREE_ICONS - ICON_PANEL_PADDING * 2) / 3
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
// Layout Constants
const OVERLAY_PANEL_WIDTH = 680
const OVERLAY_PANEL_MIN_HEIGHT = 360

function getServerConnectionStatus(): 'Y' | 'N' {
  // Check if Flag entities exist (they're only created by the authoritative server)
  const flagCount = [...engine.getEntitiesWith(Flag)].length
  return flagCount > 0 ? 'Y' : 'N'
}

function formatCountdown(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h === 0) return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function formatUTCTime(): string {
  const now = new Date()
  return now.toUTCString().slice(17, 25) // Extract just the time part HH:MM:SS
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

function PlayerListUi() {
  const rawPlayers = getPlayersWithHoldTimes()
  // getPlayersWithHoldTimes already sorts by seconds (desc), just use it directly
  const players = rawPlayers
  const localUserId = getPlayer()?.userId ?? null
  const rawVisitors = getAllVisitors()
  
  // Sort visitors: Online first (alphabetical), then offline (alphabetical)
  const allVisitors = [...rawVisitors].sort((a, b) => {
    // Primary sort: Online status (online first)
    if (a.isOnline !== b.isOnline) {
      return a.isOnline ? -1 : 1
    }
    // Secondary sort: Alphabetical by name
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
  const leaderboardPanelHeight = Math.max(
    OVERLAY_PANEL_MIN_HEIGHT,
    24 * 2 + 32 + 12 + (leaderboardEntries.length === 0 ? 28 : leaderboardEntries.length * ROW_HEIGHT)
  )
  const serverConnected = getServerConnectionStatus()

  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: '100%',
        positionType: 'relative',
      }}
    >
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
          <Label value="Time until round ends" fontSize={16} color={WHITE} font="sans-serif" />
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
              flexDirection: 'column',
              alignItems: 'center',
              borderRadius: 16,
              padding: { top: 36, bottom: 28, left: 40, right: 40 },
            }}
            uiBackground={{ color: Color4.create(0.16, 0.16, 0.18, 0.95) }}
          >
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 12, right: 12 },
                width: 28,
                height: 28,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseDown={() => { splashVisible = false }}
            >
              <Label value="×" fontSize={22} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>

            {splashPlayers.length === 0 ? (
              <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                <Label value="Round Over!" fontSize={34} color={GOLD} font="sans-serif" />
                <UiEntity uiTransform={{ height: 24 }} />
                <Label value="Next round starting..." fontSize={15} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
            ) : (
              <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                {/* Winner title */}
                <Label
                  value={splashPlayers.length === 1 || splashPlayers[0].seconds > (splashPlayers[1]?.seconds ?? 0)
                    ? `${splashPlayers[0].name} Wins!`
                    : 'Round Over!'}
                  fontSize={34}
                  color={GOLD}
                  font="sans-serif"
                />

                {/* Spacer between title and rankings */}
                <UiEntity uiTransform={{ height: 28 }} />

                {/* Rankings list */}
                {splashPlayers.map((p, i) => {
                  const rankColor = i === 0 ? GOLD : i === 1 ? SILVER : BRONZE
                  const nameColor = i === 0 ? GOLD : i === 1 ? SILVER : BRONZE
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
                      {/* Left side: rank + name */}
                      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Label
                          value={`#${i + 1}`}
                          fontSize={18}
                          color={rankColor}
                          font="sans-serif"
                        />
                        <UiEntity uiTransform={{ width: 10 }} />
                        <Label
                          value={p.name}
                          fontSize={18}
                          color={nameColor}
                          font="sans-serif"
                        />
                      </UiEntity>
                      {/* Right side: score */}
                      <Label
                        value={`${p.seconds}`}
                        fontSize={18}
                        color={scoreColor}
                        font="sans-serif"
                      />
                    </UiEntity>
                  )
                })}

                {/* Spacer before footer */}
                <UiEntity uiTransform={{ height: 24 }} />

                {/* Footer message */}
                <Label value="Next round starting..." fontSize={15} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
            )}
          </UiEntity>
        </UiEntity>
      )}

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
              width: OVERLAY_PANEL_WIDTH,
              minHeight: OVERLAY_PANEL_MIN_HEIGHT,
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
                width: 28,
                height: 28,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseDown={() => setWinConditionOverlayVisible(false)}
            >
              <Label value="×" fontSize={22} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="How to Play" fontSize={28} color={LIGHT_BLUE} font="sans-serif" textAlign="top-left" />
            <UiEntity uiTransform={{ height: 8 }} />
            <Label
              value="Grab the flag and earn 1 point for every 1 second it's held.

Steal the flag by hitting the flag holder with E.

Whoever has the most points at the end of the round wins!"
              fontSize={16}
              color={MUTED}
              font="sans-serif"
              textAlign="top-left"
            />
            <UiEntity uiTransform={{ height: 20 }} />
            <Label value="Controls" fontSize={28} color={LIGHT_BLUE} font="sans-serif" textAlign="top-left" />
            <UiEntity uiTransform={{ height: 8 }} />
            <Label value="E     pick up flag/drop flag/attack" fontSize={16} color={MUTED} font="sans-serif" textAlign="top-left" />
          </UiEntity>
        </UiEntity>
      )}

      {leaderboardOverlayVisible && (
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
              height: leaderboardPanelHeight,
              flexDirection: 'column',
              alignItems: 'stretch',
              borderRadius: 20,
              padding: 24,
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { top: 12, right: 12 },
                width: 28,
                height: 28,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseDown={() => setLeaderboardOverlayVisible(false)}
            >
              <Label value="×" fontSize={22} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Today's Leaderboard" fontSize={28} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: 12 }} />
            {leaderboardEntries.length === 0 ? (
              <UiEntity uiTransform={{ height: ROW_HEIGHT * 2, justifyContent: 'center', alignItems: 'center' }}>
                <Label value="No champions yet..." fontSize={ROW_FONT} color={MUTED} font="sans-serif" />
              </UiEntity>
            ) : (
              leaderboardEntries.map((entry, i) => {
                const isSelf = localUserId !== null && entry.userId === localUserId
                const nameColor = isSelf ? WHITE : GREY
                const crowns = '★'.repeat(entry.roundsWon)
                
                return (
                  <UiEntity
                    key={`leaderboard-${entry.userId}-${i}`}
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
        </UiEntity>
      )}

      {analyticsOverlayVisible && (
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
              minHeight: OVERLAY_PANEL_MIN_HEIGHT,
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
                width: 28,
                height: 28,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseDown={() => setAnalyticsOverlayVisible(false)}
            >
              <Label value="×" fontSize={22} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Daily Visitors" fontSize={28} color={CORAL_RED} font="sans-serif" textAlign="top-left" />
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
            
            {/* Visitor List */}
            {allVisitors.length === 0 ? (
              <UiEntity uiTransform={{ height: ROW_HEIGHT * 2, justifyContent: 'center', alignItems: 'center' }}>
                <Label value="No visitors today" fontSize={ROW_FONT} color={MUTED} font="sans-serif" />
              </UiEntity>
            ) : (
              allVisitors.map((visitor, i) => (
                  <UiEntity
                    key={`visitor-${visitor.userId}-${i}`}
                    uiTransform={{
                      width: '100%',
                      height: ROW_HEIGHT + 4,
                      flexDirection: 'row',
                      alignItems: 'center',
                      padding: { left: 0, right: 16, top: 2, bottom: 2 },
                    }}
                  >
                    <UiEntity uiTransform={{ width: '6%', flexDirection: 'row', alignItems: 'center' }}>
                      <Label 
                        value={visitor.isOnline ? "●" : "○"} 
                        fontSize={16} 
                        color={visitor.isOnline ? WHITE : GREY} 
                        font="sans-serif" 
                      />
                    </UiEntity>
                    <UiEntity uiTransform={{ width: '24%' }}>
                      <Label value={visitor.name} fontSize={ROW_FONT} color={WHITE} font="sans-serif" />
                    </UiEntity>
                    <UiEntity uiTransform={{ width: '55%' }}>
                      <Label 
                        value={visitor.userId} 
                        fontSize={13} 
                        color={WHITE} 
                        font="sans-serif" 
                      />
                    </UiEntity>
                    <UiEntity uiTransform={{ width: '15%', flexDirection: 'row', justifyContent: 'flex-end' }}>
                      <Label 
                        value={formatVisitorTime(visitor.totalSeconds)} 
                        fontSize={ROW_FONT} 
                        color={WHITE} 
                        font="sans-serif" 
                      />
                    </UiEntity>
                  </UiEntity>
                ))
            )}
          </UiEntity>
        </UiEntity>
      )}

      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { right: 16 + 48 + PANEL_WIDTH + GAP_LEFT_OF_SCOREBOARD, top: 14 },
          width: ICON_PANEL_WIDTH,
          height: ICON_PANEL_HEIGHT_THREE_ICONS,
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: ICON_PANEL_PADDING,
          borderRadius: 14,
        }}
        uiBackground={{ color: PANEL_BG_SEMI }}
      >
        <UiEntity
          uiTransform={{ width: '100%', height: ICON_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
          onMouseEnter={() => { squareIconHovered = true }}
          onMouseLeave={() => { squareIconHovered = false }}
          onMouseDown={() => { setWinConditionOverlayVisible(false); setAnalyticsOverlayVisible(false); toggleLeaderboardOverlay() }}
        >
          <Label value="★" fontSize={ICON_FONT_SQUARE} color={leaderboardOverlayVisible || squareIconHovered ? GOLD : WHITE} font="sans-serif" />
        </UiEntity>
        <UiEntity
          uiTransform={{ width: '100%', height: ICON_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
          onMouseEnter={() => { questionIconHovered = true }}
          onMouseLeave={() => { questionIconHovered = false }}
          onMouseDown={() => { setLeaderboardOverlayVisible(false); setAnalyticsOverlayVisible(false); toggleWinConditionOverlay() }}
        >
          <Label value="?" fontSize={ICON_FONT_QUESTION} color={winConditionOverlayVisible || questionIconHovered ? LIGHT_BLUE : WHITE} font="sans-serif" />
        </UiEntity>
        <UiEntity
          uiTransform={{ width: '100%', height: ICON_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
          onMouseEnter={() => { analyticsIconHovered = true }}
          onMouseLeave={() => { analyticsIconHovered = false }}
          onMouseDown={() => { 
            setWinConditionOverlayVisible(false); 
            setLeaderboardOverlayVisible(false);
            toggleAnalyticsOverlay();
          }}
        >
          <Label value="#" fontSize={ICON_FONT_ANALYTICS} color={analyticsOverlayVisible || analyticsIconHovered ? CORAL_RED : WHITE} font="sans-serif" />
        </UiEntity>
      </UiEntity>

      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { right: 16 + 48, top: 14 },
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
            const nameColor = isLeader ? BRIGHT_GOLD : 
                            isSelf ? BRIGHT_WHITE : 
                            LIGHT_GREY
            const timeColor = isLeader ? GOLD : 
                            p.seconds > 0 ? WHITE : MUTED
            const rowBg = isLeader ? Color4.create(0.3, 0.25, 0.1, 0.3) :
                        Color4.create(0, 0, 0, 0)
            
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
  )
}
