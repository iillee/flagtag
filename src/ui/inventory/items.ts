/**
 * items.ts — Game item definitions.
 * Each item knows which hotbar slot it belongs to ('E' or 'F').
 */
import type { BoomerangColor } from '../../gameState/boomerangColor'

export type ItemSlotKey = 'E' | 'F'
export type ItemCategory = 'boomerang' | 'trap'
export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'epic'

export interface GameItem {
  id: string
  name: string
  icon: string
  slot: ItemSlotKey
  category: ItemCategory
  rarity: ItemRarity
  /** For boomerangs, the color code used by the combat system */
  boomerangColor?: BoomerangColor
}

// ── Item Registry ──

export const BANANA_ITEM: GameItem = {
  id: 'banana',
  name: 'Banana',
  icon: 'assets/images/banana.png',
  slot: 'F',
  category: 'trap',
  rarity: 'common',
}

export const BOOMERANG_ITEMS: Record<BoomerangColor, GameItem> = {
  r: { id: 'boomerang-r', name: 'Base', icon: 'assets/images/boomerang.r.png', slot: 'E', category: 'boomerang', rarity: 'common', boomerangColor: 'r' },
  y: { id: 'boomerang-y', name: 'Dubs', icon: 'assets/images/boomerang.y.png', slot: 'E', category: 'boomerang', rarity: 'uncommon', boomerangColor: 'y' },
  g: { id: 'boomerang-g', name: 'Orbit', icon: 'assets/images/boomerang.g.png', slot: 'E', category: 'boomerang', rarity: 'rare', boomerangColor: 'g' },
  b: { id: 'boomerang-b', name: 'Charge', icon: 'assets/images/boomerang.b.png', slot: 'E', category: 'boomerang', rarity: 'epic', boomerangColor: 'b' },
}

/** Get all items a player owns based on their unlocked boomerangs */
export function getOwnedItems(unlockedBoomerangs: BoomerangColor[]): GameItem[] {
  const items: GameItem[] = [BANANA_ITEM]
  for (const color of unlockedBoomerangs) {
    const item = BOOMERANG_ITEMS[color]
    if (item) items.push(item)
  }
  return items
}
