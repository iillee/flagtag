import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Background, Layer, ZoneType, getTheme } from '@stom66/dcl-ui-component-kit'

import { CloseButton } from '../../ui/components/CloseButton'
import { playClickSound } from '../../ui/uiSounds'
import { S, GOLD, LIGHT_GREY } from '../../ui/uiConstants'
import { serverDownState } from '../../ui/uiState'

// MARK: ServerDownLayer
// Blocking notice shown when the multiplayer server is unreachable. Click
// panel or × to dismiss.
export class ServerDownLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-server-down',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    if (!serverDownState.visible) return null
    const theme = getTheme()
    const dismiss = () => {
      playClickSound()
      serverDownState.dismissedAt = Date.now()
      serverDownState.visible = false
    }

    return [
      <UiEntity
        key="wrap"
        uiTransform={{
          positionType: 'absolute',
          position: { top: 0, left: 0 },
          width: '100%', height: '100%',
          flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
        }}
        onMouseDown={dismiss}
      >
        <UiEntity
          uiTransform={{
            width: S(460),
            flexDirection: 'column', alignItems: 'center',
            padding: { top: S(36), bottom: S(28), left: S(40), right: S(40) },
          }}
          onMouseDown={dismiss}
        >
          <Background backgroundColor={theme.colors.body} borderRadius={theme.border.radiusLarge} />
          <CloseButton hoverKey="closeServerDown" onClose={() => { serverDownState.dismissedAt = Date.now(); serverDownState.visible = false }} />
          <Label value="Server Disconnected" fontSize={S(32)} color={GOLD} font="sans-serif"
            uiTransform={{ margin: { bottom: S(8) } }} />
          <Label
            value={`all players please leave scene\nfor 5 minutes while server resets`}
            fontSize={S(18)} color={LIGHT_GREY} font="sans-serif"
            uiTransform={{ width: S(380), height: S(48) }}
            textAlign="middle-center"
          />
        </UiEntity>
      </UiEntity>,
    ]
  }
}

export const serverDownLayer = new ServerDownLayer()

export function updateServerDownLayerVisibility() {
  if (serverDownState.visible) serverDownLayer.show(0)
  else serverDownLayer.hide(0)
}
