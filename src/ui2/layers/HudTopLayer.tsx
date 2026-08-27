import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { formatCountdown, GOLD, PANEL_BG, WHITE, S, _BORDER_RADIUS } from '../../ui/uiConstants'
import { getCountdownSeconds } from '../../shared/components'
import { isCinematicActive } from '../../gameState/cinematicState'
import { splashState } from '../../ui/uiState'

// MARK: HudTopLayer
// Round countdown, centered along the top. Hidden during splash/cinematic
// or when no round is active. Turns gold in the final 10s.
export class HudTopLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-hud-top',
      zone: ZoneType.TopCenter,
      canBeHidden: true,
      startHidden: true,
      // Don't override the zone's width/positioning — let TopCenter's 50%
      // width + 25% left anchor stay so the chip centers on the screen.
    })
  }

  protected body() {
    const seconds = getCountdownSeconds()
    const color = seconds <= 10 ? GOLD : WHITE

    // Sized chip: content-driven width + comfortable padding, no border,
    // no full-width background chrome.
    return [
      <UiEntity
        key="chip"
        uiTransform={{
          width: 'auto',
          height: 'auto',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          padding: { top: S(10), bottom: S(10), left: S(20), right: S(20) },
          borderRadius: S(_BORDER_RADIUS),
          borderWidth: 0,
        }}
        uiBackground={{ color: PANEL_BG }}
      >
        <Label
          value={formatCountdown(seconds)}
          fontSize={S(42)}
          color={color}
          font="sans-serif"
          textAlign="middle-center"
        />
      </UiEntity>,
    ]
  }
}

export const hudTopLayer = new HudTopLayer()

export function updateHudTopLayerVisibility() {
  const shouldShow = !splashState.visible && !isCinematicActive() && getCountdownSeconds() > 0
  if (shouldShow) hudTopLayer.show(0)
  else hudTopLayer.hide(0)
}
