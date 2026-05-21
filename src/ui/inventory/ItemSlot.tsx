/** Reusable item slot — used in both hotbar and inventory grid. */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import type { GameItem } from './items'
import { SLOT_BG_SELECTED, SLOT_BG_HOVER, RARITY_COLORS } from './constants'
import { S } from '../uiConstants'

export interface ItemSlotProps {
  w: GameItem | null
  size: number
  radius: number
  isSelected: boolean
  isHovered: boolean
  bgNormal: Color4
  bgEmpty: Color4
  onEnter: () => void
  onLeave: () => void
  onDown: () => void
  slotLabel?: string
  cooldownText?: string
  chargeFraction?: number
  chargeBurnout?: boolean
  dimmed?: boolean
}

export function ItemSlot(props: ItemSlotProps) {
  const { w, size, radius, isSelected, isHovered, bgNormal, bgEmpty, onEnter, onLeave, onDown, slotLabel, cooldownText, chargeFraction, chargeBurnout, dimmed } = props

  const bg = w
    ? (isSelected ? SLOT_BG_SELECTED : isHovered ? SLOT_BG_HOVER : bgNormal)
    : bgEmpty
  const iconSize = Math.round(size * 0.65)
  const rarityColor = w ? (RARITY_COLORS[w.rarity] || RARITY_COLORS.common) : RARITY_COLORS.common

  return (
    <UiEntity
      uiTransform={{
        width: S(size), height: S(size),
        flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        borderRadius: S(radius),
      }}
      uiBackground={{ color: bg }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onMouseDown={onDown}
    >
      {/* Item icon — pointerFilter: 'none' so parent gets all events */}
      {w && (
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', pointerFilter: 'none' }}>
          <UiEntity
            uiTransform={{ width: S(iconSize), height: S(iconSize), pointerFilter: 'none' }}
            uiBackground={{ textureMode: 'stretch', texture: { src: w.icon }, color: dimmed ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White() }}
          />
        </UiEntity>
      )}

      {/* Charge fill bar */}
      {chargeFraction !== undefined && chargeFraction > 0 && (
        <UiEntity uiTransform={{
          positionType: 'absolute',
          position: { bottom: S(6), left: S(6), right: S(6) },
          height: `${Math.round(chargeFraction * 100)}%`,
          maxHeight: S(size - 12),
          borderRadius: S(radius),
          pointerFilter: 'none',
        }}
        uiBackground={{ color: chargeBurnout
          ? Color4.create(1, 0.15, 0.1, 0.9)
          : chargeFraction >= 0.83
            ? Color4.create(1, 0.84, 0, 0.85)
            : Color4.create(1, 1, 1, 0.5)
        }} />
      )}

      {/* Cooldown number */}
      {cooldownText && (
        <Label value={cooldownText} fontSize={S(26)} color={Color4.White()} font="sans-serif"
          uiTransform={{ positionType: 'absolute', pointerFilter: 'none' }} textAlign="middle-center" />
      )}

      {/* Selection glow */}
      {isSelected && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: S(size), height: S(size), borderRadius: S(radius), pointerFilter: 'none' }}
          uiBackground={{ color: Color4.create(1, 0.84, 0, 0.18) }}
        />
      )}

      {/* Slot key label */}
      {slotLabel && (
        <Label
          value={slotLabel}
          fontSize={S(16)}
          color={Color4.create(0.72, 0.72, 0.75, 1)}
          font="sans-serif"
          uiTransform={{ positionType: 'absolute', position: { top: S(2), left: S(8) }, width: S(16), height: S(16), pointerFilter: 'none' }}
        />
      )}
    </UiEntity>
  )
}
