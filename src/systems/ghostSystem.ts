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
import { Ghost } from '../shared/components'
import { room } from '../shared/messages'
import { sendDeathPenalty, clearDeathPenalty } from './deathPenaltySystem'
import { exitSpectatorMode } from './spectatorSystem'
import { initPools as initCombatPools } from './combatSystem'
import { isCinematicActive } from '../gameState/cinematicState'
import { isNightTime } from '../shared/dayNight'

// ── Visual constants ──
const GHOST_MODEL_SRC = 'assets/models/ghost.glb'

// ── Client-side ghost tracking ──
const SPAWN_RISE_DURATION = 2.0  // seconds to rise from ground
const SPAWN_SINK_DURATION = 1.5  // seconds to sink into ground
const SPAWN_DEPTH = 3.0          // how far below ground to start/end

interface ClientGhost {
  entity: Entity
  modelEntity: Entity    // GLB model
  time: number           // accumulated time for bob/drift
  lastServerPos: Vector3 // last known server position
  prevServerPos: Vector3 // previous server position (for velocity estimation)
  velocity: Vector3      // estimated velocity for dead reckoning
  renderPos: Vector3     // interpolated render position
  dead: boolean
  spawnTimer: number     // counts up from 0 to SPAWN_RISE_DURATION
  sinkTimer: number      // counts up from 0 to SPAWN_SINK_DURATION (0 = not sinking)
  sinking: boolean       // true when death sink is active
  messageSunkAt: number  // Date.now() when a ghostKilled message set sinking (0 = not message-sunk)
}

const clientGhosts = new Map<Entity, ClientGhost>()
// Track entities killed via message — ignore even after visual cleanup until CRDT catches up
const killedGhostEntities = new Set<Entity>()

// ── Ghost sound replay timer ──
const GHOST_SOUND_INTERVAL = 5.0 // seconds between sound replays (clip length + gap)
let ghostSoundTimer = 0

// ── Scare meter ──
const SCARE_TIME = 3.0         // seconds of ghost contact before death
const SCARE_RECHARGE_TIME = 4.0 // seconds to fully recharge when not touched
const SCARE_RECHARGE_DELAY = 3.0 // seconds after last touch before recharge begins

let scareRemaining = 0
let scareBarVisible = false
let lastTouchedTimer = SCARE_RECHARGE_DELAY + 1 // time since last ghost touch (start high so no bar on load)
let ghostTouchingThisFrame = false

// ── Ghost death respawn ──
const GHOST_DEATH_EMOTE = 'urn:decentraland:matic:collections-v2:0x7bdc37ff3e8dca2d69f01a3dc34f3ad82e2e1870:0'
const GHOST_RESPAWN_DURATION = 5.0
const GHOST_FADE_IN = 1.5
const GHOST_FADE_OUT = 0.8
const GHOST_SPAWN_POSITION = Vector3.create(385, 96, 392)

let ghostDeathRespawnDelay = 0
let ghostDeathSoundEntity: Entity | null = null

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

/** Returns 0..1 fraction of scare filled (0 = safe, 1 = dead) */
export function getScareFraction(): number {
  return Math.max(0, Math.min(1, scareRemaining / SCARE_TIME))
}

/** Returns true if the scare meter should be displayed */
export function isScareBarVisible(): boolean {
  return scareBarVisible
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
  scareRemaining = 0
  scareBarVisible = false
  console.log('[Ghost] Death respawn cancelled')
}

room.onMessage('ghostTouching', (data) => {
  const me = getPlayerData()?.userId?.toLowerCase()
  if (me && data.victimId === me) {
    ghostTouchingThisFrame = true
  }
})

// ── Death VFX from server ──
const pendingDeathPositions: Vector3[] = []

// Max distance (squared) to associate a ghostKilled message with a live client ghost.
const GHOST_KILL_MATCH_DIST_SQ = 4.0 * 4.0
// Fallback match cap: CRDT positions lag on slow clients, but never map-widths. Beyond
// this the message can't plausibly refer to that ghost, so sink nothing and let the
// CRDT removal drive the sink when it lands.
const GHOST_KILL_FALLBACK_MAX_DIST_SQ = 12.0 * 12.0
// If a message-sunk ghost is still alive in the CRDT after this long, the message matched
// the wrong visual (or referred to one already gone) — resurrect it instead of leaving it
// frozen mid-air until it happens to die for real.
const GHOST_MESSAGE_SINK_GRACE_MS = 3000

