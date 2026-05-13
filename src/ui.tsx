/**
 * ui.tsx — Root UI renderer and layout orchestration.
 *
 * This file is the thin shell that composes screens, overlays, and HUD elements.
 * All reusable components live in src/ui/components/.
 * All screen/overlay content lives in src/ui/screens/.
 * All state lives in src/ui/uiState.ts.
 * All ECS systems live in src/ui/uiSystems.ts.
 */
import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { getPlayer } from '@dcl/sdk/players'
import { executeTask } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { signedFetch } from '~system/SignedFetch'

// State & infrastructure
import { playClickSound, playHoverSound } from './ui/uiSounds'
import { registerUiSystems } from './ui/uiSystems'
import {
  S, WHITE, BRIGHT_WHITE, BRIGHT_GOLD, MUTED, LIGHT_GREY, GREY, CLOSE_GREY,
  GOLD, SILVER, BRONZE, CORAL_RED,
  PANEL_BG, PANEL_BG_SEMI,
  getUIScaleLabel, getServerConnectionStatus,
  formatCountdown, sortVisitorsWithBotSection, getSortedLeaderboardEntries,
  _PANEL_WIDTH, _ROW_HEIGHT, _ROW_FONT, _PADDING, _BORDER_RADIUS,
  _ABILITY_BTN_SIZE, _ABILITY_ICON_SIZE,
  type VisitorOrSeparator,
} from './ui/uiConstants'
import {
  // Music
  isMusicMuted,
  // Cinematic
  getCinematicFadeOpacity, setCinematicFade,
  isTitleSplashVisible, setTitleSplashVisible,
  getCinematicShowing, setCinematicShowing,
  // Credits
  isNextRoundStartingVisible, setNextRoundStartingVisible,
  isNoScorersCreditsVisible, setNoScorersCreditsVisible,
  getCreditsCountdown, setCreditsCountdown,
  getCreditLineIndex, CREDIT_LINES,
  // Earned UI
  getActiveRoundEarnings, getEarnedUiPhase, getEarnedCoinsFlyProgress,
  // Overlay
  notifyOverlayClosed, isAnyOverlayOpen,
  registerOverlayChecks,
  // Popups
  isChestPopupVisible, showChestPopup, hideChestPopup,
  isMailboxPopupVisible, showMailboxPopup, hideMailboxPopup,
  isGravestonePopupVisible, showGravestonePopup, hideGravestonePopup,
  getMailboxStatus, setMailboxStatus,
  // Metrics
  isMetricsOpenedFromTerminal, setMetricsOpenedFromTerminal,
  // Splash
  isSplashVisible,
  // Server down
  isServerDownVisible, setServerDownVisible, setServerDownDismissedAt,
  // Hover
  hover,
  // Scroll/tabs
  scroll, tabs,
  // UI Scale
  getUIScaleFlash,
  // Mobile
  isMobileScoreboardVisible, setMobileScoreboardVisible,
  // Misc
  isSpectatorExitBlink, setSpectatorExitBlink,
  isWinsFrozen, getDisplayedWins, setDisplayedWins,
  // Admin
  COMMUNITY_ID,
} from './ui/uiState'

// Overlay visibility state
import { getWinConditionOverlayVisible, toggleWinConditionOverlay, setWinConditionOverlayVisible } from './components/winConditionOverlayState'
import { getLeaderboardOverlayVisible, toggleLeaderboardOverlay, setLeaderboardOverlayVisible } from './components/leaderboardOverlayState'
import { getAnalyticsOverlayVisible, setAnalyticsOverlayVisible } from './components/analyticsOverlayState'

// Game state
import { getPlayersWithHoldTimes, getCurrentFlagCarrierUserId } from './gameState/flagHoldTime'
import { getBoomerangColor } from './gameState/boomerangColor'
import { getAllVisitors, getTodayVisitorCount, getCurrentOnlineCount } from './gameState/sceneTime'
import { getLeaderboardEntries, getAllTimeLeaderboardEntries, getMonthlyLeaderboardEntries } from './gameState/roundsWon'
import { getCountdownSeconds } from './shared/components'
import { isCinematicActive } from './cinematicState'
import { getCoinBalance, isCoinBalanceLoaded } from './systems/coinPickupSystem'
import { getLocalLifetimeWins, isWinsLoaded, refreshUpgradesFromServer } from './gameState/playerUpgradeState'
import { isTrapOnCooldown, getTrapCooldownRemaining, triggerTrapFromUI } from './systems/trapSystem'
import { isProjectileOnCooldown, getProjectileCooldownRemaining, triggerProjectileFromUI, getChargeFraction, getIsCharging, getBurnoutFlash } from './systems/projectileSystem'
import { isSpectatorMode, isSpectatorTransitioning, exitSpectatorMode } from './systems/spectatorSystem'
import { getDrownFraction, isDrownBarVisible, getRespawnCountdown, getDrownFadeOpacity, isDrownTextVisible } from './systems/waterSystem'
import { isLightningRespawning, getLightningFadeOpacity, getLightningRespawnCountdown, isLightningTextVisible } from './systems/lightningSystem'
import { isGhostDeathRespawning, getGhostDeathFadeOpacity, getGhostDeathRespawnCountdown, isGhostDeathTextVisible, getScareFraction, isScareBarVisible } from './systems/zombieSystem'

// Reusable components
import { CloseButton } from './ui/components/CloseButton'
import { ProgressBar } from './ui/components/ProgressBar'
import { DeathOverlay } from './ui/components/DeathOverlay'
import { IconButton } from './ui/components/IconButton'

// Screens
import { HowToPlayOverlay } from './ui/screens/HowToPlay'
import { RoundEndSplash } from './ui/screens/RoundEndSplash'
import { ChestPopup } from './ui/screens/ChestPopup'
import { LeaderboardOverlay } from './ui/screens/LeaderboardOverlay'
import { AnalyticsOverlay } from './ui/screens/AnalyticsOverlay'

