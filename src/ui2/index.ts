// ═══════════════════════════════════════════════════════════
// UI2 entry — DUCK-based UI rebuild
// ═══════════════════════════════════════════════════════════

import { engine } from '@dcl/sdk/ecs'
import { SetupUiComponentKit } from '@stom66/dcl-ui-component-kit'
import { flagtag } from '../themes/flagtag'
import { isMobile } from './config'
import { desktopLayers } from './layers/desktop'
import { mobileLayers } from './layers/mobile'
import { updateHudTopLayerVisibility } from './layers/HudTopLayer'
import { updateHudBottomLayerVisibility } from './layers/HudBottomLayer'
import { updateLeaderboardLayerVisibility } from './layers/LeaderboardLayer'
import { updateHowToPlayLayerVisibility } from './layers/HowToPlayLayer'
import { updateRoundEndSplashLayerVisibility } from './layers/RoundEndSplashLayer'
import { updateDeathOverlayLayerVisibility } from './layers/DeathOverlayLayer'
import { updateChestPopupLayerVisibility } from './layers/ChestPopupLayer'
import { updateGravestoneLayerVisibility } from './layers/GravestoneLayer'
import { updateUIScaleToastLayerVisibility } from './layers/UIScaleToastLayer'
import { updateLightningWarningLayerVisibility } from './layers/LightningWarningLayer'
import { updateHitFlashLayerVisibility } from './layers/HitFlashLayer'
import { updateUnderwaterLayerVisibility } from './layers/UnderwaterLayer'
import { updateCinematicFadeLayerVisibility } from './layers/CinematicFadeLayer'
import { updateTitleSplashLayerVisibility } from './layers/TitleSplashLayer'
import { updateServerDownLayerVisibility } from './layers/ServerDownLayer'
import { updateMailboxLayerVisibility } from './layers/MailboxLayer'
import { updateBlessingLayerVisibility } from './layers/BlessingLayer'
import { updateBlessingCompletedLayerVisibility } from './layers/BlessingCompletedLayer'
import { updateSpectatorLayerVisibility } from './layers/SpectatorLayer'

export { USE_NEW_UI } from './config'

export function setupUi2() {
  const layers = isMobile() ? mobileLayers : desktopLayers
  SetupUiComponentKit({
    theme: flagtag.theme,
    layers,
  })

  // Layer visibility driver — cheap per-frame checks that toggle layers on/off
  // based on game state. Layer body() renders content each frame automatically.
  //
  // Every updater below is called on BOTH platforms. Layers not registered in
  // mobileLayers / desktopLayers simply never appear in the layer stack, so
  // calling their show()/hide() is a no-op. Keeping one shared list here means
  // we only need to add or remove a layer in one place (its platform-specific
  // layer array in ./layers/{desktop,mobile}.ts) — no risk of forgetting to
  // wire the updater and shipping an invisible layer.
  //
  // (Historical note: this used to early-return on mobile after 5 updaters,
  // which meant every fade-based layer we added to mobileLayers stayed hidden
  // forever because startHidden:true was never flipped by show(0). Death
  // overlay, cinematic fade, hit flash, lightning warning, etc. were all
  // silently broken on mobile until we removed the early return.)
  engine.addSystem(() => {
    updateHudTopLayerVisibility()
    updateHudBottomLayerVisibility()
    updateLeaderboardLayerVisibility()
    updateHowToPlayLayerVisibility()
    updateRoundEndSplashLayerVisibility()
    updateDeathOverlayLayerVisibility()
    updateChestPopupLayerVisibility()
    updateGravestoneLayerVisibility()
    updateUIScaleToastLayerVisibility()
    updateLightningWarningLayerVisibility()
    updateHitFlashLayerVisibility()
    updateUnderwaterLayerVisibility()
    updateCinematicFadeLayerVisibility()
    updateTitleSplashLayerVisibility()
    updateServerDownLayerVisibility()
    updateMailboxLayerVisibility()
    updateBlessingLayerVisibility()
    updateBlessingCompletedLayerVisibility()
    updateSpectatorLayerVisibility()
  })
}
