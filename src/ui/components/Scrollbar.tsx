/**
 * Scrollbar — Reusable vertical scrollbar with ▲/▼ buttons and draggable track.
 * Returns null if totalItems <= perPage (no scroll needed).
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { S, WHITE, CLOSE_GREY } from '../uiConstants'

interface ScrollbarProps {
  offset: number
  maxOffset: number
  perPage: number
  totalItems: number
  onScroll: (newOffset: number) => void
  keyPrefix: string
}

export function Scrollbar({ offset, maxOffset, perPage, totalItems, onScroll, keyPrefix }: ScrollbarProps) {
  if (totalItems <= perPage) return null
  const canUp = offset > 0
  const canDown = offset < maxOffset
  const thumbRatio = totalItems > 0 ? Math.max(0.15, perPage / totalItems) : 1
  const TRACK_SEGMENTS = 8

  return (
    <UiEntity uiTransform={{ width: S(10), flexDirection: 'column', alignItems: 'center', margin: { left: S(8) } }}>
      <UiEntity
        uiTransform={{ width: S(10), height: S(28), flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
        onMouseDown={() => { if (canUp) onScroll(offset - 1) }}
      >
        <Label value="▲" fontSize={S(14)} color={canUp ? WHITE : CLOSE_GREY} font="sans-serif" />
      </UiEntity>
      <UiEntity
        uiTransform={{ width: S(10), flexGrow: 1, flexDirection: 'column', borderRadius: S(0), margin: { top: S(2), bottom: S(2) } }}
        uiBackground={{ color: Color4.create(0.18, 0.18, 0.2, 1) }}
      >
        {Array.from({ length: TRACK_SEGMENTS }, (_, s) => {
          const segTarget = Math.round((s / TRACK_SEGMENTS) * maxOffset)
          const segTopFrac = s / TRACK_SEGMENTS
          const segBotFrac = (s + 1) / TRACK_SEGMENTS
          const thumbTopFrac = maxOffset > 0 ? offset / maxOffset * (1 - thumbRatio) : 0
          const thumbBotFrac = thumbTopFrac + thumbRatio
          const isThumb = thumbTopFrac < segBotFrac && thumbBotFrac > segTopFrac
          return (
            <UiEntity
              key={`${keyPrefix}-seg-${s}`}
              uiTransform={{ width: S(10), flexGrow: 1, borderRadius: S(0) }}
              uiBackground={{ color: isThumb ? Color4.create(0.45, 0.45, 0.5, 1) : Color4.create(0, 0, 0, 0) }}
              onMouseDown={() => { onScroll(segTarget) }}
            />
          )
        })}
      </UiEntity>
      <UiEntity
        uiTransform={{ width: S(10), height: S(28), flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
        onMouseDown={() => { if (canDown) onScroll(offset + 1) }}
      >
        <Label value="▼" fontSize={S(14)} color={canDown ? WHITE : CLOSE_GREY} font="sans-serif" />
      </UiEntity>
    </UiEntity>
  )
}
