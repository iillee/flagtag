/**
 * ChestPopup — Tabbed universal store overlay.
 * Categories: Projectiles, Music, Traps (coming soon), Wearables (coming soon)
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { S, GOLD, GREY, LIGHT_GREY, BRIGHT_WHITE, CORAL_RED, PANEL_BG } from '../uiConstants'
import { playClickSound } from '../uiSounds'
import { hideChestPopup } from '../uiState'
import { CloseButton } from '../components/CloseButton'
import { getCoinBalance, isCoinBalanceLoaded } from '../../systems/coinPickupSystem'
import {
  getLocalUpgrades, getLocalLifetimeWins, isWinsLoaded,
  requestBuyBoomerang, requestEquipBoomerang, requestBuyTape,
  requestBuyTrap, requestEquipTrap,
  isBuyPending, getLastBuyError,
} from '../../gameState/playerUpgradeState'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { BOOMERANG_STORE, MUSIC_STORE, TRAP_STORE, type StoreCategory, type StoreItem, type MusicStoreItem } from '../../shared/upgrades'
import type { BoomerangColor } from '../../gameState/boomerangColor'
import { getEquippedTape, setEquippedTape, getAllTapes } from './boomboxState'
import { AudioSource } from '@dcl/sdk/ecs'
import { musicEntity } from '../../systems/musicSetup'

// ── State ──

let activeTab: StoreCategory = 'projectiles'
let hoveredTab: StoreCategory | null = null
let hoveredItemId: string | null = null

// ── Tab definitions ──

const TABS: { id: StoreCategory; label: string; hasContent: boolean }[] = [
  { id: 'projectiles', label: 'Boomerangs',     hasContent: true },
  { id: 'traps',       label: 'Traps',     hasContent: true },
  { id: 'music',       label: 'Music',     hasContent: true },
  { id: 'wearables',   label: 'Wearables', hasContent: false },
]

// ── Colors ──

const LOCKED_BG   = Color4.create(0.1, 0.1, 0.12, 1)
const OWNED_BG    = Color4.create(0.15, 0.15, 0.18, 1)
const SELECTED_BG = Color4.create(0.45, 0.38, 0.1, 1)
const HOVER_BG    = Color4.create(0.2, 0.2, 0.24, 1)
const RED_DIM     = Color4.create(0.7, 0.25, 0.25, 1)
const TAB_BG      = Color4.create(0.15, 0.15, 0.18, 0.9)
const TAB_ACTIVE  = Color4.create(0.25, 0.22, 0.08, 1)
const TAB_HOVER   = Color4.create(0.2, 0.2, 0.24, 1)
const EMPTY_SLOT_BG = Color4.create(0.08, 0.08, 0.1, 0.5)

// ── Helpers ──

function getItemsForTab(tab: StoreCategory): StoreItem[] {
  switch (tab) {
    case 'projectiles': return BOOMERANG_STORE
    case 'traps':       return TRAP_STORE
    case 'music':       return MUSIC_STORE
    default:            return []
  }
}

function isOwned(tab: StoreCategory, itemId: string, upgrades: ReturnType<typeof getLocalUpgrades>): boolean {
  if (tab === 'projectiles') return upgrades.boomerangs.includes(itemId as BoomerangColor)
  if (tab === 'traps')       return upgrades.traps.includes(itemId)
  if (tab === 'music')       return upgrades.tapes.includes(itemId)
  return false
}

function isEquipped(tab: StoreCategory, itemId: string, upgrades: ReturnType<typeof getLocalUpgrades>): boolean {
  if (tab === 'projectiles') return getBoomerangColor() === itemId
  if (tab === 'traps')       return upgrades.equippedTrap === itemId
  if (tab === 'music')       return getEquippedTape() === itemId
  return false
}

function handleBuy(tab: StoreCategory, itemId: string): void {
  if (tab === 'projectiles') requestBuyBoomerang(itemId as BoomerangColor)
  if (tab === 'music')       requestBuyTape(itemId)
  if (tab === 'traps')       requestBuyTrap(itemId)
}

function handleEquip(tab: StoreCategory, itemId: string): void {
  if (tab === 'projectiles') requestEquipBoomerang(itemId as BoomerangColor)
  if (tab === 'traps')       requestEquipTrap(itemId)
  if (tab === 'music') {
    const tape = getAllTapes().find(t => t.id === itemId)
    if (tape) {
      setEquippedTape(tape.id)
      try {
        const audio = AudioSource.getMutable(musicEntity)
        audio.audioClipUrl = tape.audioSrc
        audio.playing = true
        audio.loop = true
        audio.volume = 0.0984375
      } catch (e) {
        console.error('[Chest] Failed to equip tape:', e)
      }
    }
  }
  // Traps: add equip handler when needed
}

// ── Component ──

export function ChestPopup() {
  const mobile = isMobile()
  const upgrades = getLocalUpgrades()
  const lifetimeWins = getLocalLifetimeWins()
  const coins = getCoinBalance()
  const pending = isBuyPending()
  const buyError = getLastBuyError()

  const SLOTS = 4
  const panelWidth = mobile ? 500 : S(620)
  const pad = mobile ? 20 : S(20)
  const r = mobile ? 20 : S(20)

  const items = getItemsForTab(activeTab)

  // Card sizing: always 4 in a row
  const cardGap = mobile ? 8 : S(8)
  const totalGap = cardGap * (SLOTS - 1) + pad * 2
  const cardWidth = Math.floor((panelWidth - totalGap) / SLOTS)
  const cardHeight = mobile ? 200 : S(230)

  return (
    <UiEntity uiTransform={{
      positionType: 'absolute',
      position: { top: 0, left: 0 },
      width: '100%', height: '100%',
      justifyContent: 'center', alignItems: 'center',
      pointerFilter: 'none',
    }}>
      <UiEntity uiTransform={{
        width: panelWidth,
        flexDirection: 'column',
        alignItems: 'center',
        padding: { top: pad, bottom: pad, left: pad, right: pad },
        borderRadius: r,
      }}
      uiBackground={{ color: PANEL_BG }}
      >
        <CloseButton hoverKey="closeChest" onClose={() => { hideChestPopup(); hoveredItemId = null; hoveredTab = null }} />

        {/* Title */}
        <Label value="Chest" fontSize={mobile ? 38 : S(32)} color={GOLD} font="sans-serif"
          uiTransform={{ margin: { bottom: mobile ? 4 : S(4) } }} />

        {/* Wallet row */}
        <UiEntity uiTransform={{
          flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
          margin: { top: mobile ? 4 : S(4), bottom: mobile ? 16 : S(14) },
        }}>
          <UiEntity uiTransform={{ width: mobile ? 20 : S(18), height: mobile ? 20 : S(18), margin: { right: mobile ? 5 : S(5) } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.White() }} />
          <Label value={isCoinBalanceLoaded() ? `${coins}` : '--'} fontSize={mobile ? 22 : S(18)} color={GOLD} font="sans-serif"
            uiTransform={{ margin: { right: mobile ? 20 : S(20) } }} />
          <UiEntity uiTransform={{ width: mobile ? 20 : S(20), height: mobile ? 20 : S(20), margin: { right: mobile ? 5 : S(5) } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />
          <Label value={isWinsLoaded() ? `${lifetimeWins}` : '--'} fontSize={mobile ? 22 : S(18)} color={GOLD} font="sans-serif" />
        </UiEntity>

        {/* Tab bar */}
        <UiEntity uiTransform={{
          flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
          width: '100%',
          margin: { bottom: mobile ? 14 : S(12) },
        }}>
          {TABS.map((tab, i) => {
            const isActive = activeTab === tab.id
            const isHovered = hoveredTab === tab.id
            const bg = isActive ? TAB_ACTIVE : isHovered ? TAB_HOVER : TAB_BG
            const textColor = isActive ? GOLD : tab.hasContent ? LIGHT_GREY : GREY

            return (
              <UiEntity
                key={`tab-${tab.id}`}
                uiTransform={{
                  height: mobile ? 40 : S(36),
                  padding: { left: mobile ? 12 : S(10), right: mobile ? 12 : S(10) },
                  margin: { left: i === 0 ? 0 : (mobile ? 6 : S(6)) },
                  borderRadius: mobile ? 10 : S(8),
                  justifyContent: 'center', alignItems: 'center',
                  borderWidth: isActive ? (mobile ? 1 : S(1)) : 0,
                  borderColor: isActive ? GOLD : Color4.Clear(),
                }}
                uiBackground={{ color: bg }}
                onMouseEnter={() => { hoveredTab = tab.id }}
                onMouseLeave={() => { if (hoveredTab === tab.id) hoveredTab = null }}
                onMouseDown={() => { playClickSound(); activeTab = tab.id; hoveredItemId = null }}
              >
                <Label value={tab.label} fontSize={mobile ? 17 : S(14)} color={textColor} font="sans-serif"
                  uiTransform={{ pointerFilter: 'none' }} />
              </UiEntity>
            )
          })}
        </UiEntity>

        {/* Item grid — always 4 slots */}
        <UiEntity uiTransform={{
          flexDirection: 'row',
          justifyContent: 'center', alignItems: 'flex-start',
          width: '100%',
        }}>
          {Array.from({ length: SLOTS }).map((_, i) => {
            const item = items[i] || null

            // Empty slot
            if (!item) {
              return (
                <UiEntity
                  key={`empty-${activeTab}-${i}`}
                  uiTransform={{
                    width: cardWidth,
                    height: cardHeight,
                    margin: { left: i === 0 ? 0 : cardGap },
                    borderRadius: mobile ? 14 : S(14),
                    justifyContent: 'center', alignItems: 'center',
                  }}
                  uiBackground={{ color: EMPTY_SLOT_BG }}
                >
                  <Label value="?" fontSize={mobile ? 36 : S(32)} color={GREY} font="sans-serif"
                    uiTransform={{ pointerFilter: 'none' }} />
                </UiEntity>
              )
            }

            const owned = isOwned(activeTab, item.id, upgrades)
            const equipped = isEquipped(activeTab, item.id, upgrades)
            const canAfford = coins >= item.coinCost
            const hasFlags = lifetimeWins >= item.flagsRequired
            const locked = !owned && (!canAfford || !hasFlags)
            const canBuy = !owned && canAfford && hasFlags && item.coinCost > 0
            const hovered = hoveredItemId === `${activeTab}-${item.id}`

            const bgColor = equipped ? SELECTED_BG : owned ? (hovered ? HOVER_BG : OWNED_BG) : (hovered && canBuy ? HOVER_BG : LOCKED_BG)

            // For music tab, show author as subtitle
            const isMusic = activeTab === 'music'
            const musicItem = isMusic ? (item as MusicStoreItem) : null

            const iconSize = mobile ? 72 : S(80)

            return (
              <UiEntity
                key={`item-${activeTab}-${item.id}`}
                uiTransform={{
                  width: cardWidth,
                  height: cardHeight,
                  margin: { left: i === 0 ? 0 : cardGap },
                  padding: mobile ? 8 : S(8),
                  borderRadius: mobile ? 14 : S(14),
                  borderWidth: canBuy ? (mobile ? 2 : S(2)) : 0,
                  borderColor: canBuy ? BRIGHT_WHITE : Color4.Clear(),
                  justifyContent: 'flex-start',
                  alignItems: 'center',
                  flexDirection: 'column',
                }}
                uiBackground={{ color: bgColor }}
                onMouseEnter={() => { hoveredItemId = `${activeTab}-${item.id}` }}
                onMouseLeave={() => { if (hoveredItemId === `${activeTab}-${item.id}`) hoveredItemId = null }}
                onMouseDown={() => {
                  playClickSound()
                  if (owned) {
                    handleEquip(activeTab, item.id)
                  } else if (canBuy && !pending) {
                    handleBuy(activeTab, item.id)
                  }
                }}
              >
                {/* Item icon — bomb is tall (2:3), so use narrower width to avoid distortion */}
                <UiEntity
                  uiTransform={{ width: item.id === 'bomb' ? iconSize * 0.67 : iconSize, height: iconSize, margin: { top: mobile ? 6 : S(8) } }}
                  uiBackground={{
                    textureMode: 'stretch',
                    texture: { src: item.icon },
                    color: owned ? Color4.White() : Color4.create(0.4, 0.4, 0.4, 1),
                  }}
                />

                {/* Item name */}
                <Label value={item.label} fontSize={mobile ? 18 : S(16)} color={equipped ? GOLD : owned ? LIGHT_GREY : GREY}
                  uiTransform={{ margin: { top: mobile ? 4 : S(4) }, pointerFilter: 'none' }} />

                {/* Author (music only) */}
                {musicItem && (
                  <Label value={musicItem.author} fontSize={mobile ? 14 : S(12)} color={GREY}
                    uiTransform={{ margin: { top: mobile ? 1 : S(1) }, pointerFilter: 'none' }} />
                )}

                {/* Status / Price area */}
                {owned ? (
                  <Label
                    value={equipped ? 'Equipped' : 'Equip'}
                    fontSize={mobile ? 16 : S(14)}
                    color={equipped ? GOLD : LIGHT_GREY}
                    uiTransform={{ margin: { top: mobile ? 6 : S(6) }, pointerFilter: 'none' }}
                  />
                ) : (
                  <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', margin: { top: mobile ? 4 : S(4) }, pointerFilter: 'none' }}>
                    {item.coinCost > 0 && (
                      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: mobile ? 3 : S(3) }, pointerFilter: 'none' }}>
                        <UiEntity uiTransform={{ width: mobile ? 14 : S(14), height: mobile ? 14 : S(14), margin: { right: mobile ? 4 : S(3) }, pointerFilter: 'none' }}
                          uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: canAfford ? Color4.White() : Color4.create(0.5, 0.5, 0.5, 1) }} />
                        <Label value={`${item.coinCost}`} fontSize={mobile ? 16 : S(14)} color={canAfford ? GOLD : RED_DIM}
                          uiTransform={{ pointerFilter: 'none' }} />
                      </UiEntity>
                    )}
                    {item.flagsRequired > 0 && (
                      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: mobile ? 3 : S(3) }, pointerFilter: 'none' }}>
                        <UiEntity uiTransform={{ width: mobile ? 13 : S(12), height: mobile ? 13 : S(12), margin: { right: mobile ? 3 : S(3) }, pointerFilter: 'none' }}
                          uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: hasFlags ? GOLD : Color4.create(0.5, 0.5, 0.5, 1) }} />
                        <Label value={`${Math.min(lifetimeWins, item.flagsRequired)}/${item.flagsRequired}`} fontSize={mobile ? 15 : S(14)} color={hasFlags ? GOLD : RED_DIM}
                          uiTransform={{ pointerFilter: 'none' }} />
                      </UiEntity>
                    )}
                    {canBuy && (
                      <Label
                        value={pending ? '...' : 'Buy'}
                        fontSize={mobile ? 17 : S(14)}
                        color={pending ? GREY : BRIGHT_WHITE}
                        uiTransform={{ margin: { top: mobile ? 2 : S(2) }, pointerFilter: 'none' }}
                      />
                    )}
                    {locked && !canBuy && (
                      <UiEntity uiTransform={{ width: mobile ? 18 : S(18), height: mobile ? 18 : S(18), margin: { top: mobile ? 2 : S(2) }, pointerFilter: 'none' }}
                        uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/lock.png' }, color: GREY }} />
                    )}
                  </UiEntity>
                )}
              </UiEntity>
            )
          })}
        </UiEntity>

        {/* Buy error */}
        {buyError ? (
          <Label value={buyError} fontSize={mobile ? 17 : S(14)} color={CORAL_RED}
            uiTransform={{ margin: { top: mobile ? 10 : S(10) } }} />
        ) : null}
      </UiEntity>
    </UiEntity>
  )
}
