/** Bottom hotbar — 2 slots (E and F), always visible. */
import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { SLOT_SIZE, SLOT_GAP, SLOT_RADIUS, SLOT_BG, SLOT_EMPTY_BG } from './constants'
import { ItemSlot } from './ItemSlot'
import { S } from '../uiConstants'
import {
  selSource, selIndex, hotbar, showInventory,
  hotbarHover, hoveredGridItem, setHoveredGridItem,
  clearSelection, handleSlotClick,
  ensureInventorySync,
} from './state'
import { isProjectileOnCooldown, getProjectileCooldownRemaining, getChargeFraction, getIsCharging, getBurnoutFlash } from '../../systems/projectile'
import { isTrapOnCooldown, getTrapCooldownRemaining } from '../../systems/trapSystem'

export const InventoryHotbar = () => {
  ensureInventorySync()

  const hasSelection = selSource === 'hotbar' && selIndex >= 0 && !showInventory && hotbar[selIndex] != null

  // Projectile (E) cooldown state
  const projOnCd = isProjectileOnCooldown()
  const projCdRemaining = getProjectileCooldownRemaining()
  const charging = getIsCharging()
  const burnout = getBurnoutFlash()
  const chargeFrac = charging ? getChargeFraction() : (burnout ? 1 : 0)

  // Trap (F) cooldown state
  const trapOnCd = isTrapOnCooldown()
  const trapCdRemaining = getTrapCooldownRemaining()

  const slotLabels = ['E', 'F']

  return (
    <UiEntity uiTransform={{
      positionType: 'absolute',
      position: { bottom: S(24) },
      width: '100%',
      flexDirection: 'row',
      justifyContent: 'center',
      pointerFilter: 'none',
    }}>
      {/* Click-away backdrop to dismiss selection */}
      {hasSelection && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: -9999, left: -9999 }, width: 99999, height: 99999 }}
          uiBackground={{ color: Color4.create(0, 0, 0, 0.01) }}
          onMouseDown={() => { clearSelection() }}
        />
      )}

      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
        {Array.from({ length: 2 }).map((_, i) => {
          // Per-slot cooldown/charge props
          let cooldownText: string | undefined
          let chargeFractionProp: number | undefined
          let chargeBurnoutProp: boolean | undefined
          let dimmed = false

          const item = hotbar[i]
          const isBoomerangSlot = item?.category === 'boomerang'
          const isTrapSlot = item?.category === 'trap'

          if (isBoomerangSlot) {
            dimmed = projOnCd
            if (projOnCd && projCdRemaining > 0) cooldownText = `${projCdRemaining}`
            if (charging || burnout) {
              chargeFractionProp = chargeFrac
              chargeBurnoutProp = burnout
            }
          } else if (isTrapSlot) {
            dimmed = trapOnCd
            if (trapOnCd && trapCdRemaining > 0) cooldownText = `${trapCdRemaining}`
          }

          return (
            <UiEntity key={`hb-${i}`} uiTransform={{
              margin: { left: i === 0 ? 0 : S(SLOT_GAP + 8) },
            }}>
              {ItemSlot({
                w: hotbar[i],
                size: SLOT_SIZE,
                radius: SLOT_RADIUS,
                isSelected: showInventory && selSource === 'hotbar' && selIndex === i,
                isHovered: showInventory && hotbarHover[i],
                bgNormal: SLOT_BG,
                bgEmpty: SLOT_EMPTY_BG,
                onEnter: () => { hotbarHover[i] = true; if (showInventory) setHoveredGridItem(hotbar[i] || null) },
                onLeave: () => { hotbarHover[i] = false; if (showInventory && hoveredGridItem === hotbar[i]) setHoveredGridItem(null) },
                onDown: () => { if (showInventory) handleSlotClick('hotbar', i) },
                slotLabel: slotLabels[i],
                cooldownText,
                chargeFraction: chargeFractionProp,
                chargeBurnout: chargeBurnoutProp,
                dimmed,
              })}
            </UiEntity>
          )
        })}
      </UiEntity>
    </UiEntity>
  )
}
