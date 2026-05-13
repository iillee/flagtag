/**
 * LeaderboardOverlay — Folder-tabbed overlay with Status, Leaderboards, and Metrics tabs.
 * Desktop only (mobile has its own simpler version in MobileLayout).
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import {
  S, WHITE, MUTED, GREY, GOLD, CLOSE_GREY, PANEL_BG,
  _ROW_HEIGHT, _ROW_FONT, _OVERLAY_PANEL_WIDTH, _OVERLAY_PANEL_HEIGHT,
  LEADERBOARD_PER_PAGE, VISITORS_PER_PAGE,
  sortVisitorsWithBotSection, isLikelyBot, formatVisitorTime, formatUTCDate, formatUTCMonth,
  type VisitorOrSeparator,
} from '../uiConstants'
import { hover, scroll, tabs, isMetricsOpenedFromTerminal, setMetricsOpenedFromTerminal, notifyOverlayClosed, isWinsFrozen, getDisplayedWins, setDisplayedWins } from '../uiState'
import { playClickSound } from '../uiSounds'
import { setLeaderboardOverlayVisible } from '../../gameState/overlayState'
import { SubTabBar } from '../components/SubTabBar'
import { Scrollbar } from '../components/Scrollbar'
import { StatsRow } from '../components/StatsRow'
import { getCoinBalance, isCoinBalanceLoaded } from '../../systems/coinPickupSystem'
import { getLocalLifetimeWins, isWinsLoaded } from '../../gameState/playerUpgradeState'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { getMonthlyVisitors, getMonthlyOnlineCount } from '../../gameState/visitorState'

const CLOSE_HOVER = Color4.create(0.85, 0.85, 0.9, 1)

interface LeaderboardOverlayProps {
  allVisitors: VisitorOrSeparator[]
  leaderboardEntries: any[]
  localUserId: string | null
  onlineCount: number
  totalPlaytimeMin: number
  serverConnected: string
}

export function LeaderboardOverlay({ allVisitors, leaderboardEntries, localUserId, onlineCount, totalPlaytimeMin, serverConnected }: LeaderboardOverlayProps) {
  const totalEntries = leaderboardEntries.length
  const lbMaxOffset = Math.max(0, totalEntries - LEADERBOARD_PER_PAGE)
  if (scroll.leaderboardOffset > lbMaxOffset) scroll.leaderboardOffset = lbMaxOffset
  if (scroll.leaderboardOffset < 0) scroll.leaderboardOffset = 0
  const visibleEntries = leaderboardEntries.slice(scroll.leaderboardOffset, scroll.leaderboardOffset + LEADERBOARD_PER_PAGE)

  const _FOLDER_TAB_WIDTH = 270
  const _FOLDER_TAB_HEIGHT = 56
  const _FOLDER_RADIUS = 16
  const _FOLDER_GAP = 5
  const FOLDER_ACTIVE = Color4.create(0.1, 0.1, 0.1, 1)
  const FOLDER_INACTIVE = Color4.create(0.065, 0.065, 0.07, 1)

  const metricsFromTerminal = isMetricsOpenedFromTerminal()
  const folderTab = tabs.folder
  const leaderboardTab = tabs.leaderboard

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
          height: S(_OVERLAY_PANEL_HEIGHT + _FOLDER_TAB_HEIGHT),
          flexDirection: 'column',
          alignItems: 'stretch',
        }}
      >
        {/* Filler patches */}
        {!metricsFromTerminal && <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: S(_FOLDER_TAB_HEIGHT - 2), left: S(folderTab === 'status' ? 0 : (_FOLDER_TAB_WIDTH + _FOLDER_GAP)) },
            width: S(_FOLDER_RADIUS + 2),
            height: S(_FOLDER_RADIUS + 4),
          }}
          uiBackground={{ color: FOLDER_ACTIVE }}
        />}
        {!metricsFromTerminal && <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: S(_FOLDER_TAB_HEIGHT), left: S((folderTab === 'status' ? 0 : (_FOLDER_TAB_WIDTH + _FOLDER_GAP)) + _FOLDER_TAB_WIDTH - _FOLDER_RADIUS) },
            width: S(_FOLDER_RADIUS),
            height: S(_FOLDER_RADIUS),
          }}
          uiBackground={{ color: FOLDER_ACTIVE }}
        />}

        {/* Folder tabs */}
        {!metricsFromTerminal && <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: S(0), left: S(0) },
            width: S(_FOLDER_TAB_WIDTH),
            height: S(_FOLDER_TAB_HEIGHT + _FOLDER_RADIUS),
            borderRadius: S(_FOLDER_RADIUS),
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
            padding: { bottom: S(_FOLDER_RADIUS) },
          }}
          uiBackground={{ color: folderTab === 'status' ? FOLDER_ACTIVE : FOLDER_INACTIVE }}
          onMouseDown={() => { playClickSound(); tabs.folder = 'status' }}
        >
          <Label value="Status" fontSize={S(28)} color={folderTab === 'status' ? GOLD : MUTED} font="sans-serif" />
        </UiEntity>}
        {!metricsFromTerminal && <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: S(0), left: S(_FOLDER_TAB_WIDTH + _FOLDER_GAP) },
            width: S(_FOLDER_TAB_WIDTH),
            height: S(_FOLDER_TAB_HEIGHT + _FOLDER_RADIUS),
            borderRadius: S(_FOLDER_RADIUS),
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
            padding: { bottom: S(_FOLDER_RADIUS) },
          }}
          uiBackground={{ color: folderTab === 'leaderboards' ? FOLDER_ACTIVE : FOLDER_INACTIVE }}
          onMouseDown={() => { playClickSound(); tabs.folder = 'leaderboards'; tabs.leaderboard = 'daily'; scroll.leaderboardOffset = 0 }}
        >
          <Label value="Leaderboards" fontSize={S(28)} color={folderTab === 'leaderboards' ? GOLD : MUTED} font="sans-serif" />
        </UiEntity>}

        {/* Metrics tab from terminal */}
        {metricsFromTerminal && <UiEntity
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
        </UiEntity>}
        {metricsFromTerminal && <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: S(_FOLDER_TAB_HEIGHT - 2), left: S(0) }, width: S(_FOLDER_RADIUS + 2), height: S(_FOLDER_RADIUS + 4) }}
          uiBackground={{ color: FOLDER_ACTIVE }}
        />}
        {metricsFromTerminal && <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: S(_FOLDER_TAB_HEIGHT), left: S(_FOLDER_TAB_WIDTH - _FOLDER_RADIUS) }, width: S(_FOLDER_RADIUS), height: S(_FOLDER_RADIUS) }}
          uiBackground={{ color: FOLDER_ACTIVE }}
        />}

        {/* Folder body */}
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
            {folderTab === 'leaderboards' && (
              <SubTabBar
                tabs={['Daily', 'Monthly', 'All Time']}
                keys={['daily', 'monthly', 'alltime']}
                active={leaderboardTab}
                onChange={(k) => { tabs.leaderboard = k as any; scroll.leaderboardOffset = 0 }}
              />
            )}
            {folderTab === 'metrics' && (
              <SubTabBar
                tabs={['Daily Metrics', 'Monthly Metrics']}
                keys={['daily', 'monthly']}
                active={tabs.metrics}
                onChange={(k) => { tabs.metrics = k as any; scroll.visitorOffset = 0 }}
              />
            )}
            {folderTab === 'status' && <UiEntity uiTransform={{ flexGrow: 1, height: S(32) }} />}
            <UiEntity uiTransform={{ width: S(12) }} />
            <UiEntity
              uiTransform={{ width: S(80), height: S(80), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: S(6), margin: { top: S(-6) } }}
              onMouseEnter={() => { hover.closeLeaderboard = true }}
              onMouseLeave={() => { hover.closeLeaderboard = false }}
              onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); hover.closeLeaderboard = false; setMetricsOpenedFromTerminal(false); tabs.folder = 'leaderboards'; tabs.leaderboard = 'daily'; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={S(38)} color={hover.closeLeaderboard ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            </UiEntity>
          </UiEntity>
          <UiEntity uiTransform={{ height: S(12) }} />

          {/* Column headers */}
          {folderTab !== 'status' && leaderboardTab !== 'metrics' && totalEntries > 0 && (
            <ColumnHeader tab={leaderboardTab} totalWins={leaderboardEntries.reduce((s, e) => s + (e.roundsWon || 0), 0)} hasScroll={totalEntries > LEADERBOARD_PER_PAGE} />
          )}
          {folderTab !== 'status' && leaderboardTab === 'metrics' && (() => {
            const mv = tabs.metrics === 'monthly' ? sortVisitorsWithBotSection(getMonthlyVisitors()) : allVisitors
            return <MetricsColumnHeader hasScroll={mv.length > VISITORS_PER_PAGE} />
          })()}

          {/* Metrics tab content */}
          {folderTab !== 'status' && leaderboardTab === 'metrics' && (
            <MetricsTabContent allVisitors={allVisitors} onlineCount={onlineCount} totalPlaytimeMin={totalPlaytimeMin} serverConnected={serverConnected} localUserId={localUserId} />
          )}

          {/* Status tab */}
          {folderTab === 'status' && <StatusTabContent />}

          {/* Leaderboard rows */}
          {leaderboardTab !== 'metrics' && folderTab !== 'status' && (
            <UiEntity uiTransform={{ width: '100%', flexGrow: 1, flexDirection: 'row', margin: totalEntries > 0 ? { top: S(32) } : undefined }}>
              <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column' }}>
                {totalEntries === 0 ? (
                  <UiEntity uiTransform={{ height: S(_ROW_HEIGHT) * 2, justifyContent: 'center', alignItems: 'center' }}>
                    <Label value="No champions yet..." fontSize={S(_ROW_FONT)} color={MUTED} font="sans-serif" />
                  </UiEntity>
                ) : (
                  visibleEntries.map((entry, i) => {
                    const isSelf = localUserId !== null && entry.userId === localUserId
                    const nameColor = isSelf ? WHITE : GREY
                    const rank = scroll.leaderboardOffset + i + 1
                    return (
                      <UiEntity key={`lb-${entry.userId}-${scroll.leaderboardOffset}-${i}`} uiTransform={{ height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center' }}>
                        {leaderboardTab === 'daily' ? (
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
              <Scrollbar offset={scroll.leaderboardOffset} maxOffset={lbMaxOffset} perPage={LEADERBOARD_PER_PAGE} totalItems={totalEntries} onScroll={(v) => { scroll.leaderboardOffset = v }} keyPrefix="lb" />
            </UiEntity>
          )}
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

// ── Column Headers ──

function ColumnHeader({ tab, totalWins, hasScroll }: { tab: string; totalWins: number; hasScroll: boolean }) {
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(72), left: S(24), right: S(24 + (hasScroll ? 18 : 0)) }, flexDirection: 'row', alignItems: 'center', height: S(28) }}>
      <Label value="#" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: S(32), height: S(28) }} textAlign="middle-left" />
      <Label value="Player" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: '18%', height: S(28) }} textAlign="middle-left" />
      {tab !== 'daily' && <Label value="Address" fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(28) }} textAlign="middle-left" />}
      <Label value={`Wins (${totalWins})`} fontSize={S(16)} color={WHITE} font="sans-serif" uiTransform={{ width: tab === 'daily' ? undefined : '12%', flexGrow: tab === 'daily' ? 1 : undefined, height: S(28) }} textAlign="middle-left" />
    </UiEntity>
  )
}

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

