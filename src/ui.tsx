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
import ReactEcs, { ReactEcsRenderer, UiEntity, Label, Input } from '@dcl/sdk/react-ecs'
import { getPlayer } from '@dcl/sdk/players'
import { executeTask } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { room } from './shared/messages'

// State & infrastructure

import { registerUiSystems } from './ui/uiSystems'
import {
  S, WHITE, BRIGHT_WHITE, BRIGHT_GOLD, MUTED, LIGHT_GREY, GREY, CLOSE_GREY,
  GOLD, SILVER, BRONZE, CORAL_RED,
  PANEL_BG, PANEL_BG_SEMI,
  getUIScaleLabel,
  formatCountdown,
  type VisitorOrSeparator,
} from './ui/uiConstants'
import {
  musicState,
  cinematicState, setCinematicFade,
  creditsState, CREDIT_LINES,
  blessingState, markBlessingCompleted,
  earnedState,
  notifyOverlayClosed, isAnyOverlayOpen,
  registerOverlayChecks, registerInventoryCheck,
  popupState,
  showChestPopup, hideChestPopup,
  showMailboxPopup, hideMailboxPopup,
  showGravestonePopup, hideGravestonePopup,
  showBoomboxPopup, hideBoomboxPopup,
  getMailboxStatus, setMailboxStatus,
  metricsState,
  splashState,
  serverDownState,
  hover,
  scroll, tabs,
  getUIScaleFlash,
  mobileState,
  miscState,
  type EarnedUiPhase,
} from './ui/uiState'

// Overlay visibility state
import { getWinConditionOverlayVisible, setWinConditionOverlayVisible, getLeaderboardOverlayVisible, setLeaderboardOverlayVisible, getAnalyticsOverlayVisible, setAnalyticsOverlayVisible } from './gameState/overlayState'

// Game state
import { getPlayersWithHoldTimes, getCurrentFlagCarrierUserId } from './gameState/flagHoldTime'
import { isCinematicActive } from './gameState/cinematicState'
import { refreshUpgradesFromServer } from './gameState/playerUpgradeState'
import { exitSpectatorMode } from './systems/spectatorSystem'
import { spectatorState } from './shared/clientState'
import { getDrownFraction, isDrownBarVisible, getRespawnCountdown, getDrownFadeOpacity, isDrownTextVisible } from './systems/waterSystem'
import { isLightningRespawning, getLightningFadeOpacity, getLightningRespawnCountdown, isLightningTextVisible } from './systems/lightningSystem'
import { isGhostDeathRespawning, getGhostDeathFadeOpacity, getGhostDeathRespawnCountdown, isGhostDeathTextVisible, getScareFraction, isScareBarVisible } from './systems/ghostSystem'

// Reusable components
import { CloseButton } from './ui/components/CloseButton'
import { ProgressBar } from './ui/components/ProgressBar'
import { DeathOverlay } from './ui/components/DeathOverlay'

// Screens
import { ChestPopup } from './ui/screens/ChestPopup'
import { BoomboxPopup } from './ui/screens/BoomboxPopup'

// Layouts
import { DesktopLayout } from './ui/layouts/DesktopLayout'
import { MobileLayout } from './ui/layouts/MobileLayout'

// Inventory
import { setOnHotbarChanged, hotbar, showInventory as inventoryVisible } from './ui/inventory/state'
import { requestEquipBoomerang } from './gameState/playerUpgradeState'

// ═══════════════════════════════════════════════════════════
// RE-EXPORTS — stable public API for other files
// ═══════════════════════════════════════════════════════════
export {
  setCinematicFade,
  notifyOverlayClosed, isAnyOverlayOpen,
  showChestPopup, hideChestPopup,
  showMailboxPopup, hideMailboxPopup,
  showGravestonePopup, hideGravestonePopup,
  showBoomboxPopup, hideBoomboxPopup,
}

// Re-export state objects for systems that need direct access
export { cinematicState, creditsState, popupState, splashState }

// ═══════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════

