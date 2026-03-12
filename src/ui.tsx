import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { getPlayer } from '@dcl/sdk/players'
import {
  getPlayersWithHoldTimes,
  getCurrentFlagCarrierUserId,
  getKnownPlayerName
} from './gameState/flagHoldTime'
import { getLeaderboardEntries } from './gameState/roundsWon'
import { getCountdownSeconds, CountdownTimer, getRoundWinners } from './shared/components'
import { engine } from '@dcl/sdk/ecs'
import { getWinConditionOverlayVisible, toggleWinConditionOverlay, setWinConditionOverlayVisible } from './components/winConditionOverlayState'
import { getLeaderboardOverlayVisible, toggleLeaderboardOverlay, setLeaderboardOverlayVisible } from './components/leaderboardOverlayState'

export function setupUi() {
  ReactEcsRenderer.setUiRenderer(PlayerListUi)
}

let squareIconHovered = false
let questionIconHovered = false

const PANEL_WIDTH = 220
const ROW_HEIGHT = 28
const TITLE_FONT = 18
const ROW_FONT = 14
const PADDING = 10
const BORDER_RADIUS = 16
const GAP_LEFT_OF_SCOREBOARD = 6
const ICON_PANEL_HEIGHT_ONE_USER = PADDING * 2 + ROW_HEIGHT * 2
const ICON_FONT_SQUARE = 18
const ICON_FONT_QUESTION = 20
const ICON_PANEL_WIDTH = 44
const ICON_PANEL_PADDING = 8
const ICON_ROW_HEIGHT = (ICON_PANEL_HEIGHT_ONE_USER - ICON_PANEL_PADDING * 2) / 2
const WHITE = Color4.create(1, 1, 1, 1)
const MUTED = Color4.create(0.75, 0.75, 0.8, 1)
const GOLD = Color4.create(1, 0.84, 0, 1)
const LIGHT_BLUE = Color4.create(0.45, 0.75, 1, 1)
const GREY = Color4.create(0.62, 0.62, 0.68, 1)
const CLOSE_GREY = Color4.create(0.4, 0.4, 0.45, 1)
const PANEL_BG = Color4.create(0.1, 0.1, 0.1, 0.9)
const PANEL_BG_SEMI = Color4.create(0.08, 0.08, 0.1, 0.85)
const OVERLAY_PANEL_WIDTH = 460
const OVERLAY_PANEL_MIN_HEIGHT = 320

