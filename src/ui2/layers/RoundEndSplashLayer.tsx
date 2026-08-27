import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { RoundEndSplash } from '../../ui/screens/RoundEndSplash'
import { splashState } from '../../ui/uiState'

// MARK: RoundEndSplashLayer
// Full-screen winner announcement shown at round end (during cinematic).
export class RoundEndSplashLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-round-end-splash',
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
        <RoundEndSplash />
      </UiEntity>,
    ]
  }
}

export const roundEndSplashLayer = new RoundEndSplashLayer()

export function updateRoundEndSplashLayerVisibility() {
  if (splashState.visible) roundEndSplashLayer.show(0)
  else roundEndSplashLayer.hide(0)
}
