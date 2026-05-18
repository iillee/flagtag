/**
 * pedestalSystem.ts — Ritual Pedestal "Blessing of the Gods" interaction.
 *
 * When clicked: triggers kneeling emote, emits a beam of light from the player,
 * and plays rolling credits. If the player stays for the full duration, they
 * receive 5 coins (once per day).
 */
import {
  engine, pointerEventsSystem, InputAction, GltfContainer, ColliderLayer,
  Transform, MeshRenderer, Material, Billboard, BillboardMode,
  MaterialTransparencyMode, AudioSource, type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color4, Color3 } from '@dcl/sdk/math'
import { triggerEmote } from '~system/RestrictedActions'
import { room } from '../shared/messages'
import {
  blessingState, markBlessingCompleted,
  CREDIT_LINES,
} from '../ui/uiState'

// ── Beam of light config ──
const BEAM_HEIGHT = 80
const BEAM_INNER_WIDTH = 0.6
const BEAM_OUTER_WIDTH = 2.5
const BEAM_COLOR = { r: 1, g: 0.92, b: 0.6 }  // warm divine gold
const BEAM_INNER_ALPHA = 0.5
const BEAM_OUTER_ALPHA = 0.15

// ── Blessing duration ──
const BLESSING_DURATION = 32

// ── State ──
let pedestalSetup = false
let pedestalEntity: Entity | null = null
let blessingStatusChecked = false

// Beam entities
let beamInner: Entity | null = null
let beamOuter: Entity | null = null
let beamTimer = 0

// Server response listener registered
let listenerRegistered = false
// Delay marking as "already used" until after the reward UI dismisses
let delayedMarkUsed = false


const PRAY_EMOTE = 'urn:decentraland:matic:collections-v2:0xc889a77512ef96f6a93041a1c0054bd8ebde4f1e:1'

// Movement detection — cancel blessing if player moves
let blessingStartPos: Vector3 | null = null
const MOVE_THRESHOLD = 0.5  // meters of movement allowed before cancelling

// Interval triggers at 4s, 8s, 12s
const INTERVAL_TIMES = [8, 16, 24] // credit lines + beam pulse at each; emote retrigger to match ~8s emote duration
let blessingElapsed = 0
let intervalsTriggered = 0
let firstSoundPlayed = false
const FIRST_SOUND_DELAY = 3.0 // play when beam becomes visible

// Sound entity
const blessingSoundEntity = engine.addEntity()
Transform.create(blessingSoundEntity, { position: Vector3.Zero() })
AudioSource.create(blessingSoundEntity, {
  audioClipUrl: 'assets/sounds/blessing.mp3',
  playing: false,
  loop: false,
  volume: 0.8,
  global: true,
})

const HIDDEN = Vector3.create(0, -500, 0)

function createBeams() {
  const GRADIENT_TEXTURE = Material.Texture.Common({ src: 'assets/images/beacon-gradient.png' })
  const ALPHA_TEXTURE = Material.Texture.Common({ src: 'assets/images/beacon-alpha.png' })

  beamInner = engine.addEntity()
  Transform.create(beamInner, { position: HIDDEN, scale: Vector3.create(BEAM_INNER_WIDTH, BEAM_HEIGHT, 1) })
  MeshRenderer.setPlane(beamInner)
  Billboard.create(beamInner, { billboardMode: BillboardMode.BM_Y })
  Material.setPbrMaterial(beamInner, {
    texture: GRADIENT_TEXTURE,
    alphaTexture: ALPHA_TEXTURE,
    albedoColor: Color4.create(BEAM_COLOR.r, BEAM_COLOR.g, BEAM_COLOR.b, BEAM_INNER_ALPHA),
    emissiveColor: Color3.create(BEAM_COLOR.r, BEAM_COLOR.g, BEAM_COLOR.b),
    emissiveIntensity: 4.0,
    transparencyMode: MaterialTransparencyMode.MTM_AUTO,
    castShadows: false,
  })

  beamOuter = engine.addEntity()
  Transform.create(beamOuter, { position: HIDDEN, scale: Vector3.create(BEAM_OUTER_WIDTH, BEAM_HEIGHT, 1) })
  MeshRenderer.setPlane(beamOuter)
  Billboard.create(beamOuter, { billboardMode: BillboardMode.BM_Y })
  Material.setPbrMaterial(beamOuter, {
    texture: GRADIENT_TEXTURE,
    alphaTexture: ALPHA_TEXTURE,
    albedoColor: Color4.create(BEAM_COLOR.r, BEAM_COLOR.g, BEAM_COLOR.b, BEAM_OUTER_ALPHA),
    emissiveColor: Color3.create(BEAM_COLOR.r, BEAM_COLOR.g, BEAM_COLOR.b),
    emissiveIntensity: 2.5,
    transparencyMode: MaterialTransparencyMode.MTM_AUTO,
    castShadows: false,
  })
}

