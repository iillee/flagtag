import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { getPlayer } from '@dcl/sdk/players'

import {
  S, WHITE, BRIGHT_WHITE, BRIGHT_GOLD, MUTED, LIGHT_GREY, GOLD,
  PANEL_BG, PANEL_BG_SEMI,
  getServerConnectionStatus, formatCountdown, sortVisitorsWithBotSection,
  _PANEL_WIDTH, _ROW_HEIGHT, _ROW_FONT, _PADDING, _BORDER_RADIUS,
  _ABILITY_BTN_SIZE, _ABILITY_ICON_SIZE,
} from '../uiConstants'
import {
  cinematicState,
  notifyOverlayClosed,
  splashState,
  earnedState,
  metricsState,
  hover, scroll, tabs,
} from '../uiState'
import {
  getWinConditionOverlayVisible, setWinConditionOverlayVisible,
  getLeaderboardOverlayVisible, setLeaderboardOverlayVisible,
  getAnalyticsOverlayVisible, setAnalyticsOverlayVisible,
} from '../../gameState/overlayState'
import { getPlayersWithHoldTimes, getCurrentFlagCarrierUserId } from '../../gameState/flagHoldTime'
import { getAllVisitors, getCurrentOnlineCount } from '../../gameState/visitorState'

import { getCountdownSeconds } from '../../shared/components'
import { isCinematicActive } from '../../gameState/cinematicState'
import { getCoinBalance, isCoinBalanceLoaded } from '../../systems/coinPickupSystem'
import { getLocalLifetimeWins, isWinsLoaded } from '../../gameState/playerUpgradeState'
import { isSpectatorTransitioning } from '../../systems/spectatorSystem'
import { spectatorState } from '../../shared/clientState'

import { IconButton } from '../components/IconButton'
import { HowToPlayOverlay } from '../screens/HowToPlay'
import { RoundEndSplash } from '../screens/RoundEndSplash'
import { MetricsOverlay } from '../screens/LeaderboardOverlay'

import { AnalyticsOverlay } from '../screens/AnalyticsOverlay'
import { Inventory, toggleInventory, showInventory as getShowInventory } from '../inventory'

