/**
 * StatusPopup — Simple popup showing the player's status (inventory, equipment, etc.)
 * Opened via the flag icon button on desktop, or the flag circle on mobile.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import {
  S, WHITE, GREY, GOLD, CLOSE_GREY, PANEL_BG,
} from '../uiConstants'
import { hover, notifyOverlayClosed, earnedState } from '../uiState'
import { setLeaderboardOverlayVisible } from '../../gameState/overlayState'
import { playClickSound } from '../uiSounds'
import { getCoinBalance, isCoinBalanceLoaded } from '../../systems/coinPickupSystem'
import { getLocalLifetimeWins, isWinsLoaded } from '../../gameState/playerUpgradeState'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { blessingState } from '../uiState'


const CLOSE_HOVER = Color4.create(0.85, 0.85, 0.9, 1)

// ═══════════════════════════════════════════════════════════
// STATUS POPUP — lightweight, opened from menu button
// ═══════════════════════════════════════════════════════════

export function StatusPopup() {
  const coins = getCoinBalance()
  const liveWins = getLocalLifetimeWins()
  const myFlags = earnedState.winsFrozen ? (earnedState.displayedWins ?? liveWins) : liveWins
  const boomerang = getBoomerangColor()
  const boomerangLabel = boomerang === 'r' ? 'Base' : boomerang === 'y' ? 'Dubs' : boomerang === 'b' ? 'Charge' : 'Orbit'

  const SR = 40; const SI = 28; const SF = 18; const SEC = 18

  const sectionHeader = (title: string, first = false) => (
    <UiEntity uiTransform={{ width: '100%', height: S(first ? 32 : 42), flexDirection: 'row', alignItems: 'flex-end', padding: { left: S(4) } }}>
      <Label value={title} fontSize={S(SEC)} color={GOLD} font="sans-serif" textAlign="middle-left" />
    </UiEntity>
  )
  const iconRow = (label: string, value: string, iconSrc: string, valueColor: Color4 = WHITE, iconColor: Color4 = Color4.White(), iconScale: number = 1) => {
    const icoSize = Math.round(SI * iconScale)
    return (
      <UiEntity uiTransform={{ width: '100%', height: S(SR), flexDirection: 'row', alignItems: 'center', padding: { left: S(12), right: S(12) } }}>
        <Label value={label} fontSize={S(SF)} color={GREY} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(SR) }} textAlign="middle-left" />
        <Label value={value} fontSize={S(SF)} color={valueColor} font="sans-serif" uiTransform={{ height: S(SR), margin: { right: S(6) } }} textAlign="middle-right" />
        <UiEntity uiTransform={{ width: S(icoSize), height: S(icoSize) }} uiBackground={{ textureMode: 'stretch', texture: { src: iconSrc }, color: iconColor }} />
      </UiEntity>
    )
  }

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
        pointerFilter: 'none',
      }}
    >
      <UiEntity
        uiTransform={{
          width: S(480),
          flexDirection: 'column',
          alignItems: 'stretch',
          padding: S(28),
          borderRadius: S(20),
          margin: { top: S(40) },
        }}
        uiBackground={{ color: PANEL_BG }}
      >
        {/* Header with title and close button */}
        <UiEntity uiTransform={{ flexDirection: 'row', width: '100%', height: S(44), alignItems: 'center', margin: { bottom: S(10) } }}>
          <Label value="Status" fontSize={S(32)} color={GOLD} font="sans-serif" uiTransform={{ flexGrow: 1 }} />
          <UiEntity
            uiTransform={{ width: S(44), height: S(44), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: S(6) }}
            onMouseEnter={() => { hover.closeLeaderboard = true }}
            onMouseLeave={() => { hover.closeLeaderboard = false }}
            onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); hover.closeLeaderboard = false; notifyOverlayClosed() }}
          >
            <Label value="×" fontSize={S(38)} color={hover.closeLeaderboard ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
          </UiEntity>
        </UiEntity>

        {/* Content */}
        {sectionHeader('INVENTORY', true)}
        {iconRow('Coins', isCoinBalanceLoaded() ? `${coins}` : '--', 'assets/images/coin.png', GOLD, GOLD)}
        {iconRow('Flags', isWinsLoaded() ? `${myFlags}` : '--', 'assets/images/flag-icon-white.png', GOLD, GOLD)}
        <UiEntity uiTransform={{ width: '100%', height: 1, margin: { top: S(6), bottom: S(2) } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.35, 0.6) }} />
        {sectionHeader('EQUIPMENT')}
        {iconRow('Projectile', boomerangLabel, `assets/images/boomerang.${boomerang}.png`, WHITE, Color4.White(), 1.5)}
        {iconRow('Trap', 'Banana', 'assets/images/banana.png')}
        <UiEntity uiTransform={{ width: '100%', height: 1, margin: { top: S(6), bottom: S(2) } }} uiBackground={{ color: Color4.create(0.3, 0.3, 0.35, 0.6) }} />
        {sectionHeader('DAILY')}
        <UiEntity uiTransform={{ width: '100%', height: S(SR), flexDirection: 'row', alignItems: 'center', padding: { left: S(12), right: S(12) } }}>
          <Label value="Blessed Today" fontSize={S(SF)} color={GREY} font="sans-serif" uiTransform={{ flexGrow: 1, height: S(SR) }} textAlign="middle-left" />
          <Label value={blessingState.alreadyUsed ? 'Yes' : 'No'} fontSize={S(SF)} color={blessingState.alreadyUsed ? GOLD : GREY} font="sans-serif" uiTransform={{ height: S(SR) }} textAlign="middle-right" />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
