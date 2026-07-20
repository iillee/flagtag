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
  AudioSource,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3, Color4 } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { room } from '../shared/messages'
import { BoomerangColor, onBoomerangColorChange } from '../gameState/boomerangColor'
import { registerSystem } from './systemManager'

// ── Remote charge VFX (parented to hand boomerang, same as local) ──
const REMOTE_ORBIT_PARTICLE_COUNT = 20
const REMOTE_ORBIT_RADIUS = 0.375
const REMOTE_CHARGE_TIME_SEC = 1.5 // must match CHARGE_TIME_SEC in projectileSystem
const REMOTE_CHARGE_PROXIMITY = 16 // meters — only render VFX within this distance

interface RemoteChargeState {
  particles: Entity[]
  startTime: number  // Date.now() when charge started — cf computed client-side
  visible: boolean // proximity-based visibility
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
      position: Vector3.create(0.05, 0.03, 0.1),
      scale: Vector3.Zero(),
      rotation: Quaternion.fromEulerDegrees(0, 0, -90)
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
    // Only reload the GLB when the color actually changed — every playerColorChanged
    // message runs through here, so an unconditional createOrReplace reloads the model
    // even when nothing changed (churn).
    const leftSrc = `assets/models/boomerang.${rb.color}.glb`
    if (GltfContainer.getOrNull(rb.leftModel)?.src !== leftSrc) {
      GltfContainer.createOrReplace(rb.leftModel, {
        src: leftSrc,
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })
    }
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
        t.scale = Vector3.create(1, 1.5, 1)
        t.position = Vector3.create(0.04, 0.15, 0.1)
        t.rotation = Quaternion.fromEulerDegrees(0, 0, 90)
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
  Transform.create(model, {
    parent: anchor,
    position: Vector3.create(0.04, 0.15, 0.1),
    scale: Vector3.create(1, 1.5, 1),
    rotation: Quaternion.fromEulerDegrees(0, 0, 90)
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
    releaseOrbitEntity(rb.orbit.entity)
  }
  if (rb.charge) {
    releaseChargeParticles(rb.charge.particles)
  }
  if (rb.leftModel) engine.removeEntity(rb.leftModel)
  if (rb.leftAnchor) engine.removeEntity(rb.leftAnchor)
  engine.removeEntity(rb.model)
  engine.removeEntity(rb.anchor)
  remoteBoomerangs.delete(playerId)
}

// ── Charge VFX particle pool ──
// Pre-create a shared pool of sphere particles to avoid entity churn.
// Over long sessions (45+ min), creating/destroying 21 entities per charge
// cycle causes the engine to stop rendering GltfContainer models entirely.
const CHARGE_PARTICLE_POOL_SIZE = REMOTE_ORBIT_PARTICLE_COUNT * 5 // enough for 5 concurrent chargers
const chargeParticlePool: Entity[] = []
let chargeParticlePoolReady = false
const CHARGE_HIDDEN_POS = Vector3.create(0, -300, 0)

function initChargeParticlePool(): void {
  if (chargeParticlePoolReady) return
  chargeParticlePoolReady = true
  for (let i = 0; i < CHARGE_PARTICLE_POOL_SIZE; i++) {
    const p = engine.addEntity()
    Transform.create(p, { position: CHARGE_HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(p)
    Material.setPbrMaterial(p, {
      albedoColor: Color4.create(0.045, 0.09, 0.15, 1.0),
      emissiveColor: Color3.create(0.3, 0.6, 1),
      emissiveIntensity: 5,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    chargeParticlePool.push(p)
  }
  console.log('[RemoteBoomerang] Pre-created charge particle pool of', CHARGE_PARTICLE_POOL_SIZE)
}

function acquireChargeParticles(count: number, parentEntity: Entity): Entity[] {
  initChargeParticlePool()
  const acquired: Entity[] = []
  for (const p of chargeParticlePool) {
    if (acquired.length >= count) break
    const t = Transform.get(p)
    if (t.position.y < -100) {
      Transform.createOrReplace(p, {
        position: Vector3.Zero(),
        scale: Vector3.Zero(),
        parent: parentEntity
      })
      acquired.push(p)
    }
  }
  if (acquired.length < count) {
    console.log('[RemoteBoomerang] ⚠️ Charge particle pool low — got', acquired.length, '/', count)
  }
  return acquired
}

function releaseChargeParticles(particles: Entity[]): void {
  for (const p of particles) {
    Transform.createOrReplace(p, { position: CHARGE_HIDDEN_POS, scale: Vector3.Zero() })
  }
}

function startRemoteCharge(playerId: string): void {
  // Auto-create remote boomerang if not yet known (player may not have sent color yet)
  if (!remoteBoomerangs.has(playerId)) {
    createRemoteBoomerang(playerId, 'b')
  }
  const rb = remoteBoomerangs.get(playerId)
  if (!rb || rb.charge) return // no boomerang or already charging

  const particles = acquireChargeParticles(REMOTE_ORBIT_PARTICLE_COUNT, rb.model)

  rb.charge = { particles, startTime: Date.now(), visible: true }
}

// Track when charge was stopped to ignore stale chargeVfx messages
const chargeStoppedAt = new Map<string, number>()
const CHARGE_STOP_COOLDOWN_MS = 500

function stopRemoteCharge(playerId: string): void {
  const rb = remoteBoomerangs.get(playerId)
  if (!rb || !rb.charge) return
  releaseChargeParticles(rb.charge.particles)
  rb.charge = undefined
  chargeStoppedAt.set(playerId, Date.now())
}

/** Stop remote charge VFX for a player (called from combatSystem message handler) */
export function stopRemoteChargeVfxForPlayer(playerId: string): void {
  stopRemoteCharge(playerId)
}

// Animate remote charge effects each frame — cf computed client-side from startTime
function remoteChargeAnimSystem(_dt: number): void {
  const now = Date.now()
  // Get local player position for proximity check
  let localPos: Vector3 | null = null
  if (Transform.has(engine.PlayerEntity)) {
    localPos = Transform.get(engine.PlayerEntity).position
  }

  remoteBoomerangs.forEach((rb, playerId) => {
    if (!rb.charge) return
    // Safety: force-stop a charge whose stop message was lost. Otherwise the
    // pooled particles leak permanently and the VFX stays stuck on the player.
    if (now - rb.charge.startTime > REMOTE_CHARGE_TIME_SEC * 1000 + 1000) {
      stopRemoteCharge(playerId)
      return
    }
    const cf = Math.min(1, (now - rb.charge.startTime) / 1000 / REMOTE_CHARGE_TIME_SEC)

    // Proximity check — find remote player position
    let inRange = false
    if (localPos) {
      for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
        if (identity.address.toLowerCase() === playerId) {
          const rp = Transform.get(entity).position
          const dx = localPos.x - rp.x, dy = localPos.y - rp.y, dz = localPos.z - rp.z
          inRange = (dx * dx + dy * dy + dz * dz) <= REMOTE_CHARGE_PROXIMITY * REMOTE_CHARGE_PROXIMITY
          break
        }
      }
    }

    // Hide/show particles based on proximity
    if (!inRange && rb.charge.visible) {
      for (const p of rb.charge.particles) {
        if (Transform.has(p)) Transform.getMutable(p).scale = Vector3.Zero()
      }
      rb.charge.visible = false
      return
    }
    if (!inRange) return
    rb.charge.visible = true

    // Orbit particles — only update material when charge phase changes (reduces setPbrMaterial calls by ~99%)
    const speed = 2 * Math.PI * (1 + cf * 5)
    // Phase from charge-elapsed time so the growing `speed` doesn't cause chaotic
    // jumps (Date.now()*speed makes the base term explode as speed increases).
    const angle = ((now - rb.charge.startTime) / 1000) * speed
    const radius = REMOTE_ORBIT_RADIUS * (0.5 + cf * 0.5)
    const particleSize = 0.03 + cf * 0.04
    const chargePhase = cf > 0.75 ? 1 : 0  // 0 = blue, 1 = gold
    const lastPhase = (rb.charge as any)._lastPhase ?? -1
    const needsMaterialUpdate = chargePhase !== lastPhase
    if (needsMaterialUpdate) (rb.charge as any)._lastPhase = chargePhase
    const pr = chargePhase === 1 ? 1.0 : 0.3
    const pg = chargePhase === 1 ? 0.84 : 0.6
    const pb = chargePhase === 1 ? 0.0 : 1.0
    for (let i = 0; i < rb.charge.particles.length; i++) {
      const p = rb.charge.particles[i]
      if (!Transform.has(p)) continue
      const a = angle + (i * 2 * Math.PI) / REMOTE_ORBIT_PARTICLE_COUNT
      const t = Transform.getMutable(p)
      t.position = Vector3.create(0, Math.sin(a) * radius, Math.cos(a) * radius)
      t.scale = Vector3.create(particleSize, particleSize, particleSize)
      if (needsMaterialUpdate) {
        Material.setPbrMaterial(p, {
          albedoColor: Color4.create(pr * 0.15, pg * 0.15, pb * 0.15, 1.0),
          emissiveColor: Color3.create(pr, pg, pb),
          emissiveIntensity: chargePhase === 1 ? 10 : 5,
          transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
        })
      }
    }
  })
}

const REMOTE_ORBIT_VIS_RADIUS = 3.0
const REMOTE_ORBIT_FULL_ROTATIONS = 3
const REMOTE_ORBIT_DURATION_MS = 3500
const REMOTE_ORBIT_VIS_SPEED = (REMOTE_ORBIT_FULL_ROTATIONS * 360) / (REMOTE_ORBIT_DURATION_MS / 1000)
const REMOTE_ORBIT_PROJ_SCALE = Vector3.create(2.5, 4.5, 2.5)

// ── Orbit entity pool ──
// Pre-create orbit visual entities to avoid entity churn during long sessions.
const ORBIT_POOL_SIZE = 5
const orbitPool: Entity[] = []
let orbitPoolReady = false
const ORBIT_HIDDEN_POS = Vector3.create(0, -200, 0)
const ORBIT_COLORS: BoomerangColor[] = ['r', 'y', 'b', 'g']

function initOrbitPool(): void {
  if (orbitPoolReady) return
  orbitPoolReady = true
  for (let i = 0; i < ORBIT_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: ORBIT_HIDDEN_POS, scale: Vector3.Zero() })
    GltfContainer.create(e, {
      src: 'assets/models/boomerang.g.glb',
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    AudioSource.create(e, {
      audioClipUrl: 'assets/sounds/boomerang2.mp3',
      playing: false, loop: false, volume: 0, global: false, pitch: 1.3
    })
    orbitPool.push(e)
  }
  console.log('[RemoteBoomerang] Pre-created orbit entity pool of', ORBIT_POOL_SIZE)
}

function acquireOrbitEntity(color: BoomerangColor): Entity | null {
  initOrbitPool()
  // Find one not currently used by any remote boomerang
  for (const e of orbitPool) {
    let inUse = false
    remoteBoomerangs.forEach((rb) => {
      if (rb.orbit && rb.orbit.entity === e) inUse = true
    })
    if (!inUse) {
      GltfContainer.createOrReplace(e, {
        src: `assets/models/boomerang.${color}.glb`,
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })
      return e
    }
  }
  return null
}

function releaseOrbitEntity(entity: Entity): void {
  if (AudioSource.has(entity)) {
    const a = AudioSource.getMutable(entity)
    a.playing = false
    a.volume = 0
    a.loop = false
  }
  const t = Transform.getMutable(entity)
  t.position = ORBIT_HIDDEN_POS
  t.scale = Vector3.Zero()
}

function startRemoteOrbit(playerId: string, durationMs: number, startAngle: number = 0): void {
  const rb = remoteBoomerangs.get(playerId)
  if (!rb) return
  if (rb.orbit) return // already orbiting

  const orbitEnt = acquireOrbitEntity(rb.color)
  if (!orbitEnt) return

  // Start looping spatial sound (lower volume to reduce mobile noise)
  AudioSource.createOrReplace(orbitEnt, {
    audioClipUrl: 'assets/sounds/boomerang2.mp3',
    playing: true,
    loop: true,
    volume: 0.4,
    global: false,
    pitch: 1.3
  })

  const now = Date.now()
  rb.orbit = { entity: orbitEnt, startTime: now, durationMs, endTime: now + durationMs, angle: startAngle }
  // Hide hand model during orbit
  if (Transform.has(rb.model)) {
    Transform.getMutable(rb.model).scale = Vector3.Zero()
  }
  console.log(`[RemoteBoomerang] Orbit started for ${playerId}`)
}

function stopRemoteOrbit(playerId: string): void {
  const rb = remoteBoomerangs.get(playerId)
  if (!rb || !rb.orbit) return
  releaseOrbitEntity(rb.orbit.entity)
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

    const currentAngle = rb.orbit.angle + REMOTE_ORBIT_VIS_SPEED * (elapsed / 1000)
    const radians = currentAngle * (Math.PI / 180)
    const ox = playerPos.x + Math.sin(radians) * radius
    const oz = playerPos.z + Math.cos(radians) * radius
    const oy = playerPos.y + 1.0

    const axialSpin = (elapsed / 1000) * 1080

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
      const t = Transform.getMutable(rb.model)
      t.scale = Vector3.create(1, 1.5, 1)
      t.position = Vector3.create(0.04, 0.15, 0.1)
      t.rotation = Quaternion.fromEulerDegrees(0, 0, 90)
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
    startRemoteOrbit(playerId, data.durationMs || 3500, data.startAngle || 0)
  })

  room.onMessage('orbitEnded', (data) => {
    const playerId = data.playerId?.toLowerCase()
    if (!playerId) return
    const localUserId = getPlayerData()?.userId?.toLowerCase()
    if (localUserId && playerId === localUserId) return
    endRemoteOrbitEarly(playerId)
  })

  // Reconciliation: periodically check for remote players missing hand boomerangs.
  // Messages can be lost during scene load or network hiccups.
  let reconTimer = 0
  const RECON_INTERVAL = 5.0 // seconds
  let reconCooldownUntil = 0 // timestamp — don't re-request until this time
  // Consolidated: reconciliation (throttled) + charge anim + orbit anim in one system
  registerSystem((dt: number) => {
    // Reconciliation (every 5s)
    reconTimer += dt
    if (reconTimer >= RECON_INTERVAL) {
      reconTimer = 0
      const now = Date.now()
      if (now >= reconCooldownUntil) {
        const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
        let missing = false
        for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
          const addr = identity.address.toLowerCase()
          if (addr === localUserId) continue
          if (!remoteBoomerangs.has(addr)) {
            missing = true
            break
          }
        }
        if (missing) {
          reconCooldownUntil = now + 15000
          console.log('[RemoteBoomerang] Reconciliation: requesting all colors from server')
          room.send('requestAllColors', { t: 0 })
        }
      }
    }
    // Per-frame animations
    remoteChargeAnimSystem(dt)
    remoteOrbitAnimSystem(dt)
  })
}

/** Remove a remote player's hand boomerang when they leave the scene. */
export function cleanupRemoteBoomerang(userId: string): void {
  removeRemoteBoomerang(userId.toLowerCase())
}
