import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { getHitFlashAlpha } from '../../gameState/hitFlashState'

// MARK: HitFlashLayer
// Red screen flash when the local player is hit. Oversized + negative offset
// so it bleeds past the platform's safe-area border.
export class HitFlashLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-hit-flash',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    const alpha = getHitFlashAlpha()
    if (alpha <= 0) return null
    return [
      <UiEntity
        key="flash"
        uiTransform={{
          positionType: 'absolute',
          position: { top: '-10%', left: '-10%' },
          width: '120%', height: '120%',
          pointerFilter: 'none',
        }}
        uiBackground={{ color: Color4.create(0.8, 0, 0, alpha) }}
      />,
    ]
  }
}

export const hitFlashLayer = new HitFlashLayer()

export function updateHitFlashLayerVisibility() {
  if (getHitFlashAlpha() > 0) hitFlashLayer.show(0)
  else hitFlashLayer.hide(0)
}
