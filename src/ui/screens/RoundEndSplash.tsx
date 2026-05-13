/**
 * RoundEndSplash — Winner podium overlay shown during cinematic camera.
 * Shared between desktop and mobile.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { S, GOLD, SILVER, BRONZE, LIGHT_GREY, CLOSE_GREY, PANEL_BG } from '../uiConstants'
import { isSplashVisible, setSplashVisible, getSplashPlayers, getCinematicShowing, notifyOverlayClosed } from '../uiState'
import { playClickSound } from '../uiSounds'

export function RoundEndSplash() {
  const mobile = isMobile()
  const splashPlayers = getSplashPlayers()
  const cinematicShowing = getCinematicShowing()

  if (!isSplashVisible() || !cinematicShowing || splashPlayers.length === 0) return null

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
        padding: { bottom: mobile ? 114 : S(40) },
      }}
    >
      <UiEntity
        uiTransform={{
          positionType: 'relative',
          width: mobile ? '40%' : S(440),
          minHeight: mobile ? 300 : S(280),
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: mobile ? undefined : S(16),
          padding: mobile
            ? { top: 36, bottom: 28, left: 32, right: 32 }
            : { top: S(36), bottom: S(28), left: S(40), right: S(40) },
          overflow: 'hidden',
        }}
        uiBackground={{ color: PANEL_BG }}
      >
        {mobile && (
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: 4, right: 4 },
              width: 88, height: 88,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
            }}
            onMouseDown={() => { playClickSound(); setSplashVisible(false); notifyOverlayClosed() }}
          >
            <Label value="×" fontSize={52} color={CLOSE_GREY} font="sans-serif" />
          </UiEntity>
        )}

        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
          <Label
            value={splashPlayers.length === 1 || splashPlayers[0].seconds > (splashPlayers[1]?.seconds ?? 0)
              ? `${splashPlayers[0].name} Wins!`
              : 'Round Over!'}
            fontSize={mobile ? 42 : S(34)}
            color={GOLD}
            font="sans-serif"
          />
          <UiEntity uiTransform={{ height: mobile ? 24 : S(28) }} />
          {splashPlayers.map((p, i) => {
            const rankColor = i === 0 ? GOLD : i === 1 ? SILVER : BRONZE
            return (
              <UiEntity
                key={`splash-${i}`}
                uiTransform={{
                  width: '100%',
                  height: mobile ? 42 : S(34),
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: { left: mobile ? 8 : S(4), right: mobile ? 8 : S(4) },
                }}
              >
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Label value={`#${i + 1}`} fontSize={mobile ? 26 : S(18)} color={rankColor} font="sans-serif" />
                  <UiEntity uiTransform={{ width: mobile ? 10 : S(10) }} />
                  <Label value={p.name} fontSize={mobile ? 26 : S(18)} color={rankColor} font="sans-serif" />
                </UiEntity>
                <Label value={`${p.seconds}`} fontSize={mobile ? 26 : S(18)} color={LIGHT_GREY} font="sans-serif" />
              </UiEntity>
            )
          })}
          <UiEntity uiTransform={{ height: mobile ? 20 : S(24) }} />
          <Label value="Next round starting..." fontSize={mobile ? 22 : S(15)} color={LIGHT_GREY} font="sans-serif" uiTransform={{ width: mobile ? 500 : S(440), flexShrink: 0 }} textAlign="middle-center" />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
