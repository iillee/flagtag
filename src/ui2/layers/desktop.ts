import { Layer } from '@stom66/dcl-ui-component-kit'
import { hudTopLayer } from './HudTopLayer'
import { hudTopRightLayer } from './HudTopRightLayer'
import { hudBottomLayer } from './HudBottomLayer'
import { hudBarsLayer } from './HudBarsLayer'
import { leaderboardLayer } from './LeaderboardLayer'
import { howToPlayLayer } from './HowToPlayLayer'
import { roundEndSplashLayer } from './RoundEndSplashLayer'
import { deathOverlayLayer } from './DeathOverlayLayer'
import { chestPopupLayer } from './ChestPopupLayer'
import { gravestoneLayer } from './GravestoneLayer'
import { uiScaleToastLayer } from './UIScaleToastLayer'
import { lightningWarningLayer } from './LightningWarningLayer'
import { hitFlashLayer } from './HitFlashLayer'
import { underwaterLayer } from './UnderwaterLayer'
import { cinematicFadeLayer } from './CinematicFadeLayer'
import { titleSplashLayer } from './TitleSplashLayer'
import { serverDownLayer } from './ServerDownLayer'
import { mailboxLayer } from './MailboxLayer'
import { blessingLayer } from './BlessingLayer'
import { blessingCompletedLayer } from './BlessingCompletedLayer'
import { spectatorLayer } from './SpectatorLayer'
import { compassLayer } from './CompassLayer'

// Desktop layer stack. Order matters: later layers paint on top of earlier ones.
export const desktopLayers: Layer[] = [
  // Persistent HUD
  compassLayer,
  hudTopLayer,
  hudTopRightLayer,
  hudBottomLayer,
  hudBarsLayer,

  // Visual effects + situational overlays
  hitFlashLayer,
  underwaterLayer,
  cinematicFadeLayer,
  blessingLayer,
  blessingCompletedLayer,
  spectatorLayer,
  lightningWarningLayer,
  uiScaleToastLayer,

  // Popups / modals (mid-priority)
  mailboxLayer,
  gravestoneLayer,

  // Overlays (higher priority — paint over popups)
  leaderboardLayer,
  howToPlayLayer,
  roundEndSplashLayer,
  chestPopupLayer,
  deathOverlayLayer,

  // Highest-priority: server-down blocker and title splash
  serverDownLayer,
  titleSplashLayer,
]