room.onMessage('ghostKilled', (data) => {
  pendingDeathPositions.push(Vector3.create(data.x, data.y, data.z))

  // Sink ONLY the ghost that was actually killed. The server sends just the kill
  // position, so match it to the nearest live client ghost within a small
  // threshold and sink that one — all other ghosts keep updating normally.
  // (Sinking every ghost froze non-killed ones mid-air until the server despawned
  // them, since sink progress only advances once a ghost leaves the CRDT.)
  let nearest: Entity | null = null
  let nearestDistSq = GHOST_KILL_MATCH_DIST_SQ
  let nearestAny: Entity | null = null
  let nearestAnyDistSq = Infinity
  for (const [entity, cz] of clientGhosts) {
    if (cz.sinking) continue
    const dx = cz.lastServerPos.x - data.x
    const dy = cz.lastServerPos.y - data.y
    const dz = cz.lastServerPos.z - data.z
    const distSq = dx * dx + dy * dy + dz * dz
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq
      nearest = entity
    }
    if (distSq < nearestAnyDistSq) {
      nearestAnyDistSq = distSq
      nearestAny = entity
    }
  }
  // Fallback: if no ghost is within the strict threshold (CRDT positions can lag several
  // meters on slow clients — exactly where the lingering-ghost bug bites), sink the
  // nearest live ghost within a generous cap. A wrong pick isn't self-correcting — the
  // real removal sinks the REAL ghost's entity, not this one — so the cleanup loop's
  // GHOST_MESSAGE_SINK_GRACE_MS resurrect is what un-freezes a mis-picked ghost.
  if (nearest === null && nearestAnyDistSq <= GHOST_KILL_FALLBACK_MAX_DIST_SQ) nearest = nearestAny
  if (nearest !== null) {
    const cz = clientGhosts.get(nearest)!
    cz.sinking = true
    cz.sinkTimer = 0
    cz.messageSunkAt = Date.now()
    killedGhostEntities.add(nearest)
    console.log('[Ghost] Immediate sink triggered via ghostKilled message')
  }
})

// ── Detect boomerang hits on ghosts (client reports to server) ──
// We check distance from active projectiles to ghost positions each frame.
// Import projectile tracking if needed — for now we use a simpler approach:
// The server checks projectile-ghost collisions directly.

