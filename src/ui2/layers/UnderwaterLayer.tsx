import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { getIsUnderwater } from '../../systems/interiorSystem'

// MARK: UnderwaterLayer
// Bluish full-screen tint while the local player is submerged.
export class UnderwaterLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-underwater',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    if (!getIsUnderwater()) return null
    return [
      <UiEntity
        key="tint"
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', pointerFilter: 'none' }}
        uiBackground={{ color: Color4.create(0.15, 0.35, 0.55, 0.45) }}
      />,
    ]
  }
}

export const underwaterLayer = new UnderwaterLayer()

export function updateUnderwaterLayerVisibility() {
  if (getIsUnderwater()) underwaterLayer.show(0)
  else underwaterLayer.hide(0)
}