let intervalPulse = 0 // decays from 1 to 0 on each interval hit
function showBeamAtPlayer() {
  if (!beamInner || !beamOuter) createBeams()
  beamTimer = BLESSING_DURATION
}

function hideBeam() {
  if (beamInner) Transform.getMutable(beamInner).position = HIDDEN
  if (beamOuter) Transform.getMutable(beamOuter).position = HIDDEN
  beamTimer = 0
}

function cancelBlessing() {
  blessingState.active = false
  blessingState.timer = 0
  blessingState.lineIndex = 0
  blessingState.lineTimer = 0
  hideBeam()
  blessingStartPos = null
  blessingElapsed = 0
  intervalsTriggered = 0
  intervalPulse = 0
  firstSoundPlayed = false
  console.log('[Pedestal] Blessing interrupted — player moved')
}

function startBlessing() {
  // Record starting position for movement detection
  const pos = Transform.get(engine.PlayerEntity).position
  blessingStartPos = Vector3.create(pos.x, pos.y, pos.z)

  // Trigger emote, beam, and sound immediately on click
  void triggerEmote({ predefinedEmote: PRAY_EMOTE }).catch(() => {})
  showBeamAtPlayer()
  AudioSource.createOrReplace(blessingSoundEntity, {
    audioClipUrl: 'assets/sounds/blessing.mp3',
    playing: true,
    loop: false,
    volume: 0.8,
    global: true,
  })

  blessingElapsed = 0
  intervalsTriggered = 0
  intervalPulse = 0

  // Start credits overlay — no lines visible yet (index -1)
  blessingState.active = true
  blessingState.timer = BLESSING_DURATION
  blessingState.lineIndex = -1
  blessingState.lineTimer = 0
  markBlessingCompleted(false)
}

