import { engine, Entity, Transform, MeshRenderer, Material, VisibilityComponent, LightSource, AudioSource, InputModifier, PlayerIdentityData } from '@dcl/sdk/ecs'
import { Vector3, Color4, Color3, Quaternion } from '@dcl/sdk/math'
import { flagSyncedEntity } from './flagSystem'
import { Flag, FlagState } from '../shared/components'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { triggerEmote, movePlayerTo } from '~system/RestrictedActions'
import { room } from '../shared/messages'
import { setLightningRespawning } from '../gameState/lightningState'


// Lightning bolt config
// Lightning rolls are now handled server-side
const FLASH_DURATION = 0.45   // total duration
const FLICKER_OFF_START = 0.15 // when the single flicker-off begins
const FLICKER_OFF_END = 0.22   // when it comes back on

const BOLT_COLOR = Color3.create(0.7, 0.8, 1)        // cool white-blue
const BOLT_INTENSITY = 8.0
const FLASH_LIGHT_INTENSITY = 3000

// Strike target (fallback if flag not found)
const FALLBACK_X = 201
const FALLBACK_Y = 14
const FALLBACK_Z = 273
const SKY_HEIGHT = 41  // how far above target the bolt starts

/** Get the carrier player's entity from their ID */
function getCarrierEntity(carrierPlayerId: string): Entity | null {
  if (!carrierPlayerId) return null
  const needle = carrierPlayerId.toLowerCase()

  const local = getPlayerData()
  if (local) {
    const localIdentity = PlayerIdentityData.getOrNull(engine.PlayerEntity)
    if (localIdentity && localIdentity.address.toLowerCase() === needle) {
      return engine.PlayerEntity
    }
    if (local.userId?.toLowerCase() === needle) {
      return engine.PlayerEntity
    }
  }

  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address.toLowerCase() === needle) {
      return entity as Entity
    }
  }
  return null
}

function getStrikeTarget(): { x: number; y: number; z: number } {
  // When flag is carried, target the carrier's position
  if (flagSyncedEntity && Flag.has(flagSyncedEntity)) {
    const flag = Flag.get(flagSyncedEntity)
    if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
      const carrierEntity = getCarrierEntity(flag.carrierPlayerId)
      if (carrierEntity && Transform.has(carrierEntity)) {
        const pos = Transform.get(carrierEntity).position
        return { x: pos.x, y: pos.y, z: pos.z }
      }
    }
  }
  // Fallback to flag synced position
  if (flagSyncedEntity && Transform.has(flagSyncedEntity)) {
    const pos = Transform.get(flagSyncedEntity).position
    return { x: pos.x, y: pos.y, z: pos.z }
  }
  return { x: FALLBACK_X, y: FALLBACK_Y, z: FALLBACK_Z }
}

// Spark ring config
const SPARK_COUNT = 6
const SPARK_ORBIT_RADIUS = 1.8
const SPARK_SIZE = 0.15
const SPARK_BASE_SPEED = 1.5    // rotations per second at start
const SPARK_MAX_SPEED = 8.0     // rotations per second right before strike
const SPARK_COLOR = Color3.create(0.5, 0.7, 1)

// Respawn config
const LIGHTNING_RESPAWN_DURATION = 10.0
const LIGHTNING_FADE_IN = 1.5
const LIGHTNING_FADE_OUT = 1.5
const SPAWN_POSITION = Vector3.create(263, 48, 298)

// Respawn state
let lightningRespawnDelay = 0
let deathSoundEntity: Entity | null = null

/** Returns true if player is in lightning death respawn */
export function isLightningRespawning(): boolean {
  return lightningRespawnDelay > 0
}


/** Returns 0..1 opacity for lightning death fade overlay */
export function getLightningFadeOpacity(): number {
  if (lightningRespawnDelay <= 0) return 0
  const elapsed = LIGHTNING_RESPAWN_DURATION - lightningRespawnDelay
  if (elapsed < LIGHTNING_FADE_IN) return elapsed / LIGHTNING_FADE_IN
  if (lightningRespawnDelay < LIGHTNING_FADE_OUT) return lightningRespawnDelay / LIGHTNING_FADE_OUT
  return 1
}