export function DesktopLayout() {
  const rawPlayers = getPlayersWithHoldTimes()
  const players = rawPlayers
  const localUserId = getPlayer()?.userId ?? null
  const leaderUserId = players.length > 0 && players[0].seconds > 0 ? players[0].userId : null
  const carrierUserId = getCurrentFlagCarrierUserId()
  const countdownSeconds = getCountdownSeconds()
  const cinematicFadeOpacity = cinematicState.fadeOpacity
  const splashVisible = splashState.visible
  const cinematicShowing = cinematicState.showing
  const winConditionVisible = getWinConditionOverlayVisible()
  const leaderboardVisible = getLeaderboardOverlayVisible()
  const analyticsVisible = getAnalyticsOverlayVisible()

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'relative', pointerFilter: 'none' }}>
      {/* Timer */}
      {!isCinematicActive() && !splashVisible && cinematicFadeOpacity === 0 && countdownSeconds > 0 && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(14), left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center', pointerFilter: 'none' }}>
          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: S(2 * _ROW_HEIGHT + 2 * _PADDING), padding: { left: S(20), right: S(20) }, borderRadius: S(_BORDER_RADIUS) }}
            uiBackground={{ color: PANEL_BG }}
          >
            <Label value="Round ends in:" fontSize={S(16)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { bottom: S(-6) } }} />
            <Label value={formatCountdown(countdownSeconds)} fontSize={S(40)} color={countdownSeconds <= 10 ? GOLD : WHITE} font="sans-serif" uiTransform={{ margin: { top: S(-6) } }} />
          </UiEntity>
        </UiEntity>
      )}

      <RoundEndSplash />
      {winConditionVisible && <HowToPlayOverlay />}
      {leaderboardVisible && metricsState.openedFromTerminal && (() => {
        const rawVisitors = getAllVisitors()
        const allVisitors = sortVisitorsWithBotSection(rawVisitors)
        const onlineCount = getCurrentOnlineCount()
        const totalPlaytimeMin = Math.floor(allVisitors.reduce((sum, v) => sum + v.totalSeconds, 0) / 60)
        const serverConnected = getServerConnectionStatus()
        return <MetricsOverlay allVisitors={allVisitors} localUserId={localUserId} onlineCount={onlineCount} totalPlaytimeMin={totalPlaytimeMin} serverConnected={serverConnected} />
      })()}
      {analyticsVisible && (() => {
        const rawVisitors = getAllVisitors()
        const allVisitors = sortVisitorsWithBotSection(rawVisitors)
        const onlineCount = getCurrentOnlineCount()
        const totalPlaytimeMin = Math.floor(allVisitors.reduce((sum, v) => sum + v.totalSeconds, 0) / 60)
        const serverConnected = getServerConnectionStatus()
        return <AnalyticsOverlay allVisitors={allVisitors} onlineCount={onlineCount} totalPlaytimeMin={totalPlaytimeMin} serverConnected={serverConnected} localUserId={localUserId} />
      })()}

      {/* Inventory hotbar + grid overlay */}
      {!cinematicShowing && !spectatorState.active && !isSpectatorTransitioning() && (
        <Inventory />
      )}

      {/* Right-side: icons + stats + scoreboard */}
      <UiEntity uiTransform={{ positionType: 'absolute', position: { right: S(16), top: S(14) }, flexDirection: 'row', alignItems: 'flex-start' }}>
        {/* Icon buttons */}
        <UiEntity uiTransform={{ width: S(46), height: S(2 * _ROW_HEIGHT + 2 * _PADDING), flexDirection: 'column', alignItems: 'center', margin: { right: S(4) } }}>
          <IconButton hoverKey="squareIcon" label="Inventory" isActive={getShowInventory} hoverWidth={160}
            iconContent={<UiEntity uiTransform={{ width: S(17), height: S(17) }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: getShowInventory || hover.squareIcon ? GOLD : WHITE }} />}
            onClick={() => { setWinConditionOverlayVisible(false); setAnalyticsOverlayVisible(false); setLeaderboardOverlayVisible(false); metricsState.openedFromTerminal = false; toggleInventory() }}
          />
          <UiEntity uiTransform={{ height: S(4) }} />
          <IconButton hoverKey="questionIcon" label="Help" isActive={winConditionVisible}
            iconContent={<UiEntity uiTransform={{ width: S(17), height: S(17), justifyContent: 'center', alignItems: 'center' }}><Label value="?" fontSize={S(24)} color={winConditionVisible || hover.questionIcon ? GOLD : WHITE} font="sans-serif" textAlign="middle-center" /></UiEntity>}
            onClick={() => { const wasOpen = getWinConditionOverlayVisible(); setLeaderboardOverlayVisible(false); setAnalyticsOverlayVisible(false); metricsState.openedFromTerminal = false; setWinConditionOverlayVisible(!wasOpen); if (wasOpen) notifyOverlayClosed() }}
          />
        </UiEntity>

        {/* Stats square */}
        {(() => {
          const panelH = S(2 * _ROW_HEIGHT + 2 * _PADDING)
          const panelW = S(3 * _ROW_HEIGHT + 2 * _PADDING)
          const liveWins = getLocalLifetimeWins()
          if (!earnedState.winsFrozen) earnedState.displayedWins = liveWins
          const myWins = earnedState.displayedWins ?? liveWins
          return (
            <UiEntity uiTransform={{ width: panelW, height: panelH, flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', padding: { left: S(_PADDING) }, margin: { right: S(4) }, borderRadius: S(_BORDER_RADIUS) }}
              uiBackground={{ color: PANEL_BG }}
            >
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                <UiEntity uiTransform={{ width: S(20), height: S(20), margin: { right: S(6) } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.White() }} />
                <Label value={isCoinBalanceLoaded() ? `${getCoinBalance()}` : '--'} fontSize={S(18)} color={WHITE} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                <UiEntity uiTransform={{ width: S(18), height: S(18), margin: { right: S(6) } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />
                <Label value={isWinsLoaded() ? `${myWins}` : '--'} fontSize={S(18)} color={WHITE} font="sans-serif" />
              </UiEntity>
            </UiEntity>
          )
        })()}

        {/* Scoreboard */}
        <UiEntity uiTransform={{ width: S(_PANEL_WIDTH), flexDirection: 'column', alignItems: 'stretch', borderRadius: S(_BORDER_RADIUS), padding: S(_PADDING) }}
          uiBackground={{ color: PANEL_BG }}
        >
          <UiEntity uiTransform={{ height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Label value="Scoreboard" fontSize={S(20)} color={MUTED} font="sans-serif" />
          </UiEntity>
          {players.length === 0 ? (
            <UiEntity uiTransform={{ height: S(_ROW_HEIGHT) * 2, justifyContent: 'center', alignItems: 'center' }}>
              <Label value="Waiting for players..." fontSize={S(_ROW_FONT)} color={MUTED} font="sans-serif" />
            </UiEntity>
          ) : players.map((p, i) => {
            const isLeader = leaderUserId !== null && p.userId === leaderUserId
            const isSelf = localUserId !== null && p.userId === localUserId
            const isCarrier = carrierUserId !== null && p.userId === carrierUserId
            const nameColor = isLeader ? BRIGHT_GOLD : isSelf ? BRIGHT_WHITE : LIGHT_GREY
            const timeColor = isLeader ? GOLD : p.seconds > 0 ? WHITE : MUTED
            return (
              <UiEntity key={`${p.userId}-${i}`} uiTransform={{ height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: { left: S(8), right: S(8), top: S(2), bottom: S(2) }, borderRadius: S(6) }}
                uiBackground={{ color: isLeader ? Color4.create(0.3, 0.25, 0.1, 0.3) : Color4.create(0, 0, 0, 0) }}
              >
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                  {isCarrier && <UiEntity uiTransform={{ width: S(16), height: S(16), margin: { right: S(4) } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />}
                  <Label value={p.name} fontSize={S(_ROW_FONT)} color={nameColor} font="sans-serif" />
                </UiEntity>
                <Label value={`${p.seconds}`} fontSize={S(_ROW_FONT)} color={timeColor} font="sans-serif" />
              </UiEntity>
            )
          })}
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