export function pedestalSystem(dt: number) {
  // ── Register server response listener once ──
  if (!listenerRegistered) {
    listenerRegistered = true
    room.onMessage('blessingResult', (data) => {
      console.log(`[Pedestal] blessingResult received: success=${data.success}, reason="${data.reason}", preCheckWas=${blessingState.preCheckDone}, alreadyUsedWas=${blessingState.alreadyUsed}, blessingActive=${blessingState.active}`)
      blessingState.preCheckDone = true
      if (data.reason === 'already_blessed') {
        blessingState.alreadyUsed = true
        // If ritual is currently playing, cancel it immediately
        if (blessingState.active) {
          cancelBlessing()
          markBlessingCompleted(true)  // show "already received" popup
          console.log('[Pedestal] ⚠️ Cancelled active ritual — server says already blessed')
        }
      } else if (data.success && data.reason !== 'eligible') {
        // Successful claim — delay marking as used so the coin reward UI
        // isn't replaced by the "already blessed" dismissal mid-animation
        delayedMarkUsed = true
      }
    })
  }

  // ── Deferred "already used" flag — apply after reward UI dismisses ──
  if (delayedMarkUsed && !blessingState.active && !blessingState.completed) {
    delayedMarkUsed = false
    blessingState.alreadyUsed = true
  }

  // ── Pre-check blessing status on scene load ──
  if (!blessingStatusChecked) {
    blessingStatusChecked = true
    room.send('checkBlessing', { t: 0 })
  }

  // ── Find pedestal entity from composite ──
  if (!pedestalSetup) {
    for (const [entity] of engine.getEntitiesWith(GltfContainer)) {
      const gltf = GltfContainer.get(entity)
      if (gltf.src.includes('ritual_pedestal') || gltf.src.includes('Pedestal_01')) {
        pedestalEntity = entity

        // Enable pointer collider
        const mutableGltf = GltfContainer.getMutable(entity)
        mutableGltf.visibleMeshesCollisionMask = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS
        mutableGltf.invisibleMeshesCollisionMask = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS

        pointerEventsSystem.onPointerDown(
          {
            entity,
            opts: {
              button: InputAction.IA_POINTER,
              hoverText: 'Receive the Blessing of the Gods',
              maxDistance: 6,
            },
          },
          () => {
            console.log(`[Pedestal] Click: active=${blessingState.active}, preCheckDone=${blessingState.preCheckDone}, alreadyUsed=${blessingState.alreadyUsed}`)
            if (blessingState.active) return  // already blessing in progress
            if (!blessingState.preCheckDone) {
              // Server hasn't responded yet — re-send check and wait
              console.log('[Pedestal] Pre-check not done yet, re-sending checkBlessing')
              room.send('checkBlessing', { t: 0 })
              return
            }
            if (blessingState.alreadyUsed) {
              markBlessingCompleted(true)  // show the "already received" popup immediately
              return  // no emote, no sound, no beam
            }
            startBlessing()
          }
        )

        pedestalSetup = true
        console.log('[Pedestal] 🙏 Click handler attached to ritual pedestal')
        break
      }
    }
  }

  // ── Movement detection: cancel blessing if player moves ──
  if (blessingState.active && blessingStartPos) {
    const currentPos = Transform.get(engine.PlayerEntity).position
    const dx = currentPos.x - blessingStartPos.x
    const dz = currentPos.z - blessingStartPos.z
    const horizontalDist = Math.sqrt(dx * dx + dz * dz)
    if (horizontalDist > MOVE_THRESHOLD) {
      cancelBlessing()
    }
  }

  // ── Interval triggers at 4s, 8s, 12s — emote + beam + sound + next credit line ──
  if (blessingState.active) {
    blessingElapsed += dt
    if (intervalsTriggered < INTERVAL_TIMES.length && blessingElapsed >= INTERVAL_TIMES[intervalsTriggered]) {
      // Re-trigger emote, sound, and beam at each interval (emote is ~6s, matches interval)
      void triggerEmote({ predefinedEmote: PRAY_EMOTE }).catch(() => {})
      AudioSource.createOrReplace(blessingSoundEntity, {
        audioClipUrl: 'assets/sounds/blessing.mp3',
        playing: true,
        loop: false,
        volume: 0.8,
        global: true,
      })

      // Show next credit line
      blessingState.lineIndex = intervalsTriggered
      blessingState.lineTimer = 0
      // Pulse the beam
      intervalPulse = 1
      intervalsTriggered++
    }
  }

  // ── Animate beam to follow player with fade-in ──
  if (beamTimer > 0) {
    beamTimer -= dt
    const playerPos = Transform.get(engine.PlayerEntity).position
    const beaconY = playerPos.y + BEAM_HEIGHT / 2

    // Fade in over 3s, fade out over last 2s
    const beamAge = BLESSING_DURATION - beamTimer
    const fadeIn = Math.min(1, beamAge / 3.0)
    const fadeOut = Math.min(1, beamTimer / 2.0)
    const fade = Math.min(fadeIn, fadeOut)

    // Decay interval pulse
    if (intervalPulse > 0) intervalPulse = Math.max(0, intervalPulse - dt * 2) // ~0.5s decay

    // Gentle wobble + interval flare
    const pulse = 1 + 0.1 * Math.sin(beamTimer * 3) + intervalPulse * 0.6

    if (beamInner) {
      const t = Transform.getMutable(beamInner)
      t.position = Vector3.create(playerPos.x, beaconY, playerPos.z)
      t.scale = Vector3.create(BEAM_INNER_WIDTH * pulse * fade, BEAM_HEIGHT * fade, 1)
    }
    if (beamOuter) {
      const t = Transform.getMutable(beamOuter)
      t.position = Vector3.create(playerPos.x, beaconY, playerPos.z)
      t.scale = Vector3.create(BEAM_OUTER_WIDTH * (2 - pulse) * fade, BEAM_HEIGHT * fade, 1)
    }

    if (beamTimer <= 0) {
      hideBeam()
    }
  }
}