/** Returns seconds remaining until respawn, or 0 */
export function getLightningRespawnCountdown(): number {
  return lightningRespawnDelay
}

/** Cancel lightning respawn (e.g., round end cinematic interrupts) */
export function cancelLightningRespawn(): void {
  if (lightningRespawnDelay <= 0) return
  lightningRespawnDelay = 0
  setLightningRespawning(false)
  console.log('[Lightning] Respawn cancelled (round end)')
}

/** Returns true if death text should show (not during fade-out) */
export function isLightningTextVisible(): boolean {
  if (lightningRespawnDelay <= 0) return false
  return lightningRespawnDelay >= LIGHTNING_FADE_OUT
}

// State
const WARNING_LEAD = 3.0  // seconds before strike for visual warning
const THUNDER_LEAD = 1.5  // seconds before strike for thunder sound


let strikeScheduled = false  // a strike has been decided, warning phase active
let warningTimer = 0      // counts up during warning phase
let soundPlayed = false
let flashTimer = 0
let flickeredOff = false
let flickeredBackOn = false
let isFlashing = false
let strikeTarget: { x: number; y: number; z: number } | null = null
let boltEntities: Entity[] = []
let flashLightEntity: Entity | null = null
let thunderEntity: Entity | null = null
let sparkEntities: Entity[] = []
let sparkAngle = 0
let sparksActive = false


let buzzEntity: Entity | null = null

/**
 * Build a zigzag bolt from (startX, startY, startZ) down to the strike point.
 * Each segment is a thin box stretched and rotated to connect two points.
 */
function createSegment(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  thickness: number
): Entity {
  const e = engine.addEntity()

  // Midpoint
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  const mz = (az + bz) / 2

  // Length
  const dx = bx - ax
  const dy = by - ay
  const dz = bz - az
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)

  // Rotation: orient Y-axis along the segment direction
  const dir = Vector3.normalize(Vector3.create(dx, dy, dz))
  const up = Vector3.Up()
  // Use quaternion lookRotation then rotate 90 on X to align box Y with direction
  const rot = Quaternion.fromLookAt(Vector3.create(mx, my, mz), Vector3.create(mx + dir.x, my + dir.y, mz + dir.z), up)
  
  // Actually, simpler: compute rotation to align (0,1,0) to dir
  const q = quatFromTo(Vector3.Up(), dir)

  Transform.create(e, {
    position: Vector3.create(mx, my, mz),
    scale: Vector3.create(thickness, len, thickness),
    rotation: q
  })

  MeshRenderer.setBox(e)

  // Bright emissive white-blue material
  Material.setPbrMaterial(e, {
    albedoColor: Color4.create(0.9, 0.95, 1, 1),
    emissiveColor: BOLT_COLOR,
    emissiveIntensity: BOLT_INTENSITY,
    metallic: 0,
    roughness: 1
  })

  VisibilityComponent.create(e, { visible: false })

  return e
}

/** Quaternion that rotates vector `from` to vector `to` */
function quatFromTo(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
  const dot = from.x * to.x + from.y * to.y + from.z * to.z
  const cx = from.y * to.z - from.z * to.y
  const cy = from.z * to.x - from.x * to.z
  const cz = from.x * to.y - from.y * to.x
  
  // Handle near-parallel case
  if (dot > 0.9999) return Quaternion.Identity()
  if (dot < -0.9999) return Quaternion.fromEulerDegrees(0, 0, 180)

  const w = 1 + dot
  const len = Math.sqrt(cx * cx + cy * cy + cz * cz + w * w)
  return { x: cx / len, y: cy / len, z: cz / len, w: w / len }
}

/** Generate random zigzag waypoints from sky to target */
function generateBoltPath(target: { x: number; y: number; z: number }): { x: number; y: number; z: number }[] {
  const points: { x: number; y: number; z: number }[] = []
  const skyY = target.y + SKY_HEIGHT
  points.push({ x: target.x, y: skyY, z: target.z })

  const numSegments = 6
  const segHeight = SKY_HEIGHT / numSegments

  for (let i = 1; i < numSegments; i++) {
    const y = skyY - segHeight * i
    const spread = 2.5 * (1 - i / numSegments)
    const x = target.x + (Math.random() - 0.5) * spread * 2
    const z = target.z + (Math.random() - 0.5) * spread * 2
    points.push({ x, y, z })
  }

  points.push({ x: target.x, y: target.y, z: target.z })
  return points
}

