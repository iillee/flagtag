/**
 * CloseButton — Reusable × close button with hover effect.
 * Positioned absolute top-right by default.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { S, CLOSE_GREY } from '../uiConstants'
import { playClickSound } from '../uiSounds'
import { hover } from '../uiState'

const CLOSE_HOVER = Color4.create(0.85, 0.85, 0.9, 1)

interface CloseButtonProps {
  hoverKey: keyof typeof hover
  onClose: () => void
  size?: number
  fontSize?: number
  topOffset?: number
  rightOffset?: number
}

// Mobile close-X style (matches HowToPlay / Status popups): bold red glyph,
// centered inside a larger tap target, nudged slightly outside the panel corner.
const MOBILE_RED = Color4.create(0.9, 0.15, 0.15, 1)
const MOBILE_RED_HOVER = Color4.create(1, 0.4, 0.4, 1)

export function CloseButton({ hoverKey, onClose, size, fontSize, topOffset, rightOffset }: CloseButtonProps) {
  const mobile = isMobile()
  const s = size ?? (mobile ? 110 : S(80))
  const fs = fontSize ?? (mobile ? 95 : S(44))
  const top = topOffset ?? (mobile ? -12 : S(4))
  const right = rightOffset ?? (mobile ? -15 : S(4))
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top, right },
        width: s,
        height: s,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={() => { hover[hoverKey] = true }}
      onMouseLeave={() => { hover[hoverKey] = false }}
      onMouseDown={() => { playClickSound(); onClose(); hover[hoverKey] = false }}
    >
      {mobile ? (
        <Label value="×" fontSize={fs} color={hover[hoverKey] ? MOBILE_RED_HOVER : MOBILE_RED} font="sans-serif" textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
      ) : (
        <Label value="×" fontSize={fs} color={hover[hoverKey] ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
      )}
    </UiEntity>
  )
}
