/**
 * Inventory state — self-contained, modeled after LootDrop's state.ts.
 * All mutable state lives here. Components read directly.
 */
import { InputAction } from '@dcl/sdk/ecs'
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

let lastBoomerangCount = -1
let lastBoomerangBits = 0
let lastEquippedColor: string = ''
let initialized = false

/** Fast bitmask check — no allocations on the hot path */
function boomerangBits(boomerangs: string[]): number {
  let bits = 0
  for (const c of boomerangs) {
    if (c === 'r') bits |= 1
    else if (c === 'y') bits |= 2
    else if (c === 'g') bits |= 4
    else if (c === 'b') bits |= 8
  }
  return bits
}

/**
 * Called each frame (from the Hotbar component).
 * Only rebuilds when the set of owned items changes (e.g. a purchase),
 * NOT when the equipped item changes (that's driven by hotbar swaps).
 */
export function ensureInventorySync(): void {
  const upgrades = getLocalUpgrades()
  const count = upgrades.boomerangs.length
  const bits = boomerangBits(upgrades.boomerangs)
  const equipped = getBoomerangColor()

  // If only the equipped color changed, just swap the hotbar boomerang
  if (initialized && equipped !== lastEquippedColor && count === lastBoomerangCount && bits === lastBoomerangBits) {
    lastEquippedColor = equipped
    const newItem = BOOMERANG_ITEMS[equipped]
    if (newItem) {
      // Find current boomerang in hotbar and swap it
      for (let i = 0; i < HOTBAR_SLOTS; i++) {
        if (hotbar[i]?.category === 'boomerang') {
          const oldItem = hotbar[i]!
          hotbar[i] = newItem
          // Put old boomerang back in grid, remove new from grid
          const gridIdx = grid.indexOf(newItem)
          if (gridIdx !== -1) grid[gridIdx] = oldItem
          break
        }
      }
    }
    return
  }

  if (count === lastBoomerangCount && bits === lastBoomerangBits && initialized) return

  const isFirstInit = !initialized
  lastBoomerangCount = count
  lastBoomerangBits = bits
  lastEquippedColor = equipped
  initialized = true

  const owned = getOwnedItems(upgrades.boomerangs)

  if (isFirstInit) {
    // First load: put equipped boomerang in hotbar, rest in grid
    const equippedColor = getBoomerangColor()
    const equippedBoomerang = BOOMERANG_ITEMS[equippedColor] || BOOMERANG_ITEMS['r']
    hotbar[0] = equippedBoomerang
    hotbar[1] = BANANA_ITEM

    const remaining = owned.filter(item =>
      item.id !== equippedBoomerang.id && item.id !== BANANA_ITEM.id
    )
    const gridSize = GRID_COLS * GRID_ROWS
    grid = new Array(gridSize).fill(null)
    for (let i = 0; i < remaining.length && i < gridSize; i++) {
      grid[i] = remaining[i]
    }
  } else {
    // Subsequent change (purchase): add any new items to the first empty grid slot
    const allPlaced = new Set<string>()
    if (hotbar[0]) allPlaced.add(hotbar[0].id)
    if (hotbar[1]) allPlaced.add(hotbar[1].id)
    for (const g of grid) { if (g) allPlaced.add(g.id) }

    for (const item of owned) {
      if (!allPlaced.has(item.id)) {
        // New item — find first empty grid slot
        const emptyIdx = grid.indexOf(null)
        if (emptyIdx !== -1) {
          grid[emptyIdx] = item
        }
        allPlaced.add(item.id)
      }
    }

    // Ensure the equipped boomerang is in the hotbar (not just in the grid).
    // This handles the case where first init used default 'r' but the server
    // then sent the real equipped color along with the full owned set.
    const equippedItem = BOOMERANG_ITEMS[equipped]
    if (equippedItem) {
      const hotbarHasEquipped = hotbar.some(h => h?.id === equippedItem.id)
      if (!hotbarHasEquipped) {
        for (let i = 0; i < HOTBAR_SLOTS; i++) {
          if (hotbar[i]?.category === 'boomerang') {
            const oldItem = hotbar[i]!
            hotbar[i] = equippedItem
            // Put old boomerang in grid where equipped was (or first empty slot)
            const gridIdx = grid.indexOf(equippedItem)
            if (gridIdx !== -1) {
              grid[gridIdx] = oldItem
            } else {
              const emptyIdx = grid.indexOf(null)
              if (emptyIdx !== -1) grid[emptyIdx] = oldItem
            }
            break
          }
        }
      }
    }
  }
}

// ═══════════════════════════════════════════
// Swap logic
// ═══════════════════════════════════════════

/**
 * Validates whether an item can go into a hotbar slot.
 * Any combat item (boomerang or trap) can go in either slot.
 * Slots cannot be emptied — swaps only.
 */
function canPlaceInHotbar(_slotIdx: number, item: GameItem | null): boolean {
  if (!item) return false // cannot empty a hotbar slot
  return item.slot === 'E' || item.slot === 'F'
}

/**
 * Returns which hotbar slot holds the given category.
 * Slot 0 = IA_PRIMARY (E), Slot 1 = IA_SECONDARY (F).
 * Returns null if the item category is not in any hotbar slot.
 */
export function getHotbarSlotForCategory(category: 'boomerang' | 'trap'): number | null {
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    if (hotbar[i]?.category === category) return i
  }
  return null
}

/** Slot 0 → IA_PRIMARY (E), Slot 1 → IA_SECONDARY (F) */
const SLOT_TO_ACTION: InputAction[] = [InputAction.IA_PRIMARY, InputAction.IA_SECONDARY]

/**
 * Returns the InputAction for a given item category based on its hotbar slot.
 * Returns null if the category is not hotbarred.
 */
export function getInputActionForCategory(category: 'boomerang' | 'trap'): InputAction | null {
  const slot = getHotbarSlotForCategory(category)
  if (slot === null) return null
  return SLOT_TO_ACTION[slot] ?? null
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

/** Single-click handler: grid items auto-swap with their associated hotbar slot. */
export function handleSlotClick(type: 'hotbar' | 'grid', idx: number): void {
  if (type === 'hotbar') {
    // Clicking hotbar does nothing (items are swapped via grid clicks)
    return
  }

  // Grid click: auto-swap with the matching hotbar slot
  const item = grid[idx]
  if (!item) return

  // Find the hotbar slot that matches this item's category
  const targetSlot = getHotbarSlotForCategory(item.category)
  if (targetSlot === null) return

  swapSlots('grid', idx, 'hotbar', targetSlot)
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