/** Create a branch (smaller zigzag splitting off from a point) */
function createBranch(
  startX: number, startY: number, startZ: number
): Entity[] {
  const entities: Entity[] = []
  const branchLen = 2 + Math.random() * 3
  const segments = 2 + Math.floor(Math.random() * 2)
  const segLen = branchLen / segments

  // Random horizontal direction
  const angle = Math.random() * Math.PI * 2
  const dirX = Math.cos(angle)
  const dirZ = Math.sin(angle)

  let cx = startX, cy = startY, cz = startZ
  for (let i = 0; i < segments; i++) {
    const nx = cx + dirX * segLen * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.5
    const ny = cy - segLen * (0.5 + Math.random() * 0.3)
    const nz = cz + dirZ * segLen * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.5
    entities.push(createSegment(cx, cy, cz, nx, ny, nz, 0.2))
    cx = nx; cy = ny; cz = nz
  }

  return entities
}

export function setupLightning() {
  const t = getStrikeTarget()

  // Create flash light at strike point
  flashLightEntity = engine.addEntity()
  Transform.create(flashLightEntity, { position: Vector3.create(t.x, t.y + 2, t.z) })
  LightSource.create(flashLightEntity, {
    type: LightSource.Type.Point({}),
    color: BOLT_COLOR,
    intensity: 0,
    range: 50
  })

  // Death sound (reuse gameover sound)
  deathSoundEntity = engine.addEntity()
  Transform.create(deathSoundEntity, { position: Vector3.Zero() })
  AudioSource.create(deathSoundEntity, {
    audioClipUrl: 'assets/sounds/gameover.wav',
    playing: false,
    loop: false,
    volume: 1.0,
    global: true
  })

  // Thunder sound entity
  thunderEntity = engine.addEntity()
  Transform.create(thunderEntity, { position: Vector3.create(t.x, t.y, t.z) })
  AudioSource.create(thunderEntity, {
    audioClipUrl: 'assets/sounds/lighting.mp3',
    playing: false,
    loop: false,
    volume: 1.0,
    global: true
  })

  // Buzz warning sound
  buzzEntity = engine.addEntity()
  Transform.create(buzzEntity, { position: Vector3.create(t.x, t.y, t.z) })
  AudioSource.create(buzzEntity, {
    audioClipUrl: 'assets/sounds/buzz.mp3',
    playing: false,
    loop: false,
    volume: 0.4,
    global: true
  })

  // Create spark ring entities
  for (let i = 0; i < SPARK_COUNT; i++) {
    const spark = engine.addEntity()
    Transform.create(spark, {
      position: Vector3.create(t.x, t.y, t.z),
      scale: Vector3.create(SPARK_SIZE, SPARK_SIZE, SPARK_SIZE)
    })
    MeshRenderer.setBox(spark)
    Material.setPbrMaterial(spark, {
      albedoColor: Color4.create(0.8, 0.9, 1, 1),
      emissiveColor: SPARK_COLOR,
      emissiveIntensity: 5.0,
      metallic: 0,
      roughness: 1
    })
    VisibilityComponent.create(spark, { visible: false })
    sparkEntities.push(spark)
  }

  // Generate initial bolt
  rebuildBolt()
}

