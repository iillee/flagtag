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
  isBlessingActive, setBlessingActive, setBlessingTimer,
  setBlessingLineIndex, setBlessingLineTimer,
  setBlessingCompleted, setBlessingAlreadyUsed,
  isBlessingAlreadyUsed,
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
const BLESSING_DURATION = 16

// ── State ──
let pedestalSetup = false
let pedestalEntity: Entity | null = null

// Beam entities
let beamInner: Entity | null = null
let beamOuter: Entity | null = null
let beamTimer = 0

// Server response listener registered
let listenerRegistered = false


const PRAY_EMOTE = 'urn:decentraland:matic:collections-v2:0xc889a77512ef96f6a93041a1c0054bd8ebde4f1e:1'

// Movement detection — cancel blessing if player moves
let blessingStartPos: Vector3 | null = null
const MOVE_THRESHOLD = 0.5  // meters of movement allowed before cancelling

// Delayed sound (1 second in)
const BEAM_SOUND_DELAY = 1.0
let blessingElapsed = 0
let beamTriggered = false
let emoteRetriggered = false

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
  setBlessingActive(false)
  setBlessingTimer(0)
  setBlessingLineIndex(0)
  setBlessingLineTimer(0)
  hideBeam()
  blessingStartPos = null
  beamTriggered = false
  emoteRetriggered = false
  blessingElapsed = 0
  console.log('[Pedestal] Blessing interrupted — player moved')
}

function startBlessing() {
  // Record starting position for movement detection
  const pos = Transform.get(engine.PlayerEntity).position
  blessingStartPos = Vector3.create(pos.x, pos.y, pos.z)

  // Trigger emote immediately (8s emote matches 8s blessing)
  void triggerEmote({ predefinedEmote: PRAY_EMOTE }).catch(() => {})

  // Sound triggers after 1s delay, beam starts immediately
  blessingElapsed = 0
  beamTriggered = false
  emoteRetriggered = false
  showBeamAtPlayer()

  // Start credits overlay (no black background)
  setBlessingActive(true)
  setBlessingTimer(BLESSING_DURATION)
  setBlessingLineIndex(0)
  setBlessingLineTimer(0)
  setBlessingCompleted(false)
}

export function pedestalSystem(dt: number) {
  // ── Register server response listener once ──
  if (!listenerRegistered) {
    listenerRegistered = true
    room.onMessage('blessingResult', (data) => {
      if (!data.success && data.reason === 'already_blessed') {
        setBlessingAlreadyUsed(true)
      }
    })
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
            if (isBlessingActive()) return  // already blessing in progress
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
  if (isBlessingActive() && blessingStartPos) {
    const currentPos = Transform.get(engine.PlayerEntity).position
    const dx = currentPos.x - blessingStartPos.x
    const dz = currentPos.z - blessingStartPos.z
    const horizontalDist = Math.sqrt(dx * dx + dz * dz)
    if (horizontalDist > MOVE_THRESHOLD) {
      cancelBlessing()
    }
  }

  // ── Delayed beam + sound trigger ──
  if (isBlessingActive()) {
    blessingElapsed += dt
    if (!beamTriggered && blessingElapsed >= BEAM_SOUND_DELAY) {
      beamTriggered = true
      AudioSource.createOrReplace(blessingSoundEntity, {
        audioClipUrl: 'assets/sounds/blessing.mp3',
        playing: true,
        loop: false,
        volume: 0.8,
        global: true,
      })
    }
    // Re-trigger emote at 8s for second loop
    if (!emoteRetriggered && blessingElapsed >= 8.0) {
      emoteRetriggered = true
      void triggerEmote({ predefinedEmote: PRAY_EMOTE }).catch(() => {})
    }
  }

  // ── Animate beam to follow player with fade-in ──
  if (beamTimer > 0) {
    beamTimer -= dt
    const playerPos = Transform.get(engine.PlayerEntity).position
    const beaconY = playerPos.y + BEAM_HEIGHT / 2

    // Fade in over 3 seconds, fade out over last 2 seconds
    const beamAge = BLESSING_DURATION - beamTimer
    const fadeIn = Math.min(1, beamAge / 3.0)
    const fadeOut = Math.min(1, beamTimer / 2.0)
    const fade = Math.min(fadeIn, fadeOut)

    // Pulse effect
    const pulse = 1 + 0.1 * Math.sin(beamTimer * 3)

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
