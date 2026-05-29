/**
 * StatusPopup — Simple popup showing the player's status (inventory, equipment, etc.)
 * Opened via the flag icon button on desktop, or the flag circle on mobile.
 *
 * MetricsOverlay — Folder-tabbed metrics view opened from the in-world terminal.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import {
  S, WHITE, MUTED, GREY, GOLD, CLOSE_GREY, PANEL_BG, CLICK_BLOCKER,
  _ROW_HEIGHT, _ROW_FONT, _OVERLAY_PANEL_WIDTH, _OVERLAY_PANEL_HEIGHT,
  VISITORS_PER_PAGE,
  sortVisitorsWithBotSection, isLikelyBot, formatVisitorTime, formatUTCDate, formatUTCMonth,
  type VisitorOrSeparator,
} from '../uiConstants'
import { hover, scroll, tabs, metricsState, notifyOverlayClosed, earnedState } from '../uiState'
import { setLeaderboardOverlayVisible } from '../../gameState/overlayState'
import { SubTabBar } from '../components/SubTabBar'
import { Scrollbar } from '../components/Scrollbar'
import { StatsRow } from '../components/StatsRow'
import { getCoinBalance, isCoinBalanceLoaded } from '../../systems/coinPickupSystem'
import { getLocalLifetimeWins, isWinsLoaded } from '../../gameState/playerUpgradeState'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { blessingState } from '../uiState'
import { getMonthlyVisitors, getMonthlyOnlineCount } from '../../gameState/visitorState'

const CLOSE_HOVER = Color4.create(0.85, 0.85, 0.9, 1)

// ═══════════════════════════════════════════════════════════
// STATUS POPUP — lightweight, opened from menu button
// ═══════════════════════════════════════════════════════════

export function StatusPopup() {
  const localPlayer = getPlayer()
  const localName = localPlayer?.name ?? 'Unknown'
  const coins = getCoinBalance()
  const liveWins = getLocalLifetimeWins()
  const myFlags = earnedState.winsFrozen ? (earnedState.displayedWins ?? liveWins) : liveWins
  const boomerang = getBoomerangColor()
  const boomerangLabel = boomerang === 'r' ? 'Base' : boomerang === 'y' ? 'Dubs' : boomerang === 'b' ? 'Charge' : 'Orbit'

  const SR = 34; const SI = 24; const SF = 16; const SEC = 16

  const sectionHeader = (title: string, first = false) => (
    <UiEntity uiTransform={{ width: '100%', height: S(first ? 28 : 36), flexDirection: 'row', alignItems: 'flex-end', padding: { left: S(10) } }}>
      <Label value={title} fontSize={S(SEC)} color={GOLD} font="sans-serif" />
    </UiEntity>
  )
  const iconRow = (label: string, value: string, iconSrc: string, valueColor: Color4 = WHITE, iconColor: Color4 = Color4.White(), iconScale: number = 1) => {
    const icoSize = Math.round(SI * iconScale)
    return (
      <UiEntity uiTransform={{ width: '100%', height: S(SR), flexDirection: 'row', alignItems: 'center', padding: { left: S(10), right: S(10) } }}>
        <Label value={label} fontSize={S(SF)} color={GREY} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(SR) }} textAlign="middle-left" />
        <Label value={value} fontSize={S(SF)} color={valueColor} font="sans-serif" uiTransform={{ height: S(SR), margin: { right: S(6) } }} textAlign="middle-right" />
        <UiEntity uiTransform={{ width: S(icoSize), height: S(icoSize) }} uiBackground={{ textureMode: 'stretch', texture: { src: iconSrc }, color: iconColor }} />
      </UiEntity>
    )
  }

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
      uiBackground={{ color: CLICK_BLOCKER }}
      onMouseDown={() => {}}
    >
      <UiEntity
        uiTransform={{
          width: S(380),
          flexDirection: 'column',
          alignItems: 'stretch',
          padding: S(24),
          borderRadius: S(16),
        }}
        uiBackground={{ color: Color4.create(0.1, 0.1, 0.1, 1) }}
      >
        {/* Header with title and close button */}
        <UiEntity uiTransform={{ flexDirection: 'row', width: '100%', height: S(40), alignItems: 'center', margin: { bottom: S(8) } }}>
          <Label value="Status" fontSize={S(28)} color={GOLD} font="sans-serif" uiTransform={{ flexGrow: 1 }} />
          <UiEntity
            uiTransform={{ width: S(40), height: S(40), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: S(6) }}
            onMouseEnter={() => { hover.closeLeaderboard = true }}
            onMouseLeave={() => { hover.closeLeaderboard = false }}
            onMouseDown={() => { setLeaderboardOverlayVisible(false); hover.closeLeaderboard = false; notifyOverlayClosed() }}
          >
            <Label value="×" fontSize={S(38)} color={hover.closeLeaderboard ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
          </UiEntity>
        </UiEntity>

        {/* Player name */}
        <UiEntity uiTransform={{ width: '100%', padding: { left: S(10), right: S(10), bottom: S(2) } }}>
          <Label value={localName} fontSize={S(20)} color={WHITE} font="sans-serif" />
        </UiEntity>
        <UiEntity uiTransform={{ width: '100%', height: 1, margin: { top: S(6), bottom: S(2) } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.35, 0.6) }} />

        {/* Content */}
        {sectionHeader('INVENTORY', true)}
        {iconRow('Coins', isCoinBalanceLoaded() ? `${coins}` : '--', 'assets/images/coin.png', GOLD, GOLD)}
        {iconRow('Flags', isWinsLoaded() ? `${myFlags}` : '--', 'assets/images/flag-icon-white.png', GOLD, GOLD)}
        <UiEntity uiTransform={{ width: '100%', height: 1, margin: { top: S(6), bottom: S(2) } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.35, 0.6) }} />
        {sectionHeader('EQUIPMENT')}
        {iconRow('Projectile', boomerangLabel, `assets/images/boomerang.${boomerang}.png`, WHITE, Color4.White(), 1.5)}
        {iconRow('Trap', 'Banana', 'assets/images/banana.png')}
        <UiEntity uiTransform={{ width: '100%', height: 1, margin: { top: S(6), bottom: S(2) } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.35, 0.6) }} />
        {sectionHeader('DAILY')}
        <UiEntity uiTransform={{ width: '100%', height: S(SR), flexDirection: 'row', alignItems: 'center', padding: { left: S(10), right: S(10) } }}>
          <Label value="Blessed Today" fontSize={S(SF)} color={GREY} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(SR) }} textAlign="middle-left" />
          <Label value={blessingState.alreadyUsed ? 'Yes' : 'No'} fontSize={S(SF)} color={blessingState.alreadyUsed ? GOLD : GREY} font="sans-serif" uiTransform={{ height: S(SR) }} textAlign="middle-right" />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

