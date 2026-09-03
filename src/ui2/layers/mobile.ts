import { Layer } from '@stom66/dcl-ui-component-kit'
import { mobileLayoutLayer } from './MobileLayoutLayer'
import { compassLayer } from './CompassLayer'
import { chestPopupLayer } from './ChestPopupLayer'
import { mailboxLayer } from './MailboxLayer'
import { blessingLayer } from './BlessingLayer'
import { blessingCompletedLayer } from './BlessingCompletedLayer'
import { gravestoneLayer } from './GravestoneLayer'

// Mobile layer stack. MobileLayout renders the HUD + built-in overlays
// (scoreboard, HowToPlay, RoundEndSplash). Interactive popups triggered by
// clicking in-world objects (chest, mailbox, altar, gravestone) are DUCK
// layers shared with desktop and toggled by updateXxxLayerVisibility().
export const mobileLayers: Layer[] = [
  mobileLayoutLayer,
  compassLayer,
  // Click-driven popups (must be registered so they can be shown on mobile)
  mailboxLayer,
  gravestoneLayer,
  blessingLayer,
  blessingCompletedLayer,
  chestPopupLayer,
]
