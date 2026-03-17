import {
  engine,
  Transform,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Billboard,
  BillboardMode,
  AvatarAttach,
  AvatarAnchorPointType,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'

// Forcefield visual config — tweak these!
const SHIELD_COLOR = Color4.create(1.0, 0.82, 0.2, 0.12)       // Gold, very transparent
const SHIELD_EMISSIVE = Color4.create(1.0, 0.75, 0.1, 1.0)     // Gold glow
const SHIELD_EMISSIVE_INTENSITY = 4.0
const SHIELD_RADIUS = 1.3                                        // Distance from center to each plane
const SHIELD_Y_OFFSET = 0.9                                      // Center height (hip level)
const PLANE_WIDTH = 1.1                                           // Width of each plane
const PLANE_HEIGHT = 2.2                                          // Height of each plane (covers avatar)
const NUM_PLANES = 8                                              // Octagon

// Pulse animation
const PULSE_SPEED = 2.0        // Pulses per second
const PULSE_ALPHA_MIN = 0.06   // Minimum opacity
const PULSE_ALPHA_MAX = 0.18   // Maximum opacity
const PULSE_SCALE_MIN = 0.97   // Minimum scale multiplier
const PULSE_SCALE_MAX = 1.03   // Maximum scale multiplier

// Rotation
const ROTATE_SPEED_DEG = 30    // Degrees per second — slow spin

let shieldAnchor: Entity | null = null
let shieldPlanes: Entity[] = []
let shieldVisible = false
let pulseTime = 0
let rotationAngle = 0

export function showShield(): void {
  if (shieldVisible) return

  const me = getPlayerData()
  if (!me?.userId) return

  // Create anchor attached to local player
  shieldAnchor = engine.addEntity()
  Transform.create(shieldAnchor, { position: Vector3.Zero() })
  AvatarAttach.create(shieldAnchor, {
    avatarId: me.userId,
    anchorPointId: AvatarAnchorPointType.AAPT_POSITION
  })

  // Create 8 planes arranged in an octagon
  for (let i = 0; i < NUM_PLANES; i++) {
    const angleDeg = (360 / NUM_PLANES) * i
    const angleRad = angleDeg * (Math.PI / 180)

    const x = Math.sin(angleRad) * SHIELD_RADIUS
    const z = Math.cos(angleRad) * SHIELD_RADIUS

    const plane = engine.addEntity()
    Transform.create(plane, {
      parent: shieldAnchor,
      position: Vector3.create(x, SHIELD_Y_OFFSET, z),
      // Face outward from center — rotate to face away from anchor
      rotation: Quaternion.fromEulerDegrees(0, angleDeg, 0),
      scale: Vector3.create(PLANE_WIDTH, PLANE_HEIGHT, 1)
    })
    MeshRenderer.setPlane(plane)
    Material.setPbrMaterial(plane, {
      albedoColor: SHIELD_COLOR,
      emissiveColor: SHIELD_EMISSIVE,
      emissiveIntensity: SHIELD_EMISSIVE_INTENSITY,
      roughness: 1.0,
      metallic: 0.0,
      specularIntensity: 0.0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })

    shieldPlanes.push(plane)
  }

  shieldVisible = true
  pulseTime = 0
  rotationAngle = 0
  console.log('[Shield] Forcefield shown (octagon)')
}

export function hideShield(): void {
  if (!shieldVisible) return

  for (const plane of shieldPlanes) {
    engine.removeEntity(plane)
  }
  shieldPlanes = []

  if (shieldAnchor !== null) {
    engine.removeEntity(shieldAnchor)
    shieldAnchor = null
  }

  shieldVisible = false
  console.log('[Shield] Forcefield hidden')
}

export function isShieldVisible(): boolean {
  return shieldVisible
}

/** Call from a system each frame to animate the pulse + rotation */
export function shieldSystem(dt: number): void {
  if (!shieldVisible || shieldPlanes.length === 0) return

  pulseTime += dt
  rotationAngle += ROTATE_SPEED_DEG * dt

  const t = (Math.sin(pulseTime * PULSE_SPEED * Math.PI * 2) + 1) / 2 // 0..1

  // Pulse alpha
  const alpha = PULSE_ALPHA_MIN + t * (PULSE_ALPHA_MAX - PULSE_ALPHA_MIN)

  // Pulse scale
  const scaleMul = PULSE_SCALE_MIN + t * (PULSE_SCALE_MAX - PULSE_SCALE_MIN)

  for (let i = 0; i < shieldPlanes.length; i++) {
    const plane = shieldPlanes[i]
    if (!Transform.has(plane)) continue

    // Base angle for this plane + rotation offset
    const baseDeg = (360 / NUM_PLANES) * i + rotationAngle
    const baseRad = baseDeg * (Math.PI / 180)

    const r = SHIELD_RADIUS * scaleMul
    const x = Math.sin(baseRad) * r
    const z = Math.cos(baseRad) * r

    const transform = Transform.getMutable(plane)
    transform.position = Vector3.create(x, SHIELD_Y_OFFSET, z)
    transform.rotation = Quaternion.fromEulerDegrees(0, baseDeg, 0)
    transform.scale = Vector3.create(PLANE_WIDTH * scaleMul, PLANE_HEIGHT * scaleMul, 1)
  }

  // Update material for all planes (alpha pulse)
  for (const plane of shieldPlanes) {
    Material.setPbrMaterial(plane, {
      albedoColor: Color4.create(SHIELD_COLOR.r, SHIELD_COLOR.g, SHIELD_COLOR.b, alpha),
      emissiveColor: SHIELD_EMISSIVE,
      emissiveIntensity: SHIELD_EMISSIVE_INTENSITY,
      roughness: 1.0,
      metallic: 0.0,
      specularIntensity: 0.0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
  }
}