function formatCountdown(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h === 0) return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function PlayerListUi() {
  const players = getPlayersWithHoldTimes()
  const localUserId = getPlayer()?.userId ?? null
  const leaderUserId =
    players.length > 0 && players[0].seconds > 0 ? players[0].userId : null
  const carrierUserId = getCurrentFlagCarrierUserId()
  const countdownSeconds = getCountdownSeconds()
  let isRoundOver = false
  for (const [, timer] of engine.getEntitiesWith(CountdownTimer)) {
    if (timer.roundEndTriggered) {
      isRoundOver = true
    }
    break
  }
  // Read winner snapshot (stored by server at round end, not affected by hold time reset)
  const roundWinnerSnapshot = getRoundWinners()
  // Override server names with locally-known names
  const roundOverWinners = roundWinnerSnapshot.map(w => ({
    ...w,
    name: getKnownPlayerName(w.userId) || w.name
  }))
  const roundOverLineCount = roundOverWinners.length === 0 ? 1 : roundOverWinners.length <= 1 ? 1 : roundOverWinners.length
  const roundOverSplashHeight = 24 * 2 + 40 + 12 + roundOverLineCount * 32
  const winConditionOverlayVisible = getWinConditionOverlayVisible()
  const leaderboardOverlayVisible = getLeaderboardOverlayVisible()
  const leaderboardEntries = getLeaderboardEntries()
  const leaderboardPanelHeight = Math.max(
    OVERLAY_PANEL_MIN_HEIGHT,
    24 * 2 + 32 + 12 + (leaderboardEntries.length === 0 ? 28 : leaderboardEntries.length * ROW_HEIGHT)
  )

  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: '100%',
        positionType: 'relative',
      }}
    >
      {isRoundOver && (
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
          uiBackground={{ color: Color4.create(0, 0, 0, 0.5) }}
        >
          <UiEntity
            uiTransform={{
              width: 280,
              height: roundOverSplashHeight,
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              borderRadius: 20,
              padding: 24,
            }}
            uiBackground={{ color: PANEL_BG }}
          >
            <Label value="Round over!" fontSize={36} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: 12 }} />
            {roundOverWinners.length === 0 ? (
              <Label value="No participants" fontSize={28} color={WHITE} font="sans-serif" />
            ) : roundOverWinners.length === 1 ? (
              <Label value={`${roundOverWinners[0].name} Wins!`} fontSize={28} color={WHITE} font="sans-serif" />
            ) : (
              roundOverWinners.map((w, i) => (
                <Label key={`winner-${i}`} value={`${w.name} Wins!`} fontSize={28} color={WHITE} font="sans-serif" />
              ))
            )}
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
              value="Hold the flag to earn time. The player with the most hold time at the end of the round wins!"
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
            <Label value="Leaderboard" fontSize={28} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: 12 }} />
            {leaderboardEntries.length === 0 ? (
              <Label value="No round winners yet" fontSize={ROW_FONT} color={MUTED} font="sans-serif" />
            ) : (
              leaderboardEntries.map((entry, i) => {
                const isSelf = localUserId !== null && entry.userId === localUserId
                const nameColor = isSelf ? WHITE : GREY
                const crowns = '👑'.repeat(entry.roundsWon)
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
                    <UiEntity uiTransform={{ flexGrow: 1 }} />
                    <Label value={entry.userId.slice(0, 6) + '...' + entry.userId.slice(-4)} fontSize={12} color={MUTED} font="sans-serif" />
                  </UiEntity>
                )
              })
            )}
          </UiEntity>
        </UiEntity>
      )}

      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { right: 16 + 48 + PANEL_WIDTH + GAP_LEFT_OF_SCOREBOARD, top: 14 },
          width: ICON_PANEL_WIDTH,
          height: ICON_PANEL_HEIGHT_ONE_USER,
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
          onMouseDown={() => { setWinConditionOverlayVisible(false); toggleLeaderboardOverlay() }}
        >
          <Label value="👑" fontSize={ICON_FONT_SQUARE} color={leaderboardOverlayVisible || squareIconHovered ? GOLD : WHITE} font="sans-serif" />
        </UiEntity>
        <UiEntity
          uiTransform={{ width: '100%', height: ICON_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
          onMouseEnter={() => { questionIconHovered = true }}
          onMouseLeave={() => { questionIconHovered = false }}
          onMouseDown={() => { setLeaderboardOverlayVisible(false); toggleWinConditionOverlay() }}
        >
          <Label value="?" fontSize={ICON_FONT_QUESTION} color={winConditionOverlayVisible || questionIconHovered ? LIGHT_BLUE : WHITE} font="sans-serif" />
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
          }}
        >
          <Label value="Scoreboard" fontSize={TITLE_FONT} color={MUTED} font="sans-serif" />
        </UiEntity>
        {players.length === 0 ? (
          <UiEntity uiTransform={{ height: 40 }}>
            <Label value="No one in scene" fontSize={ROW_FONT} color={MUTED} font="sans-serif" />
          </UiEntity>
        ) : (
          players.map((p, i) => {
            const isLeader = leaderUserId !== null && p.userId === leaderUserId
            const isSelf = localUserId !== null && p.userId === localUserId
            const isCarrier = carrierUserId !== null && p.userId === carrierUserId
            const nameColor = isLeader ? GOLD : isSelf ? WHITE : GREY
            return (
              <UiEntity
                key={`${p.userId}-${i}`}
                uiTransform={{
                  height: ROW_HEIGHT,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                  <Label value={isCarrier ? '👑 ' : ''} fontSize={ROW_FONT} color={GOLD} font="sans-serif" />
                  <Label value={p.name} fontSize={ROW_FONT} color={nameColor} font="sans-serif" />
                </UiEntity>
                <Label value={`${p.seconds}`} fontSize={ROW_FONT} color={MUTED} font="sans-serif" />
              </UiEntity>
            )
          })
        )}
      </UiEntity>
    </UiEntity>
  )
}