// ═══════════════════════════════════════════════════════════
// RE-EXPORTS — stable public API for other files
// ═══════════════════════════════════════════════════════════
export {
  setCinematicFade, setCinematicShowing, getCinematicShowing,
  setNextRoundStartingVisible, setNoScorersCreditsVisible, setCreditsCountdown,
  notifyOverlayClosed, isAnyOverlayOpen,
  showChestPopup, hideChestPopup, isChestPopupVisible,
  showMailboxPopup, hideMailboxPopup, isMailboxPopupVisible,
  showGravestonePopup, hideGravestonePopup, isGravestonePopupVisible,
}

// ═══════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════

export function setupUi() {
  registerOverlayChecks(getWinConditionOverlayVisible, getLeaderboardOverlayVisible, getAnalyticsOverlayVisible)
  registerUiSystems()
  ReactEcsRenderer.setUiRenderer(PlayerListUi)
}

// ═══════════════════════════════════════════════════════════
// METRICS PANEL (opened from Terminal in-world)
// ═══════════════════════════════════════════════════════════

export function openMetricsPanel() {
  playClickSound()
  setMetricsOpenedFromTerminal(true)
  setLeaderboardOverlayVisible(true)
  tabs.folder = 'metrics'; tabs.leaderboard = 'metrics'; tabs.metrics = 'daily'
  scroll.leaderboardOffset = 0; scroll.visitorOffset = 0
}

export function closeMetricsPanel() {
  if (isMetricsOpenedFromTerminal()) {
    playClickSound()
    setMetricsOpenedFromTerminal(false)
    setLeaderboardOverlayVisible(false)
    tabs.folder = 'leaderboards'; tabs.leaderboard = 'daily'
    notifyOverlayClosed()
  }
}

export function isMetricsPanelOpen(): boolean {
  return isMetricsOpenedFromTerminal() && getLeaderboardOverlayVisible()
}

// ═══════════════════════════════════════════════════════════
// MAILBOX ACTION
// ═══════════════════════════════════════════════════════════

function joinCommunity() {
  executeTask(async () => {
    try {
      const player = getPlayer()
      if (!player?.userId) { setMailboxStatus('Error: No player data'); return }
      setMailboxStatus('Joining...')
      const joinRes = await signedFetch({
        url: `https://social-api.decentraland.org/v1/communities/${COMMUNITY_ID}/members`,
        init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({}) }
      })
      if (joinRes.status >= 200 && joinRes.status < 300) {
        setMailboxStatus('Joined! Welcome to the community.')
      } else {
        const body = joinRes.body || ''
        if (body.includes('already') || body.includes('Already')) {
          setMailboxStatus('You are already a member!')
        } else {
          let msg = 'Error ' + joinRes.status
          try { msg = JSON.parse(body).message || JSON.parse(body).error || body } catch (_) {}
          setMailboxStatus(msg)
        }
      }
    } catch (err) {
      setMailboxStatus('Error: ' + String(err))
    }
  })
}

// ═══════════════════════════════════════════════════════════
// DROWN / SCARE BARS
// ═══════════════════════════════════════════════════════════

function DrownBar() {
  const mobile = isMobile()
  const fraction = getDrownFraction()
  const fillColor = fraction < 0.25 ? Color4.create(1, 0.3, 0.3, 0.95) : Color4.create(0.2, 0.5, 1.0, 0.95)
  return <ProgressBar fraction={fraction} fillColor={fillColor} bottomOffset={mobile ? 185 : S(110)} />
}

function ScareBar() {
  const mobile = isMobile()
  const fraction = getScareFraction()
  const fillColor = fraction > 0.75 ? Color4.create(1, 0.3, 0.3, 0.95) : Color4.create(0.55, 0.55, 0.55, 0.95)
  const bottomOffset = isDrownBarVisible() ? (mobile ? 215 : S(128)) : (mobile ? 185 : S(110))
  return <ProgressBar fraction={fraction} fillColor={fillColor} bottomOffset={bottomOffset} />
}

// ═══════════════════════════════════════════════════════════
// ROOT RENDERER
// ═══════════════════════════════════════════════════════════

