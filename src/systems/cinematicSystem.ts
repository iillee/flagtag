import { engine, Transform, VirtualCamera, MainCamera, InputModifier, inputSystem, InputAction, Animator, VisibilityComponent, AudioSource, Name } from '@dcl/sdk/ecs'
import { registerSystem } from './systemManager'
import { Vector3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { movePlayerTo, triggerEmote } from '~system/RestrictedActions'
import { setCinematicFade, cinematicState, creditsState, hideMailboxPopup, hideChestPopup } from '../ui'
import { setCinematicActive, isCinematicActive } from '../gameState/cinematicState'
import { getCountdownSeconds } from '../shared/components'
import { setWinConditionOverlayVisible, setLeaderboardOverlayVisible } from '../gameState/overlayState'
import { cancelDrownRespawn } from './waterSystem'
import { cancelLightningRespawn } from './lightningSystem'
import { exitSpectatorMode } from './spectatorSystem'
import { room } from '../shared/messages'
import { clearSpeedBoost } from './speedBoostSystem'
import { snapshotScoresForCinematic, snapshotScoresFromWinners, clearCinematicSnapshot, getKnownPlayerName } from '../gameState/flagHoldTime'

// ── Camera entities ──
const PODIUM_CENTER = Vector3.create(387.57, 67.51, 313.65) // winner position as orbit center

let cinematicCam = 0 as ReturnType<typeof engine.addEntity>
let lookTarget = 0 as ReturnType<typeof engine.addEntity>

// ── Orbit camera state ──
const ORBIT_AUTO_SPEED = 0.15 // rad/s auto-rotation
const ORBIT_INPUT_SPEED = 0.75
const ORBIT_DEFAULT_DIST = 10
const ORBIT_MIN_DIST = 6
const ORBIT_MAX_DIST = 50
const ORBIT_DEFAULT_HEIGHT = 6
const ORBIT_MIN_HEIGHT = 2
const ORBIT_LERP = 3.0
const SCENE_W = 512
const SCENE_D = 512
const CAM_MIN_Y = 58
const CAM_MAX_Y = 148

let orbitAngle = -Math.PI * 100 / 180
let orbitDist = ORBIT_DEFAULT_DIST
let orbitHeight = ORBIT_DEFAULT_HEIGHT
let orbitLookX = PODIUM_CENTER.x
let orbitLookY = PODIUM_CENTER.y
let orbitLookZ = PODIUM_CENTER.z
let orbitActive = false

// ── Celebration effects (fireworks + confetti) ──
let fireworkEntity: ReturnType<typeof engine.addEntity> | null = null
let confettiEntity1: ReturnType<typeof engine.addEntity> | null = null
let confettiEntity2: ReturnType<typeof engine.addEntity> | null = null
let celebrationActive = false
let fireworkTimer = 0
const FIREWORK_INTERVAL = 3.5 // seconds between firework shots
const CONFETTI_INTERVAL = 10  // re-trigger confetti loop
let confettiTimer = 0

function findCelebrationEntities() {
  if (fireworkEntity && confettiEntity1 && confettiEntity2) return
  for (const [entity] of engine.getEntitiesWith(Name)) {
    const name = Name.get(entity).value
    if (name === 'Fireworks') fireworkEntity = entity
    else if (name === 'confetti' && !confettiEntity1) confettiEntity1 = entity
    else if (name === 'confetti_2') confettiEntity2 = entity
  }
}

function triggerFirework() {
  if (!fireworkEntity) return
  // Show, play animation, play launch sound
  VisibilityComponent.createOrReplace(fireworkEntity, { visible: true })
  Animator.createOrReplace(fireworkEntity, {
    states: [{ clip: 'Play', playing: true, loop: false, shouldReset: true, speed: 1, weight: 1 }]
  })
  AudioSource.createOrReplace(fireworkEntity, {
    audioClipUrl: 'assets/asset-packs/fireworks/fireworklaunch.mp3',
    playing: true, loop: false, volume: 0.7
  })
  // Delayed explode sound
  setTimeout(() => {
    if (!fireworkEntity || !celebrationActive) return
    AudioSource.createOrReplace(fireworkEntity, {
      audioClipUrl: 'assets/asset-packs/fireworks/fireworkexplode.mp3',
      playing: true, loop: false, volume: 0.7
    })
  }, 1300)
  // Auto-hide after animation
  setTimeout(() => {
    if (!fireworkEntity || !celebrationActive) return
    VisibilityComponent.createOrReplace(fireworkEntity, { visible: false })
  }, 5000)
}

function triggerConfetti(entity: ReturnType<typeof engine.addEntity> | null) {
  if (!entity) return
  VisibilityComponent.createOrReplace(entity, { visible: true })
  Animator.createOrReplace(entity, {
    states: [{ clip: 'Animation', playing: true, loop: true, shouldReset: true, speed: 1, weight: 1 }]
  })
  AudioSource.createOrReplace(entity, {
    audioClipUrl: 'assets/asset-packs/confetti/fireworkexplode.mp3',
    playing: true, loop: false, volume: 0.5
  })
}

function startCelebration() {
  findCelebrationEntities()
  celebrationActive = true
  fireworkTimer = 0.5 // first firework after short delay
  confettiTimer = 0   // confetti immediately
  triggerConfetti(confettiEntity1)
  triggerConfetti(confettiEntity2)
}

function stopCelebration() {
  celebrationActive = false
  // Hide all effects
  if (fireworkEntity) VisibilityComponent.createOrReplace(fireworkEntity, { visible: false })
  if (confettiEntity1) {
    VisibilityComponent.createOrReplace(confettiEntity1, { visible: false })
    Animator.createOrReplace(confettiEntity1, { states: [{ clip: 'Animation', playing: false, loop: false, shouldReset: true, speed: 1, weight: 1 }] })
  }
  if (confettiEntity2) {
    VisibilityComponent.createOrReplace(confettiEntity2, { visible: false })
    Animator.createOrReplace(confettiEntity2, { states: [{ clip: 'Animation', playing: false, loop: false, shouldReset: true, speed: 1, weight: 1 }] })
  }
}

// ── State ──
let cinematicTimer = 0
let isWinnerLocalPlayer = false
let isPodiumPlayer = false
let noScorersRound = false

// Fade state machine: 0=idle, 1=fading in, 2=holding black, 3=fading out (reveal), 4=showing, 5=end fade in, 6=end hold black, 7=end fade out
let fadePhase = 0
let fadeTimer = 0
let preFadeStarted = false  // tracks whether we already started the pre-fade for this round
let preFadeElapsed = 0      // safety timeout for pre-fade
let postRespawnHoldTimer = 0 // countdown: hold black after respawnPlayers arrives
let pendingPreFadeTeleport = false // defer audience teleport until screen is fully black
const FADE_IN_DUR = 0.6
const FADE_HOLD_DUR = 0
const FADE_OUT_DUR = 1.0
const POST_RESPAWN_HOLD_DUR = 2.0 // hold black after respawnPlayers while podium sets up (movePlayerTo + grounding + waitForGroundedEmote need this long to settle; too short and podium reveals with winners still mid-teleport or in idle pose)
const END_FADE_IN_DUR = 0.5
const END_FADE_HOLD_DUR = 0.3
const END_FADE_OUT_DUR = 0.5

// ── Podium emote helper ──
// When teleported mid-glide/fall/emote, InputModifier can leave the avatar in a stuck
// animation state that blocks new emotes. Fix: wait for grounded → re-teleport to settle →
// remove InputModifier briefly to clear the stuck state → re-apply and fire the emote.
let pendingEmote: { emote: string; targetPos: { x: number; y: number; z: number } } | null = null
const STABLE_EPSILON = 0.01
const STABLE_FRAMES = 15  // ~250ms of stable Y
const EMOTE_TIMEOUT = 6.0
const EMOTE_MIN_DELAY = 0.3
let stableCount = 0
let emoteElapsed = 0
let lastPlayerY = 0
let emotePhase = 0  // 0=wait grounded, 1=re-teleport settle, 2=remove InputModifier, 3=fire emote
let phaseTimer = 0

function waitForGroundedEmote(emote: string, targetPos: { x: number; y: number; z: number }) {
  pendingEmote = { emote, targetPos }
  stableCount = 0
  emoteElapsed = 0
  lastPlayerY = -9999
  emotePhase = 0
  phaseTimer = 0
}

/**
 * Sets up the cinematic camera entities, fade system, grounded-emote system,
 * and the respawnPlayers message handler.
 */
export function setupCinematicSystem(): void {
  cinematicCam = engine.addEntity()
  Transform.create(cinematicCam, { position: Vector3.create(PODIUM_CENTER.x, PODIUM_CENTER.y + ORBIT_DEFAULT_HEIGHT, PODIUM_CENTER.z + ORBIT_DEFAULT_DIST) })
  lookTarget = engine.addEntity()
  Transform.create(lookTarget, { position: PODIUM_CENTER })
  VirtualCamera.create(cinematicCam, {
    lookAtEntity: lookTarget,
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.01) }
  })

  // Consolidated cinematic system: podium emotes + fade overlay + cinematic timer
  registerSystem((dt: number) => {
    // ── Podium emote: grounded → re-teleport → clear InputModifier → fire emote ──
    if (pendingEmote) {

    emoteElapsed += dt

    // Hard timeout - fire once and give up
    if (emoteElapsed >= EMOTE_TIMEOUT) {
      void triggerEmote({ predefinedEmote: pendingEmote.emote }).catch(() => {})
      pendingEmote = null
    } else

    if (emotePhase === 0) {
      // Phase 0: Wait for player Y to stabilize (landed on podium)
      if (emoteElapsed < EMOTE_MIN_DELAY) return
      const playerY = Transform.get(engine.PlayerEntity).position.y
      const deltaY = Math.abs(playerY - lastPlayerY)
      lastPlayerY = playerY

      if (deltaY < STABLE_EPSILON) {
        stableCount++
        if (stableCount >= STABLE_FRAMES) {
          // Player is grounded — re-teleport to same spot to force-reset animation state
          const p = pendingEmote.targetPos
          void movePlayerTo({ newRelativePosition: p })
          emotePhase = 1
          phaseTimer = 0
          stableCount = 0
          lastPlayerY = -9999
        }
      } else {
        stableCount = 0
      }
    } else if (emotePhase === 1) {
      // Phase 1: Wait for second teleport to stabilize
      const playerY = Transform.get(engine.PlayerEntity).position.y
      const deltaY = Math.abs(playerY - lastPlayerY)
      lastPlayerY = playerY

      if (deltaY < STABLE_EPSILON) {
        stableCount++
        if (stableCount >= STABLE_FRAMES) {
          // Fully settled after reset teleport — now fire the emote
          emotePhase = 2
          phaseTimer = 0
        }
      } else {
        stableCount = 0
      }
    } else if (emotePhase === 2) {
      // Phase 2: Remove InputModifier to clear any stuck state, wait a frame
      if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
      emotePhase = 3
      phaseTimer = 0
    } else if (emotePhase === 3) {
      // Phase 3: Wait a beat, then re-lock movement and fire emote
      phaseTimer += dt
      if (phaseTimer >= 0.5) {
        InputModifier.createOrReplace(engine.PlayerEntity, {
          mode: InputModifier.Mode.Standard({
            disableWalk: true, disableRun: true, disableJump: true,
            disableJog: true, disableGliding: true, disableDoubleJump: true,
          })
        })
        void triggerEmote({ predefinedEmote: pendingEmote.emote }).catch(() => {})
        pendingEmote = null
      }
    }
    } // end pendingEmote

    // ── Pre-fade: DISABLED. Server's respawnPlayers message is now the single
    // source of truth for cinematic start (see the room.onMessage handler below).
    // Rationale: the previous client-clock trigger (getCountdownSeconds() === 0)
    // could fire up to ~1s early due to floor rounding, AND — more importantly —
    // could disagree with the server by several seconds when the client's system
    // clock drifted (Windows NTP slack). Symptoms: fade starting while UI still
    // shows 5s, countdown ticks bleeding into the podium, visual desync between
    // clients. Letting the server drive eliminates all of it at the cost of a
    // small (network-latency) delay before every client sees the fade begin.

    // ── Fade overlay + cinematic timer ──
    if (fadePhase > 0) {
      fadeTimer -= dt
      if (fadePhase === 1) {
        const progress = 1 - Math.max(0, fadeTimer / FADE_IN_DUR)
        setCinematicFade(progress)
        if (fadeTimer <= 0) {
          setCinematicFade(1); fadePhase = 2; fadeTimer = FADE_HOLD_DUR
          // Now screen is fully black — safe to teleport
          if (pendingPreFadeTeleport) {
            pendingPreFadeTeleport = false
            void movePlayerTo({ newRelativePosition: { x: 383.75+ Math.random() * 3, y: 95.47999999999999, z: 390.5+ Math.random() * 3 } })
          }
        }
      } else if (fadePhase === 2) {
        setCinematicFade(1)
        preFadeElapsed += dt
        // Safety: if respawnPlayers never arrives within 8s, abort
        if (preFadeElapsed > 8 && cinematicTimer <= 0) {
          setCinematicFade(0); fadePhase = 0; preFadeStarted = false
          cinematicState.roundOverVisible = false; clearCinematicSnapshot(); setCinematicActive(false)
          if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
          return
        }
        // Wait for respawnPlayers (cinematicTimer > 0), then hold black for POST_RESPAWN_HOLD_DUR
        if (fadeTimer <= 0 && cinematicTimer > 0) {
          if (postRespawnHoldTimer > 0) {
            postRespawnHoldTimer -= dt
            if (postRespawnHoldTimer <= 0) {
              cinematicState.roundOverVisible = false
              if (noScorersRound) { cinematicState.showing = true; creditsState.noScorersVisible = true; fadePhase = 4 }
              else { fadePhase = 3; fadeTimer = FADE_OUT_DUR; cinematicState.showing = true }
            }
          }
        }
      } else if (fadePhase === 3) {
        const progress = Math.max(0, fadeTimer / FADE_OUT_DUR)
        setCinematicFade(progress)
        if (fadeTimer <= 0) { setCinematicFade(0); cinematicState.showing = true; fadePhase = 4 }
      } else if (fadePhase === 4) {
        if (noScorersRound) creditsState.countdown = Math.max(0, cinematicTimer)
      } else if (fadePhase === 5) {
        const progress = 1 - Math.max(0, fadeTimer / END_FADE_IN_DUR)
        setCinematicFade(progress)
        if (fadeTimer <= 0) {
          setCinematicFade(1)
          cinematicState.showing = false
          MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = undefined as any
          orbitActive = false
          stopCelebration()
          if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
          if (isPodiumPlayer) {
            isWinnerLocalPlayer = false
            isPodiumPlayer = false
            void movePlayerTo({ newRelativePosition: { x: 383.75+ Math.random() * 3, y: 95.47999999999999, z: 390.5+ Math.random() * 3 } })
          }
          fadePhase = 6
          fadeTimer = 5.0
          cinematicState.roundOverVisible = false
          creditsState.nextRoundVisible = true
        }
      } else if (fadePhase === 6) {
        setCinematicFade(1)
        creditsState.countdown = Math.max(0, fadeTimer)
        if (fadeTimer <= 0) { creditsState.nextRoundVisible = false; creditsState.countdown = 0; fadePhase = 7; fadeTimer = END_FADE_OUT_DUR }
      } else if (fadePhase === 7) {
        const progress = Math.max(0, fadeTimer / END_FADE_OUT_DUR)
        setCinematicFade(progress)
        if (fadeTimer <= 0) { setCinematicFade(0); fadePhase = 0; preFadeStarted = false; cinematicState.roundOverVisible = false; clearCinematicSnapshot(); setCinematicActive(false) }
      }
    }

    // ── Celebration effects loop ──
    if (celebrationActive && fadePhase >= 3 && fadePhase <= 4) {
      fireworkTimer -= dt
      if (fireworkTimer <= 0) {
        triggerFirework()
        fireworkTimer = FIREWORK_INTERVAL
      }
      confettiTimer -= dt
      if (confettiTimer <= 0) {
        triggerConfetti(confettiEntity1)
        triggerConfetti(confettiEntity2)
        confettiTimer = CONFETTI_INTERVAL
      }
    }

    // ── Orbit camera ──
    if (orbitActive && fadePhase >= 3 && fadePhase <= 4) {
      // Player input overrides auto-orbit
      let playerInput = false
      if (inputSystem.isPressed(InputAction.IA_LEFT))  { orbitAngle += ORBIT_INPUT_SPEED * dt; playerInput = true }
      if (inputSystem.isPressed(InputAction.IA_RIGHT)) { orbitAngle -= ORBIT_INPUT_SPEED * dt; playerInput = true }
      if (inputSystem.isPressed(InputAction.IA_FORWARD))  { orbitDist = Math.max(ORBIT_MIN_DIST, orbitDist - orbitDist * ORBIT_INPUT_SPEED * dt); playerInput = true }
      if (inputSystem.isPressed(InputAction.IA_BACKWARD)) { orbitDist = Math.min(ORBIT_MAX_DIST, orbitDist + orbitDist * ORBIT_INPUT_SPEED * dt); playerInput = true }
      if (inputSystem.isPressed(InputAction.IA_PRIMARY))   { orbitHeight += orbitHeight * ORBIT_INPUT_SPEED * dt; playerInput = true }
      if (inputSystem.isPressed(InputAction.IA_SECONDARY)) { orbitHeight = Math.max(ORBIT_MIN_HEIGHT, orbitHeight - orbitHeight * ORBIT_INPUT_SPEED * dt); playerInput = true }

      // Auto-rotate when no player input
      if (!playerInput) orbitAngle += ORBIT_AUTO_SPEED * dt

      // Smooth lerp look-at toward podium center
      const lerpF = Math.min(1, ORBIT_LERP * dt)
      orbitLookX += (PODIUM_CENTER.x - orbitLookX) * lerpF
      orbitLookY += (PODIUM_CENTER.y - orbitLookY) * lerpF
      orbitLookZ += (PODIUM_CENTER.z - orbitLookZ) * lerpF

      // Update look-at entity
      const lt = Transform.getMutable(lookTarget)
      lt.position = Vector3.create(orbitLookX, orbitLookY + 1.5, orbitLookZ)

      // Update camera position
      const rawX = orbitLookX + Math.sin(orbitAngle) * orbitDist
      const rawZ = orbitLookZ + Math.cos(orbitAngle) * orbitDist
      const rawY = orbitLookY + orbitHeight
      const ct = Transform.getMutable(cinematicCam)
      ct.position = Vector3.create(
        Math.max(5, Math.min(SCENE_W - 5, rawX)),
        Math.max(CAM_MIN_Y, Math.min(CAM_MAX_Y, rawY)),
        Math.max(5, Math.min(SCENE_D - 5, rawZ))
      )
    }

    if (cinematicTimer <= 0) return
    cinematicTimer -= dt
    if (cinematicTimer <= 0 && fadePhase === 4) {
      if (noScorersRound) {
        cinematicState.showing = false; creditsState.noScorersVisible = false; creditsState.countdown = 0
        if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
        // Teleport player back to spawn
        void movePlayerTo({ newRelativePosition: { x: 383.75+ Math.random() * 3, y: 95.47999999999999, z: 390.5+ Math.random() * 3 } })
        fadePhase = 7; fadeTimer = END_FADE_OUT_DUR
        return
      }
      fadePhase = 5; fadeTimer = END_FADE_IN_DUR
    }
  })

  // ── respawnPlayers message handler ──
  room.onMessage('respawnPlayers', (data) => {
    const nowMs = Date.now()
    const intervalMs = 5 * 60 * 1000
    const nextBoundary = (Math.floor(nowMs / intervalMs) + 1) * intervalMs
    const msToBoundary = nextBoundary - nowMs
    console.log(`[Cinematic] 📨 respawnPlayers RECEIVED msToBoundary=${msToBoundary} preFadeStarted=${preFadeStarted} nowMs=${nowMs}`)
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

    // Snapshot scores for cinematic scoreboard (fallback if pre-fade missed)
    if (!preFadeStarted) snapshotScoresForCinematic()
    snapshotScoresFromWinners(topPlayers.map(p => ({
      userId: p.userId,
      name: getKnownPlayerName(p.userId) || p.userId.slice(0, 8),
      seconds: p.seconds,
    })))

    const GREEN_CUBE = { x: 380.78, y: 67.25, z: 321.81 }
    const alreadyPreFaded = preFadeStarted

    if (!alreadyPreFaded) {
      // No pre-fade happened — do full setup now
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({
          disableWalk: true, disableRun: true, disableJump: true,
          disableJog: true, disableGliding: true, disableDoubleJump: true,
        })
      })
      cancelDrownRespawn()
      cancelLightningRespawn()
      clearSpeedBoost()
      setCinematicActive(true)
      setWinConditionOverlayVisible(false)
      setLeaderboardOverlayVisible(false)
      hideMailboxPopup()
      hideChestPopup()
      exitSpectatorMode()
      fadePhase = 1
      fadeTimer = FADE_IN_DUR
    } else {
      // Pre-fade already set up everything — snap to black
      setCinematicFade(1)
      fadePhase = 2
      fadeTimer = 0
    }
    preFadeStarted = false
    cinematicState.roundOverVisible = true  // keep "Round Over" visible during black hold
    cinematicTimer = 11.1
    postRespawnHoldTimer = POST_RESPAWN_HOLD_DUR  // hold black while podium sets up

    orbitActive = !noScorersRound
    if (!noScorersRound) startCelebration()

    // Teleport podium players + activate camera immediately (screen is black)
    const setupDelay = alreadyPreFaded ? 50 : FADE_IN_DUR * 1000 + 50
    setTimeout(() => {
      if (isPodiumPlayer) {
        if (isWinnerLocalPlayer) {
          const pos = { x: 387.57, y: 67.51, z: 313.65 }
          void movePlayerTo({ newRelativePosition: pos, cameraTarget: GREEN_CUBE })
          waitForGroundedEmote('handsair', pos)
        } else if (isSecondPlace) {
          const pos = { x: 388.97, y: 66.85, z: 314.87 }
          void movePlayerTo({ newRelativePosition: pos, cameraTarget: GREEN_CUBE })
          waitForGroundedEmote('clap', pos)
        } else if (isThirdPlace) {
          const pos = { x: 386.25, y: 66.16, z: 312.57 }
          void movePlayerTo({ newRelativePosition: pos, cameraTarget: GREEN_CUBE })
          waitForGroundedEmote('clap', pos)
        }
      }
      // Audience already teleported by pre-fade; skip if not podium + pre-faded
      if (!alreadyPreFaded && !isPodiumPlayer) {
        void movePlayerTo({ newRelativePosition: { x: 383.75+ Math.random() * 3, y: 95.47999999999999, z: 390.5+ Math.random() * 3 } })
      }

    }, setupDelay)

    // Activate orbit camera immediately (while still black) so players never see spawn
    if (!noScorersRound) {
      MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = cinematicCam
    }
  })
}