// ── Status Tab ──

function StatusTabContent() {
  const localPlayer = getPlayer()
  const localName = localPlayer?.name ?? 'Unknown'
  const coins = getCoinBalance()
  const liveWins = getLocalLifetimeWins()
  const myFlags = isWinsFrozen() ? (getDisplayedWins() ?? liveWins) : liveWins
  const boomerang = getBoomerangColor()
  const boomerangLabel = boomerang === 'r' ? 'Base' : boomerang === 'y' ? 'Dubs' : boomerang === 'b' ? 'Charge' : 'Orbit'

  const SR = 34; const SI = 24; const SF = 16; const SEC = 16

  const sectionHeader = (title: string, first = false) => (
    <UiEntity uiTransform={{ width: '100%', height: S(first ? 28 : 36), flexDirection: 'row', alignItems: 'flex-end', padding: { left: S(10) } }}>
      <Label value={title} fontSize={S(SEC)} color={GOLD} font="sans-serif" />
    </UiEntity>
  )
  const iconRow = (label: string, value: string, iconSrc: string, valueColor: Color4 = WHITE, iconColor: Color4 = Color4.White()) => (
    <UiEntity uiTransform={{ width: '100%', height: S(SR), flexDirection: 'row', alignItems: 'center', padding: { left: S(10), right: S(10) } }}>
      <Label value={label} fontSize={S(SF)} color={GREY} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(SR) }} textAlign="middle-left" />
      <Label value={value} fontSize={S(SF)} color={valueColor} font="sans-serif" uiTransform={{ height: S(SR), margin: { right: S(6) } }} textAlign="middle-right" />
      <UiEntity uiTransform={{ width: S(SI), height: S(SI) }} uiBackground={{ textureMode: 'stretch', texture: { src: iconSrc }, color: iconColor }} />
    </UiEntity>
  )

  return (
    <UiEntity uiTransform={{ width: '100%', flexGrow: 1, flexDirection: 'column', padding: { top: S(6), bottom: S(6) } }}>
      <UiEntity uiTransform={{ width: '100%', padding: { left: S(10), right: S(10), top: S(4), bottom: S(2) } }}>
        <Label value={localName} fontSize={S(20)} color={WHITE} font="sans-serif" />
      </UiEntity>
      {sectionHeader('INVENTORY', true)}
      {iconRow('Coins', isCoinBalanceLoaded() ? `${coins}` : '--', 'assets/images/coin.png', GOLD, GOLD)}
      {iconRow('Flags', isWinsLoaded() ? `${myFlags}` : '--', 'assets/images/flag-icon-white.png', GOLD, GOLD)}
      {sectionHeader('EQUIPMENT')}
      {iconRow('Projectile', boomerangLabel, `assets/images/boomerang.${boomerang}.png`)}
      {iconRow('Trap', 'Banana', 'assets/images/banana.png')}
    </UiEntity>
  )
}
