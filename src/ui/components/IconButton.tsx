/**
 * IconButton — Right-side icon button that expands on hover to show a label.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { S, GOLD, PANEL_BG, _ROW_HEIGHT, _PADDING, _TITLE_FONT, _BORDER_RADIUS } from '../uiConstants'
import { hover } from '../uiState'


interface IconButtonProps {
  hoverKey: keyof typeof hover
  label: string
  isActive: boolean
  iconContent: ReactEcs.JSX.Element
  onClick: () => void
}

export function IconButton({ hoverKey, label, isActive, iconContent, onClick }: IconButtonProps) {
  const hovered = hover[hoverKey]
  return (
    <UiEntity uiTransform={{ positionType: 'relative', width: S(46), height: S(_ROW_HEIGHT + _PADDING - 2) }}>
      {hovered && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { right: 0, top: 0 }, width: S(140), height: S(_ROW_HEIGHT + _PADDING - 2), borderRadius: S(_BORDER_RADIUS), flexDirection: 'row', alignItems: 'center' }}
          uiBackground={{ color: PANEL_BG }}
          onMouseEnter={() => { hover[hoverKey] = true }}
          onMouseLeave={() => { hover[hoverKey] = false }}
        >
          <Label value={label} fontSize={S(_TITLE_FONT)} color={GOLD} font="sans-serif" uiTransform={{ width: S(94), height: S(_ROW_HEIGHT + _PADDING - 2), margin: { top: S(-2), left: S(18) } }} textAlign="middle-left" />
        </UiEntity>
      )}
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: 0, right: 0 }, width: hovered ? S(140) : S(46), height: S(_ROW_HEIGHT + _PADDING - 2), flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', padding: { right: S(14) }, borderRadius: S(_BORDER_RADIUS) }}
        uiBackground={{ color: hovered ? Color4.create(0, 0, 0, 0) : PANEL_BG }}
        onMouseEnter={() => { hover[hoverKey] = true;  }}
        onMouseLeave={() => { hover[hoverKey] = false }}
        onMouseDown={() => { onClick() }}
      >
        {iconContent}
      </UiEntity>
    </UiEntity>
  )
}
