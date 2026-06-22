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
import { getHitFlashAlpha } from './gameState/hitFlashState'
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
} from './ui/uiConstants'
import {
  cinematicState, setCinematicFade,
  creditsState, CREDIT_LINES,
  blessingState, markBlessingCompleted,
  earnedState,
  notifyOverlayClosed, isAnyOverlayOpen,
  registerOverlayChecks,
  popupState,
  showChestPopup, hideChestPopup,
  showMailboxPopup, hideMailboxPopup,
  showGravestonePopup, hideGravestonePopup,
  getMailboxStatus, setMailboxStatus,
  splashState,
  serverDownState,
  hover,
  scroll,
  getUIScaleFlash,
  mobileState,
  miscState,
  type EarnedUiPhase,
} from './ui/uiState'

// Overlay visibility state
import { getWinConditionOverlayVisible, setWinConditionOverlayVisible, getLeaderboardOverlayVisible, setLeaderboardOverlayVisible } from './gameState/overlayState'

// Game state
import { getPlayersWithHoldTimes, getCurrentFlagCarrierUserId } from './gameState/flagHoldTime'
import { isCinematicActive } from './gameState/cinematicState'
import { refreshUpgradesFromServer } from './gameState/playerUpgradeState'
import { exitSpectatorMode, setSpectatorMode, selectFollowPlayer } from './systems/spectatorSystem'
import { spectatorState, type SpectatorMode } from './shared/clientState'
import { getDrownFraction, isDrownBarVisible, getRespawnCountdown, getDrownFadeOpacity, isDrownTextVisible } from './systems/waterSystem'
import { isLightningRespawning, getLightningFadeOpacity, getLightningRespawnCountdown, isLightningTextVisible, isLightningWarningActive } from './systems/lightningSystem'
import { requestManualDrop } from './systems/flagSystem'
import { isGhostDeathRespawning, getGhostDeathFadeOpacity, getGhostDeathRespawnCountdown, isGhostDeathTextVisible, getScareFraction, isScareBarVisible } from './systems/ghostSystem'

// Reusable components
import { CloseButton } from './ui/components/CloseButton'
import { playClickSound } from './ui/uiSounds'
import { ProgressBar } from './ui/components/ProgressBar'
import { DeathOverlay } from './ui/components/DeathOverlay'

// Screens
import { ChestPopup } from './ui/screens/ChestPopup'


// Layouts
import { DesktopLayout } from './ui/layouts/DesktopLayout'
import { MobileLayout } from './ui/layouts/MobileLayout'


// ═══════════════════════════════════════════════════════════
// RE-EXPORTS — stable public API for other files
// ═══════════════════════════════════════════════════════════
export {
  setCinematicFade,
  notifyOverlayClosed, isAnyOverlayOpen,
  showChestPopup, hideChestPopup,
  showMailboxPopup, hideMailboxPopup,
  showGravestonePopup, hideGravestonePopup,
}

// Re-export state objects for systems that need direct access
export { cinematicState, creditsState, popupState, splashState }

// ═══════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════

export function setupUi() {
  registerOverlayChecks(getWinConditionOverlayVisible, getLeaderboardOverlayVisible)
  registerUiSystems()

  ReactEcsRenderer.setUiRenderer(PlayerListUi)
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
  return <ProgressBar fraction={fraction} fillColor={fillColor} bottomOffset={mobile ? 50 : S(110)} />
}

