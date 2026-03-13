import { Color4, Vector3 } from '@dcl/sdk/math'
import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { getPlayer } from '@dcl/sdk/players'
import {
  getPlayersWithHoldTimes,
  getCurrentFlagCarrierUserId,
  getKnownPlayerName
} from './gameState/flagHoldTime'
import { getAllVisitors, getTodayVisitorCount, getCurrentOnlineCount } from './gameState/sceneTime'
import { getLeaderboardEntries } from './gameState/roundsWon'
import { getCountdownSeconds, CountdownTimer, getRoundWinners, Flag } from './shared/components'
import { engine, Transform, AudioSource, type Entity } from '@dcl/sdk/ecs'
import { getWinConditionOverlayVisible, toggleWinConditionOverlay, setWinConditionOverlayVisible } from './components/winConditionOverlayState'
import { getLeaderboardOverlayVisible, toggleLeaderboardOverlay, setLeaderboardOverlayVisible } from './components/leaderboardOverlayState'
import { getAnalyticsOverlayVisible, toggleAnalyticsOverlay, setAnalyticsOverlayVisible } from './components/analyticsOverlayState'
// Dynamic import for emotes to avoid deployment issues

export function setupUi() {
  ReactEcsRenderer.setUiRenderer(PlayerListUi)
}

let squareIconHovered = false
let questionIconHovered = false
let analyticsIconHovered = false
let visitorScrollOffset = 0
let leaderboardScrollOffset = 0
let scoreboardScrollOffset = 0

// Round end sound tracking - moved outside render function to prevent duplicates
let hasPlayedTrumpetSound = false
let trumpetSoundEntity: Entity | null = null
let lastProcessedRoundEnd = 0 // Track which round end we've already processed

// Daily visitor tracking now handled in ./gameState/sceneTime.ts

// Tie-breaking tracking for stable sorting
const roundWinAchievementTime = new Map<string, number>() // userId -> timestamp when they first achieved current win count
const scoreAchievementTime = new Map<string, number>() // userId -> timestamp when they first achieved current score
let lastKnownScores = new Map<string, number>() // userId -> last known seconds
let lastKnownWins = new Map<string, number>() // userId -> last known round wins

// Daily visitor tracking now handled in ./gameState/sceneTime.ts

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
const DARK_GREY = Color4.create(0.45, 0.45, 0.5, 1)
const CLOSE_GREY = Color4.create(0.4, 0.4, 0.45, 1)

// Theme Colors
const GOLD = Color4.create(1, 0.84, 0, 1)
const BRIGHT_GOLD = Color4.create(1, 0.9, 0.1, 1)
const SILVER = Color4.create(0.75, 0.78, 0.82, 1)
const BRONZE = Color4.create(0.8, 0.5, 0.2, 1)

// Accent Colors
const LIGHT_BLUE = Color4.create(0.45, 0.75, 1, 1)
const SOFT_BLUE = Color4.create(0.55, 0.8, 0.95, 1)
const CORAL_RED = Color4.create(1, 0.5, 0.45, 1)
const SOFT_RED = Color4.create(1, 0.45, 0.45, 1)
const SUCCESS_GREEN = Color4.create(0.3, 0.85, 0.4, 1)
const WARNING_ORANGE = Color4.create(1, 0.65, 0.2, 1)

// Background Colors
const PANEL_BG = Color4.create(0.1, 0.1, 0.1, 0.92)
const PANEL_BG_SEMI = Color4.create(0.08, 0.08, 0.1, 0.87)
const PANEL_BG_DARKER = Color4.create(0.06, 0.06, 0.08, 0.95)

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

// Trigger celebration emotes based on player ranking
async function triggerCelebrationEmotes(players: any[], localUserId: string | null): Promise<void> {
  if (!localUserId || players.length === 0) return
  
  // Find local player's rank
  let localPlayerRank = -1
  let localPlayerScore = 0
  
  for (let i = 0; i < players.length; i++) {
    if (players[i].userId === localUserId) {
      localPlayerRank = i + 1 // 1-based rank
      localPlayerScore = players[i].seconds
      break
    }
  }
  
  // Only trigger emotes for players who participated (have > 0 seconds)
  if (localPlayerScore === 0) {
    console.log('[Emotes] Local player did not participate, no emote triggered')
    return
  }
  
  try {
    // Dynamic import to avoid deployment issues
    const { triggerEmote } = await import('~system/RestrictedActions')
    
    if (localPlayerRank <= 3 && localPlayerRank > 0) {
      // Top 3 players: celebration emote
      console.log('[Emotes] Top 3 player (rank', localPlayerRank, ') - triggering celebration emote')
      await triggerEmote({ predefinedEmote: 'cheer' })
    } else {
      // All other players: clap emote  
      console.log('[Emotes] Player ranked', localPlayerRank, '- triggering clap emote')
      await triggerEmote({ predefinedEmote: 'clap' })
    }
  } catch (error) {
    console.log('[Emotes] Failed to trigger emote:', error)
  }
}





