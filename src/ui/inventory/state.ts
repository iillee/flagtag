/**
 * Inventory state — self-contained, modeled after LootDrop's state.ts.
 * All mutable state lives here. Components read directly.
 */
import type { GameItem, ItemSlotKey } from './items'
import { BANANA_ITEM, BOOMERANG_ITEMS, getOwnedItems } from './items'
import { HOTBAR_SLOTS, GRID_COLS, GRID_ROWS } from './constants'
import { getLocalUpgrades } from '../../gameState/playerUpgradeState'
import { getBoomerangColor, type BoomerangColor } from '../../gameState/boomerangColor'

// ═══════════════════════════════════════════
// Selection state (two-click swap)
// ═══════════════════════════════════════════

export let selSource: 'hotbar' | 'grid' | null = null
export let selIndex = -1

export function clearSelection(): void {
  selSource = null
  selIndex = -1
}

// ═══════════════════════════════════════════
// Inventory & hotbar slots
// ═══════════════════════════════════════════

export let showInventory = false

/** hotbar[0] = E slot, hotbar[1] = F slot */
export const hotbar: (GameItem | null)[] = new Array(HOTBAR_SLOTS).fill(null)

/** 3x3 grid = 9 slots */
export let grid: (GameItem | null)[] = new Array(GRID_COLS * GRID_ROWS).fill(null)

// ── Sync with upgrade system ──

let lastUpgradesJson = ''
let initialized = false

/**
 * Called each frame (from the Hotbar component).
 * Re-reads PlayerUpgrades and rebuilds slots if the data changed.
 */
export function ensureInventorySync(): void {
  const upgrades = getLocalUpgrades()
  const json = JSON.stringify(upgrades.boomerangs) + ':' + upgrades.equipped
  if (json === lastUpgradesJson && initialized) return
  lastUpgradesJson = json
  initialized = true

  const owned = getOwnedItems(upgrades.boomerangs)
  const equippedColor = getBoomerangColor()

  // Determine what goes in hotbar
  const equippedBoomerang = BOOMERANG_ITEMS[equippedColor] || BOOMERANG_ITEMS['r']
  hotbar[0] = equippedBoomerang  // E slot
  hotbar[1] = BANANA_ITEM        // F slot

  // Remaining items go to grid
  const remaining = owned.filter(item =>
    item.id !== equippedBoomerang.id && item.id !== BANANA_ITEM.id
  )
  const gridSize = GRID_COLS * GRID_ROWS
  grid = new Array(gridSize).fill(null)
  for (let i = 0; i < remaining.length && i < gridSize; i++) {
    grid[i] = remaining[i]
  }
}

// ═══════════════════════════════════════════
// Swap logic
// ═══════════════════════════════════════════

/**
 * Validates whether an item can go into a hotbar slot.
 * Slot 0 (E) only accepts boomerangs. Slot 1 (F) only accepts traps.
 */
function canPlaceInHotbar(slotIdx: number, item: GameItem | null): boolean {
  if (!item) return true // emptying is always ok
  if (slotIdx === 0) return item.slot === 'E'
  if (slotIdx === 1) return item.slot === 'F'
  return false
}

export function swapSlots(
  srcType: 'hotbar' | 'grid', srcIdx: number,
  dstType: 'hotbar' | 'grid', dstIdx: number
): boolean {
  const srcArr = srcType === 'hotbar' ? hotbar : grid
  const dstArr = dstType === 'hotbar' ? hotbar : grid

  const srcItem = srcArr[srcIdx] || null
  const dstItem = dstArr[dstIdx] || null

  // Validate hotbar placement
  if (dstType === 'hotbar' && !canPlaceInHotbar(dstIdx, srcItem)) return false
  if (srcType === 'hotbar' && !canPlaceInHotbar(srcIdx, dstItem)) return false

  // Perform swap
  dstArr[dstIdx] = srcItem
  srcArr[srcIdx] = dstItem

  // Fire callback if hotbar changed
  if (srcType === 'hotbar' || dstType === 'hotbar') {
    _onHotbarChanged?.()
  }

  return true
}

/** Unified two-click handler: first click selects, second click swaps. */
export function handleSlotClick(type: 'hotbar' | 'grid', idx: number): void {
  // Click on same slot = deselect
  if (selSource === type && selIndex === idx) {
    clearSelection()
    return
  }
  // Second click = attempt swap
  if (selSource !== null) {
    const success = swapSlots(selSource, selIndex, type, idx)
    clearSelection()
    // If swap failed, select the new slot instead
    if (!success) {
      selSource = type
      selIndex = idx
    }
    return
  }
  // First click = select
  selSource = type
  selIndex = idx
}

// ═══════════════════════════════════════════
// Visibility
// ═══════════════════════════════════════════

export function toggleInventory(): void {
  showInventory = !showInventory
  if (!showInventory) clearSelection()
}

export function setShowInventory(v: boolean): void {
  showInventory = v
  if (!v) clearSelection()
}

// ═══════════════════════════════════════════
// Hotbar change callback
// ═══════════════════════════════════════════

let _onHotbarChanged: (() => void) | null = null

export function setOnHotbarChanged(cb: () => void): void {
  _onHotbarChanged = cb
}

// ═══════════════════════════════════════════
// Hover tracking
// ═══════════════════════════════════════════

export const hotbarHover: boolean[] = new Array(HOTBAR_SLOTS).fill(false)
export const gridHover: boolean[] = new Array(GRID_COLS * GRID_ROWS).fill(false)
export let hoveredGridItem: GameItem | null = null
export function setHoveredGridItem(w: GameItem | null): void { hoveredGridItem = w }