export function setupUi() {
  registerOverlayChecks(getWinConditionOverlayVisible, getLeaderboardOverlayVisible, getAnalyticsOverlayVisible)
  registerInventoryCheck(() => inventoryVisible)
  registerUiSystems()

  // Wire inventory hotbar changes to the boomerang equip system
  setOnHotbarChanged(() => {
    // Find whichever hotbar slot has a boomerang and equip it
    for (let i = 0; i < hotbar.length; i++) {
      const item = hotbar[i]
      if (item && item.boomerangColor) {
        requestEquipBoomerang(item.boomerangColor)
        return
      }
    }
  })

  ReactEcsRenderer.setUiRenderer(PlayerListUi)
}

// ═══════════════════════════════════════════════════════════
// METRICS PANEL (opened from Terminal in-world)
// ═══════════════════════════════════════════════════════════

export function openMetricsPanel() {
  metricsState.openedFromTerminal = true
  setLeaderboardOverlayVisible(true)
  tabs.folder = 'metrics'; tabs.leaderboard = 'metrics'; tabs.metrics = 'daily'
  scroll.leaderboardOffset = 0; scroll.visitorOffset = 0
}

export function closeMetricsPanel() {
  if (metricsState.openedFromTerminal) {
    metricsState.openedFromTerminal = false
    setLeaderboardOverlayVisible(false)
    tabs.folder = 'leaderboards'; tabs.leaderboard = 'alltime'
    notifyOverlayClosed()
  }
}

export function isMetricsPanelOpen(): boolean {
  return metricsState.openedFromTerminal && getLeaderboardOverlayVisible()
}

// ═══════════════════════════════════════════════════════════
// MAILBOX ACTION
// ═══════════════════════════════════════════════════════════

let feedbackText = ''
let feedbackListenerRegistered = false

