/**
 * ChestPopup — Boomerang store overlay.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { S, GOLD, GREY, LIGHT_GREY, WHITE, BRIGHT_WHITE, CORAL_RED, PANEL_BG } from '../uiConstants'
import { hideChestPopup } from '../uiState'
import { CloseButton } from '../components/CloseButton'
import { getCoinBalance, isCoinBalanceLoaded } from '../../systems/coinPickupSystem'
import { getLocalUpgrades, getLocalLifetimeWins, isWinsLoaded, requestBuyBoomerang, requestEquipBoomerang, isBuyPending, getLastBuyError } from '../../gameState/playerUpgradeState'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { BOOMERANG_STORE } from '../../shared/upgrades'

export function ChestPopup() {
  const mobile = isMobile()
  const upgrades = getLocalUpgrades()
  const lifetimeWins = getLocalLifetimeWins()
  const coins = getCoinBalance()
  const equipped = getBoomerangColor()
  const pending = isBuyPending()
  const buyError = getLastBuyError()
  const LOCKED_BG = Color4.create(0.1, 0.1, 0.12, 1)
  const OWNED_BG = Color4.create(0.15, 0.15, 0.18, 1)
  const SELECTED_BG = Color4.create(0.45, 0.38, 0.1, 1)
  const RED_DIM = Color4.create(0.7, 0.25, 0.25, 1)

  return (
    <UiEntity uiTransform={{
      positionType: 'absolute',
      position: { top: S(0), left: S(0) },
      width: '100%',
      height: '100%',
      justifyContent: 'center',
      alignItems: 'center',
      pointerFilter: 'none',
    }}
    >
      <UiEntity uiTransform={{
        width: mobile ? 420 : S(480),
        flexDirection: 'column',
        alignItems: 'center',
        padding: mobile
          ? { top: 32, bottom: 32, left: 24, right: 24 }
          : { top: S(32), bottom: S(32), left: S(32), right: S(32) },
        borderRadius: mobile ? 20 : S(20),
      }}
      uiBackground={{ color: PANEL_BG }}
      >
        <CloseButton hoverKey="closeChest" onClose={() => { hideChestPopup() }} />

        <Label value="Chest" fontSize={mobile ? 38 : S(32)} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: mobile ? 4 : S(4) } }} />

        {/* Wallet row */}
        <UiEntity uiTransform={{
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'center',
          margin: { top: mobile ? 4 : S(4), bottom: mobile ? 20 : S(20) },
        }}>
          <UiEntity uiTransform={{ width: mobile ? 20 : S(18), height: mobile ? 20 : S(18), margin: { right: mobile ? 5 : S(5) } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.White() }} />
          <Label value={isCoinBalanceLoaded() ? `${coins}` : '--'} fontSize={mobile ? 22 : S(18)} color={GOLD} font="sans-serif"
            uiTransform={{ margin: { right: mobile ? 20 : S(20) } }} />
          <UiEntity uiTransform={{ width: mobile ? 20 : S(18), height: mobile ? 20 : S(18), margin: { right: mobile ? 5 : S(5) } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />
          <Label value={isWinsLoaded() ? `${lifetimeWins}` : '--'} fontSize={mobile ? 22 : S(18)} color={GOLD} font="sans-serif" />
        </UiEntity>

        {/* Boomerang grid — no red card, no equip */}
        <UiEntity uiTransform={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', width: '100%' }}>
          {BOOMERANG_STORE.map((item) => {
            const owned = upgrades.boomerangs.includes(item.id)
            const selected = equipped === item.id
            const canAfford = coins >= item.coinCost
            const hasFlags = lifetimeWins >= item.flagsRequired
            const locked = !owned && (!canAfford || !hasFlags)
            const canBuy = !owned && canAfford && hasFlags && item.coinCost > 0

            const bgColor = selected ? SELECTED_BG : owned ? OWNED_BG : LOCKED_BG
            const cardWidth = mobile ? 100 : S(120)
            const cardHeight = mobile ? 200 : S(240)

            return (
              <UiEntity
                key={`store-${item.id}`}
                uiTransform={{
                  width: cardWidth,
                  height: cardHeight,
                  margin: { left: mobile ? 6 : S(6), right: mobile ? 6 : S(6) },
                  padding: mobile ? 8 : S(8),
                  borderRadius: mobile ? 14 : S(14),
                  borderWidth: canBuy ? (mobile ? 2 : S(2)) : 0,
                  borderColor: canBuy ? BRIGHT_WHITE : Color4.Clear(),
                  justifyContent: 'flex-start',
                  alignItems: 'center',
                  flexDirection: 'column',
                }}
                uiBackground={{ color: bgColor }}
                onMouseDown={() => {
                  if (owned) {
                    requestEquipBoomerang(item.id)
                  } else if (canBuy && !pending) {
                    requestBuyBoomerang(item.id)
                  }
                }}
              >
                <UiEntity
                  uiTransform={{ width: mobile ? 76 : S(90), height: mobile ? 76 : S(90), margin: { top: mobile ? 6 : S(8) } }}
                  uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${item.id}.png` }, color: owned ? Color4.White() : Color4.create(0.4, 0.4, 0.4, 1) }}
                />
                <Label value={item.label} fontSize={mobile ? 18 : S(16)} color={selected ? GOLD : owned ? LIGHT_GREY : GREY} uiTransform={{ margin: { top: mobile ? 4 : S(6) } }} />

                {owned ? (
                  <Label
                    value={selected ? 'Equipped' : 'Equip'}
                    fontSize={mobile ? 14 : S(13)}
                    color={selected ? GOLD : LIGHT_GREY}
                    uiTransform={{ margin: { top: mobile ? 6 : S(6) } }}
                  />
                ) : (
                  <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', margin: { top: mobile ? 4 : S(4) } }}>
                    {item.coinCost > 0 && (
                      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: mobile ? 3 : S(3) } }}>
                        <UiEntity uiTransform={{ width: mobile ? 14 : S(14), height: mobile ? 14 : S(14), margin: { right: mobile ? 4 : S(3) } }}
                          uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: canAfford ? Color4.White() : Color4.create(0.5, 0.5, 0.5, 1) }} />
                        <Label value={`${item.coinCost}`} fontSize={mobile ? 14 : S(13)} color={canAfford ? GOLD : RED_DIM} />
                      </UiEntity>
                    )}
                    {item.flagsRequired > 0 && (
                      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: mobile ? 3 : S(3) } }}>
                        <UiEntity uiTransform={{ width: mobile ? 13 : S(12), height: mobile ? 13 : S(12), margin: { right: mobile ? 3 : S(3) } }}
                          uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: hasFlags ? GOLD : Color4.create(0.5, 0.5, 0.5, 1) }} />
                        <Label value={`${Math.min(lifetimeWins, item.flagsRequired)}/${item.flagsRequired}`} fontSize={mobile ? 13 : S(12)} color={hasFlags ? GOLD : RED_DIM} />
                      </UiEntity>
                    )}
                    {canBuy && (
                      <Label
                        value={pending ? '...' : 'Buy'}
                        fontSize={mobile ? 15 : S(13)}
                        color={pending ? GREY : BRIGHT_WHITE}
                        uiTransform={{ margin: { top: mobile ? 2 : S(2) } }}
                      />
                    )}
                    {locked && !canBuy && (
                      <UiEntity uiTransform={{ width: mobile ? 18 : S(18), height: mobile ? 18 : S(18), margin: { top: mobile ? 2 : S(2) } }}
                        uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/lock.png' }, color: GREY }} />
                    )}
                  </UiEntity>
                )}
              </UiEntity>
            )
          })}
        </UiEntity>

        {buyError ? (
          <Label value={buyError} fontSize={mobile ? 15 : S(13)} color={CORAL_RED} uiTransform={{ margin: { top: mobile ? 10 : S(10) } }} />
        ) : null}
      </UiEntity>
    </UiEntity>
  )
}
