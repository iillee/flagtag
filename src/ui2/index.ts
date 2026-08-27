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
  engine.addSystem(() => {
    if (isMobile()) return
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