// ═══════════════════════════════════════════════════════════
// METRICS OVERLAY — opened from in-world terminal
// ═══════════════════════════════════════════════════════════

interface MetricsOverlayProps {
  allVisitors: VisitorOrSeparator[]
  localUserId: string | null
  onlineCount: number
  totalPlaytimeMin: number
  serverConnected: string
}

export function MetricsOverlay({ allVisitors, localUserId, onlineCount, totalPlaytimeMin, serverConnected }: MetricsOverlayProps) {
  const _FOLDER_TAB_WIDTH = 270
  const _FOLDER_TAB_HEIGHT = 56
  const _FOLDER_RADIUS = 16
  const FOLDER_ACTIVE = Color4.create(0.1, 0.1, 0.1, 1)

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
      uiBackground={{ color: CLICK_BLOCKER }}
      onMouseDown={() => {}}
    >
      <UiEntity
        uiTransform={{
          positionType: 'relative',
          width: S(_OVERLAY_PANEL_WIDTH),
          height: S(_OVERLAY_PANEL_HEIGHT + _FOLDER_TAB_HEIGHT),
          flexDirection: 'column',
          alignItems: 'stretch',
        }}
      >
        {/* Tab header */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: S(0), left: S(0) },
            width: S(_FOLDER_TAB_WIDTH),
            height: S(_FOLDER_TAB_HEIGHT + _FOLDER_RADIUS),
            borderRadius: S(_FOLDER_RADIUS),
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
            padding: { bottom: S(_FOLDER_RADIUS) },
          }}
          uiBackground={{ color: FOLDER_ACTIVE }}
        >
          <Label value="Scene Metrics" fontSize={S(28)} color={GOLD} font="sans-serif" />
        </UiEntity>
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: S(_FOLDER_TAB_HEIGHT - 2), left: S(0) }, width: S(_FOLDER_RADIUS + 2), height: S(_FOLDER_RADIUS + 4) }}
          uiBackground={{ color: FOLDER_ACTIVE }}
        />
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: S(_FOLDER_TAB_HEIGHT), left: S(_FOLDER_TAB_WIDTH - _FOLDER_RADIUS) }, width: S(_FOLDER_RADIUS), height: S(_FOLDER_RADIUS) }}
          uiBackground={{ color: FOLDER_ACTIVE }}
        />

        {/* Body */}
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
          {/* Sub-tab bar + close */}
          <UiEntity uiTransform={{ flexDirection: 'row', width: '100%', height: S(32), alignItems: 'center' }}>
            <SubTabBar
              tabs={['Daily Metrics', 'Monthly Metrics']}
              keys={['daily', 'monthly']}
              active={tabs.metrics}
              onChange={(k) => { tabs.metrics = k as any; scroll.visitorOffset = 0 }}
            />
            <UiEntity uiTransform={{ width: S(12) }} />
            <UiEntity
              uiTransform={{ width: S(80), height: S(80), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: S(6), margin: { top: S(-6) } }}
              onMouseEnter={() => { hover.closeLeaderboard = true }}
              onMouseLeave={() => { hover.closeLeaderboard = false }}
              onMouseDown={() => { setLeaderboardOverlayVisible(false); hover.closeLeaderboard = false; metricsState.openedFromTerminal = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={S(38)} color={hover.closeLeaderboard ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>
          </UiEntity>
          <UiEntity uiTransform={{ height: S(12) }} />

          {/* Column headers */}
          {(() => {
            const mv = tabs.metrics === 'monthly' ? sortVisitorsWithBotSection(getMonthlyVisitors()) : allVisitors
            return <MetricsColumnHeader hasScroll={mv.length > VISITORS_PER_PAGE} />
          })()}

          {/* Metrics content */}
          <MetricsTabContent allVisitors={allVisitors} onlineCount={onlineCount} totalPlaytimeMin={totalPlaytimeMin} serverConnected={serverConnected} localUserId={localUserId} />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

// ── Column Headers ──

function MetricsColumnHeader({ hasScroll }: { hasScroll: boolean }) {
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(72), left: S(24), right: S(24 + (hasScroll ? 18 : 0)) }, flexDirection: 'row', alignItems: 'center', height: S(28) }}>
      <Label value="" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: S(32), height: S(28) }} textAlign="middle-left" />
      <Label value="Player" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: '18%', height: S(28) }} textAlign="middle-left" />
      <Label value="Address" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(28) }} textAlign="middle-left" />
      <Label value="Playtime" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: '12%', height: S(28) }} textAlign="middle-left" />
    </UiEntity>
  )
}

