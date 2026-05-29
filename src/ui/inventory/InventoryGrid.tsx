/** 3×3 inventory grid — opens as an overlay above the hotbar. */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import {
  GRID_COLS, GRID_ROWS, GRID_SLOT_SIZE, GRID_SLOT_GAP,
  SLOT_BG, SLOT_EMPTY_BG, RARITY_COLORS, SLOT_RADIUS,
} from './constants'
import { ItemSlot } from './ItemSlot'
import { S, GOLD, LIGHT_GREY, CLOSE_GREY } from '../uiConstants'
import {
  selSource, selIndex, grid,
  gridHover, hoveredGridItem, setHoveredGridItem,
  setShowInventory, handleSlotClick, clearSelection,
} from './state'
import { getCoinBalance, isCoinBalanceLoaded } from '../../systems/coinPickupSystem'
import { getLocalLifetimeWins, isWinsLoaded } from '../../gameState/playerUpgradeState'
import { earnedState } from '../uiState'

const HOVER_CLOSE = Color4.create(0.85, 0.85, 0.9, 1)
let closeHover = false

export const InventoryGrid = () => {
  const gridWidth = S(GRID_COLS * GRID_SLOT_SIZE + (GRID_COLS - 1) * GRID_SLOT_GAP + 32)
  const itemCount = grid.filter(Boolean).length
  const rarityColor = hoveredGridItem ? (RARITY_COLORS[hoveredGridItem.rarity] || RARITY_COLORS.common) : null

  const coins = getCoinBalance()
  const liveWins = getLocalLifetimeWins()
  const myFlags = earnedState.winsFrozen ? (earnedState.displayedWins ?? liveWins) : liveWins

  return (
    <UiEntity uiTransform={{
      positionType: 'absolute',
      position: { top: 0, left: 0 },
      width: '100%', height: '100%',
      flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      pointerFilter: 'none',
    }}
    >
      <UiEntity uiTransform={{
        width: gridWidth,
        flexDirection: 'column', alignItems: 'center',
        padding: S(12),
        borderRadius: S(14),
      }}
      uiBackground={{ color: Color4.create(0.1, 0.1, 0.1, 1) }}
      >
        {/* Header bar */}
        <UiEntity uiTransform={{
          width: '100%', height: S(32),
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          margin: { bottom: S(6) }, padding: { left: S(10), right: S(4) },
        }}>
          {/* Hovered item info or title */}
          <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexGrow: 1 }}>
            {hoveredGridItem ? (
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                <Label
                  value={hoveredGridItem.name} fontSize={S(14)} color={Color4.White()}
                  textAlign="middle-center" font="sans-serif"
                  uiTransform={{ height: S(20), margin: { right: S(10) } }}
                />
                <UiEntity
                  uiTransform={{ width: S(8), height: S(8), borderRadius: S(4), margin: { right: S(6) } }}
                  uiBackground={{ color: rarityColor! }}
                />
                <Label
                  value={hoveredGridItem.rarity.toUpperCase()} fontSize={S(12)}
                  color={rarityColor!}
                  font="sans-serif"
                  textAlign="middle-left" uiTransform={{ height: S(18) }}
                />
              </UiEntity>
            ) : (
              <Label
                value="Inventory"
                fontSize={S(16)} color={GOLD}
                font="sans-serif"
                textAlign="middle-left" uiTransform={{ height: S(20) }}
              />
            )}
          </UiEntity>

          {/* Close button */}
          <UiEntity
            uiTransform={{ width: S(28), height: S(28), borderRadius: S(6), justifyContent: 'center', alignItems: 'center', flexShrink: 0 }}
            onMouseEnter={() => { closeHover = true }}
            onMouseLeave={() => { closeHover = false }}
            onMouseDown={() => { setShowInventory(false); closeHover = false }}
          >
            <Label value="×" fontSize={S(28)} color={closeHover ? HOVER_CLOSE : CLOSE_GREY} font="sans-serif"
              textAlign="middle-center" uiTransform={{ width: S(28), height: S(28) }} />
          </UiEntity>
        </UiEntity>

        {/* Stats row — coins + flags */}
        <UiEntity uiTransform={{
          width: '100%', height: S(28),
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
          margin: { bottom: S(6) },
        }}>
          <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { right: S(16) } }}>
            <UiEntity uiTransform={{ width: S(18), height: S(18), margin: { right: S(4) } }}
              uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.White() }} />
            <Label value={isCoinBalanceLoaded() ? `${coins}` : '--'} fontSize={S(15)} color={GOLD} font="sans-serif" />
          </UiEntity>
          <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
            <UiEntity uiTransform={{ width: S(16), height: S(16), margin: { right: S(4) } }}
              uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />
            <Label value={isWinsLoaded() ? `${myFlags}` : '--'} fontSize={S(15)} color={GOLD} font="sans-serif" />
          </UiEntity>
        </UiEntity>

        {/* Item grid */}
        {Array.from({ length: GRID_ROWS }).map((_, row) => (
          <UiEntity key={`grow-${row}`} uiTransform={{ flexDirection: 'row', margin: { top: row === 0 ? 0 : S(GRID_SLOT_GAP) } }}>
            {Array.from({ length: GRID_COLS }).map((_, col) => {
              const idx = row * GRID_COLS + col
              const w = grid[idx] || null
              return (
                <UiEntity key={`gs-${row}-${col}`} uiTransform={{ margin: { left: col === 0 ? 0 : S(GRID_SLOT_GAP) } }}>
                  {ItemSlot({
                    w,
                    size: GRID_SLOT_SIZE,
                    radius: SLOT_RADIUS,
                    isSelected: selSource === 'grid' && selIndex === idx,
                    isHovered: gridHover[idx] || false,
                    bgNormal: SLOT_BG,
                    bgEmpty: SLOT_EMPTY_BG,
                    onEnter: () => { gridHover[idx] = true; setHoveredGridItem(w) },
                    onLeave: () => { gridHover[idx] = false; if (hoveredGridItem === w) setHoveredGridItem(null) },
                    onDown: () => { handleSlotClick('grid', idx) },
                  })}
                </UiEntity>
              )
            })}
          </UiEntity>
        ))}


      </UiEntity>
    </UiEntity>
  )
}
