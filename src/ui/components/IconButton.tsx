/**
 * IconButton - Right-side square icon button (Status / Help on the desktop HUD).
 * Hover only tints the icon (callers read hover[hoverKey]); no tooltip.
 */
import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { S, PANEL_BG, _ROW_HEIGHT, _PADDING, _BORDER_RADIUS } from '../uiConstants'
import { playClickSound } from '../uiSounds'
import { hover } from '../uiState'

interface IconButtonProps {
  hoverKey: keyof typeof hover
  /** Descriptive name of the button (no longer rendered; kept for call-site readability). */
  label: string
  isActive: boolean
  iconContent: ReactEcs.JSX.Element
  onClick: () => void
}

export function IconButton({ hoverKey, iconContent, onClick }: IconButtonProps) {
  const h = S(_ROW_HEIGHT + _PADDING - 2)
  return (
    <UiEntity uiTransform={{ positionType: 'relative', width: S(46), height: h }}>
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: 0, right: 0 }, width: S(46), height: h, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', padding: { right: S(14) }, borderRadius: S(_BORDER_RADIUS) }}
        uiBackground={{ color: PANEL_BG }}
        onMouseEnter={() => { hover[hoverKey] = true }}
        onMouseLeave={() => { hover[hoverKey] = false }}
        // Fires on release (more reliable than mouseDown while the UI tree re-renders).
        onMouseUp={() => { playClickSound(); onClick() }}
      >
        {iconContent}
      </UiEntity>
    </UiEntity>
  )
}