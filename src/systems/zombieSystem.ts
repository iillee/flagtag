import {
  engine,
  Transform,
  GltfContainer,
  AudioSource,
  InputModifier,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { movePlayerTo, triggerEmote } from '~system/RestrictedActions'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { Zombie } from '../shared/components'
import { room } from '../shared/messages'
import { showHitEffect, initPools as initCombatPools } from './combatSystem'
import { isCinematicActive } from '../cinematicState'

// ── Visual constants ──
const GHOST_MODEL_SRC = 'models/ghost.glb'

// ── Client-side zombie tracking ──
interface ClientZombie {
  entity: Entity
  modelEntity: Entity    // GLB model
  time: number           // accumulated time for bob/drift
  lastServerPos: Vector3 // last known server position
  renderPos: Vector3     // interpolated render position
  dead: boolean
}

const clientZombies = new Map<Entity, ClientZombie>()

// ── Ghost sound replay timer ──
const GHOST_SOUND_INTERVAL = 5.0 // seconds between sound replays (clip length + gap)
let ghostSoundTimer = 0

// ── Ghost death respawn ──
const GHOST_DEATH_EMOTE = 'urn:decentraland:matic:collections-v2:0x7bdc37ff3e8dca2d69f01a3dc34f3ad82e2e1870:0'
const GHOST_RESPAWN_DURATION = 5.0
const GHOST_FADE_IN = 1.5
const GHOST_FADE_OUT = 0.8
const GHOST_SPAWN_POSITION = Vector3.create(263, 48, 298)

let ghostDeathRespawnDelay = 0
let ghostDeathSoundEntity: Entity | null = null
let pendingGhostDeath = false

function ensureGhostDeathSound() {
  if (ghostDeathSoundEntity) return
  ghostDeathSoundEntity = engine.addEntity()
  Transform.create(ghostDeathSoundEntity, { position: Vector3.Zero() })
  AudioSource.create(ghostDeathSoundEntity, {
    audioClipUrl: 'assets/sounds/death.mp3',
    playing: false,
    loop: false,
    volume: 1.0,
    global: true
  })
}

export function isGhostDeathRespawning(): boolean {
  return ghostDeathRespawnDelay > 0
}

export function getGhostDeathFadeOpacity(): number {
  if (ghostDeathRespawnDelay <= 0) return 0
  const elapsed = GHOST_RESPAWN_DURATION - ghostDeathRespawnDelay
  if (elapsed < GHOST_FADE_IN) return elapsed / GHOST_FADE_IN
  if (ghostDeathRespawnDelay < GHOST_FADE_OUT) return ghostDeathRespawnDelay / GHOST_FADE_OUT
  return 1
}

export function getGhostDeathRespawnCountdown(): number {
  return ghostDeathRespawnDelay
}

export function isGhostDeathTextVisible(): boolean {
  if (ghostDeathRespawnDelay <= 0) return false
  return ghostDeathRespawnDelay >= GHOST_FADE_OUT
}

export function cancelGhostDeathRespawn(): void {
  if (ghostDeathRespawnDelay <= 0) return
  ghostDeathRespawnDelay = 0
  console.log('[Ghost] Death respawn cancelled')
}

room.onMessage('ghostDeath', (data) => {
  const me = getPlayerData()?.userId?.toLowerCase()
  if (me && data.victimId === me) {
    pendingGhostDeath = true
  }
})

// ── Death VFX from server ──
const pendingDeathPositions: Vector3[] = []

room.onMessage('zombieKilled', (data) => {
  pendingDeathPositions.push(Vector3.create(data.x, data.y, data.z))
})

// ── Detect boomerang hits on zombies (client reports to server) ──
// We check distance from active projectiles to zombie positions each frame.
// Import projectile tracking if needed — for now we use a simpler approach:
// The server checks projectile-zombie collisions directly.

export function zombieClientSystem(dt: number): void {
  initCombatPools()
  ensureGhostDeathSound()

  // ── Ghost death: trigger ──
  if (pendingGhostDeath && ghostDeathRespawnDelay <= 0) {
    pendingGhostDeath = false
    room.send('requestDrop', { t: 0 })
    void triggerEmote({ predefinedEmote: GHOST_DEATH_EMOTE })
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({ disableAll: true })
    })
    if (ghostDeathSoundEntity) {
      const a = AudioSource.getMutable(ghostDeathSoundEntity)
      a.currentTime = 0
      a.playing = true
    }
    ghostDeathRespawnDelay = GHOST_RESPAWN_DURATION
    console.log('[Ghost] 👻 You were scared to death!')
  }

  // ── Ghost death: respawn countdown ──
  if (ghostDeathRespawnDelay > 0) {
    if (isCinematicActive()) {
      ghostDeathRespawnDelay = 0
      return
    }
    const prevDelay = ghostDeathRespawnDelay
    ghostDeathRespawnDelay -= dt
    const teleportAt = GHOST_RESPAWN_DURATION - GHOST_FADE_IN
    if (prevDelay > teleportAt && ghostDeathRespawnDelay <= teleportAt) {
      void movePlayerTo({ newRelativePosition: GHOST_SPAWN_POSITION })
    }
    if (ghostDeathRespawnDelay <= 0) {
      ghostDeathRespawnDelay = 0
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: false })
      })
    }
  }

  // Process death VFX
  for (const pos of pendingDeathPositions) {
    showHitEffect(pos)
  }
  pendingDeathPositions.length = 0

  // Track which zombie entities currently exist (server-synced via CRDT)
  const activeZombieEntities = new Set<Entity>()

  for (const [entity] of engine.getEntitiesWith(Zombie, Transform)) {
    activeZombieEntities.add(entity)
    const zombie = Zombie.get(entity)
    const serverTransform = Transform.get(entity)

    if (!zombie.active) {
      // Zombie deactivated — remove visual if exists
      removeZombieVisual(entity)
      continue
    }

    let cz = clientZombies.get(entity)
    if (!cz) {
      // Create visual for new zombie
      cz = createZombieVisual(entity, serverTransform.position)
      clientZombies.set(entity, cz)
    }

    // Update time for animations
    cz.time += dt
    cz.lastServerPos = Vector3.create(serverTransform.position.x, serverTransform.position.y, serverTransform.position.z)

    // Replay ghost sound on interval
    ghostSoundTimer += dt
    if (ghostSoundTimer >= GHOST_SOUND_INTERVAL) {
      ghostSoundTimer = 0
      const audio = AudioSource.getMutable(cz.modelEntity)
      audio.playing = false
      audio.playing = true
    }

    // Smooth interpolation toward server position
    const lerpSpeed = 5.0
    cz.renderPos = Vector3.lerp(cz.renderPos, cz.lastServerPos, Math.min(1, lerpSpeed * dt))

    // Add floaty bob and lateral drift
    const bobY = Math.sin(cz.time * 3.14) * 0.3
    const driftX = Math.sin(cz.time * 1.7) * 0.3
    const driftZ = Math.cos(cz.time * 1.3) * 0.3

    const finalPos = Vector3.create(
      cz.renderPos.x + driftX,
      cz.renderPos.y + bobY + 1.0, // float above ground
      cz.renderPos.z + driftZ
    )

    // Update model transform
    const modelT = Transform.getMutable(cz.modelEntity)
    modelT.position = finalPos

    // Face toward movement direction (smooth rotation)
    const dx = cz.lastServerPos.x - cz.renderPos.x
    const dz = cz.lastServerPos.z - cz.renderPos.z
    if (dx * dx + dz * dz > 0.001) {
      const angle = Math.atan2(dx, dz) * (180 / Math.PI)
      modelT.rotation = Quaternion.fromEulerDegrees(0, angle, 0)
    }

    // Gentle scale pulse
    const pulse = 1.0 + Math.sin(cz.time * 5.0) * 0.03
    modelT.scale = Vector3.create(1.2 * pulse, 1.2 * pulse, 1.2 * pulse)
  }

  // Clean up visuals for zombies that no longer exist
  for (const [entity, cz] of clientZombies) {
    if (!activeZombieEntities.has(entity)) {
      destroyZombieVisual(cz)
      clientZombies.delete(entity)
    }
  }
}

function createZombieVisual(serverEntity: Entity, pos: Vector3): ClientZombie {
  const modelEntity = engine.addEntity()
  Transform.create(modelEntity, {
    position: Vector3.create(pos.x, pos.y + 1.0, pos.z),
    scale: Vector3.create(1.2, 1.2, 1.2)
  })
  GltfContainer.create(modelEntity, { src: GHOST_MODEL_SRC })
  AudioSource.create(modelEntity, {
    audioClipUrl: 'assets/sounds/ghost.mp3',
    playing: true,
    loop: false,
    volume: 1.0
  })

  return {
    entity: serverEntity,
    modelEntity,
    time: Math.random() * 10,
    lastServerPos: Vector3.create(pos.x, pos.y, pos.z),
    renderPos: Vector3.create(pos.x, pos.y, pos.z),
    dead: false
  }
}

function removeZombieVisual(entity: Entity): void {
  const cz = clientZombies.get(entity)
  if (cz) {
    destroyZombieVisual(cz)
    clientZombies.delete(entity)
  }
}

function destroyZombieVisual(cz: ClientZombie): void {
  engine.removeEntity(cz.modelEntity)
  ghostSoundTimer = 0
}
