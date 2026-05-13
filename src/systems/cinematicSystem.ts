import { engine, Transform, VirtualCamera, MainCamera, InputModifier } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { movePlayerTo, triggerEmote } from '~system/RestrictedActions'
import { setCinematicFade, setCinematicShowing, setNextRoundStartingVisible, setCreditsCountdown, setNoScorersCreditsVisible, hideMailboxPopup, hideChestPopup } from '../ui'
import { setCinematicActive } from '../gameState/cinematicState'
import { setWinConditionOverlayVisible } from '../gameState/winConditionOverlayState'
import { setLeaderboardOverlayVisible } from '../gameState/leaderboardOverlayState'
import { setAnalyticsOverlayVisible } from '../gameState/analyticsOverlayState'
import { cancelDrownRespawn } from './waterSystem'
import { cancelLightningRespawn } from './lightningSystem'
import { exitSpectatorMode } from './spectatorSystem'
import { room } from '../shared/messages'
import { clearSpeedBoost } from './speedBoostSystem'

// ── Camera entities ──
const GREEN_CUBE_POS = Vector3.create(258.78, 19.25, 227.81)
const RED_CUBE_POS = Vector3.create(265.57, 19.51, 219.65)

let cinematicCam = 0 as ReturnType<typeof engine.addEntity>
let lookTarget = 0 as ReturnType<typeof engine.addEntity>

// ── State ──
let cinematicTimer = 0
let isWinnerLocalPlayer = false
let isPodiumPlayer = false
let noScorersRound = false

// Fade state machine: 0=idle, 1=fading in, 2=holding black, 3=fading out (reveal), 4=showing, 5=end fade in, 6=end hold black, 7=end fade out
let fadePhase = 0
let fadeTimer = 0
const FADE_IN_DUR = 1.5
const FADE_HOLD_DUR = 0.3
const FADE_OUT_DUR = 1.0
const END_FADE_IN_DUR = 0.8
const END_FADE_HOLD_DUR = 0.3
const END_FADE_OUT_DUR = 0.8

// ── Grounded emote helper ──
let pendingEmote: { emote: string } | null = null
const STABLE_EPSILON = 0.01
const STABLE_FRAMES = 5
const EMOTE_TIMEOUT = 6.0
const EMOTE_MIN_DELAY = 0.5
let stableCount = 0
let emoteElapsed = 0
let lastPlayerY = 0

function waitForGroundedEmote(emote: string) {
  pendingEmote = { emote }
  stableCount = 0
  emoteElapsed = 0
  lastPlayerY = -9999
}

/**
 * Sets up the cinematic camera entities, fade system, grounded-emote system,
 * and the respawnPlayers message handler.
 */