function rebuildBolt() {
  // Remove old segments
  for (const e of boltEntities) {
    engine.removeEntity(e)
  }
  boltEntities = []

  // Use the strike target set by the server message, or fall back to live position
  const target = strikeTarget ?? getStrikeTarget()
  const path = generateBoltPath(target)

  // Move flash light to target
  if (flashLightEntity) {
    Transform.getMutable(flashLightEntity).position = Vector3.create(target.x, target.y + 2, target.z)
  }
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]
    const b = path[i + 1]
    // Main segment (thicker)
    boltEntities.push(createSegment(a.x, a.y, a.z, b.x, b.y, b.z, 0.4))
    // Inner core (thinner, brighter)
    const core = createSegment(a.x, a.y, a.z, b.x, b.y, b.z, 0.15)
    Material.setPbrMaterial(core, {
      albedoColor: Color4.White(),
      emissiveColor: Color3.White(),
      emissiveIntensity: 15,
      metallic: 0,
      roughness: 1
    })
    boltEntities.push(core)
  }

  // Add 2-3 branches from random midpoints
  const branchCount = 2 + Math.floor(Math.random() * 2)
  for (let b = 0; b < branchCount; b++) {
    const idx = 1 + Math.floor(Math.random() * (path.length - 2))
    const p = path[idx]
    const branchEnts = createBranch(p.x, p.y, p.z)
    boltEntities.push(...branchEnts)
  }
}

function showBolt() {
  for (const e of boltEntities) {
    VisibilityComponent.getMutable(e).visible = true
  }
  if (flashLightEntity) {
    LightSource.getMutable(flashLightEntity).intensity = FLASH_LIGHT_INTENSITY
  }
}

function hideBolt() {
  for (const e of boltEntities) {
    VisibilityComponent.getMutable(e).visible = false
  }
  if (flashLightEntity) {
    LightSource.getMutable(flashLightEntity).intensity = 0
  }
}

function isFlagCarried(): boolean {
  if (!flagSyncedEntity || !Flag.has(flagSyncedEntity)) return false
  return Flag.get(flagSyncedEntity).state === FlagState.Carried
}

/** Execute the visual bolt strike at a position (called by all clients) */
function executeStrike(pos: { x: number; y: number; z: number }) {
  strikeTarget = pos
  flashTimer = 0
  flickeredOff = false
  flickeredBackOn = false
  isFlashing = true

  rebuildBolt()
  showBolt()

  // Thunder sound
  if (thunderEntity) {
    AudioSource.getMutable(thunderEntity).playing = false
    AudioSource.getMutable(thunderEntity).playing = true
  }
}

/** Called by carrier's client to handle death */
function handleLocalDeath() {
  room.send('requestDrop', { t: 0 })

  void triggerEmote({ predefinedEmote: 'urn:decentraland:matic:collections-v2:0x7bdc37ff3e8dca2d69f01a3dc34f3ad82e2e1870:0' })
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: true })
  })

  if (deathSoundEntity) {
    const a = AudioSource.getMutable(deathSoundEntity)
    a.currentTime = 0
    a.playing = true
  }

  lightningRespawnDelay = LIGHTNING_RESPAWN_DURATION
  setLightningRespawning(true)
  console.log('[Lightning] ⚡ Struck the flag carrier! Death + respawn triggered')
}

export function setupLightningMessages() {
  // All clients: start warning phase when carrier's client decides a strike is coming
  room.onMessage('lightningWarning', () => {
    console.log('[Lightning] ⚠️ Warning received from server — strike incoming in 3s!')
    if (!strikeScheduled) {
      strikeScheduled = true
      warningTimer = 0
      soundPlayed = false
    }
  })

  // All clients: show the bolt at the strike position
  room.onMessage('lightningStrike', (msg) => {
    console.log('[Lightning] ⚡ Strike received at', msg.x.toFixed(1), msg.y.toFixed(1), msg.z.toFixed(1), 'victim:', msg.victimId)
    executeStrike({ x: msg.x, y: msg.y, z: msg.z })

    // If local player is the victim, handle death
    const localPlayer = getPlayerData()
    const isVictim = localPlayer && msg.victimId && localPlayer.userId?.toLowerCase() === msg.victimId.toLowerCase()
    console.log('[Lightning] Local player:', localPlayer?.userId?.slice(0, 8), 'isVictim:', !!isVictim)
    if (isVictim) {
      handleLocalDeath()
    }
  })
}