function PlayerListUi() {
  const rawPlayers = getPlayersWithHoldTimes()
  // getPlayersWithHoldTimes already sorts by seconds (desc), just use it directly
  const players = rawPlayers
  const localUserId = getPlayer()?.userId ?? null
  const allVisitors = getAllVisitors()
  const visitorCount = getTodayVisitorCount()
  const onlineCount = getCurrentOnlineCount()
  const leaderUserId =
    players.length > 0 && players[0].seconds > 0 ? players[0].userId : null
  const carrierUserId = getCurrentFlagCarrierUserId()
  const countdownSeconds = getCountdownSeconds()
  
  // Check for actual round end from server
  const countdownTimers = [...engine.getEntitiesWith(CountdownTimer)]
  let isRoundOver = false
  let roundEndData: any = null
  
  if (countdownTimers.length > 0) {
    const [, timer] = countdownTimers[0]
    const now = Date.now()
    
    if (timer.roundEndTriggered && now < timer.roundEndDisplayUntilMs) {
      isRoundOver = true
      roundEndData = timer
      
      // Play trumpet sound once per unique round end (prevent duplicates)
      const roundEndId = timer.roundEndTimeMs
      if (roundEndId !== lastProcessedRoundEnd) {
        lastProcessedRoundEnd = roundEndId
        
        console.log('[UI] Round end detected! Playing trumpet sound and showing results')
        
        // Clean up previous trumpet sound
        if (trumpetSoundEntity) {
          engine.removeEntity(trumpetSoundEntity)
        }
        
        // Play trumpet sound immediately  
        trumpetSoundEntity = engine.addEntity()
        AudioSource.create(trumpetSoundEntity, {
          audioClipUrl: 'assets/sounds/trumpets.mp3',
          playing: true,
          volume: 0.7,
          global: true
        })
        hasPlayedTrumpetSound = true
        
        console.log('[UI] Trumpet sound started, displaying winners:', timer.roundWinnerJson)
        
        // Trigger celebration emotes for all players (temporarily disabled for deployment testing)
        // void triggerCelebrationEmotes(players, localUserId)
      }
    } else {
      // Reset flags when round is no longer over  
      if (hasPlayedTrumpetSound) {
        hasPlayedTrumpetSound = false
        if (trumpetSoundEntity) {
          engine.removeEntity(trumpetSoundEntity)
          trumpetSoundEntity = null
        }
      }
    }
  }

  // Only show overlays when round is not over
  const winConditionOverlayVisible = !isRoundOver && getWinConditionOverlayVisible()
  const leaderboardOverlayVisible = !isRoundOver && getLeaderboardOverlayVisible()
  const analyticsOverlayVisible = !isRoundOver && getAnalyticsOverlayVisible()
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
      {isRoundOver && roundEndData && (
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
          uiBackground={{ color: Color4.create(0, 0, 0, 0.65) }}
        >
          <UiEntity
            uiTransform={{
              width: 420,
              flexDirection: 'column',
              alignItems: 'center',
              borderRadius: 20,
              padding: 32,
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            <Label value="--  ROUND  OVER  --" fontSize={30} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: 24 }} />
            {(() => {
              // Display previous round winners from server snapshot
              let displayResults: any[] = []
              
              // Always use the server snapshot for round end display
              if (roundEndData && roundEndData.roundWinnerJson) {
                try {
                  const winnerSnapshot = JSON.parse(roundEndData.roundWinnerJson)
                  console.log('[UI] Displaying round winners from server snapshot:', winnerSnapshot)
                  displayResults = winnerSnapshot.map((w: any) => ({
                    userId: w.userId,
                    name: w.name,
                    isWinner: true
                  }))
                } catch (e) {
                  console.error('[UI] Failed to parse round winner data:', e)
                  displayResults = []
                }
              }
              
              // If no server snapshot available, fall back to current player data (edge case)
              if (displayResults.length === 0) {
                const currentResults = players.filter(p => p.seconds > 0).slice(0, 8)
                if (currentResults.length > 0) {
                  const maxSeconds = Math.max(...currentResults.map(p => p.seconds))
                  displayResults = currentResults
                    .filter(p => p.seconds >= maxSeconds)
                    .map((p, i) => ({
                      userId: p.userId,
                      name: p.name,
                      seconds: p.seconds,
                      isWinner: true
                    }))
                }
              }

              return displayResults.length === 0 ? (
                <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                  <Label value="Round complete! No winners this round." fontSize={16} color={MUTED} font="sans-serif" />
                </UiEntity>
              ) : (
                <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                  {/* Winners Section */}
                  {displayResults.map((winner, i) => (
                    <UiEntity key={`winner-${winner.userId}-${i}`} uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
                      <Label value={`🏆 ${winner.name} WINS! 🏆`} fontSize={22} color={GOLD} font="sans-serif" />
                      {winner.seconds && (
                        <Label value={`${winner.seconds} seconds held`} fontSize={16} color={WHITE} font="sans-serif" />
                      )}
                      {i < displayResults.length - 1 && <UiEntity uiTransform={{ height: 8 }} />}
                    </UiEntity>
                  ))}
                </UiEntity>
              )
            })()}
            
            <UiEntity uiTransform={{ height: 20 }} />
            
            {/* Next round call to action */}
            <UiEntity uiTransform={{ height: 16 }} />
            <Label value="next round starting..." fontSize={14} color={MUTED} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      )}
      {!isRoundOver && (
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
                        value={`${visitor.totalMinutes} min`} 
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
