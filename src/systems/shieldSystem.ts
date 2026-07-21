import {
  engine,
  Transform,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  AvatarAttach,
  AvatarAnchorPointType,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'

// Forcefield visual config
const SHIELD_COLOR = Color4.create(1.0, 0.82, 0.2, 0.12)
const SHIELD_EMISSIVE = Color4.create(1.0, 0.75, 0.1, 1.0)
const SHIELD_EMISSIVE_INTENSITY = 4.0
const SHIELD_RADIUS = 0.64475
function getShieldYOffset(): number { return isMobile() ? 1.0 : 1.45 }
const PLANE_WIDTH = 0.53
const PLANE_HEIGHT = 1.1
const NUM_PLANES = 8

// Pulse animation
const PULSE_SPEED = 0.8
const PULSE_ALPHA_MIN = 0.06
const PULSE_ALPHA_MAX = 0.18
const PULSE_SCALE_MIN = 0.97
const PULSE_SCALE_MAX = 1.03

// Rotation
const ROTATE_SPEED_DEG = 10
const SHIELD_GRADIENT_TEXTURE = Material.Texture.Common({ src: 'assets/images/beacon-gradient.png' })

// ── Per-player shield tracking ──
interface PlayerShield {
  anchor: Entity
  planes: Entity[]
  pulseTime: number
  rotationAngle: number
  alphaMultiplier: number  // 0–1, used for fade-out
  lastMaterialAlpha: number    // last alpha written to material — skip update if unchanged
  lastMaterialEmissive: number // last emissiveIntensity written
  playerId: string | null      // lowercased owner while in use, null when parked
}

// Pool of pre-created shield rigs (anchor + planes). Show/hide re-anchors and
// toggles plane scale instead of engine.addEntity()×9 / removeEntity()×9 on every
// pickup/steal/drop/rollback/immunity event, which produced thousands of
// create/destroy cycles per session (the engine's rendering bug — see KNOWN_BUGS.md).
const SHIELD_POOL_SIZE = 5
const shieldPool: PlayerShield[] = []
let shieldPoolReady = false

// Keyed by lowercased playerId — only rigs currently in use.
const activeShields = new Map<string, PlayerShield>()

function initShieldPool(): void {
  if (shieldPoolReady) return
  shieldPoolReady = true
  for (let r = 0; r < SHIELD_POOL_SIZE; r++) {
    const anchor = engine.addEntity()
    Transform.create(anchor, { position: Vector3.Zero() })
    // AvatarAttach is created lazily on show (it needs an avatarId).

    const planes: Entity[] = []
    for (let i = 0; i < NUM_PLANES; i++) {
      const angleDeg = (360 / NUM_PLANES) * i
      const angleRad = angleDeg * (Math.PI / 180)
      const x = Math.sin(angleRad) * SHIELD_RADIUS
      const z = Math.cos(angleRad) * SHIELD_RADIUS

      const plane = engine.addEntity()
      Transform.create(plane, {
        parent: anchor,
        position: Vector3.create(x, getShieldYOffset(), z),
        rotation: Quaternion.fromEulerDegrees(0, angleDeg, 0),
        scale: Vector3.Zero()  // parked — hidden until shown
      })
      MeshRenderer.setPlane(plane)
      Material.setPbrMaterial(plane, {
        albedoColor: SHIELD_COLOR,
        texture: SHIELD_GRADIENT_TEXTURE,
        alphaTexture: SHIELD_GRADIENT_TEXTURE,
        emissiveColor: SHIELD_EMISSIVE,
        emissiveIntensity: SHIELD_EMISSIVE_INTENSITY,
        roughness: 1.0,
        metallic: 0.0,
        specularIntensity: 0.0,
        transparencyMode: MaterialTransparencyMode.MTM_AUTO,
        castShadows: false,
      })
      planes.push(plane)
    }

    shieldPool.push({ anchor, planes, pulseTime: 0, rotationAngle: 0, alphaMultiplier: 1.0, lastMaterialAlpha: -1, lastMaterialEmissive: -1, playerId: null })
  }
  console.log('[Shield] Pre-created shield rig pool of', SHIELD_POOL_SIZE)
}

export function showShieldForPlayer(playerId: string): void {
  const key = playerId.toLowerCase()
  if (activeShields.has(key)) return
  initShieldPool()

  const shield = shieldPool.find(s => s.playerId === null)
  if (!shield) {
    console.log('[Shield] Pool exhausted — no free rig for', key.slice(0, 8))
    return
  }

  shield.playerId = key
  shield.pulseTime = 0
  shield.rotationAngle = 0
  shield.alphaMultiplier = 1.0
  shield.lastMaterialAlpha = -1  // force material refresh on next animate frame
  shield.lastMaterialEmissive = -1

  AvatarAttach.createOrReplace(shield.anchor, {
    avatarId: key,
    anchorPointId: AvatarAnchorPointType.AAPT_POSITION
  })

  // Un-park the planes (animate loop takes over positioning/scale next frame).
  for (const plane of shield.planes) {
    if (Transform.has(plane)) Transform.getMutable(plane).scale = Vector3.create(PLANE_WIDTH, PLANE_HEIGHT, 1)
  }

  activeShields.set(key, shield)
  console.log('[Shield] Forcefield shown for', key.slice(0, 8))
}

export function hideShieldForPlayer(playerId: string): void {
  const key = playerId.toLowerCase()
  const shield = activeShields.get(key)
  if (!shield) return

  // Park the rig back into the pool: hide planes + detach from the avatar.
  for (const plane of shield.planes) {
    if (Transform.has(plane)) Transform.getMutable(plane).scale = Vector3.Zero()
  }
  if (AvatarAttach.has(shield.anchor)) AvatarAttach.deleteFrom(shield.anchor)

  shield.playerId = null
  activeShields.delete(key)
  console.log('[Shield] Forcefield hidden for', key.slice(0, 8))
}

/** Convenience wrappers for local player */
export function showShield(): void {
  const me = getPlayerData()
  if (me?.userId) showShieldForPlayer(me.userId)
}

export function hideShield(): void {
  const me = getPlayerData()
  if (me?.userId) hideShieldForPlayer(me.userId)
}

export function hideAllShields(): void {
  for (const playerId of [...activeShields.keys()]) {
    hideShieldForPlayer(playerId)
  }
}

/** Set the alpha multiplier (0–1) for a player's shield, used for fade-out. */
export function setShieldAlpha(playerId: string, alpha: number): void {
  const shield = activeShields.get(playerId.toLowerCase())
  if (shield) shield.alphaMultiplier = Math.max(0, Math.min(1, alpha))
}

export function isShieldVisible(): boolean {
  return activeShields.size > 0
}

/** Call from a system each frame to animate all active shields */
export function shieldSystem(dt: number): void {
  for (const [, shield] of activeShields) {
    if (shield.planes.length === 0) continue

    shield.pulseTime += dt
    shield.rotationAngle += ROTATE_SPEED_DEG * dt

    const t = (Math.sin(shield.pulseTime * PULSE_SPEED * Math.PI * 2) + 1) / 2
    const alpha = (PULSE_ALPHA_MIN + t * (PULSE_ALPHA_MAX - PULSE_ALPHA_MIN)) * shield.alphaMultiplier
    const scaleMul = PULSE_SCALE_MIN + t * (PULSE_SCALE_MAX - PULSE_SCALE_MIN)

    for (let i = 0; i < shield.planes.length; i++) {
      const plane = shield.planes[i]
      if (!Transform.has(plane)) continue

      const baseDeg = (360 / NUM_PLANES) * i + shield.rotationAngle
      const baseRad = baseDeg * (Math.PI / 180)
      const r = SHIELD_RADIUS * scaleMul
      const x = Math.sin(baseRad) * r
      const z = Math.cos(baseRad) * r

      const transform = Transform.getMutable(plane)
      transform.position = Vector3.create(x, getShieldYOffset(), z)
      transform.rotation = Quaternion.fromEulerDegrees(0, baseDeg, 0)
      transform.scale = Vector3.create(PLANE_WIDTH * scaleMul, PLANE_HEIGHT * scaleMul, 1)
    }

    // Only update material when alpha or emissive changed meaningfully (saves ~450 setPbrMaterial calls/sec)
    const emissive = SHIELD_EMISSIVE_INTENSITY * shield.alphaMultiplier
    if (Math.abs(alpha - shield.lastMaterialAlpha) >= 0.015 || Math.abs(emissive - shield.lastMaterialEmissive) >= 0.05) {
      shield.lastMaterialAlpha = alpha
      shield.lastMaterialEmissive = emissive
      for (const plane of shield.planes) {
        Material.setPbrMaterial(plane, {
          albedoColor: Color4.create(SHIELD_COLOR.r, SHIELD_COLOR.g, SHIELD_COLOR.b, alpha),
          texture: SHIELD_GRADIENT_TEXTURE,
          alphaTexture: SHIELD_GRADIENT_TEXTURE,
          emissiveColor: SHIELD_EMISSIVE,
          emissiveIntensity: emissive,
          roughness: 1.0,
          metallic: 0.0,
          specularIntensity: 0.0,
          transparencyMode: MaterialTransparencyMode.MTM_AUTO,
          castShadows: false,
        })
      }
    }
  }
}