function PlayerListUi() {
  const mobile = isMobile()
  const cinematicFadeOpacity = getCinematicFadeOpacity()
  const cinematicShowing = getCinematicShowing()
  const nextRoundStartingVisible = isNextRoundStartingVisible()
  const noScorersCreditsVisible = isNoScorersCreditsVisible()
  const activeRoundEarnings = getActiveRoundEarnings()
  const earnedUiPhase = getEarnedUiPhase()
  const earnedCoinsFlyProgress = getEarnedCoinsFlyProgress()
  const creditsCountdown = getCreditsCountdown()
  const creditLineIndex = getCreditLineIndex()

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'relative' }}>
      {mobile ? <MobileLayout /> : <DesktopLayout />}

      {/* Cinematic fade overlay */}
      {cinematicFadeOpacity > 0 && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
          uiBackground={{ color: Color4.create(0, 0, 0, cinematicFadeOpacity) }}
        >
          {(noScorersCreditsVisible || (nextRoundStartingVisible && !cinematicShowing)) && (
            <CreditsScreen
              activeRoundEarnings={activeRoundEarnings}
              earnedUiPhase={earnedUiPhase}
              earnedCoinsFlyProgress={earnedCoinsFlyProgress}
              creditsCountdown={creditsCountdown}
              creditLineIndex={creditLineIndex}
              mobile={mobile}
            />
          )}
        </UiEntity>
      )}

      {/* Server-down overlay */}
      {isServerDownVisible() && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
          uiBackground={{ color: Color4.create(0, 0, 0, 0.6) }}
        >
          <UiEntity uiTransform={{ width: mobile ? 400 : S(460), flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: mobile ? 20 : S(16), padding: mobile ? { top: 36, bottom: 32, left: 20, right: 20 } : { top: S(36), bottom: S(32), left: S(40), right: S(40) } }}
            uiBackground={{ color: PANEL_BG }}
          >
            <CloseButton hoverKey="closeServerDown" onClose={() => { setServerDownDismissedAt(Date.now()); setServerDownVisible(false) }} />
            <Label value="Server Disconnected" fontSize={mobile ? 36 : S(28)} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: mobile ? 12 : S(12) }} />
            <Label value="all players please leave scene\nfor 5 minutes while server resets" fontSize={mobile ? 20 : S(18)} color={LIGHT_GREY} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      )}

      {/* Mailbox popup */}
      {isMailboxPopupVisible() && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' }}>
          <UiEntity uiTransform={{ width: mobile ? 400 : S(420), flexDirection: 'column', alignItems: 'center', padding: mobile ? { top: 28, bottom: 28, left: 20, right: 20 } : { top: S(24), bottom: S(24), left: S(24), right: S(24) }, borderRadius: mobile ? 20 : S(20) }}
            uiBackground={{ color: PANEL_BG }}
          >
            <CloseButton hoverKey="closeMailbox" onClose={() => { hideMailboxPopup(); notifyOverlayClosed() }} />
            <Label value="Leave a Message" fontSize={mobile ? 36 : S(28)} color={Color4.create(0.2, 0.6, 1, 1)} font="sans-serif" uiTransform={{ margin: { bottom: mobile ? 8 : S(8) } }} />
            <Label value="Join the Flagtag community to\nleave a review or report a bug" fontSize={mobile ? 20 : S(16)} color={LIGHT_GREY} uiTransform={{ margin: { top: mobile ? 4 : S(4), bottom: mobile ? 20 : S(20) }, width: mobile ? '95%' : S(360), height: mobile ? 65 : S(50) }} textAlign="middle-center" />
            <UiEntity uiTransform={{ width: mobile ? 240 : S(240), height: mobile ? 44 : S(44), borderRadius: mobile ? 8 : S(8), justifyContent: 'center', alignItems: 'center' }}
              uiBackground={{ color: Color4.create(0.2, 0.6, 1, 1) }}
              onMouseDown={() => { playClickSound(); joinCommunity() }}
            >
              <Label value="Join Community" fontSize={mobile ? 20 : S(18)} color={Color4.White()} uiTransform={{ width: '100%', height: '100%' }} textAlign="middle-center" />
            </UiEntity>
            {getMailboxStatus() ? <Label value={getMailboxStatus()} fontSize={mobile ? 16 : S(13)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { top: mobile ? 12 : S(12) }, width: mobile ? '95%' : S(360) }} textAlign="middle-center" /> : null}
          </UiEntity>
        </UiEntity>
      )}

      {/* Gravestone popup */}
      {isGravestonePopupVisible() && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' }} onMouseDown={() => {}}>
          <UiEntity uiTransform={{ width: mobile ? 340 : S(340), flexDirection: 'column', alignItems: 'center', padding: mobile ? { top: 28, bottom: 28, left: 20, right: 20 } : { top: S(24), bottom: S(24), left: S(24), right: S(24) }, borderRadius: mobile ? 20 : S(20) }}
            uiBackground={{ color: PANEL_BG }}
          >
            <CloseButton hoverKey="closeWinCondition" onClose={() => { hideGravestonePopup(); notifyOverlayClosed() }} />
            <Label value="Here lies" fontSize={mobile ? 28 : S(24)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { top: mobile ? 8 : S(8) } }} />
            <Label value="_________" fontSize={mobile ? 32 : S(28)} color={WHITE} font="sans-serif" uiTransform={{ margin: { top: mobile ? 4 : S(4), bottom: mobile ? 8 : S(8) } }} />
          </UiEntity>
        </UiEntity>
      )}

      {/* Chest / Store popup */}
      {isChestPopupVisible() && <ChestPopup />}

      {/* Progress bars */}
      {isDrownBarVisible() && <DrownBar />}
      {isScareBarVisible() && <ScareBar />}

      {/* UI Scale toast */}
      {getUIScaleFlash() && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(140), left: '50%' }, margin: { left: S(-80) }, width: S(160), height: S(32), flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: S(8) }}
          uiBackground={{ color: PANEL_BG }}
        >
          <Label value={`UI: ${getUIScaleLabel()}`} fontSize={S(16)} color={WHITE} font="sans-serif" />
        </UiEntity>
      )}

      {/* Death overlays */}
      <DeathOverlay visible={getRespawnCountdown() > 0} message="You Drowned!" fadeOpacity={getDrownFadeOpacity()} showText={isDrownTextVisible()} respawnCountdown={getRespawnCountdown()} />
      <DeathOverlay visible={isLightningRespawning()} message="You were struck by lightning!" fadeOpacity={getLightningFadeOpacity()} showText={isLightningTextVisible()} respawnCountdown={getLightningRespawnCountdown()} />
      <DeathOverlay visible={isGhostDeathRespawning()} message="You were scared to death!" fadeOpacity={getGhostDeathFadeOpacity()} showText={isGhostDeathTextVisible()} respawnCountdown={getGhostDeathRespawnCountdown()} />

      {/* Spectator mode */}
      {isSpectatorMode() && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(20), left: 0 }, width: '100%', flexDirection: 'column', alignItems: 'center' }}>
          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', padding: mobile ? { top: 10, bottom: 10, left: 18, right: 18 } : { top: S(14), bottom: S(14), left: S(24), right: S(24) }, borderRadius: mobile ? 14 : S(18) }}
            uiBackground={{ color: Color4.create(0.1, 0.1, 0.1, 0.92) }}
          >
            <Label value="SPECTATOR MODE" fontSize={mobile ? 24 : S(28)} color={Color4.White()} />
            <Label value="WASD = Orbit  |  E/F = Up/Down" fontSize={mobile ? 12 : S(14)} color={Color4.create(1, 1, 1, 0.8)} />
            <UiEntity uiTransform={{ width: mobile ? 120 : S(160), height: mobile ? 32 : S(40), margin: { top: mobile ? 6 : S(8) }, borderRadius: mobile ? 8 : S(10) }}
              uiBackground={{ color: isSpectatorExitBlink() ? Color4.create(0.5, 0.5, 0.5, 0.9) : Color4.create(1, 1, 1, 0.9) }}
              onMouseDown={() => { playClickSound(); setSpectatorExitBlink(true); executeTask(async () => { await new Promise<void>(r => setTimeout(r, 120)); setSpectatorExitBlink(false) }); exitSpectatorMode() }}
            >
              <Label value="Exit" fontSize={mobile ? 16 : S(18)} color={Color4.Black()} uiTransform={{ width: '100%', height: '100%' }} />
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}

      {/* Title Splash */}
      {isTitleSplashVisible() && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
          onMouseDown={() => { playClickSound(); setTitleSplashVisible(false); setWinConditionOverlayVisible(true) }}
        >
          <UiEntity uiTransform={{ width: S(420), padding: { top: S(32), bottom: S(32), left: S(24), right: S(24) }, borderRadius: S(16), flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
            uiBackground={{ color: Color4.create(0.12, 0.10, 0.10, 0.95) }}
            onMouseDown={() => { playClickSound(); setTitleSplashVisible(false); setWinConditionOverlayVisible(true) }}
          >
            <Label value="FLAG TAG!" fontSize={S(56)} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: S(6) } }} />
            <Label value="A multiplayer keep away game!" fontSize={S(22)} color={MUTED} font="sans-serif" uiTransform={{ margin: { bottom: S(24) } }} />
            <Label value="Click anywhere to continue" fontSize={S(18)} color={Color4.create(1, 1, 1, 0.5)} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      )}
    </UiEntity>
  )
}

