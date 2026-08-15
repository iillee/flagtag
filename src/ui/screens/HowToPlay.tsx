/**
 * HowToPlay — 3-column card overlay (Flag, Combat, Win+Controls).
 * Shared between desktop and mobile.
 */
import { GAME_VERSION } from '../../version'
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { S, GOLD, MUTED, WHITE, CLOSE_GREY, PANEL_BG, MOBILE_POPUP_SCALE } from '../uiConstants'
import { playClickSound } from '../uiSounds'
import { hover, notifyOverlayClosed } from '../uiState'
import { setWinConditionOverlayVisible } from '../../gameState/overlayState'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { KeyBinding } from '../components/KeyBinding'

const CLOSE_HOVER = Color4.create(0.85, 0.85, 0.9, 1)

export function HowToPlayOverlay() {
  const mobile = isMobile()
  const M = 1.25 * MOBILE_POPUP_SCALE // mobile scale (baseline 1.25, scaled by MOBILE_POPUP_SCALE)
  const s = mobile ? (v: number) => Math.round(v * M) : S
  const cardW = mobile ? '24%' : S(320)
  const cardH = mobile ? 480 * M : S(520) // scales with M (was raw 860 at M=2 -> base 480 after visual tune)
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
      }}
      // Tap anywhere on the overlay closes it (mobile-friendly dismiss). The
      // inner card row swallows its own onMouseDown so taps inside content
      // don't accidentally dismiss. See mobile UI pass 2026-07-30.
      onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); notifyOverlayClosed() }}
    >
      <UiEntity
        uiTransform={{
          flexDirection: 'row',
          justifyContent: mobile ? 'center' : 'space-between',
          alignItems: 'stretch',
          width: mobile ? '78%' : S(1000),
          margin: { top: mobile ? 50 : S(40), bottom: mobile ? 14 * M : S(12) },
        }}
        // Was onMouseDown={() => {}} (empty swallow to block clicks bubbling to
        // the game world). That's no longer needed — the outer wrapper catches
        // all clicks now — and was blocking the tap-to-close behavior for taps
        // that landed on the cards themselves. Matching Title Splash pattern.
        onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); notifyOverlayClosed() }}
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
          <Label value={"Follow the gold beacon\nto find the Flag"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ width: '100%', margin: { bottom: mobile ? s(4) : S(24) } }} />
          <UiEntity
            uiTransform={{ width: s(140), height: s(231), borderRadius: s(8), margin: { top: mobile ? s(20) : S(40), bottom: mobile ? s(4) : S(20) } }}
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
          <Label value={mobile ? "Throw boomerang\nto stun rivals and force\nthem to drop the Flag" : "Throw boomerang (E)\nto stun rivals and force\nthem to drop the Flag"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ width: '100%', margin: { top: mobile ? s(40) : S(8), bottom: s(10) } }} />
          <UiEntity
            uiTransform={{ width: s(100), height: s(118), flexShrink: 0, margin: { top: mobile ? s(48) : S(56), bottom: s(2) } }}
            uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` }, color: Color4.White() }}
          />
          <Label value={mobile ? "Drop bananas to\nblock boomerangs and\nstun pursuers" : "Drop bananas (F) to\nblock boomerangs and\nstun pursuers"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ width: '100%', margin: { top: mobile ? 0 : S(20), bottom: s(24) } }} />
          <UiEntity
            uiTransform={{ width: s(72), height: s(72), flexShrink: 0, margin: { top: mobile ? s(56) : S(64), bottom: s(20) } }}
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
            <Label value="Win" fontSize={titleFs} color={GOLD} font="sans-serif" uiTransform={{ margin: { bottom: s(12) } }} />
            <Label value={"Score 1 point for every\nsecond you hold the Flag"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ width: '100%', margin: { bottom: mobile ? s(4) : S(24) } }} />
            <Label value={"Win the round by\nholding the Flag\nthe longest!"} fontSize={bodyFs} color={MUTED} font="sans-serif" textAlign="top-center" uiTransform={{ width: '100%', margin: { top: s(8) } }} />
            {/* Controls section is desktop-only — mobile uses on-screen
               buttons for all actions, so listing keyboard shortcuts is
               useless (and would confuse touch users). */}
            <Label value={mobile ? "Upgrades" : "Controls"} fontSize={titleFs} color={GOLD} font="sans-serif" uiTransform={{ margin: { top: mobile ? s(32) : s(10), bottom: s(22) } }} />
            {mobile && (
              <Label
                value={"Spend coins earned from\nwinning rounds at the\nchest for better gear!"}
                fontSize={bodyFs}
                color={MUTED}
                font="sans-serif"
                textAlign="middle-center"
                uiTransform={{ width: '100%', margin: { bottom: s(8) } }}
              />
            )}
            {mobile && (
              <UiEntity
                uiTransform={{ width: s(120), height: s(120), margin: { top: s(12) } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/chest.png' }, color: Color4.White() }}
              />
            )}
          </UiEntity>
          {!mobile && (
            <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'flex-start', padding: { left: s(32) }, margin: { top: s(4), bottom: s(12) } }}>
              <KeyBinding keyLabel="E" text="Throw Boomerang" s={s} />
              <KeyBinding keyLabel="F" text="Drop Banana" s={s} />
              <KeyBinding keyLabel="3" text="Drop Flag" s={s} />
              <KeyBinding keyLabel="2" text="Mute" s={s} />
              <KeyBinding keyLabel="1" text="Toggle UI Size" s={s} last />
            </UiEntity>
          )}
          {/* Close X — centered inside its own square, bold red for clarity */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: mobile ? -4 : S(0), right: mobile ? 3 : S(0) },
              width: mobile ? 68 * M : S(80),
              height: mobile ? 68 * M : S(80),
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onMouseEnter={() => { hover.closeWinCondition = true }}
            onMouseLeave={() => { hover.closeWinCondition = false }}
            onMouseDown={() => { playClickSound(); setWinConditionOverlayVisible(false); hover.closeWinCondition = false; notifyOverlayClosed() }}
          >
            {mobile ? (
              <Label
                value="×"
                fontSize={60 * M}
                color={hover.closeWinCondition ? Color4.create(1, 0.4, 0.4, 1) : Color4.create(0.9, 0.15, 0.15, 1)}
                font="sans-serif"
                textAlign="middle-center"
                uiTransform={{ width: '100%', height: '100%' }}
              />
            ) : (
              <Label value="×" fontSize={S(44)} color={hover.closeWinCondition ? CLOSE_HOVER : CLOSE_GREY} font="sans-serif" />
            )}
          </UiEntity>
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
