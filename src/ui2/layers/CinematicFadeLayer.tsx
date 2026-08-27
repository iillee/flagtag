import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { cinematicState, creditsState, earnedState } from '../../ui/uiState'
import { S } from '../../ui/uiConstants'
import { CreditsScreen } from '../../ui'

// MARK: CinematicFadeLayer
// Full-screen black fade with round-over label and (when applicable) the
// end-of-round credits/earnings screen. Oversized + negative offset so it
// bleeds past the platform's safe-area border.
export class CinematicFadeLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-cinematic-fade',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    const opacity = cinematicState.fadeOpacity
    if (opacity <= 0) return null

    const showRoundOver = cinematicState.roundOverVisible
    const showCredits =
      creditsState.noScorersVisible ||
      (creditsState.nextRoundVisible && !cinematicState.showing)

    const children: any[] = []
    if (showRoundOver) {
      children.push(
        <Label
          key="round-over"
          value="Round Over"
          fontSize={S(52)}
          color={Color4.create(1, 0.84, 0, 1)}
          font="sans-serif"
        />,
      )
    }
    if (showCredits) {
      children.push(
        <UiEntity key="credits" uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}><CreditsScreen
          activeRoundEarnings={earnedState.activeRoundEarnings}
          earnedUiPhase={earnedState.phase}
          earnedCoinsFlyProgress={earnedState.coinsFlyProgress}
          creditsCountdown={creditsState.countdown}
          mobile={false}
        /></UiEntity>,
      )
    }

    return [
      <UiEntity
        key="fade"
        uiTransform={{
          positionType: 'absolute',
          position: { top: '-10%', left: '-10%' },
          width: '120%',
          height: '120%',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
        }}
        uiBackground={{ color: Color4.create(0, 0, 0, opacity) }}
        onMouseDown={() => {}}
      >
        {children}
      </UiEntity>,
    ]
  }
}

export const cinematicFadeLayer = new CinematicFadeLayer()

export function updateCinematicFadeLayerVisibility() {
  if (cinematicState.fadeOpacity > 0) cinematicFadeLayer.show(0)
  else cinematicFadeLayer.hide(0)
}
