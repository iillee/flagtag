import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { ChestPopup } from '../../ui/screens/ChestPopup'
import { popupState } from '../../ui/uiState'

// MARK: ChestPopupLayer
// Full-screen chest shop / upgrade panel. ChestPopup has no internal
// visibility gate, so we render it only while the layer is shown.
export class ChestPopupLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-chest-popup',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    if (!popupState.chest) return null
    // Render ChestPopup as a direct child (no extra wrapper) — an extra
    // UiEntity between the Zone and ChestPopup was causing tab clicks to
    // silently no-op even though the tab buttons rendered.
    return <ChestPopup />
  }
}

export const chestPopupLayer = new ChestPopupLayer()

export function updateChestPopupLayerVisibility() {
  if (popupState.chest) chestPopupLayer.show(0)
  else chestPopupLayer.hide(0)
}
