import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { StatusPopup } from '../../ui/screens/LeaderboardOverlay'
import { getLeaderboardOverlayVisible } from '../../gameState/overlayState'

// MARK: LeaderboardLayer
// Full-screen overlay hosting the Status/Inventory popup. Visibility is
// driven by getLeaderboardOverlayVisible() from a per-frame system.
export class LeaderboardLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-leaderboard',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    return [
      <UiEntity key="popup" uiTransform={{ positionType: 'absolute', position: { top: 0, right: 0, bottom: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}>
        <StatusPopup />
      </UiEntity>,
    ]
  }
}

export const leaderboardLayer = new LeaderboardLayer()

export function updateLeaderboardLayerVisibility() {
  if (getLeaderboardOverlayVisible()) leaderboardLayer.show(0)
  else leaderboardLayer.hide(0)
}