function sendFeedback() {
  if (!feedbackText.trim()) { setMailboxStatus('Please type a message first.'); return }
  if (!feedbackListenerRegistered) {
    feedbackListenerRegistered = true
    room.onMessage('feedbackResult', (data) => { setMailboxStatus(data.message) })
  }
  setMailboxStatus('Sending...')
  room.send('sendFeedback', { message: feedbackText.trim() })
  feedbackText = ''
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
  const cinematicFadeOpacity = cinematicState.fadeOpacity
  const cinematicShowing = cinematicState.showing
  const nextRoundStartingVisible = creditsState.nextRoundVisible
  const noScorersCreditsVisible = creditsState.noScorersVisible
  const activeRoundEarnings = earnedState.activeRoundEarnings
  const earnedUiPhase = earnedState.phase
  const earnedCoinsFlyProgress = earnedState.coinsFlyProgress
  const creditsCountdown = creditsState.countdown

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'relative', pointerFilter: 'none' }}>
      {mobile ? <MobileLayout /> : <DesktopLayout />}

      {/* Cinematic fade overlay */}
      {cinematicFadeOpacity > 0 && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
          uiBackground={{ color: Color4.create(0, 0, 0, cinematicFadeOpacity) }}
          onMouseDown={() => {}}
        >
          {(noScorersCreditsVisible || (nextRoundStartingVisible && !cinematicShowing)) && (
            <CreditsScreen
              activeRoundEarnings={activeRoundEarnings}
              earnedUiPhase={earnedUiPhase}
              earnedCoinsFlyProgress={earnedCoinsFlyProgress}
              creditsCountdown={creditsCountdown}
              mobile={mobile}
            />
          )}
        </UiEntity>
      )}

      {/* Blessing overlay (no background — see through to emoting player) */}
      {(blessingState.active || blessingState.fadeOut > 0) && (() => {
        const opacity = blessingState.active ? 1 : blessingState.fadeOut
        const goldFaded = Color4.create(GOLD.r, GOLD.g, GOLD.b, opacity)
        const greyFaded = Color4.create(LIGHT_GREY.r, LIGHT_GREY.g, LIGHT_GREY.b, opacity)
        return (
          <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', flexDirection: 'column', alignItems: 'center', pointerFilter: 'none' }}
            >
            <UiEntity uiTransform={{ positionType: 'absolute', width: '100%', position: { top: '18%' }, flexDirection: 'column', alignItems: 'center', pointerFilter: 'none' }}>
              <UiEntity uiTransform={{ padding: { top: mobile ? 24 : S(18), bottom: mobile ? 24 : S(18), left: mobile ? 40 : S(32), right: mobile ? 40 : S(32) }, flexDirection: 'column', alignItems: 'center', borderRadius: mobile ? 16 : S(12) }}
                uiBackground={{ color: Color4.create(0, 0, 0, 0.6 * opacity) }}>
                <Label value="Receiving the blessing of..." fontSize={mobile ? 52 : S(34)} color={goldFaded} font="sans-serif" />
                <UiEntity uiTransform={{ height: mobile ? 14 : S(12) }} />
                {blessingState.lineIndex >= 0 && CREDIT_LINES.slice(0, blessingState.lineIndex + 1).map((line, i) => (
                  <Label key={i} value={line} fontSize={mobile ? 32 : S(20)} color={greyFaded} font="sans-serif" uiTransform={{ margin: { top: mobile ? 6 : S(4) } }} />
                ))}
              </UiEntity>
            </UiEntity>
          </UiEntity>
        )
      })()}

      {/* Blessing completed notification */}
      {blessingState.completed && (() => {
        const coinProgress = blessingState.coinProgress
        return (
          <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}
            >
            <UiEntity uiTransform={{ width: mobile ? 420 : S(340), padding: { top: mobile ? 32 : S(24), bottom: mobile ? 32 : S(24), left: mobile ? 24 : S(20), right: mobile ? 24 : S(20) }, flexDirection: 'column', alignItems: 'center', borderRadius: mobile ? 20 : S(16) }}
              uiBackground={{ textureMode: 'nine-slices', texture: { src: 'assets/images/rounded-outline.png' }, textureSlices: { top: 0.25, bottom: 0.25, left: 0.25, right: 0.25 }, color: Color4.White() }}
            >
              {blessingState.alreadyUsed ? (
                <Label value="You have already received the blessing today" fontSize={mobile ? 36 : S(24)} color={MUTED} font="sans-serif" />
              ) : (
                <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
                  <Label value="Blessing Received!" fontSize={mobile ? 56 : S(38)} color={GOLD} font="sans-serif" />
                  <UiEntity uiTransform={{ height: mobile ? 16 : S(12) }} />
                  <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                    <UiEntity uiTransform={{ width: mobile ? 40 : S(36), height: mobile ? 40 : S(36), margin: { right: mobile ? 10 : S(8) } }}
                      uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.White() }} />
                    <Label value="+6" fontSize={mobile ? 72 : S(50)} color={GOLD} font="sans-serif" />
                  </UiEntity>
                  {/* Flying coins */}
                  {(() => {
                    const coins = []
                    for (let i = 0; i < 5; i++) {
                      const angle = (i / 5) * Math.PI * 2
                      const startX = Math.cos(angle) * 60
                      const startY = 40 + Math.sin(angle) * 30
                      const progress = Math.min(1, coinProgress * 1.5 - (i * 0.08))
                      const cp = Math.max(0, Math.min(1, progress))
                      const eased = 1 - Math.pow(1 - cp, 3)
                      const x = startX * (1 - eased)
                      const y = startY * (1 - eased) - (250 * eased)
                      const opacity = cp < 0.1 ? cp * 10 : (cp > 0.85 ? (1 - cp) * 6.67 : 1)
                      coins.push(
                        <UiEntity key={`bless-coin-${i}`} uiTransform={{ positionType: 'absolute', position: { top: y, left: x + (mobile ? 180 : S(140)) }, width: mobile ? 28 : S(24), height: mobile ? 28 : S(24) }}
                          uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.create(1, 1, 1, Math.max(0, Math.min(1, opacity))) }} />
                      )
                    }
                    return <UiEntity uiTransform={{ positionType: 'relative', width: 1, height: 1, pointerFilter: 'none' }}>{coins}</UiEntity>
                  })()}
                </UiEntity>
              )}
            </UiEntity>
          </UiEntity>
        )
      })()}

      {/* Server-down overlay */}
      {serverDownState.visible && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
          uiBackground={{ color: Color4.create(0, 0, 0, 0.6) }}
          onMouseDown={() => {}}
        >
          <UiEntity uiTransform={{ width: mobile ? 400 : S(460), flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: mobile ? 20 : S(16), padding: mobile ? { top: 36, bottom: 32, left: 20, right: 20 } : { top: S(36), bottom: S(32), left: S(40), right: S(40) } }}
            uiBackground={{ color: PANEL_BG }}
          >
            <CloseButton hoverKey="closeServerDown" onClose={() => { serverDownState.dismissedAt = Date.now(); serverDownState.visible = false }} />
            <Label value="Server Disconnected" fontSize={mobile ? 36 : S(28)} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: mobile ? 12 : S(12) }} />
            <Label value="all players please leave scene
