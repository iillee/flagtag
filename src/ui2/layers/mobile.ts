import { Layer } from '@stom66/dcl-ui-component-kit'
import { mobileLayoutLayer } from './MobileLayoutLayer'
import { compassLayer } from './CompassLayer'
import { chestPopupLayer } from './ChestPopupLayer'
import { mailboxLayer } from './MailboxLayer'
import { blessingLayer } from './BlessingLayer'
import { blessingCompletedLayer } from './BlessingCompletedLayer'
import { gravestoneLayer } from './GravestoneLayer'
import { cinematicFadeLayer } from './CinematicFadeLayer'
import { hudBarsLayer } from './HudBarsLayer'
import { deathOverlayLayer } from './DeathOverlayLayer'
import { hitFlashLayer } from './HitFlashLayer'
import { underwaterLayer } from './UnderwaterLayer'
import { lightningWarningLayer } from './LightningWarningLayer'
import { spectatorLayer } from './SpectatorLayer'
import { serverDownLayer } from './ServerDownLayer'
import { titleSplashLayer } from './TitleSplashLayer'

// Mobile layer stack. MobileLayout renders the HUD + built-in overlays
// (scoreboard, HowToPlay, RoundEndSplash). Interactive popups triggered by
// clicking in-world objects (chest, mailbox, altar, gravestone) are DUCK
// layers shared with desktop and toggled by updateXxxLayerVisibility().
//
// Order matters: later entries paint on top of earlier ones.
//
// Intentionally NOT included (see desktop.ts for the full list):
//   - hudTopLayer / hudTopRightLayer / hudBottomLayer / hudBarsLayer positional
//     variants — mobile uses MobileLayoutLayer for its custom HUD
//   - leaderboardLayer / howToPlayLayer / roundEndSplashLayer — rendered
//     inside MobileLayout
//   - uiScaleToastLayer — desktop keyboard-shortcut feedback, no mobile equivalent
export const mobileLayers: Layer[] = [
  mobileLayoutLayer,
  compassLayer,

  // Visual effects + situational overlays (previously desktop-only — the ui2
  // refactor left mobile without drown/scare bars, hit flashes, underwater
  // tint, lightning warnings, or the black death fade. All are driven by
  // updateXxxLayerVisibility() in ui2/index.ts which already runs on both
  // platforms, so registering them here is sufficient.)
  hudBarsLayer,
  hitFlashLayer,
  underwaterLayer,
  cinematicFadeLayer,
  lightningWarningLayer,
  spectatorLayer,
  blessingLayer,
  blessingCompletedLayer,

  // Click-driven popups (must be registered so they can be shown on mobile)
  mailboxLayer,
  gravestoneLayer,
  chestPopupLayer,

  // High-priority overlays
  deathOverlayLayer,

  // Highest-priority blockers
  serverDownLayer,
  titleSplashLayer,
]