// ═══════════════════════════════════════════════════════════
// CREDITS SCREEN (round-end "You Earned" + credits)
// ═══════════════════════════════════════════════════════════

import type { RoundEarnings } from './gameState/roundEarnings'
import type { EarnedUiPhase } from './ui/uiState'

function CreditsScreen({ activeRoundEarnings, earnedUiPhase, earnedCoinsFlyProgress, creditsCountdown, creditLineIndex, mobile }: {
  activeRoundEarnings: RoundEarnings | null; earnedUiPhase: EarnedUiPhase; earnedCoinsFlyProgress: number; creditsCountdown: number; creditLineIndex: number; mobile: boolean
}) {
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, flexDirection: 'column', alignItems: 'center', width: '100%', height: '100%' }}>
      {/* No earnings fallback */}
      {!activeRoundEarnings && (
        <UiEntity uiTransform={{ positionType: 'absolute', width: '100%', position: { top: '15%' }, flexDirection: 'column', alignItems: 'center' }}>
          <UiEntity uiTransform={{ width: mobile ? 420 : S(320), padding: { top: mobile ? 28 : S(22), bottom: mobile ? 36 : S(28), left: mobile ? 24 : S(18), right: mobile ? 24 : S(18) }, flexDirection: 'column', alignItems: 'center' }}
            uiBackground={{ textureMode: 'nine-slices', texture: { src: 'assets/images/rounded-outline.png' }, textureSlices: { top: 0.25, bottom: 0.25, left: 0.25, right: 0.25 }, color: Color4.White() }}
          >
            <Label value="Round Over" fontSize={mobile ? 72 : S(46)} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: mobile ? 16 : S(12) }} />
            <Label value="No coins earned" fontSize={mobile ? 38 : S(24)} color={MUTED} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      )}

      {/* Earnings breakdown */}
      {activeRoundEarnings && (
        <UiEntity uiTransform={{ positionType: 'absolute', width: '100%', position: { top: '15%' }, flexDirection: 'column', alignItems: 'center' }}>
          <UiEntity uiTransform={{ width: mobile ? 420 : S(320), padding: { top: mobile ? 28 : S(22), bottom: mobile ? 36 : S(28), left: mobile ? 24 : S(18), right: mobile ? 24 : S(18) }, flexDirection: 'column', alignItems: 'center' }}
            uiBackground={{ textureMode: 'nine-slices', texture: { src: 'assets/images/rounded-outline.png' }, textureSlices: { top: 0.25, bottom: 0.25, left: 0.25, right: 0.25 }, color: Color4.White() }}
          >
            <Label value="You Earned" fontSize={mobile ? 72 : S(46)} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: mobile ? 24 : S(18) }} />
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
              <UiEntity uiTransform={{ width: mobile ? 56 : S(48), height: mobile ? 56 : S(48), margin: { right: mobile ? 16 : S(14) } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.White() }} />
              <Label value={`+${activeRoundEarnings.total}`} fontSize={mobile ? 96 : S(62)} color={GOLD} font="sans-serif" />
            </UiEntity>
            <UiEntity uiTransform={{ height: mobile ? 28 : S(20) }} />
            <Label value={`Participation: +${activeRoundEarnings.participation}`} fontSize={mobile ? 34 : S(21)} color={LIGHT_GREY} font="sans-serif" />
            {activeRoundEarnings.holdTime > 0 && <Label value={`Flag Hold Time: +${activeRoundEarnings.holdTime}`} fontSize={mobile ? 34 : S(21)} color={LIGHT_GREY} font="sans-serif" />}
            {activeRoundEarnings.placement > 0 && <Label value={`${activeRoundEarnings.rank === 1 ? '1st' : activeRoundEarnings.rank === 2 ? '2nd' : '3rd'} Place Bonus: +${activeRoundEarnings.placement}`} fontSize={mobile ? 34 : S(21)} color={activeRoundEarnings.rank === 1 ? GOLD : activeRoundEarnings.rank === 2 ? SILVER : BRONZE} font="sans-serif" />}
            {activeRoundEarnings.rank === 1 && <Label value="Winning: +1 Flag" fontSize={mobile ? 34 : S(21)} color={GOLD} font="sans-serif" />}
          </UiEntity>

          {/* Flying coins */}
          {(earnedUiPhase === 'coins' || earnedUiPhase === 'fly') && (() => {
            const numCoins = Math.min(activeRoundEarnings.total, 10)
            const coins = []
            for (let i = 0; i < numCoins; i++) {
              const angle = (i / numCoins) * Math.PI * 2
              const startX = Math.cos(angle) * 80
              const startY = 60 + Math.sin(angle) * 40
              const progress = Math.min(1, earnedCoinsFlyProgress * 1.5 - (i * 0.05))
              const cp = Math.max(0, Math.min(1, progress))
              const eased = 1 - Math.pow(1 - cp, 3)
              const x = startX * (1 - eased)
              const y = startY * (1 - eased) - (300 * eased)
              const opacity = cp < 0.1 ? cp * 10 : (cp > 0.85 ? (1 - cp) * 6.67 : 1)
              coins.push(
                <UiEntity key={`fly-coin-${i}`} uiTransform={{ positionType: 'absolute', position: { top: y, left: x + (mobile ? 180 : S(200)) }, width: mobile ? 28 : S(24), height: mobile ? 28 : S(24) }}
                  uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.create(1, 1, 1, Math.max(0, Math.min(1, opacity))) }} />
              )
            }
            return <UiEntity uiTransform={{ positionType: 'relative', width: 1, height: 1 }}>{coins}</UiEntity>
          })()}
        </UiEntity>
      )}

      {/* Credits */}
      <UiEntity uiTransform={{ positionType: 'absolute', width: '100%', position: { top: '62%' }, flexDirection: 'column', alignItems: 'center' }}>
        <Label value="Special Thanks to:" fontSize={mobile ? 52 : S(34)} color={GOLD} font="sans-serif" />
        <UiEntity uiTransform={{ height: mobile ? 14 : S(12) }} />
        {CREDIT_LINES.slice(0, creditLineIndex + 1).map((line, i) => (
          <Label key={i} value={line} fontSize={mobile ? 32 : S(20)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { top: mobile ? 6 : S(4) } }} />
        ))}
      </UiEntity>

      {creditsCountdown > 0 && (
        <Label value={`Next round in ${Math.ceil(creditsCountdown)}...`} fontSize={mobile ? 42 : S(26)} color={GOLD} font="sans-serif" uiTransform={{ positionType: 'absolute', position: { bottom: '3%' }, width: '100%', justifyContent: 'center' }} />
      )}
    </UiEntity>
  )
}

