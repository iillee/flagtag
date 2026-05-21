/** Inventory UI layout constants */
import { Color4 } from '@dcl/sdk/math'

// ── Slot sizing ──
export const SLOT_SIZE = 74
export const SLOT_GAP = 4
export const SLOT_RADIUS = 18

// ── Slot colors ──
export const SLOT_BG          = Color4.create(0.08, 0.08, 0.1, 0.87)
export const SLOT_BG_HOVER    = Color4.create(0.16, 0.16, 0.22, 0.92)
export const SLOT_BG_SELECTED = Color4.create(0.28, 0.22, 0.08, 0.95)
export const SLOT_EMPTY_BG    = Color4.create(0.06, 0.06, 0.08, 0.5)

// ── Rarity colors ──
export const RARITY_COLORS: Record<string, Color4> = {
  common:   Color4.create(0.6, 0.6, 0.6, 1),
  uncommon: Color4.create(0.12, 0.8, 0.26, 1),
  rare:     Color4.create(0.2, 0.5, 1, 1),
  epic:     Color4.create(0.7, 0.3, 1, 1),
}

// ── Grid ──
export const GRID_COLS = 3
export const GRID_ROWS = 3
export const GRID_SLOT_SIZE = SLOT_SIZE
export const GRID_SLOT_GAP = SLOT_GAP

// ── Hotbar ──
export const HOTBAR_SLOTS = 2
