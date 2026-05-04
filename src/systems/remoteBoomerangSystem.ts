/**
 * Manages boomerang hand models for remote players.
 * When a player changes their boomerang color, the server broadcasts it.
 * Each client creates/updates AvatarAttach boomerangs for other players.
 */
import {
  engine,
  Transform,
  GltfContainer,
  AvatarAttach,
  AvatarAnchorPointType,
  VisibilityComponent,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3, Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { room } from '../shared/messages'
import { BoomerangColor, onBoomerangColorChange } from '../gameState/boomerangColor'

// ── Remote charge effect config ──
const REMOTE_ORBIT_COUNT = 6
const REMOTE_ORBIT_RADIUS = 0.5
const REMOTE_CHARGE_TIME = 1.5 // must match CHARGE_TIME_SEC in projectileSystem

interface RemoteChargeState {
  startTime: number  // Date.now() when charge started
  glow: Entity
  particles: Entity[]
}

interface RemoteBoomerang {
  anchor: Entity
  model: Entity
  color: BoomerangColor
  charge?: RemoteChargeState
  leftAnchor?: Entity
  leftModel?: Entity
}

const remoteBoomerangs = new Map<string, RemoteBoomerang>()

function ensureLeftHand(playerId: string, rb: RemoteBoomerang): void {
  if (!rb.leftAnchor) {
    rb.leftAnchor = engine.addEntity()
    AvatarAttach.create(rb.leftAnchor, {
      avatarId: playerId,
      anchorPointId: AvatarAnchorPointType.AAPT_LEFT_HAND
    })
    Transform.create(rb.leftAnchor, { position: Vector3.Zero(), scale: Vector3.One() })
    rb.leftModel = engine.addEntity()
    Transform.create(rb.leftModel, {
      parent: rb.leftAnchor,
      position: isMobile() ? Vector3.create(0.12, 0.01, -0.13) : Vector3.create(0.05, 0.03, 0.1),
      scale: Vector3.Zero(),
      rotation: Quaternion.fromEulerDegrees(isMobile() ? 15 : 0, isMobile() ? 180 : 0, -90)
    })
    GltfContainer.create(rb.leftModel, {
      src: `assets/models/boomerang.${rb.color}.glb`,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
  }
  // Show/hide based on yellow
  if (rb.leftModel && Transform.has(rb.leftModel)) {
    Transform.getMutable(rb.leftModel).scale = rb.color === 'y' ? Vector3.create(1, 1.5, 1) : Vector3.Zero()
    GltfContainer.createOrReplace(rb.leftModel, {
      src: `assets/models/boomerang.${rb.color}.glb`,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
  }
}

function createRemoteBoomerang(playerId: string, color: BoomerangColor): void {
  if (remoteBoomerangs.has(playerId)) {
    // Update existing
    const rb = remoteBoomerangs.get(playerId)!
    if (rb.color !== color) {
      rb.color = color
      GltfContainer.createOrReplace(rb.model, {
        src: `assets/models/boomerang.${color}.glb`,
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })
    }
    VisibilityComponent.createOrReplace(rb.model, { visible: true })
    ensureLeftHand(playerId, rb)
    return
  }

  const anchor = engine.addEntity()
  AvatarAttach.create(anchor, {
    avatarId: playerId,
    anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND
  })
  Transform.create(anchor, { position: Vector3.Zero(), scale: Vector3.One() })

  const model = engine.addEntity()
  Transform.create(model, {
    parent: anchor,
    position: isMobile() ? Vector3.create(-0.02, 0.13, -0.13) : Vector3.create(0.04, 0.15, 0.1),
    scale: Vector3.create(1, 1.5, 1),
    rotation: Quaternion.fromEulerDegrees(isMobile() ? 15 : 0, isMobile() ? 180 : 0, 90)
  })
  GltfContainer.create(model, {
    src: `assets/models/boomerang.${color}.glb`,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  const rb: RemoteBoomerang = { anchor, model, color }
  remoteBoomerangs.set(playerId, rb)
  ensureLeftHand(playerId, rb)
  console.log(`[RemoteBoomerang] Created hand boomerang for ${playerId} (${color})`)
}

function removeRemoteBoomerang(playerId: string): void {
  const rb = remoteBoomerangs.get(playerId)
  if (!rb) return
  if (rb.charge) {
    engine.removeEntity(rb.charge.glow)
    for (const p of rb.charge.particles) engine.removeEntity(p)
  }
  if (rb.leftModel) engine.removeEntity(rb.leftModel)
  if (rb.leftAnchor) engine.removeEntity(rb.leftAnchor)
  engine.removeEntity(rb.model)
  engine.removeEntity(rb.anchor)
  remoteBoomerangs.delete(playerId)
}

function startRemoteCharge(playerId: string): void {
  const rb = remoteBoomerangs.get(playerId)
  if (!rb || rb.charge) return // no boomerang or already charging

  // Green boomerang: no glow/orbit VFX, just scale the model (handled in anim system)
  if (rb.color === 'g') {
    rb.charge = { startTime: Date.now(), glow: engine.addEntity(), particles: [] }
    // Hidden dummy glow entity (no visuals needed)
    Transform.create(rb.charge.glow, { position: Vector3.Zero(), scale: Vector3.Zero(), parent: rb.model })
    return
  }

  const glow = engine.addEntity()
  Transform.create(glow, { position: Vector3.Zero(), scale: Vector3.Zero(), parent: rb.model })
  MeshRenderer.setSphere(glow)
  Material.setPbrMaterial(glow, {
    albedoColor: Color4.create(1, 1, 1, 0),
    emissiveColor: Color3.create(0.3, 0.6, 1),
    emissiveIntensity: 0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
  })

  const particles: Entity[] = []
  for (let i = 0; i < REMOTE_ORBIT_COUNT; i++) {
    const p = engine.addEntity()
    Transform.create(p, { position: Vector3.Zero(), scale: Vector3.Zero(), parent: rb.model })
    MeshRenderer.setSphere(p)
    Material.setPbrMaterial(p, {
      albedoColor: Color4.create(1, 1, 1, 0),
      emissiveColor: Color3.create(0.3, 0.6, 1),
      emissiveIntensity: 5,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    particles.push(p)
  }

  rb.charge = { startTime: Date.now(), glow, particles }
}

function stopRemoteCharge(playerId: string): void {
  const rb = remoteBoomerangs.get(playerId)
  if (!rb || !rb.charge) return
  engine.removeEntity(rb.charge.glow)
  for (const p of rb.charge.particles) engine.removeEntity(p)
  rb.charge = undefined
}

// System to animate remote charge effects each frame
function remoteChargeAnimSystem(_dt: number): void {
  const now = Date.now()
  remoteBoomerangs.forEach((rb) => {
    if (!rb.charge) {
      // Reset model scale when not charging
      if (rb.color === 'g' && Transform.has(rb.model)) {
        const s = Transform.get(rb.model).scale
        if (s.x !== 1) Transform.getMutable(rb.model).scale = Vector3.One()
      }
      return
    }
    const elapsed = (now - rb.charge.startTime) / 1000
    const cf = Math.min(1, elapsed / REMOTE_CHARGE_TIME)

    // Green: scale the model, no particles
    if (rb.color === 'g') {
      if (Transform.has(rb.model)) {
        const scaleMult = 1 + cf * 2 // 1x to 3x
        Transform.getMutable(rb.model).scale = Vector3.create(scaleMult, scaleMult * 1.5, scaleMult)
      }
      return
    }

    // Blue: glow + orbit particles
    if (Transform.has(rb.charge.glow)) {
      const glowSize = 0.3 + cf * 0.7
      Transform.getMutable(rb.charge.glow).scale = Vector3.create(glowSize, glowSize, glowSize)
      const r = cf > 0.75 ? 1.0 : 0.3
      const g = cf > 0.75 ? 0.2 : 0.6
      const b = cf > 0.75 ? 0.1 : 1.0
      Material.setPbrMaterial(rb.charge.glow, {
        albedoColor: Color4.create(1, 1, 1, 0),
        emissiveColor: Color3.create(r, g, b),
        emissiveIntensity: 2 + cf * 8,
        transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      })
    }

    // Orbit particles
    const speed = 2 * Math.PI * (1 + cf * 5)
    const angle = elapsed * speed
    const radius = REMOTE_ORBIT_RADIUS * (0.5 + cf * 0.5)
    const particleSize = 0.1 + cf * 0.15
    const pr = cf > 0.75 ? 1.0 : 0.3
    const pg = cf > 0.75 ? 0.2 : 0.6
    const pb = cf > 0.75 ? 0.1 : 1.0
    for (let i = 0; i < rb.charge.particles.length; i++) {
      const p = rb.charge.particles[i]
      if (!Transform.has(p)) continue
      const a = angle + (i * 2 * Math.PI) / REMOTE_ORBIT_COUNT
      Transform.getMutable(p).position = Vector3.create(
        Math.cos(a) * radius,
        Math.sin(a) * radius * 0.4,
        Math.sin(a) * radius * 0.6
      )
      Transform.getMutable(p).scale = Vector3.create(particleSize, particleSize, particleSize)
      Material.setPbrMaterial(p, {
        albedoColor: Color4.create(1, 1, 1, 0),
        emissiveColor: Color3.create(pr, pg, pb),
        emissiveIntensity: 5 + cf * 5,
        transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      })
    }
  })
}

export function setupRemoteBoomerangs(): void {
  // Listen for color changes from other players
  room.onMessage('playerColorChanged', (data) => {
    const playerId = data.playerId?.toLowerCase()
    if (!playerId) return

    // Skip local player — their hand boomerang is managed by projectileSystem
    // Re-fetch each time since getPlayerData() may return null during early setup
    const localUserId = getPlayerData()?.userId?.toLowerCase()
    if (localUserId && playerId === localUserId) return

    const color = (['r', 'y', 'b', 'g'].includes(data.color) ? data.color : 'r') as BoomerangColor
    console.log(`[RemoteBoomerang] Player ${playerId} color → ${color}`)
    createRemoteBoomerang(playerId, color)
  })

  // When LOCAL player changes color, notify server
  onBoomerangColorChange((color) => {
    room.send('colorChanged', { color })
  })

  // Listen for remote charge start/stop
  room.onMessage('playerChargeStart', (data) => {
    const playerId = data.playerId?.toLowerCase()
    if (!playerId) return
    const localUserId = getPlayerData()?.userId?.toLowerCase()
    if (localUserId && playerId === localUserId) return
    startRemoteCharge(playerId)
  })

  room.onMessage('playerChargeStop', (data) => {
    const playerId = data.playerId?.toLowerCase()
    if (!playerId) return
    const localUserId = getPlayerData()?.userId?.toLowerCase()
    if (localUserId && playerId === localUserId) return
    stopRemoteCharge(playerId)
  })

  // Register animation system
  engine.addSystem(remoteChargeAnimSystem)
}

/** Remove a remote player's hand boomerang when they leave the scene. */
export function cleanupRemoteBoomerang(userId: string): void {
  removeRemoteBoomerang(userId.toLowerCase())
}
