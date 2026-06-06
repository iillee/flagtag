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
}

export function CloseButton({ hoverKey, onClose, size, fontSize }: CloseButtonProps) {
  const mobile = isMobile()
  const s = size ?? (mobile ? 80 : S(80))
  const fs = fontSize ?? (mobile ? 52 : S(44))
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: mobile ? 4 : S(4), right: mobile ? 4 : S(4) },
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
      <Label value="×" fontSize={fs} color={hover[hoverKey] ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
    </UiEntity>
  )
}
