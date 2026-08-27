import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Background, Layer, ZoneType, getTheme } from '@stom66/dcl-ui-component-kit'

import { S, getUIScaleLabel } from '../../ui/uiConstants'
import { getUIScaleFlash } from '../../ui/uiState'

// MARK: UIScaleToastLayer
// Brief toast shown when the player cycles UI scale via keybind.
export class UIScaleToastLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-ui-scale-toast',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    if (!getUIScaleFlash()) return null
    const theme = getTheme()
    return [
      <UiEntity
        key="toast"
        uiTransform={{
          positionType: 'absolute',
          position: { bottom: S(140), left: '50%' },
          margin: { left: S(-80) },
          width: S(160), height: S(32),
          flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
          pointerFilter: 'none',
        }}
      >
        <Background backgroundColor={theme.colors.body} borderRadius={S(8)} />
        <Label value={`UI: ${getUIScaleLabel()}`} fontSize={S(16)} color={theme.colors.light} font="sans-serif" />
      </UiEntity>,
    ]
  }
}

export const uiScaleToastLayer = new UIScaleToastLayer()

export function updateUIScaleToastLayerVisibility() {
  if (getUIScaleFlash()) uiScaleToastLayer.show(0)
  else uiScaleToastLayer.hide(0)
}
