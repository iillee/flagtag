import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { S, GOLD, LIGHT_GREY } from '../../ui/uiConstants'
import { blessingState, CREDIT_LINES } from '../../ui/uiState'

// MARK: BlessingLayer
// Faded "Receiving the blessing of…" credits list shown while a player is
// emoting at the altar. Fades in/out with blessingState.
export class BlessingLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-blessing',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    if (!(blessingState.active || blessingState.fadeOut > 0)) return null
    const opacity = blessingState.active ? 1 : blessingState.fadeOut
    const goldFaded = Color4.create(GOLD.r, GOLD.g, GOLD.b, opacity)
    const greyFaded = Color4.create(LIGHT_GREY.r, LIGHT_GREY.g, LIGHT_GREY.b, opacity)

    return [
      <UiEntity
        key="wrap"
        uiTransform={{
          positionType: 'absolute',
          position: { top: 0, left: 0 },
          width: '100%', height: '100%',
          flexDirection: 'column', alignItems: 'center',
          pointerFilter: 'none',
        }}
      >
        <UiEntity uiTransform={{ positionType: 'absolute', width: '100%', position: { top: '18%' }, flexDirection: 'column', alignItems: 'center', pointerFilter: 'none' }}>
          <UiEntity
            uiTransform={{
              padding: { top: S(18), bottom: S(18), left: S(32), right: S(32) },
              flexDirection: 'column', alignItems: 'center', borderRadius: S(12),
            }}
            uiBackground={{ color: Color4.create(0, 0, 0, 0.6 * opacity) }}
          >
            <Label value="Receiving the blessing of..." fontSize={S(34)} color={goldFaded} font="sans-serif" />
            <UiEntity uiTransform={{ height: S(12) }} />
            {blessingState.lineIndex >= 0 && CREDIT_LINES.slice(0, blessingState.lineIndex + 1).map((line, i) => (
              <Label key={`bless-line-${i}`} value={line} fontSize={S(20)} color={greyFaded} font="sans-serif"
                uiTransform={{ margin: { top: S(4) } }} />
            ))}
          </UiEntity>
        </UiEntity>
      </UiEntity>,
    ]
  }
}

export const blessingLayer = new BlessingLayer()

export function updateBlessingLayerVisibility() {
  if (blessingState.active || blessingState.fadeOut > 0) blessingLayer.show(0)
  else blessingLayer.hide(0)
}