function ScareBar() {
  const mobile = isMobile()
  const fraction = getScareFraction()
  const fillColor = fraction > 0.75 ? Color4.create(1, 0.3, 0.3, 0.95) : Color4.create(0.55, 0.55, 0.55, 0.95)
  const bottomOffset = isDrownBarVisible() ? (mobile ? 80 : S(128)) : (mobile ? 50 : S(110))
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

      {/* Hit flash overlay */}
      {getHitFlashAlpha() > 0 && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}
          uiBackground={{ color: Color4.create(0.8, 0, 0, getHitFlashAlpha()) }}
        />
      )}

      {/* Cinematic fade overlay */}
      {cinematicFadeOpacity > 0 && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
          uiBackground={{ color: Color4.create(0, 0, 0, cinematicFadeOpacity) }}
          onMouseDown={() => {}}
        >
          {cinematicState.roundOverVisible && (
            <Label value="Round Over" fontSize={mobile ? 64 : S(52)} color={Color4.create(1, 0.84, 0, 1)} font="sans-serif" />
          )}
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
            <UiEntity uiTransform={{ width: mobile ? 420 : S(340), padding: { top: mobile ? 32 : S(24), bottom: mobile ? 32 : S(24), left: mobile ? 24 : S(20), right: mobile ? 24 : S(20) }, flexDirection: 'column', alignItems: 'center', borderRadius: mobile ? 20 : S(20) }}
              uiBackground={{ color: PANEL_BG }}
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
          <UiEntity uiTransform={{ width: mobile ? 560 : S(460), flexDirection: 'column', alignItems: 'center', borderRadius: mobile ? 20 : S(20), padding: mobile ? { top: 44, bottom: 24, left: 24, right: 24 } : { top: S(36), bottom: S(28), left: S(40), right: S(40) } }}
            uiBackground={{ color: PANEL_BG }}
          >
            <CloseButton hoverKey="closeServerDown" onClose={() => { serverDownState.dismissedAt = Date.now(); serverDownState.visible = false }} />
            <Label value="Server Disconnected" fontSize={mobile ? 36 : S(32)} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: mobile ? 10 : S(8) } }} />
            <Label value={`all players please leave scene\nfor 5 minutes while server resets`} fontSize={mobile ? 20 : S(18)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ width: mobile ? '90%' : S(380), height: mobile ? 56 : S(48) }} textAlign="middle-center" />
          </UiEntity>
        </UiEntity>
      )}

      {/* Mailbox popup */}
      {popupState.mailbox && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}
          >
          <UiEntity uiTransform={{ width: mobile ? 540 : S(480), flexDirection: 'column', alignItems: 'center', padding: mobile ? { top: 36, bottom: 36, left: 28, right: 28 } : { top: S(24), bottom: S(24), left: S(24), right: S(24) }, borderRadius: mobile ? 20 : S(20) }}
            uiBackground={{ color: PANEL_BG }}
          >
            <CloseButton hoverKey="closeMailbox" onClose={() => { hideMailboxPopup(); notifyOverlayClosed() }} />
            <Label value="Leave a Message" fontSize={mobile ? 42 : S(28)} color={Color4.create(0.2, 0.6, 1, 1)} font="sans-serif" uiTransform={{ margin: { bottom: mobile ? 8 : S(8) } }} />
            <Label value="Leave feedback, report a bug, or just say hi!" fontSize={mobile ? 24 : S(16)} color={LIGHT_GREY} uiTransform={{ margin: { top: mobile ? 6 : S(4), bottom: mobile ? 16 : S(12) }, width: mobile ? '95%' : S(420), height: mobile ? 65 : S(28) }} textAlign="middle-center" />
            <Input
              placeholder="Type your message..."
              fontSize={mobile ? 22 : S(15)}
              color={Color4.White()}
              placeholderColor={Color4.create(0.6, 0.6, 0.6, 1)}
              uiTransform={{ width: mobile ? '95%' : S(420), height: mobile ? 54 : S(40), margin: { bottom: mobile ? 16 : S(12) }, borderRadius: mobile ? 10 : S(8), padding: { left: mobile ? 12 : S(8), right: mobile ? 12 : S(8) } }}
              uiBackground={{ color: Color4.create(0.15, 0.15, 0.2, 1) }}
              onChange={(val) => { feedbackText = val }}
              onSubmit={(val) => { feedbackText = val; sendFeedback() }}
              value={feedbackText}
            />
            <UiEntity uiTransform={{ width: mobile ? 240 : S(200), height: mobile ? 54 : S(44), borderRadius: mobile ? 10 : S(8), justifyContent: 'center', alignItems: 'center' }}
              uiBackground={{ color: Color4.create(0.2, 0.6, 1, 1) }}
              onMouseDown={() => { sendFeedback() }}
            >
              <Label value="Send" fontSize={mobile ? 24 : S(18)} color={Color4.White()} uiTransform={{ width: '100%', height: '100%' }} textAlign="middle-center" />
            </UiEntity>
            {getMailboxStatus() ? <Label value={getMailboxStatus()} fontSize={mobile ? 16 : S(13)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { top: mobile ? 12 : S(12) }, width: mobile ? '95%' : S(360) }} textAlign="middle-center" /> : null}
          </UiEntity>
        </UiEntity>
      )}

      {/* Gravestone popup */}
      {popupState.gravestone && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}
          >
          <UiEntity uiTransform={{ width: mobile ? 480 : S(340), flexDirection: 'column', alignItems: 'center', padding: mobile ? { top: 36, bottom: 36, left: 28, right: 28 } : { top: S(24), bottom: S(24), left: S(24), right: S(24) }, borderRadius: mobile ? 20 : S(20) }}
            uiBackground={{ color: PANEL_BG }}
          >
            <CloseButton hoverKey="closeWinCondition" onClose={() => { hideGravestonePopup(); notifyOverlayClosed() }} />
            <Label value="Here Lies" fontSize={mobile ? 38 : S(24)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ margin: { top: mobile ? 12 : S(8) } }} />
            <Label value="Schneeflocke1" fontSize={mobile ? 42 : S(28)} color={WHITE} font="sans-serif" uiTransform={{ margin: { top: mobile ? 8 : S(4), bottom: mobile ? 12 : S(8) } }} />
          </UiEntity>
        </UiEntity>
      )}

      {/* Chest / Store popup */}
      {popupState.chest && <ChestPopup />}

      {/* Boombox / Tape popup */}


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

      {/* Lightning warning tooltip — visible to flag carrier when sparks start */}
      {isLightningWarningActive() && (() => {
        const localPlayer = getPlayer()
        const carrierId = getCurrentFlagCarrierUserId()
        const isCarrier = localPlayer && carrierId && localPlayer.userId?.toLowerCase() === carrierId.toLowerCase()
        return isCarrier ? (
          mobile ? (
            <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: 140 }, width: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
              <UiEntity uiTransform={{ padding: { top: 16, bottom: 16, left: 32, right: 32 }, borderRadius: 14 }}
                uiBackground={{ color: Color4.create(0.15, 0.1, 0.05, 0.92) }}
                onMouseDown={() => { requestManualDrop() }}
              >
                <Label value="Drop Flag!" fontSize={38} color={Color4.create(1, 0.9, 0.3, 1)} font="sans-serif" />
              </UiEntity>
            </UiEntity>
          ) : (
            <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: S(180) }, width: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}>
              <UiEntity uiTransform={{ padding: { top: S(10), bottom: S(10), left: S(20), right: S(20) }, borderRadius: S(10) }}
                uiBackground={{ color: Color4.create(0.1, 0.1, 0.15, 0.9) }}
              >
                <Label value="Press 3 to Drop!" fontSize={S(24)} color={Color4.create(1, 0.9, 0.3, 1)} font="sans-serif" />
              </UiEntity>
            </UiEntity>
          )
        ) : null
      })()}

      {/* Death overlays */}
      <DeathOverlay visible={getRespawnCountdown() > 0} message="You Drowned!" fadeOpacity={getDrownFadeOpacity()} showText={isDrownTextVisible()} respawnCountdown={getRespawnCountdown()} />
      <DeathOverlay visible={isLightningRespawning()} message="You were struck by lightning!" fadeOpacity={getLightningFadeOpacity()} showText={isLightningTextVisible()} respawnCountdown={getLightningRespawnCountdown()} />
      <DeathOverlay visible={isGhostDeathRespawning()} message="You were scared to death!" fadeOpacity={getGhostDeathFadeOpacity()} showText={isGhostDeathTextVisible()} respawnCountdown={getGhostDeathRespawnCountdown()} />

      {/* Spectator mode */}
      {spectatorState.active && <SpectatorHUD mobile={mobile} />}

      {/* Title Splash */}
      {cinematicState.titleSplashVisible && (
        <UiEntity uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
          
          onMouseDown={() => { cinematicState.titleSplashVisible = false; setWinConditionOverlayVisible(true) }}
        >
          <UiEntity uiTransform={{ width: S(420), padding: { top: S(32), bottom: S(32), left: S(24), right: S(24) }, borderRadius: S(16), flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
            uiBackground={{ color: PANEL_BG }}
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
// SPECTATOR HUD
// ═══════════════════════════════════════════════════════════

const SPEC_MODES: { key: SpectatorMode; label: string }[] = [
  { key: 'flag', label: 'Follow Flag' },
  { key: 'player', label: 'Follow Player' },
]

function SpectatorHUD({ mobile }: { mobile: boolean }) {
  const mode = spectatorState.mode
  const players = getPlayersWithHoldTimes()
  const carrierUserId = getCurrentFlagCarrierUserId()

  const controlsHint = 'W/S = Zoom  |  A/D = Orbit  |  E/F = Up/Down'

  const TAB_BG = Color4.create(0.2, 0.2, 0.25, 0.9)
  const TAB_ACTIVE = Color4.create(0.9, 0.75, 0.2, 1)
  const PANEL = Color4.create(0.08, 0.08, 0.1, 0.94)

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: mobile ? 60 : S(16), left: 0 }, width: '100%', flexDirection: 'column', alignItems: 'center', pointerFilter: 'none' }}>
      {/* Mobile player picker (above bar) */}
      {mobile && mode === 'player' && spectatorState.playerPickerOpen && players.length > 0 && (
        <UiEntity uiTransform={{ flexDirection: 'column', width: 280, maxHeight: 260, margin: { bottom: 4 }, borderRadius: 10, padding: { top: 6, bottom: 6 } }}
          uiBackground={{ color: PANEL }}
        >
          {players.map((p, i) => {
            const isCarrier = carrierUserId !== null && p.userId.toLowerCase() === carrierUserId.toLowerCase()
            const isSelected = spectatorState.followPlayerId?.toLowerCase() === p.userId.toLowerCase()
            return (
              <UiEntity key={`sp-${i}`}
                uiTransform={{ height: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: { left: 12, right: 12 }, borderRadius: 6, margin: { left: 4, right: 4, top: 2, bottom: 2 } }}
                uiBackground={{ color: isSelected ? Color4.create(0.9, 0.75, 0.2, 0.25) : Color4.create(0, 0, 0, 0) }}
                onMouseDown={() => { selectFollowPlayer(p.userId, p.name) }}
              >
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                  {isCarrier && <UiEntity uiTransform={{ width: 16, height: 16, margin: { right: 4 } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />}
                  <Label value={p.name} fontSize={18} color={isSelected ? TAB_ACTIVE : LIGHT_GREY} font="sans-serif" />
                </UiEntity>
              </UiEntity>
            )
          })}
        </UiEntity>
      )}

      {/* Main bar */}
      {mobile ? (
        <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', borderRadius: 18, padding: { top: 12, bottom: 12, left: 12, right: 12 } }}
          uiBackground={{ color: PANEL }}
        >
          {[...SPEC_MODES, { key: 'exit' as any, label: '×' }].map((m, i) => {
            const isExit = m.key === 'exit'
            const isActive = !isExit && mode === m.key
            return (
              <UiEntity key={`tab-${i}`}
                uiTransform={{ height: 60, width: isExit ? 60 : undefined, padding: isExit ? undefined : { left: 24, right: 24 }, margin: { left: i > 0 ? 6 : 0 }, borderRadius: 12, justifyContent: 'center', alignItems: 'center' }}
                uiBackground={{ color: isActive ? TAB_ACTIVE : TAB_BG }}
                onMouseDown={() => {
                  if (isExit) {
                    exitSpectatorMode()
                  } else if (m.key === 'player' && mode === 'player') {
                    spectatorState.playerPickerOpen = !spectatorState.playerPickerOpen
                  } else {
                    setSpectatorMode(m.key)
                  }
                }}
              >
                <Label value={m.label} fontSize={isExit ? 60 : 26} color={isActive ? Color4.Black() : Color4.White()} font="sans-serif" uiTransform={isExit ? { margin: { top: -10 } } : undefined} />
              </UiEntity>
            )
          })}
        </UiEntity>
      ) : (
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {/* Desktop player picker (above bar, same width) */}
          {mode === 'player' && spectatorState.playerPickerOpen && players.length > 0 && (
            <UiEntity uiTransform={{ flexDirection: 'column', maxHeight: S(240), borderRadius: S(10), padding: { top: S(4), bottom: S(4) }, margin: { bottom: S(4) } }}
              uiBackground={{ color: PANEL }}
            >
              {players.map((p, i) => {
                const isCarrier = carrierUserId !== null && p.userId.toLowerCase() === carrierUserId.toLowerCase()
                const isSelected = spectatorState.followPlayerId?.toLowerCase() === p.userId.toLowerCase()
                return (
                  <UiEntity key={`sp-${i}`}
                    uiTransform={{ height: S(32), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: { left: S(10), right: S(10) }, borderRadius: S(6), margin: { left: S(4), right: S(4), top: S(1), bottom: S(1) } }}
                    uiBackground={{ color: isSelected ? Color4.create(0.9, 0.75, 0.2, 0.25) : Color4.create(0, 0, 0, 0) }}
                    onMouseDown={() => { selectFollowPlayer(p.userId, p.name) }}
                  >
                    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                      {isCarrier && <UiEntity uiTransform={{ width: S(14), height: S(14), margin: { right: S(4) } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />}
                      <Label value={p.name} fontSize={S(15)} color={isSelected ? TAB_ACTIVE : LIGHT_GREY} font="sans-serif" />
                    </UiEntity>
                  </UiEntity>
                )
              })}
            </UiEntity>
          )}

          {/* Main bar */}
          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', borderRadius: S(14), padding: { top: S(10), bottom: S(10), left: S(10), right: S(10) } }}
            uiBackground={{ color: PANEL }}
          >
            {/* Mode tabs + close button in one row */}
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: S(6) } }}>
              {SPEC_MODES.map((m, i) => {
                const isActive = mode === m.key
                return (
                  <UiEntity key={`tab-${i}`}
                    uiTransform={{ height: S(34), padding: { left: S(16), right: S(16) }, margin: { left: i > 0 ? S(4) : 0 }, borderRadius: S(10), justifyContent: 'center', alignItems: 'center' }}
                    uiBackground={{ color: isActive ? TAB_ACTIVE : TAB_BG }}
                    onMouseDown={() => {
                      if (m.key === 'player') {
                        if (mode !== 'player') {
                          setSpectatorMode(m.key)
                        } else {
                          spectatorState.playerPickerOpen = !spectatorState.playerPickerOpen
                        }
                      } else {
                        setSpectatorMode(m.key)
                      }
                    }}
                  >
                    <Label value={m.label} fontSize={S(14)} color={isActive ? Color4.Black() : Color4.White()} font="sans-serif" />
                  </UiEntity>
                )
              })}
              {/* Close button */}
              <UiEntity
                uiTransform={{ height: S(34), width: S(34), margin: { left: S(4) }, borderRadius: S(10), justifyContent: 'center', alignItems: 'center' }}
                uiBackground={{ color: hover.closeSpectator ? Color4.create(0.35, 0.3, 0.3, 0.95) : TAB_BG }}
                onMouseEnter={() => { hover.closeSpectator = true }}
                onMouseLeave={() => { hover.closeSpectator = false }}
                onMouseDown={() => { playClickSound(); exitSpectatorMode(); hover.closeSpectator = false }}
              >
                <Label value="×" fontSize={S(28)} color={hover.closeSpectator ? Color4.create(0.85, 0.85, 0.9, 1) : CLOSE_GREY} font="sans-serif" textAlign="middle-center" uiTransform={{ width: '100%', height: '100%', margin: { top: S(-4), left: S(2) } }} />
              </UiEntity>
            </UiEntity>

            {/* Controls hint */}
            <Label value={controlsHint} fontSize={S(12)} color={Color4.create(1, 1, 1, 0.6)} font="sans-serif" />
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
          <Label value="Round Over" fontSize={mobile ? 72 : S(46)} color={GOLD} font="sans-serif" />
          <UiEntity uiTransform={{ height: mobile ? 16 : S(12) }} />
          <Label value="No coins earned" fontSize={mobile ? 38 : S(24)} color={MUTED} font="sans-serif" />
        </UiEntity>
      )}

      {/* Earnings breakdown */}
      {activeRoundEarnings && (
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
          <UiEntity uiTransform={{ width: mobile ? 420 : S(320), padding: { top: mobile ? 20 : S(22), bottom: mobile ? 24 : S(28), left: mobile ? 24 : S(18), right: mobile ? 24 : S(18) }, flexDirection: 'column', alignItems: 'center' }}
            uiBackground={{ textureMode: 'nine-slices', texture: { src: 'assets/images/rounded-outline.png' }, textureSlices: { top: 0.25, bottom: 0.25, left: 0.25, right: 0.25 }, color: Color4.White() }}
          >
            <Label value="You Earned" fontSize={mobile ? 56 : S(46)} color={GOLD} font="sans-serif" />
            <UiEntity uiTransform={{ height: mobile ? 16 : S(18) }} />
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
              <UiEntity uiTransform={{ width: mobile ? 48 : S(48), height: mobile ? 48 : S(48), margin: { right: mobile ? 14 : S(14) } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.White() }} />
              <Label value={`+${activeRoundEarnings.total}`} fontSize={mobile ? 76 : S(62)} color={GOLD} font="sans-serif" />
            </UiEntity>
            <UiEntity uiTransform={{ height: mobile ? 20 : S(20) }} />
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

      {!mobile && creditsCountdown > 0 && (
        <Label value={`Next round in ${Math.ceil(creditsCountdown)}...`} fontSize={S(26)} color={GOLD} font="sans-serif" uiTransform={{ positionType: 'absolute', position: { bottom: '3%' }, width: '100%', justifyContent: 'center' }} />
      )}
    </UiEntity>
  )
}
