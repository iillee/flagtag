import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { S } from '../../ui/uiConstants'
import { ProgressBar } from '../../ui/components/ProgressBar'
import { getDrownFraction, isDrownBarVisible } from '../../systems/waterSystem'
import { getScareFraction, isScareBarVisible } from '../../systems/ghostSystem'

// MARK: HudBarsLayer
// Overlay bars that anchor above the ability bar: Drown (breath) and Scare.
// Uses a FullScreen zone so ProgressBar's own absolute positioning works.
export class HudBarsLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-hud-bars',
      zone: ZoneType.FullScreen,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    const drownVisible = isDrownBarVisible()
    const scareVisible = isScareBarVisible()

    const bars: ReactEcs.JSX.Element[] = []

    if (drownVisible) {
      const fraction = getDrownFraction()
      const fillColor = fraction < 0.25
        ? Color4.create(1, 0.3, 0.3, 0.95)
        : Color4.create(0.2, 0.5, 1.0, 0.95)
      bars.push(
        <UiEntity
          key="drown"
          uiTransform={{
            positionType: 'absolute',
            position: { top: 0, right: 0, bottom: 0, left: 0 },
            width: '100%', height: '100%',
            pointerFilter: 'none',
          }}
        >
          <ProgressBar fraction={fraction} fillColor={fillColor} bottomOffset={S(110)} />
        </UiEntity>,
      )
    }

    if (scareVisible) {
      const fraction = getScareFraction()
      const fillColor = fraction > 0.75
        ? Color4.create(1, 0.3, 0.3, 0.95)
        : Color4.create(0.55, 0.55, 0.55, 0.95)
      const bottomOffset = drownVisible ? S(128) : S(110)
      bars.push(
        <UiEntity
          key="scare"
          uiTransform={{
            positionType: 'absolute',
            position: { top: 0, right: 0, bottom: 0, left: 0 },
            width: '100%', height: '100%',
            pointerFilter: 'none',
          }}
        >
          <ProgressBar fraction={fraction} fillColor={fillColor} bottomOffset={bottomOffset} />
        </UiEntity>,
      )
    }

    return bars
  }
}

export const hudBarsLayer = new HudBarsLayer()
