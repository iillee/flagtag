/**
 * StatusPopup — Simple popup showing the player's status (inventory, equipment, etc.)
 * Opened via the flag icon button on desktop, or the flag circle on mobile.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import {
  S, WHITE, GREY, GOLD, CLOSE_GREY,
} from '../uiConstants'
import { hover, notifyOverlayClosed, isWinsFrozen, getDisplayedWins } from '../uiState'
import { setLeaderboardOverlayVisible } from '../../gameState/overlayState'
import { getCoinBalance, isCoinBalanceLoaded } from '../../systems/coinPickupSystem'
import { getLocalLifetimeWins, isWinsLoaded } from '../../gameState/playerUpgradeState'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { isBlessingAlreadyUsed } from '../uiState'

const CLOSE_HOVER = Color4.create(0.85, 0.85, 0.9, 1)
const PANEL_BG = Color4.create(0.1, 0.1, 0.1, 1)

export function StatusPopup() {
  const localPlayer = getPlayer()
  const localName = localPlayer?.name ?? 'Unknown'
  const coins = getCoinBalance()
  const liveWins = getLocalLifetimeWins()
  const myFlags = isWinsFrozen() ? (getDisplayedWins() ?? liveWins) : liveWins
  const boomerang = getBoomerangColor()
  const boomerangLabel = boomerang === 'r' ? 'Base' : boomerang === 'y' ? 'Dubs' : boomerang === 'b' ? 'Charge' : 'Orbit'

  const SR = 34; const SI = 24; const SF = 16; const SEC = 16

  const sectionHeader = (title: string, first = false) => (
    <UiEntity uiTransform={{ width: '100%', height: S(first ? 28 : 36), flexDirection: 'row', alignItems: 'flex-end', padding: { left: S(10) } }}>
      <Label value={title} fontSize={S(SEC)} color={GOLD} font="sans-serif" />
    </UiEntity>
  )
  const iconRow = (label: string, value: string, iconSrc: string, valueColor: Color4 = WHITE, iconColor: Color4 = Color4.White()) => (
    <UiEntity uiTransform={{ width: '100%', height: S(SR), flexDirection: 'row', alignItems: 'center', padding: { left: S(10), right: S(10) } }}>
      <Label value={label} fontSize={S(SF)} color={GREY} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(SR) }} textAlign="middle-left" />
      <Label value={value} fontSize={S(SF)} color={valueColor} font="sans-serif" uiTransform={{ height: S(SR), margin: { right: S(6) } }} textAlign="middle-right" />
      <UiEntity uiTransform={{ width: S(SI), height: S(SI) }} uiBackground={{ textureMode: 'stretch', texture: { src: iconSrc }, color: iconColor }} />
    </UiEntity>
  )

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { left: S(0), top: S(0) },
        width: '100%',
        height: '100%',
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <UiEntity
        uiTransform={{
          width: S(380),
          flexDirection: 'column',
          alignItems: 'stretch',
          padding: S(24),
          borderRadius: S(16),
        }}
        uiBackground={{ color: PANEL_BG }}
      >
        {/* Header with title and close button */}
        <UiEntity uiTransform={{ flexDirection: 'row', width: '100%', height: S(40), alignItems: 'center', margin: { bottom: S(8) } }}>
          <Label value="Status" fontSize={S(28)} color={GOLD} font="sans-serif" uiTransform={{ flexGrow: 1 }} />
          <UiEntity
            uiTransform={{ width: S(40), height: S(40), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: S(6) }}
            onMouseEnter={() => { hover.closeLeaderboard = true }}
            onMouseLeave={() => { hover.closeLeaderboard = false }}
            onMouseDown={() => { setLeaderboardOverlayVisible(false); hover.closeLeaderboard = false; notifyOverlayClosed() }}
          >
            <Label value="×" fontSize={S(38)} color={hover.closeLeaderboard ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
          </UiEntity>
        </UiEntity>

        {/* Player name */}
        <UiEntity uiTransform={{ width: '100%', padding: { left: S(10), right: S(10), bottom: S(2) } }}>
          <Label value={localName} fontSize={S(20)} color={WHITE} font="sans-serif" />
        </UiEntity>

        {/* Content */}
        {sectionHeader('INVENTORY', true)}
        {iconRow('Coins', isCoinBalanceLoaded() ? `${coins}` : '--', 'assets/images/coin.png', GOLD, GOLD)}
        {iconRow('Flags', isWinsLoaded() ? `${myFlags}` : '--', 'assets/images/flag-icon-white.png', GOLD, GOLD)}
        {sectionHeader('DAILY')}
        {iconRow('Blessed Today', isBlessingAlreadyUsed() ? 'Yes' : 'No', 'assets/images/coin.png', isBlessingAlreadyUsed() ? GOLD : GREY)}
        {sectionHeader('EQUIPMENT')}
        {iconRow('Projectile', boomerangLabel, `assets/images/boomerang.${boomerang}.png`)}
        {iconRow('Trap', 'Banana', 'assets/images/banana.png')}
      </UiEntity>
    </UiEntity>
  )
}