export function ghostClientSystem(dt: number): void {
  initCombatPools()
  ensureGhostDeathSound()


  // Ghost visibility is determined by the server — if the server sends active
  // Ghost entities via CRDT, we render them. No client-side night check needed.
  // This prevents desync where some players see ghosts and others don't.

  // ── Scare meter: drain while ghost is touching, recharge when safe ──
  if (ghostDeathRespawnDelay <= 0) {
    if (ghostTouchingThisFrame) {
      lastTouchedTimer = 0
      scareRemaining += dt
      if (scareRemaining > SCARE_TIME) scareRemaining = SCARE_TIME
      scareBarVisible = true

      // Death!
      if (scareRemaining >= SCARE_TIME) {
        exitSpectatorMode()
        room.send('requestDrop', { t: 0 })
        void triggerEmote({ predefinedEmote: GHOST_DEATH_EMOTE })
        InputModifier.createOrReplace(engine.PlayerEntity, {
          mode: InputModifier.Mode.Standard({ disableAll: true })
        })
        if (ghostDeathSoundEntity) {
          AudioSource.createOrReplace(ghostDeathSoundEntity, { audioClipUrl: 'assets/sounds/death.mp3', playing: true, loop: false, volume: 1, global: true })
        }
        ghostDeathRespawnDelay = GHOST_RESPAWN_DURATION
        scareRemaining = 0
        scareBarVisible = false
        lastTouchedTimer = SCARE_RECHARGE_DELAY + 1
        sendDeathPenalty('ghost')
        console.log('[Ghost] 👻 You were scared to death!')
      }
    } else {
      lastTouchedTimer += dt
      // Drain back down after delay
      if (scareRemaining > 0) {
        if (lastTouchedTimer >= SCARE_RECHARGE_DELAY) {
          scareRemaining -= (SCARE_TIME / SCARE_RECHARGE_TIME) * dt
          if (scareRemaining <= 0) {
            scareRemaining = 0
            scareBarVisible = false
          } else {
            scareBarVisible = true
          }
        } else {
          scareBarVisible = true // still show bar during delay
        }
      }
    }
  }
  ghostTouchingThisFrame = false

  // ── Ghost death: respawn countdown ──
  if (ghostDeathRespawnDelay > 0) {
    if (isCinematicActive()) {
      ghostDeathRespawnDelay = 0
      scareRemaining = 0
      scareBarVisible = false
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
      clearDeathPenalty()
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: false })
      })
    }
  }

  // Death positions are used for sink triggering only — hitVfx already handles the VFX
  pendingDeathPositions.length = 0

  // Track which ghost entities currently exist (server-synced via CRDT)
  const activeGhostEntities = new Set<Entity>()

  for (const [entity] of engine.getEntitiesWith(Ghost)) {
    activeGhostEntities.add(entity)
    const ghost = Ghost.get(entity)

    if (!ghost.active) {
      // Ghost deactivated — remove visual if exists
      removeGhostVisual(entity)
      killedGhostEntities.delete(entity)
      continue
    }

    // Skip entities we know are dead via message but CRDT hasn't removed yet
    if (killedGhostEntities.has(entity)) {
      continue
    }

    // Read position from Ghost component fields (throttled at 5Hz by server)
    // instead of Transform (which is no longer synced to avoid CRDT saturation)
    const serverPos = Vector3.create(ghost.targetX, ghost.targetY, ghost.targetZ)

    let cz = clientGhosts.get(entity)
    if (!cz) {
      // Create visual for new ghost
      cz = createGhostVisual(entity, serverPos)
      clientGhosts.set(entity, cz)
    } else if (cz.sinking) {
      // Ghost was marked for sinking — let the cleanup loop handle it
      continue
    }

    // Update time for animations
    cz.time += dt

    // Detect new server position and estimate velocity
    const dx2 = serverPos.x - cz.lastServerPos.x
    const dy2 = serverPos.y - cz.lastServerPos.y
    const dz2 = serverPos.z - cz.lastServerPos.z
    if (dx2 * dx2 + dy2 * dy2 + dz2 * dz2 > 0.0001) {
      // Server sent a new position — estimate velocity from delta
      // CRDT updates arrive ~5Hz (200ms), so divide by estimated interval
      const interval = 0.2
      cz.velocity = Vector3.create(dx2 / interval, dy2 / interval, dz2 / interval)
      cz.prevServerPos = Vector3.clone(cz.lastServerPos)
      cz.lastServerPos = serverPos
    }

    // Spawn rise animation
    if (cz.spawnTimer < SPAWN_RISE_DURATION) {
      cz.spawnTimer += dt
      if (cz.spawnTimer > SPAWN_RISE_DURATION) cz.spawnTimer = SPAWN_RISE_DURATION
    }
    const spawnProgress = Math.min(1, cz.spawnTimer / SPAWN_RISE_DURATION)
    // Ease-out curve for smooth rise
    const spawnEase = 1 - (1 - spawnProgress) * (1 - spawnProgress)
    const spawnYOffset = -SPAWN_DEPTH * (1 - spawnEase)



    // Dead reckoning: predict where the ghost should be, then lerp toward it
    // This smooths out the 5Hz server updates into fluid motion
    const predictedPos = Vector3.create(
      cz.lastServerPos.x + cz.velocity.x * 0.1,
      cz.lastServerPos.y + cz.velocity.y * 0.1,
      cz.lastServerPos.z + cz.velocity.z * 0.1
    )
    const lerpSpeed = 4.0
    cz.renderPos = Vector3.lerp(cz.renderPos, predictedPos, Math.min(1, lerpSpeed * dt))

    // Add floaty bob and lateral drift (only after spawn completes)
    const animBlend = spawnEase // 0 during rise, 1 when fully spawned
    const bobY = Math.sin(cz.time * 3.14) * 0.3 * animBlend
    const driftX = Math.sin(cz.time * 1.7) * 0.3 * animBlend
    const driftZ = Math.cos(cz.time * 1.3) * 0.3 * animBlend

    const finalPos = Vector3.create(
      cz.renderPos.x + driftX,
      cz.renderPos.y + bobY + 1.0 + spawnYOffset,
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

  // Clean up visuals for ghosts that no longer exist — start sinking
  for (const [entity, cz] of clientGhosts) {
    if (!activeGhostEntities.has(entity)) {
      if (!cz.sinking) {
        // Start sinking animation
        cz.sinking = true
        cz.sinkTimer = 0
      }
      cz.sinkTimer += dt
      const sinkProgress = Math.min(1, cz.sinkTimer / SPAWN_SINK_DURATION)
      // Ease-in curve for accelerating sink
      const sinkEase = sinkProgress * sinkProgress
      const sinkYOffset = -SPAWN_DEPTH * sinkEase

      // Update position (keep last known pos, just sink down)
      const modelT = Transform.getMutable(cz.modelEntity)
      modelT.position = Vector3.create(
        cz.renderPos.x,
        cz.renderPos.y + 1.0 + sinkYOffset,
        cz.renderPos.z
      )
      // Remove once fully sunk
      if (sinkProgress >= 1) {
        destroyGhostVisual(cz)
        clientGhosts.delete(entity)
        // Keep entity in killedGhostEntities until CRDT removes it —
        // prevents re-creating the visual from stale CRDT data
      }
    } else {
      // Entity still in CRDT — clear from killed set so it can be created fresh
      killedGhostEntities.delete(entity)
      // Resurrect a message-sunk ghost the CRDT still considers alive: the ghostKilled
      // fallback picked the wrong visual (or the message raced an already-processed
      // removal). Without this the ghost stays frozen mid-air until it dies for real —
      // sink progress only advances once the entity leaves the CRDT.
      if (cz.sinking && cz.messageSunkAt > 0 && Date.now() - cz.messageSunkAt > GHOST_MESSAGE_SINK_GRACE_MS) {
        cz.sinking = false
        cz.sinkTimer = 0
        cz.messageSunkAt = 0
        console.log('[Ghost] Resurrecting message-sunk ghost still alive in CRDT (wrong fallback pick)')
      }
    }
  }
}

function createGhostVisual(serverEntity: Entity, pos: Vector3): ClientGhost {
  const modelEntity = engine.addEntity()
  Transform.create(modelEntity, {
    position: Vector3.create(pos.x, pos.y + 1.0, pos.z),
    scale: Vector3.create(1.2, 1.2, 1.2)
  })
  GltfContainer.create(modelEntity, { src: GHOST_MODEL_SRC })
  AudioSource.create(modelEntity, {
    audioClipUrl: 'assets/sounds/ghost.mp3',
    playing: true,
    loop: true,
    volume: 0.3,
    global: false
  })

  return {
    entity: serverEntity,
    modelEntity,
    time: Math.random() * 10,
    lastServerPos: Vector3.create(pos.x, pos.y, pos.z),
    prevServerPos: Vector3.create(pos.x, pos.y, pos.z),
    velocity: Vector3.Zero(),
    renderPos: Vector3.create(pos.x, pos.y, pos.z),
    dead: false,
    spawnTimer: 0,
    sinkTimer: 0,
    sinking: false,
    messageSunkAt: 0
  }
}

function removeGhostVisual(entity: Entity): void {
  const cz = clientGhosts.get(entity)
  if (cz) {
    destroyGhostVisual(cz)
    clientGhosts.delete(entity)
  }
}

function destroyGhostVisual(cz: ClientGhost): void {
  engine.removeEntity(cz.modelEntity)
  ghostSoundTimer = 0
}
