import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { getPlayer } from '@dcl/sdk/players'
import { isNightTime } from '../../shared/dayNight'

import {
  WHITE, BRIGHT_WHITE, BRIGHT_GOLD, MUTED, LIGHT_GREY, GREY, CLOSE_GREY, GOLD,
  PANEL_BG,
  formatCountdown,
} from '../uiConstants'
import { playClickSound } from '../uiSounds'
import {
  notifyOverlayClosed,
  scroll,
  mobileState,

  earnedState,
  blessingState,
} from '../uiState'
import {
  getWinConditionOverlayVisible, setWinConditionOverlayVisible, toggleWinConditionOverlay,
  getLeaderboardOverlayVisible, setLeaderboardOverlayVisible, toggleLeaderboardOverlay,

} from '../../gameState/overlayState'
import { getPlayersWithHoldTimes, getCurrentFlagCarrierUserId, getCinematicSnapshot } from '../../gameState/flagHoldTime'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { getCoinBalance, isCoinBalanceLoaded } from '../../systems/coinPickupSystem'
import { getLocalLifetimeWins, isWinsLoaded, getLocalUpgrades } from '../../gameState/playerUpgradeState'
import { getCountdownSeconds } from '../../shared/components'
import { isTrapOnCooldown, getTrapCooldownRemaining, triggerTrapFromUI } from '../../systems/trapSystem'
import { isProjectileOnCooldown, getProjectileCooldownRemaining, triggerProjectileFromUI, triggerProjectileReleaseFromUI, getChargeFraction } from '../../systems/projectile'
import { spectatorState } from '../../shared/clientState'

import { HowToPlayOverlay } from '../screens/HowToPlay'
import { RoundEndSplash } from '../screens/RoundEndSplash'

