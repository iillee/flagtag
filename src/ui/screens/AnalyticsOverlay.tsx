/**
 * AnalyticsOverlay — Daily visitors list with stats row.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import {
  S, WHITE, GREY, GOLD, MUTED, PANEL_BG,
  _ROW_HEIGHT, _ROW_FONT, _OVERLAY_PANEL_WIDTH, _OVERLAY_PANEL_HEIGHT, VISITORS_PER_PAGE,
  isLikelyBot, formatVisitorTime, formatUTCDate,
  type VisitorOrSeparator,
} from '../uiConstants'
import { scroll, notifyOverlayClosed } from '../uiState'
import { CloseButton } from '../components/CloseButton'
import { Scrollbar } from '../components/Scrollbar'
import { StatsRow } from '../components/StatsRow'
import { setAnalyticsOverlayVisible } from '../../gameState/overlayState'

interface AnalyticsOverlayProps {
  allVisitors: VisitorOrSeparator[]
  onlineCount: number
  totalPlaytimeMin: number
  serverConnected: string
  localUserId: string | null
}

export function AnalyticsOverlay({ allVisitors, onlineCount, totalPlaytimeMin, serverConnected, localUserId }: AnalyticsOverlayProps) {
  const totalVisitors = allVisitors.length
  const maxOffset = Math.max(0, totalVisitors - VISITORS_PER_PAGE)
  if (scroll.visitorOffset > maxOffset) scroll.visitorOffset = maxOffset
  if (scroll.visitorOffset < 0) scroll.visitorOffset = 0
  const visibleVisitors = allVisitors.slice(scroll.visitorOffset, scroll.visitorOffset + VISITORS_PER_PAGE)

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { left: S(0), top: S(0) },
        width: '100%', height: '100%',
        flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
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
        <CloseButton hoverKey="closeAnalytics" onClose={() => { setAnalyticsOverlayVisible(false); notifyOverlayClosed() }} />
        <Label value="Daily Visitors" fontSize={S(28)} color={GOLD} font="sans-serif" textAlign="top-left" />
        <UiEntity uiTransform={{ height: S(16) }} />

        <StatsRow
          visitorCount={allVisitors.filter(v => !isLikelyBot(v)).length}
          botCount={allVisitors.filter(v => isLikelyBot(v)).length}
          onlineCount={onlineCount}
          serverConnected={serverConnected}
          dateLabel={formatUTCDate()}
          totalPlaytimeMin={totalPlaytimeMin}
          localUserId={localUserId}
        />

        <UiEntity uiTransform={{ height: S(20) }} />

        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row' }}>
          <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column' }}>
            {totalVisitors === 0 ? (
              <UiEntity uiTransform={{ height: S(_ROW_HEIGHT) * 2, justifyContent: 'center', alignItems: 'center' }}>
                <Label value="No visitors today" fontSize={S(_ROW_FONT)} color={MUTED} font="sans-serif" />
              </UiEntity>
            ) : (
              visibleVisitors.map((visitor, i) => (
                <UiEntity
                  key={`visitor-${visitor.userId}-${scroll.visitorOffset}-${i}`}
                  uiTransform={{
                    width: '100%',
                    height: (S(_ROW_HEIGHT) + S(4)),
                    flexDirection: 'row', alignItems: 'center',
                    padding: { left: S(0), right: S(8), top: S(2), bottom: S(2) },
                  }}
                >
                  <UiEntity uiTransform={{ width: '5%', flexDirection: 'row', alignItems: 'center' }}>
                    <Label value={visitor.isOnline ? "●" : "○"} fontSize={S(14)} color={visitor.isOnline ? WHITE : GREY} font="sans-serif" />
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
          <Scrollbar offset={scroll.visitorOffset} maxOffset={maxOffset} perPage={VISITORS_PER_PAGE} totalItems={totalVisitors} onScroll={(v) => { scroll.visitorOffset = v }} keyPrefix="analytics" />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
