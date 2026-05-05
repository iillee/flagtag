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
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  PlayerIdentityData,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3, Color4 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { room } from '../shared/messages'
import { BoomerangColor, onBoomerangColorChange } from '../gameState/boomerangColor'

// ── Remote charge VFX (parented to hand boomerang, same as local) ──
const REMOTE_ORBIT_PARTICLE_COUNT = 20
const REMOTE_ORBIT_RADIUS = 0.5

interface RemoteChargeState {
  glow: Entity
  particles: Entity[]
  cf: number  // current charge fraction, updated via message
}

interface RemoteOrbitState {
  entity: Entity
  startTime: number
  durationMs: number
  endTime: number  // can be shortened on hit
  angle: number
}

interface RemoteBoomerang {
  anchor: Entity
  model: Entity
  color: BoomerangColor
  charge?: RemoteChargeState
  leftAnchor?: Entity
  leftModel?: Entity
  orbit?: RemoteOrbitState
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
      // Reset scale and transform
      if (Transform.has(rb.model)) {
        const t = Transform.getMutable(rb.model)
        const mobile = isMobile()
        t.scale = Vector3.create(1, 1.5, 1)
        t.position = mobile ? Vector3.create(-0.02, 0.13, -0.13) : Vector3.create(0.04, 0.15, 0.1)
        t.rotation = Quaternion.fromEulerDegrees(mobile ? 15 : 0, mobile ? 180 : 0, 90)
      }
    }
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
  const mobile = isMobile()
  Transform.create(model, {
    parent: anchor,
    position: mobile ? Vector3.create(-0.02, 0.13, -0.13) : Vector3.create(0.04, 0.15, 0.1),
    scale: Vector3.create(1, 1.5, 1),
    rotation: Quaternion.fromEulerDegrees(mobile ? 15 : 0, mobile ? 180 : 0, 90)
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
  if (rb.orbit) {
    engine.removeEntity(rb.orbit.entity)
  }
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
  // Auto-create remote boomerang if not yet known (player may not have sent color yet)
  if (!remoteBoomerangs.has(playerId)) {
    createRemoteBoomerang(playerId, 'b')
  }
  const rb = remoteBoomerangs.get(playerId)
  if (!rb || rb.charge) return // no boomerang or already charging

  // Create orbit particles parented to rb.anchor (uniform scale 1,1,1)
  // No glow sphere — it's invisible locally (alpha:0) but can't be hidden remotely
  // Particles offset to hand model position so they orbit around the boomerang
  const modelPos = isMobile() ? Vector3.create(-0.02, 0.13, -0.13) : Vector3.create(0.04, 0.15, 0.1)

  const particles: Entity[] = []
  for (let i = 0; i < REMOTE_ORBIT_PARTICLE_COUNT; i++) {
    const p = engine.addEntity()
    Transform.create(p, {
      position: modelPos,
      scale: Vector3.Zero(),
      parent: rb.anchor
    })
    MeshRenderer.setSphere(p)
    Material.setPbrMaterial(p, {
      albedoColor: Color4.create(0.3, 0.6, 1, 0.12),
      emissiveColor: Color3.create(0.3, 0.6, 1),
      emissiveIntensity: 5,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    particles.push(p)
  }

  rb.charge = { glow: engine.addEntity(), particles, cf: 0 }
  // glow is a dummy entity (not rendered) to keep interface compatible
  console.log(`[RemoteBoomerang] Created charge VFX for ${playerId} (parented to hand anchor)`)
}

// Track when charge was stopped to ignore stale chargeVfx messages
const chargeStoppedAt = new Map<string, number>()
const CHARGE_STOP_COOLDOWN_MS = 500

function stopRemoteCharge(playerId: string): void {
  const rb = remoteBoomerangs.get(playerId)
  if (!rb || !rb.charge) return
  engine.removeEntity(rb.charge.glow)
  for (const p of rb.charge.particles) engine.removeEntity(p)
  rb.charge = undefined
  chargeStoppedAt.set(playerId, Date.now())
}

/** Update remote charge VFX with new charge fraction (called from combatSystem message handler) */
export function updateRemoteChargeVfx(playerId: string, cf: number): void {
  // Ignore stale chargeVfx messages that arrive after chargeStop
  const stoppedAt = chargeStoppedAt.get(playerId) || 0
  if (Date.now() - stoppedAt < CHARGE_STOP_COOLDOWN_MS) return

  // Auto-create boomerang + charge if needed
  if (!remoteBoomerangs.has(playerId)) {
    createRemoteBoomerang(playerId, 'b')
  }
  const rb = remoteBoomerangs.get(playerId)
  if (!rb) return
  if (!rb.charge) {
    startRemoteCharge(playerId)
  }
  if (rb.charge) {
    rb.charge.cf = cf
  }
}

/** Stop remote charge VFX for a player (called from combatSystem message handler) */
export function stopRemoteChargeVfxForPlayer(playerId: string): void {
  stopRemoteCharge(playerId)
}

// Animate remote charge effects each frame — same math as local (projectileSystem)
function remoteChargeAnimSystem(_dt: number): void {
  const now = Date.now()
  const mobile = isMobile()
  // Model offset from anchor — particles orbit around this point
  const modelPos = mobile ? Vector3.create(-0.02, 0.13, -0.13) : Vector3.create(0.04, 0.15, 0.1)

  remoteBoomerangs.forEach((rb) => {
    if (!rb.charge) return
    const cf = rb.charge.cf

    // Orbit particles — exact same math as local (projectileSystem updateHandBoomerangVisibility)
    const speed = 2 * Math.PI * (1 + cf * 5)
    const angle = (now / 1000) * speed
    const radius = REMOTE_ORBIT_RADIUS * (0.5 + cf * 0.5)
    const particleSize = 0.03 + cf * 0.04
    const pr = cf > 0.75 ? 1.0 : 0.3
    const pg = cf > 0.75 ? 0.84 : 0.6
    const pb = cf > 0.75 ? 0.0 : 1.0
    for (let i = 0; i < rb.charge.particles.length; i++) {
      const p = rb.charge.particles[i]
      if (!Transform.has(p)) continue
      const a = angle + (i * 2 * Math.PI) / REMOTE_ORBIT_PARTICLE_COUNT
      Transform.getMutable(p).position = Vector3.create(
        modelPos.x,
        modelPos.y + Math.sin(a) * radius,
        modelPos.z + Math.cos(a) * radius
      )
      Transform.getMutable(p).scale = Vector3.create(particleSize, particleSize, particleSize)
      Material.setPbrMaterial(p, {
        albedoColor: Color4.create(pr, pg, pb, 0.12),
        emissiveColor: Color3.create(pr, pg, pb),
        emissiveIntensity: 3 + cf * 7,
        transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      })
    }
  })
}

const REMOTE_ORBIT_VIS_RADIUS = 4.0
const REMOTE_ORBIT_FULL_ROTATIONS = 3
const REMOTE_ORBIT_DURATION_MS = 3500
const REMOTE_ORBIT_VIS_SPEED = (REMOTE_ORBIT_FULL_ROTATIONS * 360) / (REMOTE_ORBIT_DURATION_MS / 1000)
const REMOTE_ORBIT_PROJ_SCALE = Vector3.create(2.5, 4.5, 2.5)

function startRemoteOrbit(playerId: string, durationMs: number): void {
  const rb = remoteBoomerangs.get(playerId)
  if (!rb) return
  if (rb.orbit) return // already orbiting

  const orbitEnt = engine.addEntity()
  Transform.create(orbitEnt, { position: Vector3.Zero(), scale: Vector3.Zero() })
  GltfContainer.create(orbitEnt, {
    src: `assets/models/boomerang.${rb.color}.glb`,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  const now = Date.now()
  rb.orbit = { entity: orbitEnt, startTime: now, durationMs, endTime: now + durationMs, angle: 0 }
  // Hide hand model during orbit
  if (Transform.has(rb.model)) {
    Transform.getMutable(rb.model).scale = Vector3.Zero()
  }
  console.log(`[RemoteBoomerang] Orbit started for ${playerId}`)
}

function stopRemoteOrbit(playerId: string): void {
  const rb = remoteBoomerangs.get(playerId)
  if (!rb || !rb.orbit) return
  engine.removeEntity(rb.orbit.entity)
  rb.orbit = undefined
  // Restore hand model
  if (Transform.has(rb.model)) {
    Transform.getMutable(rb.model).scale = Vector3.create(1, 1.5, 1)
  }
  console.log(`[RemoteBoomerang] Orbit ended for ${playerId}`)
}

/** Trigger early ramp-down for remote orbit */
function endRemoteOrbitEarly(playerId: string): void {
  const rb = remoteBoomerangs.get(playerId)
  if (!rb || !rb.orbit) return
  const now = Date.now()
  const remaining = rb.orbit.endTime - now
  if (remaining <= REMOTE_ORBIT_RAMP_MS) return
  rb.orbit.endTime = now + REMOTE_ORBIT_RAMP_MS
}

const REMOTE_ORBIT_RAMP_MS = 400

function remoteOrbitAnimSystem(_dt: number): void {
  const now = Date.now()
  remoteBoomerangs.forEach((rb, playerId) => {
    if (!rb.orbit) return

    const elapsed = now - rb.orbit.startTime
    // Finished (past endTime)
    if (now > rb.orbit.endTime) {
      stopRemoteOrbit(playerId)
      return
    }

    // Find remote player position via PlayerIdentityData
    let playerPos: Vector3 | null = null
    for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      if (identity.address.toLowerCase() === playerId) {
        playerPos = Transform.get(entity).position
        break
      }
    }
    if (!playerPos) return

    // Radius ramps up at start and back down at end
    const timeUntilEnd = rb.orbit.endTime - now
    let radiusFrac = 1.0
    if (elapsed < REMOTE_ORBIT_RAMP_MS) {
      radiusFrac = elapsed / REMOTE_ORBIT_RAMP_MS
    } else if (timeUntilEnd < REMOTE_ORBIT_RAMP_MS) {
      radiusFrac = timeUntilEnd / REMOTE_ORBIT_RAMP_MS
    }
    radiusFrac = radiusFrac * radiusFrac * (3 - 2 * radiusFrac)
    const radius = REMOTE_ORBIT_VIS_RADIUS * radiusFrac

    const currentAngle = REMOTE_ORBIT_VIS_SPEED * (elapsed / 1000)
    const radians = currentAngle * (Math.PI / 180)
    const ox = playerPos.x + Math.sin(radians) * radius
    const oz = playerPos.z + Math.cos(radians) * radius
    const oy = playerPos.y + 1.0

    const axialSpin = (elapsed / 1000) * 1440

    const t = Transform.getMutable(rb.orbit.entity)
    t.position = Vector3.create(ox, oy, oz)
    t.scale = REMOTE_ORBIT_PROJ_SCALE
    t.rotation = Quaternion.fromEulerDegrees(0, currentAngle + 90 + axialSpin, 0)
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

  // Hide remote player's hand boomerang when they throw
  room.onMessage('shellDropped', (data) => {
    const playerId = data.firedBy?.toLowerCase()
    if (!playerId) return
    const localUserId = getPlayerData()?.userId?.toLowerCase()
    if (localUserId && playerId === localUserId) return
    const rb = remoteBoomerangs.get(playerId)
    if (rb && Transform.has(rb.model)) {
      Transform.getMutable(rb.model).scale = Vector3.Zero()
    }
    if (rb && rb.leftModel && Transform.has(rb.leftModel)) {
      Transform.getMutable(rb.leftModel).scale = Vector3.Zero()
    }
  })

  // Restore remote player's hand boomerang when their projectile returns/expires
  room.onMessage('shellReturned', (data) => {
    const playerId = data.firedBy?.toLowerCase()
    if (!playerId) return
    const localUserId = getPlayerData()?.userId?.toLowerCase()
    if (localUserId && playerId === localUserId) return
    const rb = remoteBoomerangs.get(playerId)
    if (!rb) return
    // Restore right hand
    if (Transform.has(rb.model)) {
      const mobile = isMobile()
      const t = Transform.getMutable(rb.model)
      t.scale = Vector3.create(1, 1.5, 1)
      t.position = mobile ? Vector3.create(-0.02, 0.13, -0.13) : Vector3.create(0.04, 0.15, 0.1)
      t.rotation = Quaternion.fromEulerDegrees(mobile ? 15 : 0, mobile ? 180 : 0, 90)
    }
    // Restore left hand for yellow
    if (rb.leftModel && Transform.has(rb.leftModel)) {
      Transform.getMutable(rb.leftModel).scale = rb.color === 'y' ? Vector3.create(1, 1.5, 1) : Vector3.Zero()
    }
  })

  // Listen for remote charge start/stop
  room.onMessage('playerChargeStart', (data) => {
    const playerId = data.playerId?.toLowerCase()
    if (!playerId) return
    const localUserId = getPlayerData()?.userId?.toLowerCase()
    if (localUserId && playerId === localUserId) return
    console.log(`[RemoteBoomerang] Received playerChargeStart for ${playerId}, has entry: ${remoteBoomerangs.has(playerId)}`)
    startRemoteCharge(playerId)
  })

  room.onMessage('playerChargeStop', (data) => {
    const playerId = data.playerId?.toLowerCase()
    if (!playerId) return
    const localUserId = getPlayerData()?.userId?.toLowerCase()
    if (localUserId && playerId === localUserId) return
    stopRemoteCharge(playerId)
  })

  // Listen for remote orbit start/end
  room.onMessage('orbitStarted', (data) => {
    const playerId = data.playerId?.toLowerCase()
    if (!playerId) return
    const localUserId = getPlayerData()?.userId?.toLowerCase()
    if (localUserId && playerId === localUserId) return
    // Auto-create remote boomerang if not yet known
    if (!remoteBoomerangs.has(playerId)) {
      createRemoteBoomerang(playerId, 'g')
    }
    startRemoteOrbit(playerId, data.durationMs || 3500)
  })

  room.onMessage('orbitEnded', (data) => {
    const playerId = data.playerId?.toLowerCase()
    if (!playerId) return
    const localUserId = getPlayerData()?.userId?.toLowerCase()
    if (localUserId && playerId === localUserId) return
    endRemoteOrbitEarly(playerId)
  })

  // Register animation systems
  engine.addSystem(remoteChargeAnimSystem)
  engine.addSystem(remoteOrbitAnimSystem)
}

/** Remove a remote player's hand boomerang when they leave the scene. */
export function cleanupRemoteBoomerang(userId: string): void {
  removeRemoteBoomerang(userId.toLowerCase())
}