export function lightningSystem(dt: number) {
  // Handle lightning death respawn (runs regardless of flag state)
  if (lightningRespawnDelay > 0) {
    const prevDelay = lightningRespawnDelay
    lightningRespawnDelay -= dt

    // Teleport once screen is fully black
    const teleportAt = LIGHTNING_RESPAWN_DURATION - LIGHTNING_FADE_IN
    if (prevDelay > teleportAt && lightningRespawnDelay <= teleportAt) {
      void movePlayerTo({ newRelativePosition: SPAWN_POSITION })
    }

    // Cancel emote 1 second before respawn
    if (prevDelay > 1.0 && lightningRespawnDelay <= 1.0) {
      void triggerEmote({ predefinedEmote: 'wave' })
    }

    if (lightningRespawnDelay <= 0) {
      lightningRespawnDelay = 0
      setLightningRespawning(false)
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: false })
      })
    }
  }

  // Handle active bolt flash (all clients)
  if (isFlashing) {
    flashTimer += dt

    if (!flickeredOff && flashTimer >= FLICKER_OFF_START) {
      flickeredOff = true
      hideBolt()
    } else if (!flickeredBackOn && flashTimer >= FLICKER_OFF_END) {
      flickeredBackOn = true
      showBolt()
    }

    if (flashTimer >= FLASH_DURATION) {
      hideBolt()
      isFlashing = false
    }
  }

  // Handle warning phase (all clients see sparks when strike is scheduled)
  if (strikeScheduled) {
    warningTimer += dt

    // Activate sparks + buzz at start
    if (!sparksActive) {
      sparksActive = true
      for (const s of sparkEntities) {
        VisibilityComponent.getMutable(s).visible = true
      }
      if (buzzEntity) {
        const buzz = AudioSource.getMutable(buzzEntity)
        buzz.playing = false
        buzz.playing = true
      }
    }

    // Progress 0→1 over warning period
    const target = getStrikeTarget()
    const progress = Math.min(1, warningTimer / WARNING_LEAD)
    const speed = SPARK_BASE_SPEED + (SPARK_MAX_SPEED - SPARK_BASE_SPEED) * progress
    sparkAngle += speed * dt * Math.PI * 2

    const intensity = 5.0 + progress * 15.0
    const size = SPARK_SIZE + progress * 0.1

    for (let i = 0; i < sparkEntities.length; i++) {
      const angle = sparkAngle + (i / SPARK_COUNT) * Math.PI * 2
      const bobY = Math.sin(sparkAngle * 3 + i) * 0.3
      const x = target.x + Math.cos(angle) * SPARK_ORBIT_RADIUS
      const z = target.z + Math.sin(angle) * SPARK_ORBIT_RADIUS
      const y = target.y + bobY

      const t = Transform.getMutable(sparkEntities[i])
      t.position = Vector3.create(x, y, z)
      t.scale = Vector3.create(size, size, size)
      t.rotation = Quaternion.fromEulerDegrees(sparkAngle * 200 + i * 60, sparkAngle * 300, 0)

      Material.setPbrMaterial(sparkEntities[i]!, {
        albedoColor: Color4.create(0.8, 0.9, 1, 1),
        emissiveColor: SPARK_COLOR,
        emissiveIntensity: intensity,
        metallic: 0,
        roughness: 1
      })
    }

    // Play thunder sound at THUNDER_LEAD before strike
    if (!soundPlayed && warningTimer >= WARNING_LEAD - THUNDER_LEAD) {
      soundPlayed = true
      if (thunderEntity) {
        AudioSource.getMutable(thunderEntity).playing = false
        AudioSource.getMutable(thunderEntity).playing = true
      }
    }

    // Warning period complete — fire the strike
    if (warningTimer >= WARNING_LEAD) {
      // Hide sparks
      sparksActive = false
      for (const s of sparkEntities) {
        VisibilityComponent.getMutable(s).visible = false
      }
      if (buzzEntity) AudioSource.getMutable(buzzEntity).playing = false

      // Strike is now handled server-side — just clean up warning visuals
      strikeScheduled = false
      warningTimer = 0
      soundPlayed = false
    }

    return
  }

  // Clean up sparks if flag is no longer carried
  if (!isFlagCarried()) {
    if (sparksActive) {
      sparksActive = false
      for (const s of sparkEntities) {
        VisibilityComponent.getMutable(s).visible = false
      }
      if (buzzEntity) AudioSource.getMutable(buzzEntity).playing = false
    }
  }
}
