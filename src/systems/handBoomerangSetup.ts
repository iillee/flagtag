/**
 * handBoomerangSetup.ts — Creates the local player's held boomerang models
 * and the charging torus ring visual effect.
 */
import { Vector3, Color4, Color3, Quaternion } from '@dcl/sdk/math'
import { engine, Entity, Transform, MeshRenderer, Material, MaterialTransparencyMode, GltfContainer, AvatarAttach, AvatarAnchorPointType } from '@dcl/sdk/ecs'
import { registerSystem } from './systemManager'
import { isMobile } from '@dcl/sdk/platform'
import { setHandBoomerangEntity, setLeftHandBoomerangEntity, getChargeFraction, getChargePhase } from './projectile'
import { getBoomerangColor, onBoomerangColorChange } from '../gameState/boomerangColor'

export function setupHandBoomerangs() {
  // ── Right-hand boomerang (always visible) ──
  const boomerangHand = engine.addEntity()
  AvatarAttach.create(boomerangHand, {
    anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND
  })
  Transform.create(boomerangHand, { position: Vector3.Zero(), scale: Vector3.One() })
  const boomerangModel = engine.addEntity()
  Transform.create(boomerangModel, {
    parent: boomerangHand,
    position: isMobile() ? Vector3.create(-0.02, 0.13, -0.13) : Vector3.create(0.04, 0.15, 0.1),
    scale: Vector3.create(1, 1.5, 1),
    rotation: Quaternion.fromEulerDegrees(isMobile() ? 15 : 0, isMobile() ? 180 : 0, 90)
  })
  GltfContainer.create(boomerangModel, {
    src: 'assets/models/boomerang.r.glb',
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })
  setHandBoomerangEntity(boomerangModel)

  // ── Left-hand boomerang (yellow only) ──
  const leftHandAnchor = engine.addEntity()
  AvatarAttach.create(leftHandAnchor, {
    anchorPointId: AvatarAnchorPointType.AAPT_LEFT_HAND
  })
  Transform.create(leftHandAnchor, { position: Vector3.Zero(), scale: Vector3.One() })
  const leftBoomerangModel = engine.addEntity()
  Transform.create(leftBoomerangModel, {
    parent: leftHandAnchor,
    position: isMobile() ? Vector3.create(-0.01, 0.01, -0.08) : Vector3.create(0.05, 0.03, 0.1),
    scale: getBoomerangColor() === 'y' ? Vector3.create(1, 1.5, 1) : Vector3.Zero(),
    rotation: Quaternion.fromEulerDegrees(isMobile() ? 0 : 0, isMobile() ? 180 : 0, -90)
  })
  GltfContainer.create(leftBoomerangModel, {
    src: `assets/models/boomerang.${getBoomerangColor()}.glb`,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  // Show/hide left hand boomerang when color changes
  onBoomerangColorChange((color) => {
    if (Transform.has(leftBoomerangModel)) {
      Transform.getMutable(leftBoomerangModel).scale = color === 'y' ? Vector3.create(1, 1.5, 1) : Vector3.Zero()
    }
    if (GltfContainer.has(leftBoomerangModel)) {
      GltfContainer.getMutable(leftBoomerangModel).src = `assets/models/boomerang.${color}.glb`
    }
  })

  setLeftHandBoomerangEntity(leftBoomerangModel)

  // ── Charging torus ring — small spheres arranged in a circle ──
  const RING_SEGMENTS = 16
  const RING_RADIUS = 0.35
  const RING_BEAD_SIZE = 0.06
  const ringParent = engine.addEntity()
  Transform.create(ringParent, {
    parent: boomerangHand,
    position: Vector3.create(0, 0.15, 0),
    scale: Vector3.Zero() // hidden by default
  })
  const ringBeads: Entity[] = []
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const angle = (i * 2 * Math.PI) / RING_SEGMENTS
    const bead = engine.addEntity()
    Transform.create(bead, {
      parent: ringParent,
      position: Vector3.create(Math.cos(angle) * RING_RADIUS, 0, Math.sin(angle) * RING_RADIUS),
      scale: Vector3.create(RING_BEAD_SIZE, RING_BEAD_SIZE, RING_BEAD_SIZE)
    })
    MeshRenderer.setSphere(bead)
    Material.setPbrMaterial(bead, {
      albedoColor: Color4.create(1, 0.85, 0, 0.5),
      emissiveColor: Color3.create(1, 0.8, 0),
      emissiveIntensity: 5,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    ringBeads.push(bead)
  }

  // Update charge ring each frame — grows + spins
  let lastBeadPhase = -1
  registerSystem((dt: number) => {
    if (getChargePhase() === 'charging' && getChargeFraction() > 0.15 && getBoomerangColor() !== 'g') {
      const cf = getChargeFraction()
      const size = 0.375 + cf * 0.75
      const spinSpeed = 120 + cf * 360
      Transform.getMutable(ringParent).scale = Vector3.create(size, size, size)
      Transform.getMutable(ringParent).rotation = Quaternion.multiply(
        Quaternion.fromEulerDegrees(0, spinSpeed * dt, 0),
        Transform.get(ringParent).rotation
      )
      const phase = cf > 0.75 ? 1 : 0
      if (phase !== lastBeadPhase) {
        lastBeadPhase = phase
        const r = phase === 1 ? 1.0 : 1.0
        const g = phase === 1 ? 0.3 : 0.8
        const b = phase === 1 ? 0.1 : 0.0
        for (const bead of ringBeads) {
          Material.setPbrMaterial(bead, {
            albedoColor: Color4.create(1, 0.85, 0, phase === 1 ? 0.7 : 0.5),
            emissiveColor: Color3.create(r, g, b),
            emissiveIntensity: phase === 1 ? 15 : 5,
            transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
          })
        }
      }
    } else {
      if (lastBeadPhase !== -1) lastBeadPhase = -1
      if (Transform.has(ringParent)) {
        Transform.getMutable(ringParent).scale = Vector3.Zero()
      }
    }
  })
}
