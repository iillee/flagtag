/**
 * RoundEndSplash — Winner podium overlay shown during cinematic camera.
 * Shared between desktop and mobile.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { S, GOLD, SILVER, BRONZE, LIGHT_GREY, CLOSE_GREY, PANEL_BG } from '../uiConstants'
import { playClickSound } from '../uiSounds'
import { splashState, cinematicState, notifyOverlayClosed } from '../uiState'

export function RoundEndSplash() {
  const mobile = isMobile()
  const splashPlayers = splashState.players
  const cinematicShowing = cinematicState.showing

  if (!splashState.visible || !cinematicShowing || splashPlayers.length === 0) return null

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: S(0), left: S(0) },
        width: '100%',
        height: '100%',
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'flex-end',
        padding: { bottom: mobile ? 40 : S(40) },
        pointerFilter: 'none',
      }}
    >
      <UiEntity
        uiTransform={{
          positionType: 'relative',
          width: mobile ? '40%' : S(360),
          minHeight: mobile ? 80 : S(220),
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: mobile ? 16 : S(16),
          padding: mobile
            ? { top: 16, bottom: 16, left: 24, right: 24 }
            : { top: S(24), bottom: S(20), left: S(28), right: S(28) },
          overflow: 'hidden',
        }}
        uiBackground={{ color: Color4.create(0.1, 0.1, 0.1, 0.6) }}
      >
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
          <Label
            value={splashPlayers.length === 1 || splashPlayers[0].seconds > (splashPlayers[1]?.seconds ?? 0)
              ? `${splashPlayers[0].name} Wins!`
              : 'Round Over!'}
            fontSize={mobile ? 42 : S(36)}
            color={GOLD}
            font="sans-serif"
          />
          {!mobile && <UiEntity uiTransform={{ height: S(28) }} />}
          {!mobile && splashPlayers.map((p, i) => {
            const rankColor = i === 0 ? GOLD : i === 1 ? SILVER : BRONZE
            return (
              <UiEntity
                key={`splash-${i}`}
                uiTransform={{
                  width: '100%',
                  height: S(34),
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: { left: S(4), right: S(4) },
                }}
              >
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Label value={`#${i + 1}`} fontSize={S(20)} color={rankColor} font="sans-serif" />
                  <UiEntity uiTransform={{ width: S(10) }} />
                  <Label value={p.name} fontSize={S(20)} color={rankColor} font="sans-serif" />
                </UiEntity>
                <Label value={`${p.seconds}`} fontSize={S(20)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
            )
          })}

        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
