import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Background, Layer, ZoneType, getTheme } from '@stom66/dcl-ui-component-kit'

import { CloseButton } from '../../ui/components/CloseButton'
import { S } from '../../ui/uiConstants'
import { popupState, notifyOverlayClosed, hideGravestonePopup } from '../../ui/uiState'

// MARK: GravestoneLayer
// "Here Lies …" popup, opened when interacting with a gravestone in the
// scene. First pass rewritten with DUCK primitives — good template for
// converting the rest of the modal-style overlays.
export class GravestoneLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-gravestone',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    if (!popupState.gravestone) return null
    const theme = getTheme()

    return [
      // Full-screen centering wrapper.
      <UiEntity
        key="wrap"
        uiTransform={{
          positionType: 'absolute',
          position: { top: 0, right: 0, bottom: 0, left: 0 },
          width: '100%', height: '100%',
          justifyContent: 'center', alignItems: 'center',
          pointerFilter: 'none',
        }}
      >
        {/* Panel — sized column, DUCK Background chrome. */}
        <UiEntity
          uiTransform={{
            width: S(340),
            flexDirection: 'column',
            alignItems: 'center',
            padding: { top: S(24), bottom: S(24), left: S(24), right: S(24) },
          }}
        >
          <Background backgroundColor={theme.colors.body} borderRadius={theme.border.radiusLarge} />
          <CloseButton
            hoverKey="closeWinCondition"
            onClose={() => { hideGravestonePopup(); notifyOverlayClosed() }}
          />
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <Label
              value="Here Lies"
              fontSize={S(24)}
              color={theme.colors.secondary}
              font="sans-serif"
              textAlign="middle-center"
              uiTransform={{ width: '100%', height: S(30), margin: { top: S(8), bottom: S(4) } }}
            />
            <Label
              value="Schneeflocke1"
              fontSize={S(28)}
              color={theme.colors.light}
              font="sans-serif"
              textAlign="middle-center"
              uiTransform={{ width: '100%', height: S(34), margin: { top: S(4), bottom: S(8) } }}
            />
          </UiEntity>
        </UiEntity>
      </UiEntity>,
    ]
  }
}

export const gravestoneLayer = new GravestoneLayer()

export function updateGravestoneLayerVisibility() {
  if (popupState.gravestone) gravestoneLayer.show(0)
  else gravestoneLayer.hide(0)
}
