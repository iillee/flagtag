/**
 * HowToPlay — 3-column card overlay (Flag, Combat, Win+Controls).
 * Shared between desktop and mobile.
 */
import { GAME_VERSION } from '../../version'
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { S, GOLD, MUTED, WHITE, CLOSE_GREY } from '../uiConstants'
import { hover, notifyOverlayClosed } from '../uiState'
import { getEquippedTape } from './boomboxState'
import { setWinConditionOverlayVisible } from '../../gameState/overlayState'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { KeyBinding } from '../components/KeyBinding'

const CLOSE_HOVER = Color4.create(0.85, 0.85, 0.9, 1)

export function HowToPlayOverlay() {
  const mobile = isMobile()
  const s = mobile ? (v: number) => v : S
  const cardW = mobile ? '32%' : S(280)
  const cardH = mobile ? 480 : S(480)
  const cardPad = mobile
    ? { top: 14, bottom: 14, left: 16, right: 16 }
    : { top: S(14), bottom: S(14), left: S(16), right: S(16) }
  const cardBg = Color4.create(0.15, 0.12, 0.12, 0.92)
  const titleFs = mobile ? 28 : S(28)
  const bodyFs = mobile ? 13 : S(13)

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { left: S(0), top: S(0) },
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        pointerFilter: 'none',
      }}
    >
      <UiEntity
        uiTransform={{
          flexDirection: 'row',
          justifyContent: mobile ? 'center' : 'space-between',
          alignItems: 'stretch',
          width: mobile ? '56%' : S(880),
          margin: { bottom: mobile ? 14 : S(12) },
        }}
        onMouseDown={() => {}}
      >
        {/* Flag Card */}
        <UiEntity
          uiTransform={{
            width: cardW,
            height: cardH,
            flexDirection: 'column',
            alignItems: 'center',
            borderRadius: mobile ? 16 : S(16),
            padding: cardPad,
            margin: { right: mobile ? 4 : S(8) },
          }}
          uiBackground={{ color: cardBg }}
        >
          <Label value="Flag" fontSize={titleFs} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: s(12) } }} />
          <Label value={"Find the Flag by following\nthe gold beacon"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: s(4) } }} />
          <UiEntity
            uiTransform={{ width: s(160), flexGrow: 1, borderRadius: s(8), margin: { top: s(4) } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/beacon2.png' } }}
          />
          <Label value={"Move close to the Flag to pickup\nor steal it from another player"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { top: s(8) } }} />
        </UiEntity>

        {/* Combat Card */}
        <UiEntity
          uiTransform={{
            width: cardW,
            height: cardH,
            flexDirection: 'column',
            alignItems: 'center',
            borderRadius: mobile ? 16 : S(16),
            padding: cardPad,
            margin: { left: mobile ? 4 : S(4), right: mobile ? 4 : S(4) },
          }}
          uiBackground={{ color: cardBg }}
        >
          <Label value="Combat" fontSize={titleFs} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: s(12) } }} />
          <Label value={"Throw your boomerang (E) to\nstun rivals and force them\nto drop the Flag"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: s(10) } }} />
          <UiEntity
            uiTransform={{ width: s(120), height: s(120), margin: { bottom: s(14) } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` }, color: Color4.White() }}
          />
          <Label value={"Drop bananas (F) to block\nboomerangs and stun pursuers"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ margin: { bottom: s(10) } }} />
          <UiEntity
            uiTransform={{ width: s(81), height: s(81) }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/banana.png' }, color: Color4.White() }}
          />
          <UiEntity uiTransform={{ flexGrow: 1 }} />
          <Label value={GAME_VERSION} fontSize={s(10)} color={Color4.create(1, 1, 1, 0.35)} font="sans-serif" />
        </UiEntity>

        {/* Win + Controls Card */}
        <UiEntity
          uiTransform={{
            width: cardW,
            height: cardH,
            flexDirection: 'column',
            alignItems: 'center',
            borderRadius: mobile ? 16 : S(16),
            padding: cardPad,
            margin: { left: mobile ? 4 : S(8) },
          }}
          uiBackground={{ color: cardBg }}
          onMouseDown={() => {}}
        >
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
            <Label value="Win" fontSize={titleFs} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: s(12) } }} />
            <Label value={"Score 1 point for every\nsecond you hold the Flag"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="middle-center" uiTransform={{ margin: { bottom: s(6) } }} />
            <Label value={"Win the round by holding\nthe Flag for the longest!"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="middle-center" uiTransform={{ margin: { bottom: s(20) } }} />
            <Label value="Controls" fontSize={titleFs} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: s(16) } }} />
          </UiEntity>
          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'flex-start', padding: { left: s(32) }, margin: { bottom: s(12) } }}>
            <KeyBinding keyLabel="E" text="Throw Boomerang" s={s} />
            <KeyBinding keyLabel="F" text="Drop Trap" s={s} />
            <KeyBinding keyLabel="3" text="Drop Flag" s={s} />
            <KeyBinding keyLabel="2" text={getEquippedTape() ? "Eject Tape" : "Insert Tape"} s={s} />
            {!mobile && <KeyBinding keyLabel="1" text="Toggle UI Size" s={s} last />}
          </UiEntity>
          {/* Close X */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: S(0), right: S(0) },
              width: mobile ? 88 : S(80),
              height: mobile ? 88 : S(80),
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onMouseEnter={() => { hover.closeWinCondition = true }}
            onMouseLeave={() => { hover.closeWinCondition = false }}
            onMouseDown={() => { setWinConditionOverlayVisible(false); hover.closeWinCondition = false; notifyOverlayClosed() }}
          >
            <Label value="×" fontSize={mobile ? 52 : S(44)} color={hover.closeWinCondition ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
