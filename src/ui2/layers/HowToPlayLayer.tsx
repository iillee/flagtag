import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { HowToPlayOverlay } from '../../ui/screens/HowToPlay'
import { getWinConditionOverlayVisible } from '../../gameState/overlayState'

// MARK: HowToPlayLayer
// Full-screen overlay hosting the HowToPlay / rules / tabs panel.
// Visibility mirrors getWinConditionOverlayVisible() (toggled by the ? button).
export class HowToPlayLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-howtoplay',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    return [
      <UiEntity
        key="popup"
        uiTransform={{
          positionType: 'absolute',
          position: { top: 0, right: 0, bottom: 0, left: 0 },
          width: '100%', height: '100%',
          pointerFilter: 'none',
        }}
      >
        <HowToPlayOverlay />
      </UiEntity>,
    ]
  }
}

export const howToPlayLayer = new HowToPlayLayer()

export function updateHowToPlayLayerVisibility() {
  if (getWinConditionOverlayVisible()) howToPlayLayer.show(0)
  else howToPlayLayer.hide(0)
}
