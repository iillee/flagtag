/**
 * IconButton — Right-side icon button that expands on hover to show a label.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { S, GOLD, PANEL_BG, _ROW_HEIGHT, _PADDING, _TITLE_FONT, _BORDER_RADIUS } from '../uiConstants'
import { playClickSound } from '../uiSounds'
import { hover } from '../uiState'

// DIAGNOSTIC (fix/ui-click-hitboxes): per-physical-click event counter.
// Logs every mouseDown/mouseUp/enter/leave the SDK delivers to Status/Help.
// Goal: see whether SDK is double-firing, dropping, or misrouting events.
// Remove after we identify the root cause.
const clickDbg: Record<string, { down: number; up: number; enter: number; leave: number; lastAt: number }> = {}
function dbg(key: string, kind: 'down' | 'up' | 'enter' | 'leave') {
  const now = Date.now()
  const rec = clickDbg[key] ?? (clickDbg[key] = { down: 0, up: 0, enter: 0, leave: 0, lastAt: 0 })
  const dt = rec.lastAt ? now - rec.lastAt : 0
  rec[kind]++
  rec.lastAt = now
  console.log(`[IconBtn:${key}] ${kind} (+${dt}ms) down=${rec.down} up=${rec.up} enter=${rec.enter} leave=${rec.leave}`)
}

interface IconButtonProps {
  hoverKey: keyof typeof hover
  label: string
  isActive: boolean
  iconContent: ReactEcs.JSX.Element
  onClick: () => void
  hoverWidth?: number
}

export function IconButton({ hoverKey, label, isActive, iconContent, onClick, hoverWidth }: IconButtonProps) {
  const hovered = hover[hoverKey]
  const expandedW = hoverWidth ?? 140
  return (
    <UiEntity uiTransform={{ positionType: 'relative', width: S(46), height: S(_ROW_HEIGHT + _PADDING - 2) }}>
      {hovered && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { right: 0, top: 0 }, width: S(expandedW), height: S(_ROW_HEIGHT + _PADDING - 2), borderRadius: S(_BORDER_RADIUS), flexDirection: 'row', alignItems: 'center' }}
          uiBackground={{ color: PANEL_BG }}
          onMouseEnter={() => { dbg(String(hoverKey) + ':label', 'enter'); hover[hoverKey] = true }}
          onMouseLeave={() => { dbg(String(hoverKey) + ':label', 'leave'); hover[hoverKey] = false }}
        >
          <Label value={label} fontSize={S(_TITLE_FONT)} color={GOLD} font="sans-serif" uiTransform={{ width: S(expandedW - 46), height: S(_ROW_HEIGHT + _PADDING - 2), margin: { top: S(-2), left: S(18) } }} textAlign="middle-left" />
        </UiEntity>
      )}
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: 0, right: 0 }, width: hovered ? S(expandedW) : S(46), height: S(_ROW_HEIGHT + _PADDING - 2), flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', padding: { right: S(14) }, borderRadius: S(_BORDER_RADIUS) }}
        uiBackground={{ color: hovered ? Color4.create(0, 0, 0, 0) : PANEL_BG }}
        onMouseEnter={() => { dbg(String(hoverKey) + ':icon', 'enter'); hover[hoverKey] = true;  }}
        onMouseLeave={() => { dbg(String(hoverKey) + ':icon', 'leave'); hover[hoverKey] = false }}
        // A/B test (fix/ui-click-hitboxes): SDK7 seems to double-fire onMouseDown
        // when the entity tree churns between press and release. onMouseUp is
        // more reliable because it fires once, at release, after the tree has
        // settled. If this fixes the "needs 3–4 clicks" issue on Status/Help,
        // roll the same pattern out to CloseButton and other click targets.
        onMouseDown={() => { dbg(String(hoverKey) + ':icon', 'down') }}
        onMouseUp={() => { dbg(String(hoverKey) + ':icon', 'up'); playClickSound(); onClick() }}
      >
        {iconContent}
      </UiEntity>
    </UiEntity>
  )
}
