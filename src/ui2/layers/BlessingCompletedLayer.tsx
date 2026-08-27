import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { Background, Layer, ZoneType, getTheme } from '@stom66/dcl-ui-component-kit'

import { S, GOLD, MUTED } from '../../ui/uiConstants'
import { blessingState } from '../../ui/uiState'

// MARK: BlessingCompletedLayer
// "Blessing Received!" panel with animated coins flying up. Also shows the
// failure / already-used messages when applicable.
export class BlessingCompletedLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-blessing-completed',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    if (!blessingState.completed) return null
    const theme = getTheme()
    const coinProgress = blessingState.coinProgress

    let inner: any
    if (blessingState.failedMessage) {
      inner = <Label key="fail" value={blessingState.failedMessage} fontSize={S(24)} color={MUTED} font="sans-serif" />
    } else if (blessingState.alreadyUsed) {
      inner = <Label key="already" value="You have already received the blessing today" fontSize={S(24)} color={MUTED} font="sans-serif" />
    } else {
      // Flying coins
      const coins: any[] = []
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2
        const startX = Math.cos(angle) * 60
        const startY = 40 + Math.sin(angle) * 30
        const progress = Math.min(1, coinProgress * 1.5 - (i * 0.08))
        const cp = Math.max(0, Math.min(1, progress))
        const eased = 1 - Math.pow(1 - cp, 3)
        const x = startX * (1 - eased)
        const y = startY * (1 - eased) - (250 * eased)
        const opacity = cp < 0.1 ? cp * 10 : (cp > 0.85 ? (1 - cp) * 6.67 : 1)
        coins.push(
          <UiEntity key={`bless-coin-${i}`}
            uiTransform={{ positionType: 'absolute', position: { top: y, left: x + S(140) }, width: S(24), height: S(24) }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.create(1, 1, 1, Math.max(0, Math.min(1, opacity))) }} />,
        )
      }
      inner = (
        <UiEntity key="ok" uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
          <Label value="Blessing Received!" fontSize={S(38)} color={GOLD} font="sans-serif" />
          <UiEntity uiTransform={{ height: S(12) }} />
          <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
            <UiEntity uiTransform={{ width: S(36), height: S(36), margin: { right: S(8) } }}
              uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/coin.png' }, color: Color4.White() }} />
            <Label value="+6" fontSize={S(50)} color={GOLD} font="sans-serif" />
          </UiEntity>
          <UiEntity uiTransform={{ positionType: 'relative', width: 1, height: 1, pointerFilter: 'none' }}>{coins}</UiEntity>
        </UiEntity>
      )
    }

    return [
      <UiEntity
        key="wrap"
        uiTransform={{
          positionType: 'absolute',
          position: { top: 0, left: 0 },
          width: '100%', height: '100%',
          flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
          pointerFilter: 'none',
        }}
      >
        <UiEntity
          uiTransform={{
            width: S(340),
            padding: { top: S(24), bottom: S(24), left: S(20), right: S(20) },
            flexDirection: 'column', alignItems: 'center',
          }}
        >
          <Background backgroundColor={theme.colors.body} borderRadius={theme.border.radiusLarge} />
          {inner}
        </UiEntity>
      </UiEntity>,
    ]
  }
}

export const blessingCompletedLayer = new BlessingCompletedLayer()

export function updateBlessingCompletedLayerVisibility() {
  if (blessingState.completed) blessingCompletedLayer.show(0)
  else blessingCompletedLayer.hide(0)
}
