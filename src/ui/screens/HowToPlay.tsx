/**
 * HowToPlay — 3-column card overlay (Flag, Combat, Win+Controls).
 * Shared between desktop and mobile.
 */
import { GAME_VERSION } from '../../version'
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { S, GOLD, MUTED, WHITE, CLOSE_GREY, PANEL_BG } from '../uiConstants'
import { playClickSound } from '../uiSounds'
import { hover, notifyOverlayClosed } from '../uiState'
import { setWinConditionOverlayVisible } from '../../gameState/overlayState'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { KeyBinding } from '../components/KeyBinding'

const CLOSE_HOVER = Color4.create(0.85, 0.85, 0.9, 1)

export function HowToPlayOverlay() {
  const mobile = isMobile()
  const M = 2 // mobile scale multiplier
  const s = mobile ? (v: number) => Math.round(v * M) : S
  const cardW = mobile ? '24%' : S(320)
  const cardH = mobile ? 860 : S(520)
  const cardPad = mobile
    ? { top: 18 * M, bottom: 32 * M, left: 20 * M, right: 20 * M }
    : { top: S(18), bottom: S(18), left: S(20), right: S(20) }
  const cardBg = PANEL_BG
  const titleFs = mobile ? 32 * M : S(32)
  const bodyFs = mobile ? 16 * M : S(16)

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
          width: mobile ? '78%' : S(1000),
          margin: { top: mobile ? 140 : S(40), bottom: mobile ? 14 * M : S(12) },
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
            borderRadius: mobile ? 40 : S(16),
            padding: cardPad,
            margin: { right: mobile ? 4 : S(8) },
          }}
          uiBackground={{ color: cardBg }}
        >
          <Label value="Flag" fontSize={titleFs} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: s(12) } }} />
          <Label value={"Follow the gold beacon\nto find the Flag"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ width: '100%', margin: { bottom: s(4) } }} />
          <UiEntity
            uiTransform={{ width: s(140), height: s(231), borderRadius: s(8), margin: { top: s(20), bottom: s(4) } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/beacon2.png' } }}
          />
          <Label value={"Move close to the Flag\nto pickup or steal\nfrom another player"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ width: '100%', margin: { top: s(8) } }} />
        </UiEntity>

        {/* Combat Card */}
        <UiEntity
          uiTransform={{
            width: cardW,
            height: cardH,
            flexDirection: 'column',
            alignItems: 'center',
            borderRadius: mobile ? 40 : S(16),
            padding: cardPad,
            margin: { left: mobile ? 4 : S(4), right: mobile ? 4 : S(4) },
          }}
          uiBackground={{ color: cardBg }}
        >
          <Label value="Combat" fontSize={titleFs} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: s(12) } }} />
          <Label value={"Throw boomerang (E)\nto stun rivals and force\nthem to drop the Flag"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ width: '100%', margin: { top: s(40), bottom: s(10) } }} />
          <UiEntity
            uiTransform={{ width: s(100), height: s(118), flexShrink: 0, margin: { top: s(48), bottom: s(2) } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` }, color: Color4.White() }}
          />
          <Label value={"Drop bananas (F) to\nblock boomerangs and\nstun pursuers"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ width: '100%', margin: { bottom: s(24) } }} />
          <UiEntity
            uiTransform={{ width: s(72), height: s(72), flexShrink: 0, margin: { top: s(56), bottom: s(20) } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/banana.png' }, color: Color4.White() }}
          />
          <UiEntity uiTransform={{ flexGrow: 1 }} />
          <Label value={GAME_VERSION} fontSize={s(10)} color={Color4.create(1, 1, 1, 0.35)} font="sans-serif" uiTransform={{ positionType: 'absolute', position: { bottom: s(6) } }} />
        </UiEntity>

        {/* Win + Controls Card */}
        <UiEntity
          uiTransform={{
            width: cardW,
            height: cardH,
            flexDirection: 'column',
            alignItems: 'center',
            borderRadius: mobile ? 40 : S(16),
            padding: cardPad,
            margin: { left: mobile ? 4 : S(8) },
          }}
          uiBackground={{ color: cardBg }}
          onMouseDown={() => {}}
        >
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
            <Label value="Win" fontSize={titleFs} color={GOLD} font="sans-serif" uiTransform={{ height: titleFs * 1.4, margin: { bottom: s(20) } }} />
            <Label value="Score 1 point for every" fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="middle-center" uiTransform={{ width: '100%', height: bodyFs * 1.2, margin: { bottom: s(8) } }} />
            <Label value="second you hold the Flag" fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="middle-center" uiTransform={{ width: '100%', height: bodyFs * 1.2, margin: { bottom: s(8) } }} />
            <Label value="Win the round by" fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="middle-center" uiTransform={{ width: '100%', height: bodyFs * 1.2, margin: { bottom: s(8) } }} />
            <Label value="holding the Flag" fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="middle-center" uiTransform={{ width: '100%', height: bodyFs * 1.2, margin: { bottom: s(8) } }} />
            <Label value="the longest!" fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="middle-center" uiTransform={{ width: '100%', height: bodyFs * 1.2, margin: { bottom: s(8) } }} />
            <Label value="Controls" fontSize={titleFs} color={GOLD} font="sans-serif" uiTransform={{ margin: { top: s(10), bottom: s(22) } }} />
          </UiEntity>
          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'flex-start', padding: { left: s(32) }, margin: { top: s(4), bottom: s(12) } }}>
            <KeyBinding keyLabel="E" text="Throw Boomerang" s={s} />
            <KeyBinding keyLabel="F" text="Drop Banana" s={s} />
            <KeyBinding keyLabel="3" text="Drop Flag" s={s} />
            <KeyBinding keyLabel="2" text="Mute" s={s} />
            {!mobile && <KeyBinding keyLabel="1" text="Toggle UI Size" s={s} last />}
          </UiEntity>
          {/* Close X */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: mobile ? -20 : S(0), right: mobile ? -20 : S(0) },
              width: mobile ? 88 * M : S(80),
              height: mobile ? 88 * M : S(80),
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onMouseEnter={() => { hover.closeWinCondition = true }}
            onMouseLeave={() => { hover.closeWinCondition = false }}
            onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); hover.closeWinCondition = false; notifyOverlayClosed() }}
          >
            <Label value="×" fontSize={mobile ? 52 * M : S(44)} color={hover.closeWinCondition ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