for 5 minutes while server resets" fontSize={mobile ? 20 : S(18)} color={LIGHT_GREY} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      )}

      {/* Mailbox popup */}
      {popupState.mailbox && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}
          >
          <UiEntity uiTransform={{ width: mobile ? 440 : S(480), flexDirection: 'column', alignItems: 'center', padding: mobile ? { top: 28, bottom: 28, left: 20, right: 20 } : { top: S(24), bottom: S(24), left: S(24), right: S(24) }, borderRadius: mobile ? 20 : S(20) }}
            uiBackground={{ color: PANEL_BG }}
          >
            <CloseButton hoverKey="closeMailbox" onClose={() => { hideMailboxPopup(); notifyOverlayClosed() }} />
            <Label value="Leave a Message" fontSize={mobile ? 36 : S(28)} color={Color4.create(0.2, 0.6, 1, 1)} font="sans-serif" uiTransform={{ margin: { bottom: mobile ? 8 : S(8) } }} />
            <Label value={`Leave feedback, report a bug, or just say hi!`} fontSize={mobile ? 20 : S(16)} color={LIGHT_GREY} uiTransform={{ margin: { top: mobile ? 4 : S(4), bottom: mobile ? 12 : S(12) }, width: mobile ? '95%' : S(420), height: mobile ? 35 : S(28) }} textAlign="middle-center" />
            <Input
              placeholder="Type your message..."
              fontSize={mobile ? 18 : S(15)}
              color={Color4.White()}
              placeholderColor={Color4.create(0.6, 0.6, 0.6, 1)}
              uiTransform={{ width: mobile ? '95%' : S(420), height: mobile ? 44 : S(40), margin: { bottom: mobile ? 12 : S(12) }, borderRadius: mobile ? 8 : S(8), padding: { left: mobile ? 8 : S(8), right: mobile ? 8 : S(8) } }}
              uiBackground={{ color: Color4.create(0.15, 0.15, 0.2, 1) }}
              onChange={(val) => { feedbackText = val }}
              onSubmit={(val) => { feedbackText = val; sendFeedback() }}
              value={feedbackText}
            />
            <UiEntity uiTransform={{ width: mobile ? 200 : S(200), height: mobile ? 44 : S(44), borderRadius: mobile ? 8 : S(8), justifyContent: 'center', alignItems: 'center' }}
              uiBackground={{ color: Color4.create(0.2, 0.6, 1, 1) }}
              onMouseDown={() => { sendFeedback() }}
            >
              <Label value="Send" fontSize={mobile ? 20 : S(18)} color={Color4.White()} uiTransform={{ width: '100%', height: '100%' }} textAlign="middle-center" />
            </UiEntity>
            {getMailboxStatus() ? <Label value={getMailboxStatus()} fontSize={mobile ? 16 : S(13)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { top: mobile ? 12 : S(12) }, width: mobile ? '95%' : S(360) }} textAlign="middle-center" /> : null}
          </UiEntity>
        </UiEntity>
      )}

      {/* Gravestone popup */}
      {popupState.gravestone && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}
          >
          <UiEntity uiTransform={{ width: mobile ? 340 : S(340), flexDirection: 'column', alignItems: 'center', padding: mobile ? { top: 28, bottom: 28, left: 20, right: 20 } : { top: S(24), bottom: S(24), left: S(24), right: S(24) }, borderRadius: mobile ? 20 : S(20) }}
            uiBackground={{ color: PANEL_BG }}
          >
            <CloseButton hoverKey="closeWinCondition" onClose={() => { hideGravestonePopup(); notifyOverlayClosed() }} />
            <Label value="Here Lies" fontSize={mobile ? 28 : S(24)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { top: mobile ? 8 : S(8) } }} />
            <Label value="Casper the Ghost" fontSize={mobile ? 32 : S(28)} color={WHITE} font="sans-serif" uiTransform={{ margin: { top: mobile ? 4 : S(4), bottom: mobile ? 8 : S(8) } }} />
          </UiEntity>
        </UiEntity>
      )}

      {/* Chest / Store popup */}
      {popupState.chest && <ChestPopup />}

      {/* Boombox / Tape popup */}
      {popupState.boombox && <BoomboxPopup />}

      {/* Progress bars */}
      {isDrownBarVisible() && <DrownBar />}
      {isScareBarVisible() && <ScareBar />}

      {/* UI Scale toast */}
      {getUIScaleFlash() && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(140), left: '50%' }, margin: { left: S(-80) }, width: S(160), height: S(32), flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: S(8), pointerFilter: 'none' }}
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
      {spectatorState.active && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(20), left: 0 }, width: '100%', flexDirection: 'column', alignItems: 'center', pointerFilter: 'none' }}>
          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', padding: mobile ? { top: 10, bottom: 10, left: 18, right: 18 } : { top: S(14), bottom: S(14), left: S(24), right: S(24) }, borderRadius: mobile ? 14 : S(18) }}
            uiBackground={{ color: Color4.create(0.1, 0.1, 0.1, 0.92) }}
          >
            <Label value="SPECTATOR MODE" fontSize={mobile ? 24 : S(28)} color={Color4.White()} />
            <Label value="WASD = Orbit  |  E/F = Up/Down" fontSize={mobile ? 12 : S(14)} color={Color4.create(1, 1, 1, 0.8)} />
            <UiEntity uiTransform={{ width: mobile ? 120 : S(160), height: mobile ? 32 : S(40), margin: { top: mobile ? 6 : S(8) }, borderRadius: mobile ? 8 : S(10) }}
              uiBackground={{ color: miscState.spectatorExitBlink ? Color4.create(0.5, 0.5, 0.5, 0.9) : Color4.create(1, 1, 1, 0.9) }}
              onMouseDown={() => { miscState.spectatorExitBlink = true; executeTask(async () => { await new Promise<void>(r => setTimeout(r, 120)); miscState.spectatorExitBlink = false }); exitSpectatorMode() }}
            >
              <Label value="Exit" fontSize={mobile ? 16 : S(18)} color={Color4.Black()} uiTransform={{ width: '100%', height: '100%' }} />
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}

      {/* Title Splash */}
      {cinematicState.titleSplashVisible && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
          
          onMouseDown={() => { cinematicState.titleSplashVisible = false; setWinConditionOverlayVisible(true) }}
        >
          <UiEntity uiTransform={{ width: S(420), padding: { top: S(32), bottom: S(32), left: S(24), right: S(24) }, borderRadius: S(16), flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
            uiBackground={{ color: Color4.create(0.12, 0.10, 0.10, 0.95) }}
            onMouseDown={() => { cinematicState.titleSplashVisible = false; setWinConditionOverlayVisible(true) }}
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

function CreditsScreen({ activeRoundEarnings, earnedUiPhase, earnedCoinsFlyProgress, creditsCountdown, mobile }: {
  activeRoundEarnings: RoundEarnings | null; earnedUiPhase: EarnedUiPhase; earnedCoinsFlyProgress: number; creditsCountdown: number; mobile: boolean
}) {
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', pointerFilter: 'none' }}>
      {/* No earnings fallback */}
      {!activeRoundEarnings && (
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
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
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
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

      {creditsCountdown > 0 && (
        <Label value={`Next round in ${Math.ceil(creditsCountdown)}...`} fontSize={mobile ? 42 : S(26)} color={GOLD} font="sans-serif" uiTransform={{ positionType: 'absolute', position: { bottom: '3%' }, width: '100%', justifyContent: 'center' }} />
      )}
    </UiEntity>
  )
}
