import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { isMobile } from '@dcl/sdk/platform'
import { Background, Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { S } from '../../ui/uiConstants'
import { getCurrentFlagCarrierUserId } from '../../gameState/flagHoldTime'
import { isLightningWarningActive } from '../../systems/lightningSystem'
import { requestManualDrop } from '../../systems/flagSystem'

// MARK: LightningWarningLayer
// "Press 3 to Drop!" hint shown to the flag carrier when lightning sparks
// start. Mobile shows a tappable "Drop Flag!" button instead.
function isLocalCarrier(): boolean {
  const p = getPlayer()
  const c = getCurrentFlagCarrierUserId()
  return !!(p && c && p.userId?.toLowerCase() === c.toLowerCase())
}

export class LightningWarningLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-lightning-warning',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    if (!isLightningWarningActive() || !isLocalCarrier()) return null
    const mobile = isMobile()
    const gold = Color4.create(1, 0.9, 0.3, 1)

    if (mobile) {
      return [
        <UiEntity key="mob" uiTransform={{ positionType: 'absolute', position: { bottom: 140 }, width: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
          <UiEntity
            uiTransform={{ padding: { top: 16, bottom: 16, left: 32, right: 32 } }}
            onMouseDown={() => { requestManualDrop() }}
          >
            <Background backgroundColor={Color4.create(0.15, 0.1, 0.05, 0.92)} borderRadius={14} />
            <Label value="Drop Flag!" fontSize={38} color={gold} font="sans-serif" />
          </UiEntity>
        </UiEntity>,
      ]
    }
    return [
      <UiEntity key="desk" uiTransform={{ positionType: 'absolute', position: { bottom: S(180) }, width: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', pointerFilter: 'none' }}>
        <UiEntity uiTransform={{ padding: { top: S(10), bottom: S(10), left: S(20), right: S(20) } }}>
          <Background backgroundColor={Color4.create(0.1, 0.1, 0.15, 0.9)} borderRadius={S(10)} />
          <Label value="Press 3 to Drop!" fontSize={S(24)} color={gold} font="sans-serif" />
        </UiEntity>
      </UiEntity>,
    ]
  }
}

export const lightningWarningLayer = new LightningWarningLayer()

export function updateLightningWarningLayerVisibility() {
  if (isLightningWarningActive() && isLocalCarrier()) lightningWarningLayer.show(0)
  else lightningWarningLayer.hide(0)
}