export function setupCinematicSystem(): void {
  cinematicCam = engine.addEntity()
  Transform.create(cinematicCam, { position: GREEN_CUBE_POS })
  lookTarget = engine.addEntity()
  Transform.create(lookTarget, { position: RED_CUBE_POS })
  VirtualCamera.create(cinematicCam, {
    lookAtEntity: lookTarget,
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.01) }
  })

  // Grounded-emote system
  engine.addSystem((dt: number) => {
    if (!pendingEmote) return
    emoteElapsed += dt
    if (emoteElapsed >= EMOTE_TIMEOUT) {
      void triggerEmote({ predefinedEmote: pendingEmote.emote }).catch(() => {})
      pendingEmote = null
      return
    }
    if (emoteElapsed < EMOTE_MIN_DELAY) return
    const playerY = Transform.get(engine.PlayerEntity).position.y
    const deltaY = Math.abs(playerY - lastPlayerY)
    lastPlayerY = playerY
    if (deltaY < STABLE_EPSILON) {
      stableCount++
      if (stableCount >= STABLE_FRAMES) {
        void triggerEmote({ predefinedEmote: pendingEmote.emote }).catch(() => {})
        pendingEmote = null
      }
    } else {
      stableCount = 0
    }
  })

  // Fade overlay + cinematic timer system
  engine.addSystem((dt: number) => {
    if (fadePhase > 0) {
      fadeTimer -= dt
      if (fadePhase === 1) {
        const progress = 1 - Math.max(0, fadeTimer / FADE_IN_DUR)
        setCinematicFade(progress)
        if (fadeTimer <= 0) { setCinematicFade(1); fadePhase = 2; fadeTimer = FADE_HOLD_DUR }
      } else if (fadePhase === 2) {
        setCinematicFade(1)
        if (fadeTimer <= 0) {
          setCinematicShowing(true)
          if (noScorersRound) { setNoScorersCreditsVisible(true); fadePhase = 4 }
          else { fadePhase = 3; fadeTimer = FADE_OUT_DUR }
        }
      } else if (fadePhase === 3) {
        const progress = Math.max(0, fadeTimer / FADE_OUT_DUR)
        setCinematicFade(progress)
        if (fadeTimer <= 0) { setCinematicFade(0); fadePhase = 4 }
      } else if (fadePhase === 4) {
        if (noScorersRound) setCreditsCountdown(Math.max(0, cinematicTimer))
      } else if (fadePhase === 5) {
        const progress = 1 - Math.max(0, fadeTimer / END_FADE_IN_DUR)
        setCinematicFade(progress)
        if (fadeTimer <= 0) {
          setCinematicFade(1)
          setCinematicShowing(false)
          MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = undefined as any
          if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
          if (isPodiumPlayer) {
            isWinnerLocalPlayer = false
            isPodiumPlayer = false
            void movePlayerTo({ newRelativePosition: { x: 261.75 + Math.random() * 3, y: 47.48, z: 296.5 + Math.random() * 3 } })
          }
          fadePhase = 6
          fadeTimer = 15.0
          setNextRoundStartingVisible(true)
        }
      } else if (fadePhase === 6) {
        setCinematicFade(1)
        setCreditsCountdown(Math.max(0, fadeTimer))
        if (fadeTimer <= 0) { setNextRoundStartingVisible(false); setCreditsCountdown(0); fadePhase = 7; fadeTimer = END_FADE_OUT_DUR }
      } else if (fadePhase === 7) {
        const progress = Math.max(0, fadeTimer / END_FADE_OUT_DUR)
        setCinematicFade(progress)
        if (fadeTimer <= 0) { setCinematicFade(0); fadePhase = 0; setCinematicActive(false) }
      }
    }

    if (cinematicTimer <= 0) return
    cinematicTimer -= dt
    if (cinematicTimer <= 0 && fadePhase === 4) {
      if (noScorersRound) {
        setCinematicShowing(false); setNoScorersCreditsVisible(false); setCreditsCountdown(0)
        if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
        fadePhase = 7; fadeTimer = END_FADE_OUT_DUR
        return
      }
      fadePhase = 5; fadeTimer = END_FADE_IN_DUR
    }
  })

  // ── respawnPlayers message handler ──
  room.onMessage('respawnPlayers', (data) => {
    const localPlayer = getPlayer()
    const localUserId = localPlayer?.userId?.toLowerCase() ?? ''

    let topPlayers: Array<{ userId: string; seconds: number }> = []
    if (data.winnersJson) {
      try {
        const parsed = JSON.parse(data.winnersJson) as Array<{ userId?: string; seconds: number }>
        topPlayers = parsed.filter(d => d.userId && d.seconds > 0).map(d => ({ userId: d.userId!.toLowerCase(), seconds: d.seconds }))
      } catch { /* ignore */ }
    }

    const place1 = topPlayers[0]?.userId ?? null
    const place2 = topPlayers[1]?.userId ?? null
    const place3 = topPlayers[2]?.userId ?? null
    isWinnerLocalPlayer = !!(place1 && place1 === localUserId)
    const isSecondPlace = !!(place2 && place2 === localUserId)
    const isThirdPlace = !!(place3 && place3 === localUserId)
    isPodiumPlayer = isWinnerLocalPlayer || isSecondPlace || isThirdPlace
    noScorersRound = topPlayers.length === 0

    const GREEN_CUBE = { x: 258.78, y: 19.25, z: 227.81 }

    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({
        disableWalk: true, disableRun: true, disableJump: true,
        disableJog: true, disableGliding: true, disableDoubleJump: true,
      })
    })

    cancelDrownRespawn()
    cancelLightningRespawn()
    clearSpeedBoost()

    fadePhase = 1
    fadeTimer = FADE_IN_DUR
    setCinematicActive(true)
    cinematicTimer = 15

    setWinConditionOverlayVisible(false)
    setLeaderboardOverlayVisible(false)
    setAnalyticsOverlayVisible(false)
    hideMailboxPopup()
    hideChestPopup()
    exitSpectatorMode()

    setTimeout(() => {
      if (noScorersRound) {
        void movePlayerTo({ newRelativePosition: { x: 261.75 + Math.random() * 3, y: 47.48, z: 296.5 + Math.random() * 3 } })
      } else if (isWinnerLocalPlayer) {
        void movePlayerTo({ newRelativePosition: { x: 265.57, y: 19.51, z: 219.65 }, cameraTarget: GREEN_CUBE })
        waitForGroundedEmote('handsair')
      } else if (isSecondPlace) {
        void movePlayerTo({ newRelativePosition: { x: 266.97, y: 18.85, z: 220.87 }, cameraTarget: GREEN_CUBE })
        waitForGroundedEmote('clap')
      } else if (isThirdPlace) {
        void movePlayerTo({ newRelativePosition: { x: 264.25, y: 18.16, z: 218.57 }, cameraTarget: GREEN_CUBE })
        waitForGroundedEmote('clap')
      } else {
        void movePlayerTo({ newRelativePosition: { x: 261.75 + Math.random() * 3, y: 47.48, z: 296.5 + Math.random() * 3 } })
      }

      if (!noScorersRound) {
        MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = cinematicCam
      }
    }, FADE_IN_DUR * 1000 + 50)
  })
}
