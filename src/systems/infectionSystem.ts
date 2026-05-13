/**
 * Client-side Infection System — handles infection event visuals,
 * local infection state tracking, and sword attack VFX.
 */
import {
  engine,
  Transform,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  AudioSource,
  AvatarAttach,
  AvatarAnchorPointType,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color4, Color3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { InfectionState, PlayerInfected, INFECTION_RADIUS } from '../shared/components'
import { room } from '../shared/messages'

// ── Local infection state (readable by UI) ──
let localIsInfected = false
let humansRemaining = 0
let roundActive = false
let patientZeroId = ''
let infectedPlayerIds: string[] = []

// Status flash (brief message at top of screen)
let statusFlashText = ''
let statusFlashUntil = 0
const STATUS_FLASH_DURATION_MS = 3000

export function getLocalIsInfected(): boolean { return localIsInfected }
export function getHumansRemaining(): number { return humansRemaining }
export function isInfectionRoundActive(): boolean { return roundActive }
export function getPatientZeroId(): string { return patientZeroId }
export function getInfectedPlayerIds(): string[] { return infectedPlayerIds }
export function getStatusFlashText(): string {
  if (Date.now() > statusFlashUntil) return ''
  return statusFlashText
}

function showStatusFlash(text: string, durationMs: number = STATUS_FLASH_DURATION_MS): void {
  statusFlashText = text
  statusFlashUntil = Date.now() + durationMs
}

// ── VFX pools ──

// Infection splat particles (green puffs at infection point)
const SPLAT_POOL_SIZE = 12
const SPLAT_LIFETIME_MS = 1200
const splatPool: Entity[] = []
let splatPoolIdx = 0
let splatPoolReady = false
interface SplatParticle {
  entity: Entity
  spawnTime: number
  startPos: Vector3
}
const activeSplats: SplatParticle[] = []
const HIDDEN_POS = Vector3.create(0, -500, 0)

function initSplatPool(): void {
  if (splatPoolReady) return
  splatPoolReady = true
  for (let i = 0; i < SPLAT_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, {
      albedoColor: Color4.create(0.2, 0.9, 0.1, 0.7),
      emissiveColor: Color3.create(0.1, 0.8, 0.05),
      emissiveIntensity: 4,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    splatPool.push(e)
  }
}

function spawnInfectionSplat(position: Vector3): void {
  initSplatPool()
  // Spawn 4 particles in a burst
  for (let j = 0; j < 4; j++) {
    const e = splatPool[splatPoolIdx % SPLAT_POOL_SIZE]
    splatPoolIdx++
    const jittered = Vector3.create(
      position.x + (Math.random() - 0.5) * 1.5,
      position.y + Math.random() * 2,
      position.z + (Math.random() - 0.5) * 1.5,
    )
    const s = 0.15 + Math.random() * 0.2
    Transform.createOrReplace(e, {
      position: jittered,
      scale: Vector3.create(s, s, s)
    })
    activeSplats.push({ entity: e, spawnTime: Date.now(), startPos: jittered })
  }
}

// Sword swing VFX (orange arc particles)
const SWING_POOL_SIZE = 8
const SWING_LIFETIME_MS = 600
const swingPool: Entity[] = []
let swingPoolIdx = 0
let swingPoolReady = false
interface SwingParticle {
  entity: Entity
  spawnTime: number
}
const activeSwings: SwingParticle[] = []

function initSwingPool(): void {
  if (swingPoolReady) return
  swingPoolReady = true
  for (let i = 0; i < SWING_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setBox(e)
    Material.setPbrMaterial(e, {
      albedoColor: Color4.create(1, 0.6, 0.1, 0.8),
      emissiveColor: Color3.create(1, 0.5, 0),
      emissiveIntensity: 6,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    swingPool.push(e)
  }
}

function spawnSwingVfx(position: Vector3): void {
  initSwingPool()
  for (let j = 0; j < 3; j++) {
    const e = swingPool[swingPoolIdx % SWING_POOL_SIZE]
    swingPoolIdx++
    const angle = (j / 3) * Math.PI * 2
    const radius = 1.5
    const pos = Vector3.create(
      position.x + Math.cos(angle) * radius,
      position.y + 1 + Math.random() * 0.5,
      position.z + Math.sin(angle) * radius,
    )
    Transform.createOrReplace(e, {
      position: pos,
      scale: Vector3.create(0.08, 0.4, 0.08)
    })
    activeSwings.push({ entity: e, spawnTime: Date.now() })
  }
}

// Kill VFX (red burst when slime is killed)
function spawnKillVfx(position: Vector3): void {
  initSplatPool()
  for (let j = 0; j < 3; j++) {
    const e = splatPool[splatPoolIdx % SPLAT_POOL_SIZE]
    splatPoolIdx++
    const jittered = Vector3.create(
      position.x + (Math.random() - 0.5) * 1,
      position.y + 0.5 + Math.random() * 1.5,
      position.z + (Math.random() - 0.5) * 1,
    )
    Transform.createOrReplace(e, {
      position: jittered,
      scale: Vector3.create(0.25, 0.25, 0.25)
    })
    // Reuse splat pool with red color
    Material.setPbrMaterial(e, {
      albedoColor: Color4.create(1, 0.15, 0.1, 0.8),
      emissiveColor: Color3.create(1, 0.1, 0),
      emissiveIntensity: 5,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    activeSplats.push({ entity: e, spawnTime: Date.now(), startPos: jittered })
  }
}

// ── Sound entities ──
let infectionSoundEntity: Entity | null = null
let swordSwingSoundEntity: Entity | null = null

function playInfectionSound(): void {
  if (!infectionSoundEntity) {
    infectionSoundEntity = engine.addEntity()
    Transform.create(infectionSoundEntity, { position: Vector3.Zero() })
  }
  AudioSource.createOrReplace(infectionSoundEntity, {
    audioClipUrl: 'assets/sounds/drop.mp3',  // reuse existing sound for now
    playing: true, loop: false, volume: 0.5, global: true
  })
}

function playSwordSwingSound(): void {
  if (!swordSwingSoundEntity) {
    swordSwingSoundEntity = engine.addEntity()
    Transform.create(swordSwingSoundEntity, { position: Vector3.Zero() })
  }
  AudioSource.createOrReplace(swordSwingSoundEntity, {
    audioClipUrl: 'assets/sounds/pickup2.wav',  // reuse existing sound for now
    playing: true, loop: false, volume: 0.4, global: true
  })
}

// ── Message listeners (set up once) ──
let listenersReady = false

function setupInfectionListeners(): void {
  if (listenersReady) return
  listenersReady = true

  const localPlayer = getPlayer()
  const localUserId = localPlayer?.userId?.toLowerCase() ?? ''

  room.onMessage('roundStartInfection', (data) => {
    patientZeroId = data.patientZeroId
    if (data.patientZeroId.toLowerCase() === localUserId) {
      showStatusFlash('☠️ YOU ARE PATIENT ZERO! Infect everyone!', 5000)
    } else {
      showStatusFlash('⚠️ INFECTION STARTED — Run from the slimes!', 4000)
    }
  })

  room.onMessage('playerInfected', (data) => {
    playInfectionSound()
    // Spawn green splat at a rough position (we don't have exact pos, use player entity)
    if (Transform.has(engine.PlayerEntity)) {
      const myPos = Transform.get(engine.PlayerEntity).position
      // If WE are the victim, show splat at our position
      if (data.victimId.toLowerCase() === localUserId) {
        spawnInfectionSplat(myPos)
        showStatusFlash('☠️ YOU HAVE BEEN INFECTED!', 3000)
      }
    }
  })

  room.onMessage('swordAttackVfx', (data) => {
    playSwordSwingSound()
    spawnSwingVfx(Vector3.create(data.x, data.y, data.z))
  })

  room.onMessage('slimeKilled', (data) => {
    spawnKillVfx(Vector3.create(data.x, data.y, data.z))
    if (data.slimeId.toLowerCase() === localUserId) {
      showStatusFlash('💀 You were slain! Respawning...', 3000)
    }
  })

  room.onMessage('slimeRespawned', (data) => {
    if (data.slimeId.toLowerCase() === localUserId) {
      showStatusFlash('🔄 You have respawned!', 2000)
    }
  })

  room.onMessage('lastHumanWin', (data) => {
    showStatusFlash('🏆 Last human standing wins!', 4000)
  })

  room.onMessage('allHumansInfected', (_data) => {
    showStatusFlash('☠️ ALL HUMANS INFECTED — Round Over!', 4000)
  })
}

// ── Slime Aura System ──
// Green transparent sphere attached to each infected player, sized to INFECTION_RADIUS.
// Uses AvatarAttach (AAPT_POSITION) → child sphere so it follows the player.

const slimeAuras = new Map<string, { anchor: Entity; orb: Entity }>()

/** Diameter = INFECTION_RADIUS * 2. The sphere mesh has radius 0.5, so scale = diameter. */
const AURA_DIAMETER = INFECTION_RADIUS * 2

function getOrCreateAura(playerId: string): { anchor: Entity; orb: Entity } {
  const existing = slimeAuras.get(playerId)
  if (existing) return existing

  // Anchor — attached to player position
  const anchor = engine.addEntity()
  Transform.create(anchor, { position: Vector3.Zero() })
  AvatarAttach.create(anchor, {
    avatarId: playerId,
    anchorPointId: AvatarAnchorPointType.AAPT_POSITION
  })

  // Orb — child of anchor, centered at waist height
  const orb = engine.addEntity()
  Transform.create(orb, {
    parent: anchor,
    position: Vector3.create(0, 1, 0), // waist height
    scale: Vector3.create(AURA_DIAMETER, AURA_DIAMETER, AURA_DIAMETER)
  })
  MeshRenderer.setSphere(orb)
  Material.setPbrMaterial(orb, {
    albedoColor: Color4.create(0.1, 0.8, 0.05, 0.12),
    emissiveColor: Color3.create(0.1, 0.6, 0.02),
    emissiveIntensity: 2,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
  })

  const entry = { anchor, orb }
  slimeAuras.set(playerId, entry)
  return entry
}

function hideAura(playerId: string): void {
  const entry = slimeAuras.get(playerId)
  if (!entry) return
  if (Transform.has(entry.orb)) {
    Transform.getMutable(entry.orb).scale = Vector3.Zero()
  }
}

function showAura(playerId: string): void {
  const entry = getOrCreateAura(playerId)
  if (Transform.has(entry.orb)) {
    Transform.getMutable(entry.orb).scale = Vector3.create(AURA_DIAMETER, AURA_DIAMETER, AURA_DIAMETER)
  }
}

function updateSlimeAuras(infectedIds: string[], active: boolean): void {
  if (!active) {
    // Round not active — hide all auras
    for (const [id] of slimeAuras) {
      hideAura(id)
    }
    return
  }

  // Build set of currently infected
  const infectedSet = new Set(infectedIds.map(id => id.toLowerCase()))

  // Show auras for infected players
  for (const id of infectedSet) {
    showAura(id)
  }

  // Hide auras for players no longer infected
  for (const [id] of slimeAuras) {
    if (!infectedSet.has(id)) {
      hideAura(id)
    }
  }
}

// ── Per-frame system ──

export function infectionClientSystem(dt: number): void {
  setupInfectionListeners()

  const localPlayer = getPlayer()
  const localUserId = localPlayer?.userId?.toLowerCase() ?? ''

  // Read InfectionState CRDT component
  for (const [, state] of engine.getEntitiesWith(InfectionState)) {
    humansRemaining = state.humansRemaining
    roundActive = state.roundActive
    if (state.patientZeroId) patientZeroId = state.patientZeroId
    try {
      infectedPlayerIds = JSON.parse(state.infectedPlayersJson || '[]')
    } catch { infectedPlayerIds = [] }
    break
  }

  // Read local player's PlayerInfected component
  for (const [, data] of engine.getEntitiesWith(PlayerInfected)) {
    if (data.playerId.toLowerCase() === localUserId) {
      localIsInfected = data.isInfected
      break
    }
  }

  // ── Slime aura management ──
  // Create/show green orbs for infected players, hide for humans
  updateSlimeAuras(infectedPlayerIds, roundActive)

  // ── Update VFX particles ──
  const now = Date.now()

  // Infection splats
  for (let i = activeSplats.length - 1; i >= 0; i--) {
    const sp = activeSplats[i]
    const elapsed = now - sp.spawnTime
    const progress = Math.min(1, elapsed / SPLAT_LIFETIME_MS)
    if (progress >= 1) {
      const t = Transform.getMutable(sp.entity)
      t.position = HIDDEN_POS
      t.scale = Vector3.Zero()
      // Restore green color for reuse
      Material.setPbrMaterial(sp.entity, {
        albedoColor: Color4.create(0.2, 0.9, 0.1, 0.7),
        emissiveColor: Color3.create(0.1, 0.8, 0.05),
        emissiveIntensity: 4,
        transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      })
      activeSplats.splice(i, 1)
      continue
    }
    // Float up and fade
    const t = Transform.getMutable(sp.entity)
    t.position = Vector3.create(sp.startPos.x, sp.startPos.y + progress * 2, sp.startPos.z)
    const scale = (1 - progress) * 0.2
    t.scale = Vector3.create(scale, scale, scale)
  }

  // Sword swing particles
  for (let i = activeSwings.length - 1; i >= 0; i--) {
    const sw = activeSwings[i]
    const elapsed = now - sw.spawnTime
    const progress = Math.min(1, elapsed / SWING_LIFETIME_MS)
    if (progress >= 1) {
      const t = Transform.getMutable(sw.entity)
      t.position = HIDDEN_POS
      t.scale = Vector3.Zero()
      activeSwings.splice(i, 1)
      continue
    }
    const scale = (1 - progress)
    const t = Transform.getMutable(sw.entity)
    t.scale = Vector3.create(0.08 * scale, 0.4 * scale, 0.08 * scale)
  }
}
