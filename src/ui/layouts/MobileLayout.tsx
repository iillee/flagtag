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
import { isServerConnected } from '../../systems/clientUtils'
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
        const T = 1.2 // top HUD scale multiplier (was 1.5, rendered too large on mobile after Foundation's virtual-screen revert 2026-07-30)
        return (
          <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 20 * T }, width: '100%', height: 68 * T, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}>
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
              <UiEntity uiTransform={{ height: 68 * T, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: { left: 28 * T, right: 28 * T }, borderRadius: 34 * T, margin: { right: 10 * T }, borderWidth: 3 * T, borderColor: Color4.create(1, 1, 1, 0.8) }}
                uiBackground={{ color: Color4.create(0, 0, 0, 0.8) }}
              >
                <Label value={formatCountdown(countdownSeconds)} fontSize={32 * T} color={countdownSeconds <= 10 ? GOLD : WHITE} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ height: 68 * T, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: { left: 18 * T, right: 30 * T }, borderRadius: 34 * T, borderWidth: 3 * T, borderColor: Color4.create(1, 1, 1, 0.8) }}
                uiBackground={{ color: Color4.create(0, 0, 0, 0.8) }}
                onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); setLeaderboardOverlayVisible(false); mobileState.scoreboardVisible = !mobileState.scoreboardVisible }}
              >
                <UiEntity uiTransform={{ width: 34 * T, height: 34 * T, margin: { right: 8 * T } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/expand.png' }, color: Color4.White() }} />
                <Label value="Score:" fontSize={32 * T} color={scoreColor} font="sans-serif" />
                <UiEntity uiTransform={{ width: 6 * T }} />
                <Label value={`${myScore}`} fontSize={32 * T} color={scoreColor} font="sans-serif" uiTransform={{ minWidth: 40 * T }} />
                {hasFlag && <UiEntity uiTransform={{ width: 22 * T, height: 22 * T, margin: { left: 6 * T } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />}
              </UiEntity>
              <UiEntity uiTransform={{ width: M_CIRCLE_SIZE * T, height: M_CIRCLE_SIZE * T, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { left: 10 * T } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
                onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); mobileState.scoreboardVisible = false; toggleWinConditionOverlay(); notifyOverlayClosed() }}
              >
                <Label value="?" fontSize={36 * T} color={winConditionVisible ? GOLD : WHITE} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: M_CIRCLE_SIZE * T, height: M_CIRCLE_SIZE * T, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { left: 6 * T } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
                onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); mobileState.scoreboardVisible = false; toggleLeaderboardOverlay(); notifyOverlayClosed() }}
              >
                <UiEntity uiTransform={{ width: 52 * T, height: 52 * T }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/backpack.png' }, color: leaderboardVisible ? GOLD : WHITE }} />
              </UiEntity>
            </UiEntity>
          </UiEntity>
        )
      })()}

      {/* Mobile Ability Bar */}
      {!spectatorState.active && (() => {
        // Ability bar scaled by 0.8 alongside top HUD (2026-07-30 mobile pass)
        const AB_SIZE = M_CIRCLE_SIZE * 2.142
        const AB_ICON = 50 * 2.142
        return (
          <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: 350, right: 160 }, flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end' }}>
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
              {/* Match banana structure exactly: no negative margin, no inner
                 handlers, no pointerFilter. Previous margin:{top:-8} pushed the
                 icon 8px above the button bounds and broke hit-testing on the
                 icon region (only a small strip below the icon was clickable
                 — the classic 'children outside parent don't bubble' SDK quirk). */}
              {isServerConnected() && (
                <UiEntity uiTransform={{ width: (AB_ICON - 8) * 1.134, height: (AB_ICON - 8) * 1.134 }}
                  uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` }, color: isProjectileOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White() }} />
              )}
              {isServerConnected() && isProjectileOnCooldown() && getProjectileCooldownRemaining() > 0 && <Label value={`${getProjectileCooldownRemaining()}`} fontSize={78} color={WHITE} font="sans-serif" uiTransform={{ positionType: 'absolute', pointerFilter: 'none' }} />}
            </UiEntity>
            <UiEntity uiTransform={{ width: AB_SIZE, height: AB_SIZE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { bottom: 0 } }}
              uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
              onMouseDown={() => { playClickSound(); triggerTrapFromUI() }}
            >
              {isServerConnected() && (
                <UiEntity uiTransform={{ width: Math.round(AB_ICON * 1.25 * 0.675 * 1.1), height: Math.round(AB_ICON * 1.25 * 0.675 * 1.1) }}
                  uiBackground={{ textureMode: 'stretch', texture: { src: getLocalUpgrades().equippedTrap === 'bomb' ? 'assets/images/bomb.png' : 'assets/images/banana.png' }, color: isTrapOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White() }} />
              )}
              {isServerConnected() && isTrapOnCooldown() && <Label value={`${getTrapCooldownRemaining()}`} fontSize={78} color={WHITE} font="sans-serif" uiTransform={{ positionType: 'absolute' }} />}
            </UiEntity>
          </UiEntity>
        )
      })()}

      {/* Mobile Scoreboard Overlay */}
      {mobileState.scoreboardVisible && (() => { const M = 1.6; return (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
          onMouseDown={() => { playClickSound(); mobileState.scoreboardVisible = false; notifyOverlayClosed() }}
          >
          <UiEntity uiTransform={{ positionType: 'relative', width: '46%', height: '62%', flexDirection: 'column', alignItems: 'stretch', padding: 22 * M, overflow: 'hidden', borderRadius: 40 }}
            uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 8, right: 8 }, width: 52 * M, height: 52 * M, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
              onMouseDown={() => { playClickSound(); mobileState.scoreboardVisible = false; notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={52 * M} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <UiEntity uiTransform={{ height: 52 * M, flexShrink: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
              <Label value="Scoreboard" fontSize={32 * M} color={GOLD} font="sans-serif" textAlign="middle-center" />
            </UiEntity>
            <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column' }}>
              {players.length === 0 ? (
                <UiEntity uiTransform={{ height: 88, justifyContent: 'center', alignItems: 'center' }}>
                  <Label value="Waiting for players..." fontSize={16 * M} color={MUTED} font="sans-serif" />
                </UiEntity>
              ) : players.map((p, i) => {
                const isPlayerLeader = leaderUserId !== null && p.userId === leaderUserId
                const isSelf = localUserId !== null && p.userId === localUserId
                const isCarrier = carrierUserId !== null && p.userId === carrierUserId
                return (
                  <UiEntity key={`m-sb-${p.userId}-${i}`} uiTransform={{ height: 44 * M, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: { left: 8 * M, right: 8 * M, top: 2 * M, bottom: 2 * M } }}
                    uiBackground={{ color: isPlayerLeader ? Color4.create(0.3, 0.25, 0.1, 0.3) : Color4.create(0, 0, 0, 0) }}
                  >
                    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                      {isCarrier && <UiEntity uiTransform={{ width: 16 * M, height: 16 * M, margin: { right: 4 * M } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />}
                      <Label value={p.name} fontSize={16 * M} color={isPlayerLeader ? BRIGHT_GOLD : isSelf ? BRIGHT_WHITE : LIGHT_GREY} font="sans-serif" />
                    </UiEntity>
                    <Label value={`${p.seconds}`} fontSize={16 * M} color={isPlayerLeader ? GOLD : p.seconds > 0 ? WHITE : MUTED} font="sans-serif" />
                  </UiEntity>
                )
              })}
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )})()}

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

  const M = 1.6 // match HowToPlay mobile scale (scaled 2 -> 1.6 in mobile pass 2026-07-30)
  const iconRow = (label: string, value: string, iconSrc: string, valueColor: Color4 = WHITE, iconColor: Color4 = Color4.White(), iconScale: number = 1) => {
    const icoSize = Math.round(30 * iconScale * M)
    const rowH = 48 * M
    return (
      <UiEntity uiTransform={{ width: '100%', height: rowH, flexDirection: 'row', alignItems: 'center', padding: { left: 12 * M, right: 12 * M } }}>
        <Label value={label} fontSize={16 * M} color={GREY} font="sans-serif" uiTransform={{ flexGrow: 1, height: rowH }} textAlign="middle-left" />
        <Label value={value} fontSize={16 * M} color={valueColor} font="sans-serif" uiTransform={{ height: rowH, margin: { right: 6 * M } }} textAlign="middle-right" />
        <UiEntity uiTransform={{ width: icoSize, height: icoSize }} uiBackground={{ textureMode: 'stretch', texture: { src: iconSrc }, color: iconColor }} />
      </UiEntity>
    )
  }

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
      onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); notifyOverlayClosed() }}
      >
      <UiEntity uiTransform={{ width: '24%', height: 600, flexDirection: 'column', alignItems: 'stretch', padding: 22 * M, borderRadius: 40, margin: { top: 50 } }}
        uiBackground={{ color: PANEL_BG }}
      >
        <UiEntity uiTransform={{ flexDirection: 'row', width: '100%', height: 52 * M, alignItems: 'center', justifyContent: 'center', margin: { bottom: 10 * M } }}>
          <Label value="Status" fontSize={32 * M} color={GOLD} font="sans-serif" textAlign="middle-center" />
          <UiEntity uiTransform={{ positionType: 'absolute', position: { top: -50, right: -35 }, width: 52 * M, height: 52 * M, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
            onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); notifyOverlayClosed() }}
          >
            <Label value="×" fontSize={52 * M} color={CLOSE_GREY} font="sans-serif" />
          </UiEntity>
        </UiEntity>
        <UiEntity uiTransform={{ height: 24 * M, flexShrink: 0 }} />
        <Label value="INVENTORY" fontSize={16 * M} color={GOLD} font="sans-serif" uiTransform={{ padding: { left: 4 * M, top: 4 * M } }} textAlign="middle-left" />
        {iconRow('Coins', isCoinBalanceLoaded() ? `${coins}` : '--', 'assets/images/coin.png', GOLD, GOLD)}
        {iconRow('Flags', isWinsLoaded() ? `${myFlags}` : '--', 'assets/images/flag-icon-white.png', GOLD, GOLD)}
        <Label value="EQUIPMENT" fontSize={16 * M} color={GOLD} font="sans-serif" uiTransform={{ padding: { left: 4 * M, top: 14 * M } }} textAlign="middle-left" />
        {iconRow('Projectile', boomerangLabel, `assets/images/boomerang.${boomerang}.png`, WHITE, Color4.White(), 1.5)}
        {iconRow('Trap', getLocalUpgrades().equippedTrap === 'bomb' ? 'Bomb' : 'Banana', getLocalUpgrades().equippedTrap === 'bomb' ? 'assets/images/bomb.png' : 'assets/images/banana.png')}
      </UiEntity>
    </UiEntity>
  )
}
