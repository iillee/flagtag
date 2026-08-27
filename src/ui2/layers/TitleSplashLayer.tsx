import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { Background, Layer, ZoneType, getTheme } from '@stom66/dcl-ui-component-kit'

import { S, GOLD, MUTED } from '../../ui/uiConstants'
import { cinematicState } from '../../ui/uiState'
import { setWinConditionOverlayVisible } from '../../gameState/overlayState'

// MARK: TitleSplashLayer
// First-load "FLAG TAG!" splash. Click anywhere to dismiss and open the win
// condition overlay.
export class TitleSplashLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-title-splash',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    if (!cinematicState.titleSplashVisible) return null
    const theme = getTheme()
    const dismiss = () => {
      cinematicState.titleSplashVisible = false
      setWinConditionOverlayVisible(true)
    }

    return [
      <UiEntity
        key="wrap"
        uiTransform={{
          positionType: 'absolute',
          position: { top: 0, left: 0 },
          width: '100%', height: '100%',
          flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
        }}
        onMouseDown={dismiss}
      >
        <UiEntity
          uiTransform={{
            padding: { top: S(24), bottom: S(24), left: S(32), right: S(32) },
            flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
          }}
          onMouseDown={dismiss}
        >
          <Background backgroundColor={theme.colors.body} borderRadius={theme.border.radiusLarge} />
          <Label value="FLAG TAG!" fontSize={S(72)} color={GOLD} font="sans-serif" textAlign="middle-center"
            uiTransform={{ width: S(380), height: S(88), margin: { bottom: S(12) } }} />
          <Label value="A multiplayer keep away game!" fontSize={S(16)} color={MUTED} font="sans-serif" textAlign="middle-center"
            uiTransform={{ width: S(300), height: S(22), margin: { bottom: S(28) } }} />
          <Label value="Click anywhere to continue" fontSize={S(14)} color={Color4.create(1, 1, 1, 0.5)} font="sans-serif" textAlign="middle-center"
            uiTransform={{ width: S(300), height: S(20) }} />
        </UiEntity>
      </UiEntity>,
    ]
  }
}

export const titleSplashLayer = new TitleSplashLayer()

export function updateTitleSplashLayerVisibility() {
  if (cinematicState.titleSplashVisible) titleSplashLayer.show(0)
  else titleSplashLayer.hide(0)
}