export function MobileLayout() {
  const players = getCinematicSnapshot() ?? getPlayersWithHoldTimes()
  const localUserId = getPlayer()?.userId ?? null
  const leaderUserId = players.length > 0 && players[0].seconds > 0 ? players[0].userId : null
  const carrierUserId = getCurrentFlagCarrierUserId()
  const countdownSeconds = getCountdownSeconds()
  const winConditionVisible = getWinConditionOverlayVisible()
  const leaderboardVisible = getLeaderboardOverlayVisible()
  // Leaderboard entries computed lazily inside the overlay conditional below

  const M_CIRCLE_SIZE = 68
  const M_CIRCLE_TEXTURE = 'assets/images/UI_circle.png'
  const M_CIRCLE_OPACITY = Color4.create(1, 1, 1, 0.8)

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'relative', pointerFilter: 'none' }}>
      {/* Top bar */}
      {(() => {
        const localPlayer = players.find(p => localUserId !== null && p.userId === localUserId)
        const myScore = localPlayer ? localPlayer.seconds : 0
        const isLeader = localPlayer && leaderUserId !== null && localPlayer.userId === leaderUserId
        const hasFlag = localPlayer && carrierUserId !== null && localPlayer.userId === carrierUserId
        const scoreColor = isLeader ? GOLD : WHITE
        return (
          <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 28 }, width: '100%', height: 68, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}>
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
              <UiEntity uiTransform={{ height: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: { left: 28, right: 28 }, borderRadius: 34, margin: { right: 10 }, borderWidth: 3, borderColor: Color4.create(1, 1, 1, 0.8) }}
                uiBackground={{ color: Color4.create(0, 0, 0, 0.8) }}
              >
                <Label value={formatCountdown(countdownSeconds)} fontSize={32} color={countdownSeconds <= 10 ? GOLD : WHITE} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ height: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: { left: 18, right: 30 }, borderRadius: 34, borderWidth: 3, borderColor: Color4.create(1, 1, 1, 0.8) }}
                uiBackground={{ color: Color4.create(0, 0, 0, 0.8) }}
                onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); setLeaderboardOverlayVisible(false); mobileState.scoreboardVisible = !mobileState.scoreboardVisible }}
              >
                <UiEntity uiTransform={{ width: 34, height: 34, margin: { right: 8 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/expand.png' }, color: Color4.White() }} />
                <Label value="Score:" fontSize={32} color={scoreColor} font="sans-serif" />
                <UiEntity uiTransform={{ width: 6 }} />
                <Label value={`${myScore}`} fontSize={32} color={scoreColor} font="sans-serif" uiTransform={{ minWidth: 40 }} />
                {hasFlag && <UiEntity uiTransform={{ width: 22, height: 22, margin: { left: 6 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />}
              </UiEntity>
              <UiEntity uiTransform={{ width: M_CIRCLE_SIZE, height: M_CIRCLE_SIZE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { left: 10 } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
                onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); mobileState.scoreboardVisible = false; toggleWinConditionOverlay(); notifyOverlayClosed() }}
              >
                <Label value="?" fontSize={36} color={winConditionVisible ? GOLD : WHITE} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: M_CIRCLE_SIZE, height: M_CIRCLE_SIZE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { left: 6 } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
                onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); mobileState.scoreboardVisible = false; toggleLeaderboardOverlay(); notifyOverlayClosed() }}
              >
                <UiEntity uiTransform={{ width: 52, height: 52 }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/backpack.png' }, color: leaderboardVisible ? GOLD : WHITE }} />
              </UiEntity>
            </UiEntity>
          </UiEntity>
        )
      })()}

      {/* Mobile Ability Bar */}
      {!spectatorState.active && (() => {
        const AB_SIZE = Math.round(M_CIRCLE_SIZE * 1.815)
        const AB_ICON = Math.round(50 * 1.815)
        return (
          <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: 300, right: 65 }, flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end' }}>
            <UiEntity uiTransform={{ width: AB_SIZE, height: AB_SIZE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { bottom: 16 } }}
              uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
              onMouseDown={() => { playClickSound(); triggerProjectileFromUI() }}
              onMouseUp={() => { triggerProjectileReleaseFromUI() }}
            >
              {/* Blue charge circle glow — over black bg, under boomerang icon */}
              {getBoomerangColor() === 'b' && getChargeFraction() > 0 && (() => {
                const cf = getChargeFraction()
                const peak = cf > 0.75
                const r = 1
                const g = peak ? 0.84 : 1
                const b = peak ? 0 : 1
                const a = 0.15 + cf * 0.5
                return (
                  <UiEntity uiTransform={{ positionType: 'absolute', width: AB_SIZE, height: AB_SIZE, pointerFilter: 'none' }}
                    uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/UI_circle_filled.png' }, color: Color4.create(r, g, b, a) }} />
                )
              })()}
              <UiEntity uiTransform={{ width: (AB_ICON - 8) * 1.4175, height: (AB_ICON - 8) * 1.4175, margin: { top: -8 }, pointerFilter: 'none' }}
                uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` }, color: isProjectileOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White() }} />
              {isProjectileOnCooldown() && getProjectileCooldownRemaining() > 0 && <Label value={`${getProjectileCooldownRemaining()}`} fontSize={52} color={WHITE} font="sans-serif" uiTransform={{ positionType: 'absolute', pointerFilter: 'none' }} />}
            </UiEntity>
            <UiEntity uiTransform={{ width: AB_SIZE, height: AB_SIZE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { bottom: 0 } }}
              uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
              onMouseDown={() => { playClickSound(); triggerTrapFromUI() }}
            >
              <UiEntity uiTransform={{ width: Math.round(AB_ICON * 1.25 * 0.675 * 1.1), height: Math.round(AB_ICON * 1.25 * 0.675 * 1.1) }}
                uiBackground={{ textureMode: 'stretch', texture: { src: getLocalUpgrades().equippedTrap === 'bomb' ? 'assets/images/bomb.png' : 'assets/images/banana.png' }, color: isTrapOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White() }} />
              {isTrapOnCooldown() && <Label value={`${getTrapCooldownRemaining()}`} fontSize={52} color={WHITE} font="sans-serif" uiTransform={{ positionType: 'absolute' }} />}
            </UiEntity>
          </UiEntity>
        )
      })()}

      {/* Mobile Scoreboard Overlay */}
      {mobileState.scoreboardVisible && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}
          >
          <UiEntity uiTransform={{ positionType: 'relative', width: '46%', height: '62%', flexDirection: 'column', alignItems: 'stretch', padding: 28, overflow: 'hidden', borderRadius: 20 }}
            uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 4, right: 4 }, width: 88, height: 88, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
              onMouseDown={() => { playClickSound(); mobileState.scoreboardVisible = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={52} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <UiEntity uiTransform={{ height: 48, flexShrink: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <Label value="Scoreboard" fontSize={38} color={MUTED} font="sans-serif" />
            </UiEntity>
            <UiEntity uiTransform={{ height: 12, flexShrink: 0 }} />
            <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column' }}>
              {players.length === 0 ? (
                <UiEntity uiTransform={{ height: 88, justifyContent: 'center', alignItems: 'center' }}>
                  <Label value="Waiting for players..." fontSize={22} color={MUTED} font="sans-serif" />
                </UiEntity>
              ) : players.map((p, i) => {
                const isPlayerLeader = leaderUserId !== null && p.userId === leaderUserId
                const isSelf = localUserId !== null && p.userId === localUserId
                const isCarrier = carrierUserId !== null && p.userId === carrierUserId
                return (
                  <UiEntity key={`m-sb-${p.userId}-${i}`} uiTransform={{ height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: { left: 8, right: 8, top: 2, bottom: 2 } }}
                    uiBackground={{ color: isPlayerLeader ? Color4.create(0.3, 0.25, 0.1, 0.3) : Color4.create(0, 0, 0, 0) }}
                  >
                    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                      {isCarrier && <UiEntity uiTransform={{ width: 16, height: 16, margin: { right: 4 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />}
                      <Label value={p.name} fontSize={22} color={isPlayerLeader ? BRIGHT_GOLD : isSelf ? BRIGHT_WHITE : LIGHT_GREY} font="sans-serif" />
                    </UiEntity>
                    <Label value={`${p.seconds}`} fontSize={22} color={isPlayerLeader ? GOLD : p.seconds > 0 ? WHITE : MUTED} font="sans-serif" />
                  </UiEntity>
                )
              })}
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}

      <RoundEndSplash />
      {winConditionVisible && <HowToPlayOverlay />}

      {/* Mobile Status Popup */}
      {leaderboardVisible && <MobileStatusPopup />}
    </UiEntity>
  )
}

function MobileStatusPopup() {
  const localPlayer = getPlayer()
  const localName = localPlayer?.name ?? 'Unknown'
  const coins = getCoinBalance()
  const liveWins = getLocalLifetimeWins()
  const myFlags = earnedState.winsFrozen ? (earnedState.displayedWins ?? liveWins) : liveWins
  const boomerang = getBoomerangColor()
  const boomerangLabel = boomerang === 'r' ? 'Base' : boomerang === 'y' ? 'Dubs' : boomerang === 'b' ? 'Charge' : 'Orbit'

  const iconRow = (label: string, value: string, iconSrc: string, valueColor: Color4 = WHITE, iconColor: Color4 = Color4.White(), iconScale: number = 1) => {
    const icoSize = Math.round(30 * iconScale)
    return (
      <UiEntity uiTransform={{ width: '100%', height: 48, flexDirection: 'row', alignItems: 'center', padding: { left: 12, right: 12 } }}>
        <Label value={label} fontSize={22} color={GREY} font="sans-serif" uiTransform={{ flexGrow: 1, height: 48 }} textAlign="middle-left" />
        <Label value={value} fontSize={22} color={valueColor} font="sans-serif" uiTransform={{ height: 48, margin: { right: 6 } }} textAlign="middle-right" />
        <UiEntity uiTransform={{ width: icoSize, height: icoSize }} uiBackground={{ textureMode: 'stretch', texture: { src: iconSrc }, color: iconColor }} />
      </UiEntity>
    )
  }

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}
      >
      <UiEntity uiTransform={{ width: '30%', flexDirection: 'column', alignItems: 'stretch', padding: 22, borderRadius: 20, margin: { top: 80 } }}
        uiBackground={{ color: PANEL_BG }}
      >
        <UiEntity uiTransform={{ flexDirection: 'row', width: '100%', height: 52, alignItems: 'center', margin: { bottom: 10 } }}>
          <Label value="Status" fontSize={38} color={GOLD} font="sans-serif" uiTransform={{ flexGrow: 1 }} />
          <UiEntity uiTransform={{ width: 52, height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
            onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); notifyOverlayClosed() }}
          >
            <Label value="×" fontSize={52} color={CLOSE_GREY} font="sans-serif" />
          </UiEntity>
        </UiEntity>
        <Label value="INVENTORY" fontSize={20} color={GOLD} font="sans-serif" uiTransform={{ padding: { left: 4, top: 4 } }} textAlign="middle-left" />
        {iconRow('Coins', isCoinBalanceLoaded() ? `${coins}` : '--', 'assets/images/coin.png', GOLD, GOLD)}
        {iconRow('Flags', isWinsLoaded() ? `${myFlags}` : '--', 'assets/images/flag-icon-white.png', GOLD, GOLD)}
        <Label value="EQUIPMENT" fontSize={20} color={GOLD} font="sans-serif" uiTransform={{ padding: { left: 4, top: 14 } }} textAlign="middle-left" />
        {iconRow('Projectile', boomerangLabel, `assets/images/boomerang.${boomerang}.png`, WHITE, Color4.White(), 1.5)}
        {iconRow('Trap', getLocalUpgrades().equippedTrap === 'bomb' ? 'Bomb' : 'Banana', getLocalUpgrades().equippedTrap === 'bomb' ? 'assets/images/bomb.png' : 'assets/images/banana.png')}
        <Label value="DAILY" fontSize={20} color={GOLD} font="sans-serif" uiTransform={{ padding: { left: 4, top: 14 } }} textAlign="middle-left" />
        <UiEntity uiTransform={{ width: '100%', height: 48, flexDirection: 'row', alignItems: 'center', padding: { left: 12, right: 12 } }}>
          <Label value="Blessed Today" fontSize={22} color={GREY} font="sans-serif" uiTransform={{ flexGrow: 1, height: 48 }} textAlign="middle-left" />
          <Label value={blessingState.alreadyUsed ? 'Yes' : 'No'} fontSize={22} color={blessingState.alreadyUsed ? GOLD : GREY} font="sans-serif" uiTransform={{ height: 48 }} textAlign="middle-right" />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
