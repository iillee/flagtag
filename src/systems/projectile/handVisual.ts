/**
 * Hand boomerang visibility — shows/hides the boomerang attached to the player's hand,
 * including charge glow and orbit particle effects.
 */
import {
  engine, Transform, Material, MeshRenderer, AvatarEmoteCommand, type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3, Color4 } from '@dcl/sdk/math'
import { MaterialTransparencyMode } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import {
  hand, localThrow, charge, yellow, HAND_BOOMERANG_SCALE, LEFT_HAND_SCALE,
  ORBIT_PARTICLE_COUNT, ORBIT_RADIUS, EMOTE_MOVE_THRESHOLD
} from './state'

// Track last material phase to avoid redundant setPbrMaterial calls
// Phase 0 = blue (< 75%), Phase 1 = gold (>= 75%), Phase -1 = hidden/not charging
let lastGlowPhase = -1
let lastParticlePhase = -1
import { getChargeFraction } from './charge'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { isCinematicActive } from '../../gameState/cinematicState'
import { localProjectiles, msgProjectileVisuals } from './state'

export function setHandBoomerangEntity(e: Entity): void {
  hand.entity = e

  // Create glow child entity
  hand.glowEntity = engine.addEntity()
  Transform.create(hand.glowEntity, {
    position: Vector3.create(0, 0, 0),
    scale: Vector3.Zero(),
    parent: e
  })
  MeshRenderer.setSphere(hand.glowEntity)
  Material.setPbrMaterial(hand.glowEntity, {
    albedoColor: Color4.create(1, 1, 1, 0),
    emissiveColor: Color3.create(0.3, 0.6, 1),
    emissiveIntensity: 0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
  })

  // Create orbiting charge particles
  hand.orbitParticles = []
  for (let i = 0; i < ORBIT_PARTICLE_COUNT; i++) {
    const p = engine.addEntity()
    Transform.create(p, {
      position: Vector3.Zero(),
      scale: Vector3.Zero(),
      parent: e
    })
    MeshRenderer.setSphere(p)
    Material.setPbrMaterial(p, {
      albedoColor: Color4.create(1, 1, 1, 0),
      emissiveColor: Color3.create(0.3, 0.6, 1),
      emissiveIntensity: 5,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    hand.orbitParticles.push(p)
  }

  // Listen for emotes on the local player
  AvatarEmoteCommand.onChange(engine.PlayerEntity, (cmd) => {
    if (cmd && !cmd.emoteUrn?.includes('getHit')) {
      hand.emoteActive = true
      if (Transform.has(engine.PlayerEntity)) {
        const p = Transform.get(engine.PlayerEntity).position
        hand.lastPlayerPos = Vector3.create(p.x, p.y, p.z)
      }
      updateHandBoomerangVisibility()
    }
  })
}

export function setLeftHandBoomerangEntity(e: Entity): void {
  hand.leftEntity = e
}

export function updateHandBoomerangVisibility(): void {
  if (hand.entity === null) return

  // Cancel emote hide once player moves
  if (hand.emoteActive && Transform.has(engine.PlayerEntity) && hand.lastPlayerPos) {
    const p = Transform.get(engine.PlayerEntity).position
    if (Vector3.distance(p, hand.lastPlayerPos) > EMOTE_MOVE_THRESHOLD) {
      hand.emoteActive = false
    }
  }

  const shouldShow = localProjectiles.length === 0 && !localThrow.active && !hand.emoteActive && !isCinematicActive()

  if (Transform.has(hand.entity)) {
    const t = Transform.getMutable(hand.entity)
    const currentlyVisible = t.scale.x > 0
    if (currentlyVisible !== shouldShow) {
      console.log(`[HandBoomerang] ${shouldShow ? 'SHOW' : 'HIDE'} | localThrowActive=${localThrow.active} localProj=${localProjectiles.length} msgVis=${msgProjectileVisuals.length} emote=${hand.emoteActive} cinematic=${isCinematicActive()}`)
    }
    const isGreen = getBoomerangColor() === 'g'
    const mobile = isMobile()
    if (shouldShow) {
      t.scale = HAND_BOOMERANG_SCALE
      t.position = mobile ? Vector3.create(-0.02, 0.13, -0.13) : Vector3.create(0.04, 0.15, 0.1)
      t.rotation = Quaternion.fromEulerDegrees(mobile ? 15 : 0, mobile ? 180 : 0, 90)
    } else {
      t.scale = Vector3.Zero()
    }

    // Update glow during charge (blue only)
    // Material is only updated when crossing the 75% threshold (phase change),
    // NOT every frame — to avoid exhausting renderer material resources over time.
    if (hand.glowEntity && Transform.has(hand.glowEntity)) {
      if (shouldShow && charge.isCharging && !isGreen) {
        const cf = getChargeFraction()
        const glowSize = 0.3 + cf * 0.7
        Transform.getMutable(hand.glowEntity).scale = Vector3.create(glowSize, glowSize, glowSize)
        const phase = cf > 0.75 ? 1 : 0
        if (phase !== lastGlowPhase) {
          lastGlowPhase = phase
          const r = phase === 1 ? 1.0 : 0.3
          const g = phase === 1 ? 0.84 : 0.6
          const b = phase === 1 ? 0.0 : 1.0
          Material.setPbrMaterial(hand.glowEntity, {
            albedoColor: Color4.create(1, 1, 1, 0),
            emissiveColor: Color3.create(r, g, b),
            emissiveIntensity: phase === 1 ? 10 : 6,
            transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
          })
        }
      } else {
        if (lastGlowPhase !== -1) lastGlowPhase = -1
        Transform.getMutable(hand.glowEntity).scale = Vector3.Zero()
      }
    }

    // Update orbit particles (blue only)
    // Only positions/scales update per-frame; material only on phase change.
    if (shouldShow && charge.isCharging && !isGreen) {
      const cf = getChargeFraction()
      const speed = 2 * Math.PI * (1 + cf * 5)
      hand.orbitAngle = ((Date.now() - charge.startMs) / 1000) * speed
      const radius = ORBIT_RADIUS * (0.5 + cf * 0.5)
      const particleSize = 0.1 + cf * 0.15
      const phase = cf > 0.75 ? 1 : 0
      if (phase !== lastParticlePhase) {
        lastParticlePhase = phase
        const pr = phase === 1 ? 1.0 : 0.3
        const pg = phase === 1 ? 0.84 : 0.6
        const pb = phase === 1 ? 0.0 : 1.0
        for (let i = 0; i < hand.orbitParticles.length; i++) {
          const op = hand.orbitParticles[i]
          Material.setPbrMaterial(op, {
            albedoColor: Color4.create(1, 1, 1, 0),
            emissiveColor: Color3.create(pr, pg, pb),
            emissiveIntensity: phase === 1 ? 10 : 8,
            transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
          })
        }
      }
      for (let i = 0; i < hand.orbitParticles.length; i++) {
        const op = hand.orbitParticles[i]
        if (!Transform.has(op)) continue
        const angle = hand.orbitAngle + (i * 2 * Math.PI) / ORBIT_PARTICLE_COUNT
        Transform.getMutable(op).position = Vector3.create(
          0,
          Math.sin(angle) * radius,
          Math.cos(angle) * radius
        )
        Transform.getMutable(op).scale = Vector3.create(particleSize, particleSize, particleSize)
      }
    } else {
      if (lastParticlePhase !== -1) lastParticlePhase = -1
      for (let i = 0; i < hand.orbitParticles.length; i++) {
        const op = hand.orbitParticles[i]
        if (Transform.has(op)) Transform.getMutable(op).scale = Vector3.Zero()
      }
    }

    // Left-hand boomerang: show when yellow, ready, and no pending 2nd throw
    if (hand.leftEntity && Transform.has(hand.leftEntity)) {
      const showLeft = shouldShow && getBoomerangColor() === 'y' && yellow.secondThrowAt === 0
      const leftVisible = Transform.get(hand.leftEntity).scale.x > 0
      if (showLeft !== leftVisible) {
        Transform.getMutable(hand.leftEntity).scale = showLeft ? LEFT_HAND_SCALE : Vector3.Zero()
      }
    }
  }
}
