/**
 * ProgressBar — Horizontal fill bar (used for Drown air meter, Scare meter).
 */
import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { S, PANEL_BG_SEMI } from '../uiConstants'

const BAR_WIDTH_BASE = 160
const BAR_HEIGHT_BASE = 10
const BORDER_BASE = 2

interface ProgressBarProps {
  fraction: number
  fillColor: Color4
  bottomOffset: number
}

export function ProgressBar({ fraction, fillColor, bottomOffset }: ProgressBarProps) {
  const mobile = isMobile()
  const barW = mobile ? 280 : S(BAR_WIDTH_BASE)
  const barH = mobile ? 18 : S(BAR_HEIGHT_BASE)
  const border = mobile ? 3 : S(BORDER_BASE)

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: bottomOffset, left: '50%' },
        width: barW + border * 2,
        height: barH + border * 2,
        margin: { left: -(barW + border * 2) / 2 },
        borderRadius: (barH + border * 2) / 2,
        padding: border,
      }}
      uiBackground={{ color: PANEL_BG_SEMI }}
    >
      <UiEntity
        uiTransform={{ width: '100%', height: '100%', borderRadius: barH / 2 }}
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