// ═══════════════════════════════════════════════════════════
// DESKTOP LAYOUT
// ═══════════════════════════════════════════════════════════

function DesktopLayout() {
  const rawPlayers = getPlayersWithHoldTimes()
  const players = rawPlayers
  const localUserId = getPlayer()?.userId ?? null
  const rawVisitors = getAllVisitors()
  const allVisitors = sortVisitorsWithBotSection(rawVisitors)
  const onlineCount = getCurrentOnlineCount()
  const totalPlaytimeMin = Math.floor(allVisitors.reduce((sum, v) => sum + v.totalSeconds, 0) / 60)
  const leaderUserId = players.length > 0 && players[0].seconds > 0 ? players[0].userId : null
  const carrierUserId = getCurrentFlagCarrierUserId()
  const countdownSeconds = getCountdownSeconds()
  const cinematicFadeOpacity = getCinematicFadeOpacity()
  const splashVisible = isSplashVisible()
  const cinematicShowing = getCinematicShowing()
  const winConditionVisible = getWinConditionOverlayVisible()
  const leaderboardVisible = getLeaderboardOverlayVisible()
  const analyticsVisible = getAnalyticsOverlayVisible()
  const rawLbEntries = tabs.leaderboard === 'monthly' ? getMonthlyLeaderboardEntries() : tabs.leaderboard === 'alltime' ? getAllTimeLeaderboardEntries() : getLeaderboardEntries()
  const leaderboardEntries = getSortedLeaderboardEntries(rawLbEntries)
  const serverConnected = getServerConnectionStatus()

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'relative' }}>
      {/* Timer */}
      {!isCinematicActive() && !splashVisible && cinematicFadeOpacity === 0 && countdownSeconds > 0 && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: S(14), left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: S(2 * _ROW_HEIGHT + 2 * _PADDING), padding: { left: S(20), right: S(20) }, borderRadius: S(_BORDER_RADIUS) }}
            uiBackground={{ color: PANEL_BG }}
          >
            <Label value="Round ends in:" fontSize={S(16)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { bottom: S(-6) } }} />
            <Label value={formatCountdown(countdownSeconds)} fontSize={S(40)} color={countdownSeconds <= 10 ? GOLD : WHITE} font="sans-serif" uiTransform={{ margin: { top: S(-6) } }} />
          </UiEntity>
        </UiEntity>
      )}

      <RoundEndSplash />
      {winConditionVisible && <HowToPlayOverlay />}
      {leaderboardVisible && <LeaderboardOverlay allVisitors={allVisitors} leaderboardEntries={leaderboardEntries} localUserId={localUserId} onlineCount={onlineCount} totalPlaytimeMin={totalPlaytimeMin} serverConnected={serverConnected} />}
      {analyticsVisible && <AnalyticsOverlay allVisitors={allVisitors} onlineCount={onlineCount} totalPlaytimeMin={totalPlaytimeMin} serverConnected={serverConnected} localUserId={localUserId} />}

      {/* Ability bar */}
      {!cinematicShowing && !isSpectatorMode() && !isSpectatorTransitioning() && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(24) }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
          <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
            {/* Projectile (E) */}
            <UiEntity uiTransform={{ width: S(_ABILITY_BTN_SIZE), height: S(_ABILITY_BTN_SIZE), flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: S(_BORDER_RADIUS), margin: { right: S(8) } }}
              uiBackground={{ color: PANEL_BG_SEMI }}
            >
              <Label value="E" fontSize={S(16)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ positionType: 'absolute', position: { top: S(2), left: S(8) } }} />
              {(getIsCharging() || getBurnoutFlash()) && (() => {
                const burnout = getBurnoutFlash()
                const cf = burnout ? 1 : getChargeFraction()
                const inset = S(6)
                return <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: inset, left: inset, right: inset }, height: `${Math.round(cf * 100)}%`, maxHeight: S(_ABILITY_BTN_SIZE) - inset * 2, borderRadius: S(_BORDER_RADIUS) }}
                  uiBackground={{ color: burnout ? Color4.create(1, 0.15, 0.1, 0.9) : cf >= 1.25 / 1.5 ? Color4.create(1, 0.84, 0, 0.85) : Color4.create(1, 1, 1, 0.5) }} />
              })()}
              <UiEntity uiTransform={{ width: (S(_ABILITY_ICON_SIZE) - 6) * 1.4175, height: (S(_ABILITY_ICON_SIZE) - 6) * 1.4175, margin: { top: S(-2) }, positionType: 'absolute' }}
                uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` }, color: isProjectileOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White() }} />
              {isProjectileOnCooldown() && getProjectileCooldownRemaining() > 0 && <Label value={`${getProjectileCooldownRemaining()}`} fontSize={S(26)} color={WHITE} font="sans-serif" uiTransform={{ positionType: 'absolute' }} />}
            </UiEntity>
            {/* Trap (F) */}
            <UiEntity uiTransform={{ width: S(_ABILITY_BTN_SIZE), height: S(_ABILITY_BTN_SIZE), flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: S(_BORDER_RADIUS), margin: { left: S(8) } }}
              uiBackground={{ color: PANEL_BG_SEMI }}
            >
              <Label value="F" fontSize={S(16)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ positionType: 'absolute', position: { top: S(2), left: S(8) } }} />
              <UiEntity uiTransform={{ width: S(_ABILITY_ICON_SIZE) * 1.3 * 0.675 * 1.1, height: S(_ABILITY_ICON_SIZE) * 1.3 * 0.675 * 1.1, margin: { top: S(2) } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/banana.png' }, color: isTrapOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White() }} />
              {isTrapOnCooldown() && <Label value={`${getTrapCooldownRemaining()}`} fontSize={S(26)} color={WHITE} font="sans-serif" uiTransform={{ positionType: 'absolute' }} />}
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}

      {/* Right-side: icons + stats + scoreboard */}
      <UiEntity uiTransform={{ positionType: 'absolute', position: { right: S(16), top: S(14) }, flexDirection: 'row', alignItems: 'flex-start' }}>
        {/* Icon buttons */}
        <UiEntity uiTransform={{ width: S(46), height: S(2 * _ROW_HEIGHT + 2 * _PADDING), flexDirection: 'column', alignItems: 'center', margin: { right: S(4) } }}>
          <IconButton hoverKey="squareIcon" label="Menus" isActive={leaderboardVisible}
            iconContent={<UiEntity uiTransform={{ width: S(17), height: S(17) }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: leaderboardVisible || hover.squareIcon ? GOLD : WHITE }} />}
            onClick={() => { const wasOpen = getLeaderboardOverlayVisible(); setWinConditionOverlayVisible(false); setAnalyticsOverlayVisible(false); scroll.leaderboardOffset = 0; tabs.leaderboard = 'daily'; tabs.folder = 'leaderboards'; setMetricsOpenedFromTerminal(false); setLeaderboardOverlayVisible(!wasOpen); if (wasOpen) notifyOverlayClosed() }}
          />
          <UiEntity uiTransform={{ height: S(4) }} />
          <IconButton hoverKey="questionIcon" label="Help" isActive={winConditionVisible}
            iconContent={<Label value="?" fontSize={S(24)} color={winConditionVisible || hover.questionIcon ? GOLD : WHITE} font="sans-serif" />}
            onClick={() => { const wasOpen = getWinConditionOverlayVisible(); setLeaderboardOverlayVisible(false); setAnalyticsOverlayVisible(false); setMetricsOpenedFromTerminal(false); setWinConditionOverlayVisible(!wasOpen); if (wasOpen) notifyOverlayClosed() }}
          />
        </UiEntity>

        {/* Stats square */}
        {(() => {
          const panelH = S(2 * _ROW_HEIGHT + 2 * _PADDING)
          const panelW = S(3 * _ROW_HEIGHT + 2 * _PADDING)
          const liveWins = getLocalLifetimeWins()
          if (!isWinsFrozen()) setDisplayedWins(liveWins)
          const myWins = getDisplayedWins() ?? liveWins
          return (
            <UiEntity uiTransform={{ width: panelW, height: panelH, flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', padding: { left: S(_PADDING) }, margin: { right: S(4) }, borderRadius: S(_BORDER_RADIUS) }}
              uiBackground={{ color: PANEL_BG }}
            >
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                <UiEntity uiTransform={{ width: S(20), height: S(20), margin: { right: S(6) } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.White() }} />
                <Label value={isCoinBalanceLoaded() ? `${getCoinBalance()}` : '--'} fontSize={S(18)} color={WHITE} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                <UiEntity uiTransform={{ width: S(18), height: S(18), margin: { right: S(6) } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />
                <Label value={isWinsLoaded() ? `${myWins}` : '--'} fontSize={S(18)} color={WHITE} font="sans-serif" />
              </UiEntity>
            </UiEntity>
          )
        })()}

        {/* Scoreboard */}
        <UiEntity uiTransform={{ width: S(_PANEL_WIDTH), flexDirection: 'column', alignItems: 'stretch', borderRadius: S(_BORDER_RADIUS), padding: S(_PADDING) }}
          uiBackground={{ color: PANEL_BG }}
        >
          <UiEntity uiTransform={{ height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Label value="Scoreboard" fontSize={S(20)} color={MUTED} font="sans-serif" />
          </UiEntity>
          {players.length === 0 ? (
            <UiEntity uiTransform={{ height: S(_ROW_HEIGHT) * 2, justifyContent: 'center', alignItems: 'center' }}>
              <Label value="Waiting for players..." fontSize={S(_ROW_FONT)} color={MUTED} font="sans-serif" />
            </UiEntity>
          ) : players.map((p, i) => {
            const isLeader = leaderUserId !== null && p.userId === leaderUserId
            const isSelf = localUserId !== null && p.userId === localUserId
            const isCarrier = carrierUserId !== null && p.userId === carrierUserId
            const nameColor = isLeader ? BRIGHT_GOLD : isSelf ? BRIGHT_WHITE : LIGHT_GREY
            const timeColor = isLeader ? GOLD : p.seconds > 0 ? WHITE : MUTED
            return (
              <UiEntity key={`${p.userId}-${i}`} uiTransform={{ height: S(_ROW_HEIGHT), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: { left: S(8), right: S(8), top: S(2), bottom: S(2) }, borderRadius: S(6) }}
                uiBackground={{ color: isLeader ? Color4.create(0.3, 0.25, 0.1, 0.3) : Color4.create(0, 0, 0, 0) }}
              >
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                  {isCarrier && <UiEntity uiTransform={{ width: S(16), height: S(16), margin: { right: S(4) } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />}
                  <Label value={p.name} fontSize={S(_ROW_FONT)} color={nameColor} font="sans-serif" />
                </UiEntity>
                <Label value={`${p.seconds}`} fontSize={S(_ROW_FONT)} color={timeColor} font="sans-serif" />
              </UiEntity>
            )
          })}
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

// ═══════════════════════════════════════════════════════════
// MOBILE LAYOUT
// ═══════════════════════════════════════════════════════════

function MobileLayout() {
  const players = getPlayersWithHoldTimes()
  const localUserId = getPlayer()?.userId ?? null
  const leaderUserId = players.length > 0 && players[0].seconds > 0 ? players[0].userId : null
  const carrierUserId = getCurrentFlagCarrierUserId()
  const countdownSeconds = getCountdownSeconds()
  const winConditionVisible = getWinConditionOverlayVisible()
  const leaderboardVisible = getLeaderboardOverlayVisible()
  const rawLbEntries = tabs.leaderboard === 'monthly' ? getMonthlyLeaderboardEntries() : tabs.leaderboard === 'alltime' ? getAllTimeLeaderboardEntries() : getLeaderboardEntries()
  const leaderboardEntries = getSortedLeaderboardEntries(rawLbEntries)

  const M_CIRCLE_SIZE = 68
  const M_CIRCLE_TEXTURE = 'assets/images/UI_circle.png'
  const M_CIRCLE_OPACITY = Color4.create(1, 1, 1, 0.8)

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'relative' }}>
      {/* Top bar */}
      {(() => {
        const localPlayer = players.find(p => localUserId !== null && p.userId === localUserId)
        const myScore = localPlayer ? localPlayer.seconds : 0
        const isLeader = localPlayer && leaderUserId !== null && localPlayer.userId === leaderUserId
        const hasFlag = localPlayer && carrierUserId !== null && localPlayer.userId === carrierUserId
        const scoreColor = isLeader ? GOLD : WHITE
        return (
          <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 28 }, width: '100%', height: 68, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
              <UiEntity uiTransform={{ height: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: { left: 28, right: 28 }, borderRadius: 34, margin: { right: 10 } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/UI_pill_timer.png' } }}
              >
                <Label value={formatCountdown(countdownSeconds)} fontSize={32} color={WHITE} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ height: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: { left: 18, right: 30 }, borderRadius: 34 }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/UI_pill_score.png' } }}
                onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); setAnalyticsOverlayVisible(false); setLeaderboardOverlayVisible(false); setMobileScoreboardVisible(!isMobileScoreboardVisible()) }}
              >
                <UiEntity uiTransform={{ width: 34, height: 34, margin: { right: 8 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/expand.png' }, color: Color4.White() }} />
                <Label value="Score:" fontSize={32} color={scoreColor} font="sans-serif" />
                <UiEntity uiTransform={{ width: 6 }} />
                <Label value={`${myScore}`} fontSize={32} color={scoreColor} font="sans-serif" />
                {hasFlag && <UiEntity uiTransform={{ width: 22, height: 22, margin: { left: 6 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />}
              </UiEntity>
              <UiEntity uiTransform={{ width: M_CIRCLE_SIZE, height: M_CIRCLE_SIZE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { left: 10 } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
                onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); setAnalyticsOverlayVisible(false); setMobileScoreboardVisible(false); toggleWinConditionOverlay(); notifyOverlayClosed() }}
              >
                <Label value="?" fontSize={36} color={winConditionVisible ? GOLD : WHITE} font="sans-serif" />
              </UiEntity>
              <UiEntity uiTransform={{ width: M_CIRCLE_SIZE, height: M_CIRCLE_SIZE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { left: 6 } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
                onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); setAnalyticsOverlayVisible(false); setMobileScoreboardVisible(false); scroll.leaderboardOffset = 0; tabs.leaderboard = 'daily'; tabs.folder = 'leaderboards'; setMetricsOpenedFromTerminal(false); toggleLeaderboardOverlay(); notifyOverlayClosed() }}
              >
                <UiEntity uiTransform={{ width: 26, height: 26 }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: leaderboardVisible ? GOLD : WHITE }} />
              </UiEntity>
            </UiEntity>
          </UiEntity>
        )
      })()}

      {/* Mobile Ability Bar */}
      {!isSpectatorMode() && (() => {
        const AB_SIZE = Math.round(M_CIRCLE_SIZE * 1.65)
        const AB_ICON = Math.round(50 * 1.65)
        return (
          <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: 44, left: '50%' }, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { left: -(AB_SIZE + 10) } }}>
            <UiEntity uiTransform={{ width: AB_SIZE, height: AB_SIZE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: { right: 20 } }}
              uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
              onMouseDown={() => { triggerTrapFromUI() }}
            >
              <UiEntity uiTransform={{ width: Math.round(AB_ICON * 1.25 * 0.675 * 1.1 * 1.1 * 1.1), height: Math.round(AB_ICON * 1.25 * 0.675 * 1.1 * 1.1 * 1.1) }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/banana.png' }, color: isTrapOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White() }} />
              {isTrapOnCooldown() && <Label value={`${getTrapCooldownRemaining()}`} fontSize={52} color={WHITE} font="sans-serif" uiTransform={{ positionType: 'absolute' }} />}
            </UiEntity>
            <UiEntity uiTransform={{ width: AB_SIZE, height: AB_SIZE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
              uiBackground={{ textureMode: 'stretch', texture: { src: M_CIRCLE_TEXTURE }, color: M_CIRCLE_OPACITY }}
              onMouseDown={() => { triggerProjectileFromUI() }}
            >
              <UiEntity uiTransform={{ width: (AB_ICON - 8) * 1.4175, height: (AB_ICON - 8) * 1.4175, margin: { top: -8 } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` }, color: isProjectileOnCooldown() ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White() }} />
              {isProjectileOnCooldown() && getProjectileCooldownRemaining() > 0 && <Label value={`${getProjectileCooldownRemaining()}`} fontSize={52} color={WHITE} font="sans-serif" uiTransform={{ positionType: 'absolute' }} />}
            </UiEntity>
          </UiEntity>
        )
      })()}

      {/* Mobile Scoreboard Overlay */}
      {isMobileScoreboardVisible() && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
          <UiEntity uiTransform={{ positionType: 'relative', width: '42%', height: '62%', flexDirection: 'column', alignItems: 'stretch', padding: 28, overflow: 'hidden' }}
            uiBackground={{ color: PANEL_BG }}
          >
            <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 4, right: 4 }, width: 88, height: 88, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
              onMouseDown={() => { playClickSound(); setMobileScoreboardVisible(false); notifyOverlayClosed() }}
            >
              <Label value="×" fontSize={52} color={CLOSE_GREY} font="sans-serif" />
            </UiEntity>
            <Label value="Scoreboard" fontSize={36} color={MUTED} font="sans-serif" uiTransform={{ height: 44, flexShrink: 0 }} />
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

      {/* Mobile Leaderboard */}
      {leaderboardVisible && (() => {
        const PER_PAGE = 8
        const total = leaderboardEntries.length
        const maxOff = Math.max(0, total - PER_PAGE)
        if (scroll.leaderboardOffset > maxOff) scroll.leaderboardOffset = maxOff
        if (scroll.leaderboardOffset < 0) scroll.leaderboardOffset = 0
        const visible = leaderboardEntries.slice(scroll.leaderboardOffset, scroll.leaderboardOffset + PER_PAGE)
        const canUp = scroll.leaderboardOffset > 0
        const canDown = scroll.leaderboardOffset < maxOff

        return (
          <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
            <UiEntity uiTransform={{ positionType: 'relative', width: '42%', height: '62%', flexDirection: 'column', alignItems: 'stretch', padding: 28, overflow: 'hidden' }}
              uiBackground={{ color: PANEL_BG }}
            >
              <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 4, right: 4 }, width: 88, height: 88, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
                onMouseDown={() => { playClickSound(); setLeaderboardOverlayVisible(false); setMetricsOpenedFromTerminal(false); tabs.folder = 'leaderboards'; tabs.leaderboard = 'daily'; notifyOverlayClosed() }}
              >
                <Label value="×" fontSize={52} color={CLOSE_GREY} font="sans-serif" />
              </UiEntity>
              {(() => { if (!isMetricsOpenedFromTerminal()) { tabs.folder = 'leaderboards'; tabs.leaderboard = tabs.leaderboard === 'metrics' ? 'daily' : tabs.leaderboard } return null })()}
              <UiEntity uiTransform={{ flexDirection: 'row', width: '100%', height: 40 }}>
                {(['Daily', 'Monthly', 'All Time'] as const).map((label, i) => {
                  const keys = ['daily', 'monthly', 'alltime'] as const
                  return (
                    <UiEntity key={`m-tab-${keys[i]}`} uiTransform={{ flexGrow: 1, flexDirection: 'row' }}>
                      {i > 0 && <UiEntity uiTransform={{ width: 6 }} />}
                      <UiEntity uiTransform={{ flexGrow: 1, height: 40, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: 6 }}
                        uiBackground={{ color: tabs.leaderboard === keys[i] ? Color4.create(0.3, 0.3, 0.35, 1) : Color4.create(0.15, 0.15, 0.18, 1) }}
                        onMouseDown={() => { playClickSound(); tabs.leaderboard = keys[i]; scroll.leaderboardOffset = 0 }}
                      >
                        <Label value={label} fontSize={16} color={tabs.leaderboard === keys[i] ? WHITE : MUTED} font="sans-serif" />
                      </UiEntity>
                    </UiEntity>
                  )
                })}
              </UiEntity>
              <UiEntity uiTransform={{ height: 12 }} />
              <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column' }}>
                {canUp && <UiEntity uiTransform={{ width: '100%', height: 40, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }} uiBackground={{ color: Color4.create(0.2, 0.2, 0.22, 0.8) }} onMouseDown={() => { scroll.leaderboardOffset -= 1 }}><Label value="▲ More" fontSize={22} color={WHITE} font="sans-serif" /></UiEntity>}
                <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column' }}>
                  {total === 0 ? (
                    <UiEntity uiTransform={{ height: 88, justifyContent: 'center', alignItems: 'center' }}><Label value="No champions yet..." fontSize={22} color={MUTED} font="sans-serif" /></UiEntity>
                  ) : visible.map((entry, i) => {
                    const isSelf = localUserId !== null && entry.userId === localUserId
                    const rank = scroll.leaderboardOffset + i + 1
                    return (
                      <UiEntity key={`m-lb-${entry.userId}-${scroll.leaderboardOffset}-${i}`} uiTransform={{ height: 44, flexDirection: 'row', alignItems: 'center' }}>
                        {tabs.leaderboard === 'daily' ? (
                          <UiEntity uiTransform={{ flexDirection: "row", alignItems: "center", flexGrow: 1 }}>
                            {Array.from({ length: entry.roundsWon }, (_, ri) => <UiEntity key={`m-rw-${ri}`} uiTransform={{ width: 16, height: 16, margin: { right: 2 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />)}
                            {entry.roundsWon > 0 && <UiEntity uiTransform={{ width: 4 }} />}
                            <Label value={entry.name} fontSize={22} color={isSelf ? WHITE : GREY} font="sans-serif" />
                          </UiEntity>
                        ) : (
                          <UiEntity uiTransform={{ flexDirection: "row", alignItems: "center", flexGrow: 1 }}>
                            <Label value={`${rank}.`} fontSize={22} color={MUTED} font="sans-serif" uiTransform={{ width: 36 }} textAlign="middle-left" />
                            <Label value={entry.name} fontSize={22} color={isSelf ? WHITE : GREY} font="sans-serif" uiTransform={{ flexGrow: 1 }} />
                            <Label value={`${entry.roundsWon}`} fontSize={22} color={GOLD} font="sans-serif" />
                          </UiEntity>
                        )}
                      </UiEntity>
                    )
                  })}
                </UiEntity>
                {canDown && <UiEntity uiTransform={{ width: '100%', height: 40, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }} uiBackground={{ color: Color4.create(0.2, 0.2, 0.22, 0.8) }} onMouseDown={() => { scroll.leaderboardOffset += 1 }}><Label value="▼ More" fontSize={22} color={WHITE} font="sans-serif" /></UiEntity>}
              </UiEntity>
            </UiEntity>
          </UiEntity>
        )
      })()}
    </UiEntity>
  )
}