// ── Metrics Tab ──

function MetricsTabContent({ allVisitors, onlineCount, totalPlaytimeMin, serverConnected, localUserId }: { allVisitors: VisitorOrSeparator[]; onlineCount: number; totalPlaytimeMin: number; serverConnected: string; localUserId: string | null }) {
  const metricsVisitors = tabs.metrics === 'monthly'
    ? sortVisitorsWithBotSection(getMonthlyVisitors())
    : allVisitors
  const mBotCount = metricsVisitors.filter(v => !('_isSeparator' in v && v._isSeparator) && isLikelyBot(v)).length
  const mVisitorCount = metricsVisitors.filter(v => !('_isSeparator' in v && v._isSeparator)).length - mBotCount
  const mOnlineCount = tabs.metrics === 'monthly' ? getMonthlyOnlineCount() : onlineCount
  const mTotalPlaytimeMin = Math.floor(metricsVisitors.reduce((sum, v) => sum + v.totalSeconds, 0) / 60)
  const emptyMessage = tabs.metrics === 'monthly' ? 'No visitors this month' : 'No visitors today'
  const totalVisitors = metricsVisitors.length
  const metricsMaxOffset = Math.max(0, totalVisitors - VISITORS_PER_PAGE)
  if (scroll.visitorOffset > metricsMaxOffset) scroll.visitorOffset = metricsMaxOffset
  if (scroll.visitorOffset < 0) scroll.visitorOffset = 0
  const visibleVisitors = metricsVisitors.slice(scroll.visitorOffset, scroll.visitorOffset + VISITORS_PER_PAGE)

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
                <UiEntity key={`sep-${i}`} uiTransform={{ height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                  <UiEntity uiTransform={{ flexGrow: 1, height: 1, margin: { right: S(8) } }} uiBackground={{ color: Color4.create(0.35, 0.35, 0.4, 0.8) }} />
                  <Label value="Likely Bots" fontSize={S(11)} color={GREY} font="sans-serif" />
                  <UiEntity uiTransform={{ flexGrow: 1, height: 1, margin: { left: S(8) } }} uiBackground={{ color: Color4.create(0.35, 0.35, 0.4, 0.8) }} />
                </UiEntity>
              ) : (
                <UiEntity key={`v-${visitor.userId}-${scroll.visitorOffset}-${i}`} uiTransform={{ height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center' }}>
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
        <Scrollbar offset={scroll.visitorOffset} maxOffset={metricsMaxOffset} perPage={VISITORS_PER_PAGE} totalItems={totalVisitors} onScroll={(v) => { scroll.visitorOffset = v }} keyPrefix="metrics" />
      </UiEntity>
      <StatsRow visitorCount={mVisitorCount} botCount={mBotCount} onlineCount={mOnlineCount} serverConnected={serverConnected} dateLabel={tabs.metrics === 'monthly' ? formatUTCMonth() : formatUTCDate()} totalPlaytimeMin={mTotalPlaytimeMin} localUserId={localUserId} />
    </UiEntity>
  )
}
