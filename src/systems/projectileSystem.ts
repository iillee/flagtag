import {
  engine,
  Transform,
  AudioSource,
  GltfContainer,
  inputSystem,
  InputAction,
  PointerEventType,
  InputModifier,
  Raycast,
  RaycastResult,
  RaycastQueryType,
  AvatarEmoteCommand,
  type Entity,
  PlayerIdentityData,
  Material,
  MaterialTransparencyMode,
  MeshRenderer
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3, Color4 } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { Projectile, PROJECTILE_COOLDOWN_SEC, PROJECTILE_LIFETIME_SEC, PROJECTILE_SPEED, PROJECTILE_MAX_RANGE } from '../shared/components'

import { room } from '../shared/messages'
import { playErrorSound, isServerConnected } from './clientUtils'
import { triggerEmote } from '~system/RestrictedActions'
import { isSpectatorMode } from './spectatorSystem'
import { isCinematicActive } from '../cinematicState'
import { isDrownRespawning } from './waterSystem'
import { isMobile } from '@dcl/sdk/platform'
import { showHitEffect, showMissEffect, playHitSound, playMissSound } from './combatSystem'
import { getBoomerangModelSrc, getBoomerangColor, onBoomerangColorChange } from '../gameState/boomerangColor'

// ── Charge mechanic ──
const CHARGE_TIME_SEC = 1.5      // seconds to full charge = burnout
const CHARGE_MIN_SPEED = PROJECTILE_SPEED   // tap = 30 m/s
const CHARGE_MAX_SPEED = 60                  // full charge = 60 m/s
const CHARGE_MIN_RANGE = 20                  // tap = 20m
const RED_RANGE = 40                         // red boomerang fixed range
const CHARGE_MAX_RANGE = PROJECTILE_MAX_RANGE // full charge = 50m
let chargeStartMs: number = 0    // 0 = not charging
let isCharging = false
let lastChargeGroundY: number = 0 // track Y for airborne detection

/** Returns current charge fraction 0..1 (0 if not charging) */
export function getChargeFraction(): number {
  if (!isCharging || chargeStartMs === 0) return 0
  const elapsed = (Date.now() - chargeStartMs) / 1000
  return Math.min(1, elapsed / CHARGE_TIME_SEC)
}

/** Returns true if the player is currently charging a throw */
export function getIsCharging(): boolean { return isCharging }

// ── Burnout flash state ──
let burnoutFlashUntil: number = 0
const BURNOUT_FLASH_MS = 400
export function getBurnoutFlash(): boolean { return Date.now() < burnoutFlashUntil }

/** Returns charge phase: 'charging' | 'none' */
export function getChargePhase(): 'charging' | 'none' {
  if (!isCharging || chargeStartMs === 0) return 'none'
  return 'charging'
}

function applyChargeSlow(): void {
  // Disable jumping and sprinting while charging — player can still walk
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({
      disableRun: true,
      disableJump: true,
      disableGliding: true,
    })
  })
}

function removeChargeSlow(): void {
  if (InputModifier.has(engine.PlayerEntity)) {
    InputModifier.deleteFrom(engine.PlayerEntity)
  }
}

/** Compute speed from charge fraction */
function chargeToSpeed(fraction: number): number {
  return CHARGE_MIN_SPEED + fraction * (CHARGE_MAX_SPEED - CHARGE_MIN_SPEED)
}

/** Compute range from charge fraction */
function chargeToRange(fraction: number): number {
  return CHARGE_MIN_RANGE + fraction * (CHARGE_MAX_RANGE - CHARGE_MIN_RANGE)
}

// Hand boomerang visibility
let handBoomerangEntity: Entity | null = null
let handGlowEntity: Entity | null = null
let leftHandBoomerangEntity: Entity | null = null
const LEFT_HAND_SCALE = Vector3.create(1, 1.5, 1)

export function setLeftHandBoomerangEntity(e: Entity) {
  leftHandBoomerangEntity = e
}

// ── Charge orbit ring effect ──
const ORBIT_PARTICLE_COUNT = 6
const ORBIT_RADIUS = 0.5
let orbitParticles: Entity[] = []
let orbitAngle = 0 // current rotation angle in radians
let emoteActive = false
let lastPlayerPos: Vector3 | null = null
const EMOTE_MOVE_THRESHOLD = 0.1 // player must move this far to cancel emote hide

// Track when the local player has an active throw (hide hand boomerang)
let localThrowActive = false
let localThrowSawVisual = false // set true once msgProjectileVisuals was non-empty after throw
let localThrowStartMs = 0 // independent timestamp — never overwritten by cooldown logic
const LOCAL_THROW_SAFETY_MS = 4000 // force-clear localThrowActive after 4s with no visual

export function setHandBoomerangEntity(e: Entity) {
  handBoomerangEntity = e

  // Create glow child entity
  handGlowEntity = engine.addEntity()
  Transform.create(handGlowEntity, {
    position: Vector3.create(0, 0, 0),
    scale: Vector3.Zero(), // hidden by default
    parent: e
  })
  MeshRenderer.setSphere(handGlowEntity)
  Material.setPbrMaterial(handGlowEntity, {
    albedoColor: Color4.create(1, 1, 1, 0),
    emissiveColor: Color3.create(0.3, 0.6, 1),
    emissiveIntensity: 0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
  })
  // Create orbiting charge particles
  orbitParticles = []
  for (let i = 0; i < ORBIT_PARTICLE_COUNT; i++) {
    const p = engine.addEntity()
    Transform.create(p, {
      position: Vector3.Zero(),
      scale: Vector3.Zero(), // hidden by default
      parent: e
    })
    MeshRenderer.setSphere(p)
    Material.setPbrMaterial(p, {
      albedoColor: Color4.create(1, 1, 1, 0),
      emissiveColor: Color3.create(0.3, 0.6, 1),
      emissiveIntensity: 5,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    orbitParticles.push(p)
  }

  // Listen for emotes on the local player
  AvatarEmoteCommand.onChange(engine.PlayerEntity, (cmd) => {
    if (cmd && !cmd.emoteUrn?.includes('getHit')) {
      emoteActive = true
      // Snapshot position so we detect when player moves to cancel
      if (Transform.has(engine.PlayerEntity)) {
        const p = Transform.get(engine.PlayerEntity).position
        lastPlayerPos = Vector3.create(p.x, p.y, p.z)
      }
      updateHandBoomerangVisibility()
    }
  })
}

const HAND_BOOMERANG_SCALE = Vector3.create(1, 1.5, 1)

function updateHandBoomerangVisibility(): void {
  if (handBoomerangEntity === null) return
  // Cancel emote hide once player moves
  if (emoteActive && Transform.has(engine.PlayerEntity) && lastPlayerPos) {
    const p = Transform.get(engine.PlayerEntity).position
    if (Vector3.distance(p, lastPlayerPos) > EMOTE_MOVE_THRESHOLD) {
      emoteActive = false
    }
  }
  const shouldShow = localProjectiles.length === 0 && !localThrowActive && !emoteActive && !isCinematicActive()
  // Use scale to hide/show — VisibilityComponent doesn't reliably work on AvatarAttach children
  if (Transform.has(handBoomerangEntity)) {
    const t = Transform.getMutable(handBoomerangEntity)
    const currentlyVisible = t.scale.x > 0
    if (currentlyVisible !== shouldShow) {
      console.log(`[HandBoomerang] ${shouldShow ? 'SHOW' : 'HIDE'} | localThrowActive=${localThrowActive} localProj=${localProjectiles.length} msgVis=${msgProjectileVisuals.length} emote=${emoteActive} cinematic=${isCinematicActive()}`)
    }
    const isGreen = getBoomerangColor() === 'g'
    const mobile = isMobile()
    if (shouldShow) {
      t.scale = HAND_BOOMERANG_SCALE
      t.position = mobile ? Vector3.create(-0.02, 0.13, -0.13) : Vector3.create(0.04, 0.15, 0.1)
      t.rotation = Quaternion.fromEulerDegrees(mobile ? 15 : 0, mobile ? 180 : 0, 90)
    } else {
      t.scale = Vector3.Zero()
    }

    // Update glow during charge (blue only)
    if (handGlowEntity && Transform.has(handGlowEntity)) {
      if (shouldShow && isCharging && !isGreen) {  // green has orbit, not charge
        const cf = getChargeFraction()
        // Glow sphere grows and brightens with charge
        const glowSize = 0.3 + cf * 0.7
        Transform.getMutable(handGlowEntity).scale = Vector3.create(glowSize, glowSize, glowSize)
        // Shift color from blue to red near burnout
        const r = cf > 0.75 ? 1.0 : 0.3
        const g = cf > 0.75 ? 0.84 : 0.6
        const b = cf > 0.75 ? 0.0 : 1.0
        Material.setPbrMaterial(handGlowEntity, {
          albedoColor: Color4.create(1, 1, 1, 0),
          emissiveColor: Color3.create(r, g, b),
          emissiveIntensity: 2 + cf * 8,
          transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
        })
      } else {
        Transform.getMutable(handGlowEntity).scale = Vector3.Zero()
      }
    }

    // Update orbit particles (blue only)
    if (shouldShow && isCharging && !isGreen) {
      const cf = getChargeFraction()
      // Advance angle once (not per-particle), use real time
      const speed = 2 * Math.PI * (1 + cf * 5)
      orbitAngle = ((Date.now() - chargeStartMs) / 1000) * speed
      const radius = ORBIT_RADIUS * (0.5 + cf * 0.5)
      const particleSize = 0.1 + cf * 0.15
      const pr = cf > 0.75 ? 1.0 : 0.3
      const pg = cf > 0.75 ? 0.84 : 0.6
      const pb = cf > 0.75 ? 0.0 : 1.0
      for (let i = 0; i < orbitParticles.length; i++) {
        const op = orbitParticles[i]
        if (!Transform.has(op)) continue
        const angle = orbitAngle + (i * 2 * Math.PI) / ORBIT_PARTICLE_COUNT
        Transform.getMutable(op).position = Vector3.create(
          0,
          Math.sin(angle) * radius,
          Math.cos(angle) * radius
        )
        Transform.getMutable(op).scale = Vector3.create(particleSize, particleSize, particleSize)
        Material.setPbrMaterial(op, {
          albedoColor: Color4.create(1, 1, 1, 0),
          emissiveColor: Color3.create(pr, pg, pb),
          emissiveIntensity: 3 + cf * 7,
          transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
        })
      }
    } else {
      for (let i = 0; i < orbitParticles.length; i++) {
        const op = orbitParticles[i]
        if (Transform.has(op)) Transform.getMutable(op).scale = Vector3.Zero()
      }
    }

    // Left-hand boomerang: show when yellow, ready, and no pending 2nd throw
    if (leftHandBoomerangEntity && Transform.has(leftHandBoomerangEntity)) {
      const showLeft = shouldShow && getBoomerangColor() === 'y' && yellowSecondThrowAt === 0
      const leftVisible = Transform.get(leftHandBoomerangEntity).scale.x > 0
      if (showLeft !== leftVisible) {
        Transform.getMutable(leftHandBoomerangEntity).scale = showLeft ? LEFT_HAND_SCALE : Vector3.Zero()
      }
    }
  }
}

// ── Green orbit visual ──
const ORBIT_VISUAL_RADIUS = 3.0
const ORBIT_FULL_ROTATIONS = 3   // exact number of full loops
const ORBIT_DURATION_MS = 3500
const ORBIT_VISUAL_SPEED = (ORBIT_FULL_ROTATIONS * 360) / (ORBIT_DURATION_MS / 1000)  // ~308°/s
let orbitEntity: Entity | null = null
let orbitActive = false
let orbitStartMs = 0
let orbitStartAngle = 0  // player's forward angle when orbit begins
let orbitEndMs = 0        // when the orbit should finish (can be shortened on hit)
let orbitWallRayEntity: Entity | null = null  // persistent ray entity for wall checks

/** Returns true if the local player's green orbit is currently active. */
export function isOrbitActive(): boolean { return orbitActive }

function startOrbitVisual(): void {
  if (orbitEntity === null) {
    orbitEntity = engine.addEntity()
    Transform.create(orbitEntity, { position: Vector3.Zero(), scale: Vector3.Zero() })
    GltfContainer.create(orbitEntity, {
      src: getBoomerangModelSrc(),
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    attachProjectileSound(orbitEntity)
  } else {
    // Update model in case color changed
    if (GltfContainer.has(orbitEntity)) {
      GltfContainer.getMutable(orbitEntity).src = getBoomerangModelSrc()
    }
    attachProjectileSound(orbitEntity)
  }
  orbitActive = true
  orbitStartMs = Date.now()
  orbitEndMs = orbitStartMs + ORBIT_DURATION_MS
  // Start from player's forward direction
  const { dirX, dirZ } = getPlayerForward()
  orbitStartAngle = Math.atan2(dirX, dirZ) * (180 / Math.PI)
  // Hide hand boomerang during orbit
  localThrowActive = true
  localThrowSawVisual = true
  updateHandBoomerangVisibility()
}

/** Trigger early ramp-down — boomerang returns to player over ORBIT_RAMP_MS */
function endOrbitEarly(): void {
  if (!orbitActive) return
  const now = Date.now()
  const remaining = orbitEndMs - now
  // If we're already in ramp-down or nearly done, let it finish naturally
  if (remaining <= ORBIT_RAMP_MS) return
  // Set end time so ramp-down starts now
  orbitEndMs = now + ORBIT_RAMP_MS
}

function stopOrbitVisual(): void {
  orbitActive = false
  if (orbitEntity !== null && Transform.has(orbitEntity)) {
    Transform.getMutable(orbitEntity).scale = Vector3.Zero()
    stopProjectileSound(orbitEntity)
  }
  if (orbitWallRayEntity !== null) {
    engine.removeEntity(orbitWallRayEntity)
    orbitWallRayEntity = null
  }
  localThrowActive = false
  localThrowSawVisual = false
  localThrowStartMs = 0
  // Start cooldown NOW (after orbit ends), not when it was thrown
  lastLocalProjectileFireTime = Date.now()
  lastThrowExtraCooldown = 3 // 1s base + 3s extra = 4s total post-catch cooldown
  updateHandBoomerangVisibility()
}

const ORBIT_RAMP_MS = 400  // ramp up/down duration to match remote visual

function updateOrbitVisual(_dt: number): void {
  if (!orbitActive || orbitEntity === null) return

  const now = Date.now()
  const elapsed = now - orbitStartMs
  const totalDuration = orbitEndMs - orbitStartMs
  if (now > orbitEndMs) {
    stopOrbitVisual()
    return
  }

  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position

  // Radius ramps up at start and back down at end (matches remote visual)
  const timeUntilEnd = orbitEndMs - now
  let radiusFrac = 1.0
  if (elapsed < ORBIT_RAMP_MS) {
    radiusFrac = elapsed / ORBIT_RAMP_MS
  } else if (timeUntilEnd < ORBIT_RAMP_MS) {
    radiusFrac = timeUntilEnd / ORBIT_RAMP_MS
  }
  radiusFrac = radiusFrac * radiusFrac * (3 - 2 * radiusFrac) // smoothstep
  const radius = ORBIT_VISUAL_RADIUS * radiusFrac

  // Time-based angle ensures exact full rotations
  const currentAngle = orbitStartAngle + ORBIT_VISUAL_SPEED * (elapsed / 1000)
  const radians = currentAngle * (Math.PI / 180)

  const orbitX = playerPos.x + Math.sin(radians) * radius
  const orbitZ = playerPos.z + Math.cos(radians) * radius
  const orbitY = playerPos.y + 1.0

  // Fast axial spin (like a real boomerang spinning on its own axis)
  const axialSpin = (elapsed / 1000) * 1080  // 3 full spins per second

  const t = Transform.getMutable(orbitEntity)
  t.position = Vector3.create(orbitX, orbitY, orbitZ)
  t.scale = PROJECTILE_SCALE
  t.rotation = Quaternion.fromEulerDegrees(0, currentAngle + 90 + axialSpin, 0)

  // Wall collision removed — orbit is a close-range ability, no need to check walls
}

function getProjectileModelSrc(): string {
  return getBoomerangModelSrc()
}
const PROJECTILE_SCALE = Vector3.create(2.5, 4.5, 2.5)
const PROJECTILE_STAGGER_MS = 800
const PROJECTILE_SPIN_SPEED = 720 // degrees per second
const PROJECTILE_CHEST_OFFSET = 0.8 // Y offset from player position to chest height


// Stagger state for projectile hits
let projectileStaggerUntil = 0

// ── Sound ──
const CHARGE_SOUND_SRC = 'assets/sounds/charge.mp3'
let chargeSoundEntity: Entity | null = null

function playChargeSound(): void {
  if (!chargeSoundEntity) {
    chargeSoundEntity = engine.addEntity()
    Transform.create(chargeSoundEntity, {})
  }
  AudioSource.createOrReplace(chargeSoundEntity, {
    audioClipUrl: CHARGE_SOUND_SRC,
    playing: true,
    loop: false,
    volume: 0.25,
    global: true,
    pitch: 0.6
  })
}

function stopChargeSound(): void {
  if (chargeSoundEntity && AudioSource.has(chargeSoundEntity)) {
    AudioSource.createOrReplace(chargeSoundEntity, { audioClipUrl: CHARGE_SOUND_SRC, playing: false, loop: false, volume: 0, global: true, pitch: 0.6 })
  }
}

const RELEASE_SOUND_SRC = 'assets/sounds/release.mp3'
let releaseSoundEntity: Entity | null = null

function playReleaseSound(): void {
  if (!releaseSoundEntity) {
    releaseSoundEntity = engine.addEntity()
    Transform.create(releaseSoundEntity, {})
  }
  AudioSource.createOrReplace(releaseSoundEntity, {
    audioClipUrl: RELEASE_SOUND_SRC,
    playing: true,
    loop: false,
    volume: 0.175,
    global: true,
    pitch: 1.0
  })
}

/** Play the release sound spatially at a world position (for remote players' charged throws). */
function playReleaseSoundAt(pos: Vector3): void {
  const e = engine.addEntity()
  Transform.create(e, { position: pos })
  AudioSource.create(e, {
    audioClipUrl: RELEASE_SOUND_SRC,
    playing: true,
    loop: false,
    volume: 0.35,
    global: false,
    pitch: 1.0
  })
  // Clean up after sound finishes (~2s)
  const createdAt = Date.now()
  const cleanup = () => {
    if (Date.now() - createdAt > 2000) {
      engine.removeEntity(e)
      engine.removeSystem(cleanup)
    }
  }
  engine.addSystem(cleanup)
}

const PROJECTILE_SOUND_SRC = 'assets/sounds/boomerang2.mp3'

/** Attach a looping spatial projectile sound directly to a projectile entity. */
function attachProjectileSound(entity: Entity): void {
  AudioSource.createOrReplace(entity, {
    audioClipUrl: PROJECTILE_SOUND_SRC,
    playing: true,
    loop: true,
    volume: 1.0,
    global: false,
    pitch: 1.3
  })
}

/** Stop the projectile sound on an entity (before removal). */
function stopProjectileSound(entity: Entity): void {
  if (AudioSource.has(entity)) {
    const a = AudioSource.getMutable(entity)
    a.playing = false
    a.volume = 0
    a.loop = false
  }
}

// playErrorSound imported from clientUtils

// ── Client cooldown tracking ──
let lastLocalProjectileFireTime = 0
let lastThrowExtraCooldown = 0 // extra seconds added for charged throws

// ── Yellow double-throw ──
const YELLOW_SECOND_THROW_DELAY_MS = 250 // ms between 1st and 2nd throw
let yellowSecondThrowAt = 0 // timestamp when 2nd throw should fire (0 = none pending)
let yellowSecondThrowDir = { dirX: 0, dirZ: 0 }

/** Returns true if a boomerang is currently in flight (local or server-driven). */
export function isProjectileInFlight(): boolean {
  return localProjectiles.length > 0 || localThrowActive
}

/** Returns true if projectile is unavailable — either on cooldown or in flight (for UI). */
export function isProjectileOnCooldown(): boolean {
  // Orbit active = unavailable
  if (orbitActive) return true
  // In flight = unavailable
  if (isProjectileInFlight()) return true
  // Time-based cooldown (if any)
  if (lastLocalProjectileFireTime === 0) return false
  const cooldown = PROJECTILE_COOLDOWN_SEC + lastThrowExtraCooldown
  return (Date.now() - lastLocalProjectileFireTime) < cooldown * 1000
}

/** Returns cooldown remaining in seconds (0 if ready). -1 if boomerang is in flight. */
export function getProjectileCooldownRemaining(): number {
  if (orbitActive) return -1
  if (isProjectileInFlight()) return -1
  if (lastLocalProjectileFireTime === 0) return 0
  const cooldown = PROJECTILE_COOLDOWN_SEC + lastThrowExtraCooldown
  const elapsed = Date.now() - lastLocalProjectileFireTime
  const remaining = cooldown * 1000 - elapsed
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

// ── Wall distance raycast ──
interface PendingWallRay {
  entity: Entity
}
const pendingWallRays: PendingWallRay[] = []

function fireWallRaycast(pos: Vector3, dirX: number, dirZ: number): void {
  const rayEntity = engine.addEntity()
  Transform.create(rayEntity, { position: pos })
  Raycast.create(rayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(dirX, 0, dirZ) },
    maxDistance: PROJECTILE_MAX_RANGE,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })
  pendingWallRays.push({ entity: rayEntity })
}

function processWallRaycasts(): void {
  for (let i = pendingWallRays.length - 1; i >= 0; i--) {
    const ray = pendingWallRays[i]
    const result = RaycastResult.getOrNull(ray.entity)
    if (result) {
      if (result.hits.length > 0) {
        const hitDist = result.hits[0].length
        room.send('reportShellWallDist', { shellId: 0, maxDist: hitDist })
      }
      engine.removeEntity(ray.entity)
      pendingWallRays.splice(i, 1)
    }
  }
}

// ── Ground raycasts for server-mode projectiles REMOVED ──
// Projectile visuals are entirely message-driven (shellDropped/shellTriggered/shellReturned).
// The CRDT-synced Projectile component is no longer used for client rendering.
// Ground raycasts were a vestige of the old shell-with-gravity mechanic.

// ── Message listeners (registered at module scope for reliable delivery) ──
room.onMessage('shellDropped', (data) => {
  // Create visual from message bus (instant, no CRDT dependency).
  // This fires for ALL players including local — the server echo is the source of truth.
  createMsgProjectileVisual(data.x, data.y, data.z, data.dirX, data.dirZ, data.color, data.firedBy, data.chargeSpeed, data.chargeRange, data.chargeScale)

  // Play release sound for remote blue charged throws so everyone hears it
  // Local player already plays it in the E-key-up handler — skip for self
  const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
  const throwerId = (data.firedBy || '').toLowerCase()
  if (throwerId && throwerId !== localUserId && data.color === 'b' && data.chargeSpeed >= 55) {
    playReleaseSoundAt(Vector3.create(data.x, data.y, data.z))
  }
})

/** Look up a remote player's position by wallet address (case-insensitive). */
function getRemotePlayerPosition(userId: string): Vector3 | null {
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address.toLowerCase() === userId) {
      return Transform.get(entity).position
    }
  }
  return null
}

room.onMessage('shellTriggered', (data) => {
  const pos = Vector3.create(data.x, data.y, data.z)
  // Remove the projectile visual matching the thrower
  removeMsgProjectileVisualByThrower(data.firedBy || '', data.x, data.y, data.z, !!data.peak)

  // Hit a player: particles + hit sound + stagger. Hit a wall: miss sound.
  if (data.victimId && data.victimId !== '') {
    showHitEffect(pos)
    playHitSound(pos)

    // Stagger the victim if it's the local player
    const me = getPlayerData()?.userId?.toLowerCase()
    if (me && data.victimId === me && !isCinematicActive()) {
      triggerEmote({ predefinedEmote: 'getHit' })
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: true, disableGliding: true, disableDoubleJump: true })
      })
      projectileStaggerUntil = Date.now() + PROJECTILE_STAGGER_MS
    }
  } else if (!data.peak) {
    // Projectile hit banana, wall, or shield — show miss cloud + sound
    // Skip if peak=true (boomerang just reached max range and is returning)
    showMissEffect(pos)
    const playerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : pos
    playMissSound(playerPos)
  }
})

// ── Orbit message listeners ──
room.onMessage('shellReturned', (data) => {
  const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
  const playerId = (data.firedBy || '').toLowerCase()
  if (!playerId) return
  // Clean up ALL visuals for this thrower (local or remote) — prevents pool leaks
  for (let i = msgProjectileVisuals.length - 1; i >= 0; i--) {
    if (msgProjectileVisuals[i].firedBy === playerId) {
      if (msgProjectileVisuals[i].groundRayEntity !== null) engine.removeEntity(msgProjectileVisuals[i].groundRayEntity!)
      releaseProjectileToPool(msgProjectileVisuals[i].entity)
      msgProjectileVisuals.splice(i, 1)
    }
  }
  // Clear local throw state if this was our boomerang
  if (playerId === localUserId && localThrowActive && !orbitActive) {
    console.log('[Projectile] ✅ shellReturned for local player — clearing localThrowActive')
    localThrowActive = false
    localThrowSawVisual = false
    localThrowStartMs = 0
    lastLocalProjectileFireTime = Date.now()
    updateHandBoomerangVisibility()
  }
})

room.onMessage('orbitStarted', (data) => {
  const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
  const playerId = data.playerId?.toLowerCase() || ''
  if (playerId === localUserId) {
    // Local player's orbit confirmed by server — start visual
    startOrbitVisual()
  }
  // Remote orbit visuals are handled by remoteBoomerangSystem
})

room.onMessage('orbitHit', (data) => {
  const pos = Vector3.create(data.x, data.y, data.z)
  showHitEffect(pos)
  playHitSound(pos)

  // Stagger the victim if it's the local player
  const me = getPlayerData()?.userId?.toLowerCase()
  if (me && data.victimId === me && !isCinematicActive()) {
    triggerEmote({ predefinedEmote: 'getHit' })
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({ disableAll: true, disableGliding: true, disableDoubleJump: true })
    })
    projectileStaggerUntil = Date.now() + PROJECTILE_STAGGER_MS
  }
})

room.onMessage('orbitEnded', (data) => {
  const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
  const playerId = data.playerId?.toLowerCase() || ''
  if (playerId === localUserId) {
    endOrbitEarly()
  }
})

// isServerConnected imported from clientUtils

function getPlayerForward(): { dirX: number; dirZ: number } {
  if (!Transform.has(engine.PlayerEntity)) return { dirX: 0, dirZ: 1 }
  const rot = Transform.get(engine.PlayerEntity).rotation
  const forward = Vector3.rotate(Vector3.Forward(), rot)
  const len = Math.sqrt(forward.x * forward.x + forward.z * forward.z)
  if (len < 0.01) return { dirX: 0, dirZ: 1 }
  return { dirX: forward.x / len, dirZ: forward.z / len }
}

interface LocalProjectile {
  entity: Entity
  firedAtMs: number
  startX: number
  startY: number
  startZ: number
  dirX: number
  dirZ: number
  distanceTraveled: number
  maxDistance: number
  speed: number
  // Wall raycast
  wallRayEntity: Entity | null
  // Gravity + ground tracking
  currentY: number
  fallVelocity: number
  groundY: number
  onGround: boolean
  groundRayEntity: Entity | null
  lastGroundRayTime: number
  spinAngle: number
  returning: boolean
  returnDistance: number
}
const localProjectiles: LocalProjectile[] = []

function fireProjectileLocally(speed: number = CHARGE_MIN_SPEED, maxDist: number = CHARGE_MIN_RANGE): void {
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position
  const { dirX, dirZ } = getPlayerForward()

  const spawnPos = Vector3.create(
    playerPos.x + dirX * 1.0,
    playerPos.y + 0.8,
    playerPos.z + dirZ * 1.0
  )

  const shellEntity = engine.addEntity()
  Transform.create(shellEntity, {
    position: spawnPos,
    scale: PROJECTILE_SCALE,
    rotation: Quaternion.fromEulerDegrees(0, Math.atan2(dirX, dirZ) * (180 / Math.PI), 0)
  })
  GltfContainer.create(shellEntity, {
    src: getProjectileModelSrc(),
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  // Fire wall raycast (forward)
  const wallRayEntity = engine.addEntity()
  Transform.create(wallRayEntity, { position: spawnPos })
  Raycast.create(wallRayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(dirX, 0, dirZ) },
    maxDistance: maxDist,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })

  // Attach looping spatial sound to the projectile entity
  attachProjectileSound(shellEntity)

  localProjectiles.push({
    entity: shellEntity,
    firedAtMs: Date.now(),
    startX: spawnPos.x,
    startY: spawnPos.y,
    startZ: spawnPos.z,
    dirX,
    dirZ,
    distanceTraveled: 0,
    maxDistance: maxDist,
    speed,
    wallRayEntity,
    currentY: spawnPos.y,
    fallVelocity: 0,
    groundY: 0,
    onGround: false,
    groundRayEntity: null,
    lastGroundRayTime: 0,
    spinAngle: 0,
    returning: false,
    returnDistance: 0,
  })
  console.log('[Projectile] 🎯 LOCAL projectile fired dir:', dirX.toFixed(2), dirZ.toFixed(2), 'speed:', speed, 'range:', maxDist)
  updateHandBoomerangVisibility()
}

function removeLocalProjectile(index: number): void {
  const projectile = localProjectiles[index]
  stopProjectileSound(projectile.entity)
  if (projectile.wallRayEntity !== null) engine.removeEntity(projectile.wallRayEntity)
  if (projectile.groundRayEntity !== null) engine.removeEntity(projectile.groundRayEntity)
  engine.removeEntity(projectile.entity)
  localProjectiles.splice(index, 1)
  if (localProjectiles.length === 0) localThrowActive = false
  updateHandBoomerangVisibility()
}

function updateLocalProjectiles(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = localProjectiles.length - 1; i >= 0; i--) {
    const projectile = localProjectiles[i]

    // Check wall raycast result
    if (projectile.wallRayEntity !== null) {
      const result = RaycastResult.getOrNull(projectile.wallRayEntity)
      if (result) {
        if (result.hits.length > 0) {
          projectile.maxDistance = Math.min(projectile.maxDistance, result.hits[0].length)
        }
        engine.removeEntity(projectile.wallRayEntity)
        projectile.wallRayEntity = null
      }
    }

    // Safety expiry
    if (now - projectile.firedAtMs > PROJECTILE_LIFETIME_SEC * 1000) {
      console.log('[Projectile] 🎯 LOCAL projectile expired')
      removeLocalProjectile(i)
      continue
    }

    // Move forward or return to player's current position
    const moveDistance = projectile.speed * clampedDt
    if (!projectile.returning) {
      projectile.distanceTraveled += moveDistance
      if (projectile.distanceTraveled >= projectile.maxDistance) {
        projectile.returning = true
        projectile.returnDistance = 0
        console.log('[Projectile] 🎯 LOCAL projectile reached max range, returning')
      }
    }

    // Spin the boomerang
    projectile.spinAngle += PROJECTILE_SPIN_SPEED * clampedDt

    if (!projectile.returning) {
      // Outbound — straight line from start
      const headingDeg = Math.atan2(projectile.dirX, projectile.dirZ) * (180 / Math.PI)
      const newX = projectile.startX + projectile.dirX * projectile.distanceTraveled
      const newZ = projectile.startZ + projectile.dirZ * projectile.distanceTraveled
      const t = Transform.getMutable(projectile.entity)
      t.position = Vector3.create(newX, projectile.startY, newZ)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + projectile.spinAngle, 0)
    } else {
      // Returning — home in on player's chest height
      const shellPos = Transform.get(projectile.entity).position
      const rawPlayerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : Vector3.create(projectile.startX, projectile.startY, projectile.startZ)
      const playerPos = Vector3.create(rawPlayerPos.x, rawPlayerPos.y + PROJECTILE_CHEST_OFFSET, rawPlayerPos.z)
      const dx = playerPos.x - shellPos.x
      const dy = playerPos.y - shellPos.y
      const dz = playerPos.z - shellPos.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (dist < 2.0) {
        console.log('[Projectile] 🎯 LOCAL projectile returned to player')
        removeLocalProjectile(i)
        continue
      }

      const nx = dx / dist, ny = dy / dist, nz = dz / dist
      const headingDeg = Math.atan2(nx, nz) * (180 / Math.PI)
      const t = Transform.getMutable(projectile.entity)
      t.position = Vector3.create(shellPos.x + nx * moveDistance, shellPos.y + ny * moveDistance, shellPos.z + nz * moveDistance)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + projectile.spinAngle, 0)
    }
  }
}

// ── Projectile visual entity pool (per-color) ──
// Pre-create a fixed pool of entities per boomerang color, each with its own
// GltfContainer already loaded. This avoids swapping .glb src on reuse, which
// triggers a Decentraland engine bug where rapid GltfContainer model swaps
// cause models to stop rendering after repeated use.
const POOL_SIZE_PER_COLOR = 10
const BOOMERANG_COLORS = ['r', 'y', 'b', 'g'] as const
const projectilePoolByColor: Map<string, Entity[]> = new Map()
let projectilePoolReady = false
const PROJECTILE_HIDDEN_POS = Vector3.create(0, -200, 0)

export function initProjectilePool(): void {
  if (projectilePoolReady) return
  projectilePoolReady = true
  let totalCreated = 0
  for (const color of BOOMERANG_COLORS) {
    const pool: Entity[] = []
    for (let i = 0; i < POOL_SIZE_PER_COLOR; i++) {
      const e = engine.addEntity()
      Transform.create(e, { position: PROJECTILE_HIDDEN_POS, scale: Vector3.Zero() })
      GltfContainer.create(e, {
        src: `assets/models/boomerang.${color}.glb`,
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })
      pool.push(e)
      totalCreated++
    }
    projectilePoolByColor.set(color, pool)
  }
  console.log('[Projectile] 🎯 Pre-created', totalCreated, 'projectile visuals (', POOL_SIZE_PER_COLOR, 'per color)')
}

// Update hand boomerang when color changes (pool no longer needs updating)
onBoomerangColorChange((color) => {
  const newSrc = getProjectileModelSrc()
  // Update hand boomerang
  if (handBoomerangEntity !== null && GltfContainer.has(handBoomerangEntity)) {
    const gltf = GltfContainer.getMutable(handBoomerangEntity)
    gltf.src = newSrc
  }
  console.log('[Projectile] Updated hand model to', newSrc)
})

function acquireProjectileFromPool(color: string): Entity | null {
  initProjectilePool()
  const validColor = BOOMERANG_COLORS.includes(color as any) ? color : 'r'
  const pool = projectilePoolByColor.get(validColor)
  if (!pool) return null
  for (const e of pool) {
    const t = Transform.get(e)
    if (t.position.y < -100) return e
  }
  console.error('[Projectile] 🎯 Pool exhausted for color', validColor, '! All', POOL_SIZE_PER_COLOR, 'in use.')
  return null
}

function releaseProjectileToPool(entity: Entity): void {
  stopProjectileSound(entity)
  const t = Transform.getMutable(entity)
  t.position = PROJECTILE_HIDDEN_POS
  t.scale = Vector3.Zero()
}

// ── Message-driven visual entities for projectiles ──
// Visuals are created from the 'shellDropped' message (WebSocket, instant) rather than
// from CRDT-synced Projectile entities. Mobile live CRDT sync is unreliable — projectiles expire
// before entities arrive. The message bus delivers position + direction instantly.
// 'shellTriggered' message or time-based safety expiry removes the visual.
interface MsgProjectileVisual {
  entity: Entity
  firedBy: string  // userId of the thrower
  startX: number
  startY: number
  startZ: number
  dirX: number
  dirZ: number
  createdAtMs: number
  distanceTraveled: number
  maxDistance: number
  speed: number
  currentY: number
  fallVelocity: number
  groundY: number
  onGround: boolean
  groundRayEntity: Entity | null
  lastGroundRayTime: number
  spinAngle: number
  returning: boolean
  returnDistance: number
}
const msgProjectileVisuals: MsgProjectileVisual[] = []

function createMsgProjectileVisual(x: number, y: number, z: number, dirX: number, dirZ: number, color?: string, firedBy?: string, chargeSpeed?: number, chargeRange?: number, chargeScale?: number): void {
  const validColors = ['r', 'y', 'b', 'g']
  const c = (color && validColors.includes(color)) ? color : 'r'
  const localEntity = acquireProjectileFromPool(c)
  if (!localEntity) return

  const scaleMult = (chargeScale && chargeScale > 0) ? chargeScale : 1
  const t = Transform.getMutable(localEntity)
  t.position = Vector3.create(x, y, z)
  t.scale = Vector3.create(PROJECTILE_SCALE.x * scaleMult, PROJECTILE_SCALE.y * scaleMult, PROJECTILE_SCALE.z * scaleMult)
  t.rotation = Quaternion.fromEulerDegrees(0, Math.atan2(dirX, dirZ) * (180 / Math.PI), 0)

  // No GltfContainer swap needed — pool entity already has the correct color model

  attachProjectileSound(localEntity)

  msgProjectileVisuals.push({
    entity: localEntity,
    firedBy: firedBy?.toLowerCase() || '',
    startX: x, startY: y, startZ: z,
    dirX, dirZ,
    createdAtMs: Date.now(),
    distanceTraveled: 0,
    maxDistance: (chargeRange && chargeRange > 0) ? chargeRange : PROJECTILE_MAX_RANGE,
    speed: (chargeSpeed && chargeSpeed > 0) ? chargeSpeed : PROJECTILE_SPEED,
    currentY: y,
    fallVelocity: 0,
    groundY: 0,
    onGround: false,
    groundRayEntity: null,
    lastGroundRayTime: 0,
    spinAngle: 0,
    returning: false,
    returnDistance: 0,
  })
  console.log('[Projectile] 🎯 Created message-driven projectile visual at:', x.toFixed(1), y.toFixed(1), z.toFixed(1), 'speed:', ((chargeSpeed && chargeSpeed > 0) ? chargeSpeed : PROJECTILE_SPEED))
}

function removeMsgProjectileVisualByThrower(firedBy: string, x: number, y: number, z: number, isPeak: boolean = false): void {
  // Match by thrower ID to avoid cross-player mismatches.
  // If multiple visuals exist for the same thrower (e.g. yellow double-throw),
  // pick the closest one among that thrower's visuals.
  const throwerId = (firedBy || '').toLowerCase()
  let closestIdx = -1
  let closestDist = Infinity
  for (let i = 0; i < msgProjectileVisuals.length; i++) {
    const vis = msgProjectileVisuals[i]
    if (throwerId && vis.firedBy !== throwerId) continue
    const pos = Transform.get(vis.entity).position
    const dx = pos.x - x, dy = pos.y - y, dz = pos.z - z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dist < closestDist) { closestDist = dist; closestIdx = i }
  }
  // Fallback: if no match by thrower (shouldn't happen), try any visual
  if (closestIdx === -1 && throwerId) {
    for (let i = 0; i < msgProjectileVisuals.length; i++) {
      const vis = msgProjectileVisuals[i]
      const pos = Transform.get(vis.entity).position
      const dx = pos.x - x, dy = pos.y - y, dz = pos.z - z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < closestDist) { closestDist = dist; closestIdx = i }
    }
  }
  if (closestIdx === -1) return

  const vis = msgProjectileVisuals[closestIdx]
  if (vis.returning) {
    if (isPeak) {
      // Server confirming the turnaround — client already started returning, just ignore
      console.log('[Projectile] 🎯 Peak message arrived but already returning — ignoring')
      return
    }
    // Already returning — this is a real hit on the return trip, actually remove it
    if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
    releaseProjectileToPool(vis.entity)
    msgProjectileVisuals.splice(closestIdx, 1)
  } else {
    // Outbound hit — start returning
    vis.returning = true
    vis.returnDistance = 0
  }
}

function updateMsgProjectileVisuals(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = msgProjectileVisuals.length - 1; i >= 0; i--) {
    const vis = msgProjectileVisuals[i]

    // Safety expiry
    if (now - vis.createdAtMs > PROJECTILE_LIFETIME_SEC * 1000) {
      if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
      releaseProjectileToPool(vis.entity)
      msgProjectileVisuals.splice(i, 1)
      continue
    }

    // Move forward or return to player's CURRENT position
    const moveDist = vis.speed * clampedDt
    if (!vis.returning) {
      vis.distanceTraveled += moveDist
      if (vis.distanceTraveled >= vis.maxDistance) {
        vis.returning = true
        vis.returnDistance = 0
      }
    }

    // Spin the boomerang
    vis.spinAngle += PROJECTILE_SPIN_SPEED * clampedDt

    if (!vis.returning) {
      // Outbound — straight line from start
      const headingDeg = Math.atan2(vis.dirX, vis.dirZ) * (180 / Math.PI)
      const t = Transform.getMutable(vis.entity)
      t.position = Vector3.create(vis.startX + vis.dirX * vis.distanceTraveled, vis.startY, vis.startZ + vis.dirZ * vis.distanceTraveled)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + vis.spinAngle, 0)
    } else {
      // Returning — use server-broadcast position for remote throwers, local PlayerEntity for self
      const shellPos = Transform.get(vis.entity).position
      const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
      const isLocalThrower = vis.firedBy === localUserId || vis.firedBy === ''

      let targetPos: Vector3
      if (isLocalThrower) {
        // Local player's boomerang — use own position (accurate, no lag)
        const rawPlayerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : Vector3.create(vis.startX, vis.startY, vis.startZ)
        targetPos = Vector3.create(rawPlayerPos.x, rawPlayerPos.y + PROJECTILE_CHEST_OFFSET, rawPlayerPos.z)
      } else {
        // Remote player's boomerang — look up their position locally via CRDT
        const remotePos = getRemotePlayerPosition(vis.firedBy)
        if (remotePos) {
          targetPos = Vector3.create(remotePos.x, remotePos.y + PROJECTILE_CHEST_OFFSET, remotePos.z)
        } else {
          // Fallback: return to start position if player left
          targetPos = Vector3.create(vis.startX, vis.startY + PROJECTILE_CHEST_OFFSET, vis.startZ)
        }
      }

      const dx = targetPos.x - shellPos.x
      const dy = targetPos.y - shellPos.y
      const dz = targetPos.z - shellPos.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (dist < 2.0) {
        // Close enough — disappear
        if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
        releaseProjectileToPool(vis.entity)
        msgProjectileVisuals.splice(i, 1)
        continue
      }

      // Move toward target at projectile speed
      const nx = dx / dist, ny = dy / dist, nz = dz / dist
      const headingDeg = Math.atan2(nx, nz) * (180 / Math.PI)
      const t = Transform.getMutable(vis.entity)
      t.position = Vector3.create(shellPos.x + nx * moveDist, shellPos.y + ny * moveDist, shellPos.z + nz * moveDist)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + vis.spinAngle, 0)
    }
  }
}

/** Fire a projectile from the UI (mobile tap). Same logic as E key press. */
export function triggerProjectileFromUI(): void {
  if (isDrownRespawning()) return
  const now = Date.now()
  const userId = getPlayerData()?.userId
  if (!userId) return

  if (now - lastLocalProjectileFireTime < (PROJECTILE_COOLDOWN_SEC + lastThrowExtraCooldown) * 1000) { playErrorSound(); return }
  if (localThrowActive || localProjectiles.length > 0) return

  lastLocalProjectileFireTime = now
  const uiColor = getBoomerangColor()

  // Green: orbit mechanic
  if (uiColor === 'g') {
    if (orbitActive) return
    lastThrowExtraCooldown = 4
    const { dirX: oaDirX, dirZ: oaDirZ } = getPlayerForward()
    const uiOrbitAngle = Math.atan2(oaDirX, oaDirZ) * (180 / Math.PI)
    const serverUp = isServerConnected()
    if (serverUp) {
      localThrowActive = true; localThrowSawVisual = false; localThrowStartMs = Date.now()
      updateHandBoomerangVisibility()
      room.send('requestOrbit', { t: now, startAngle: uiOrbitAngle })
    } else {
      startOrbitVisual()
    }
    console.log('[Projectile] 🌀 UI tap — green orbit requested')
    return
  }

  lastThrowExtraCooldown = uiColor === 'y' ? 1 : 0
  const { dirX, dirZ } = getPlayerForward()
  const serverUp = isServerConnected()

  if (serverUp) {
    console.log('[Projectile] 🎯 UI tap — requesting projectile fire (server)')
    localThrowActive = true; localThrowSawVisual = false; localThrowStartMs = Date.now()
    updateHandBoomerangVisibility()
    const uiRange = uiColor === 'r' ? RED_RANGE : CHARGE_MIN_RANGE
    const uiSpeed = CHARGE_MIN_SPEED
    room.send('requestShell', { dirX, dirZ, color: uiColor, chargeSpeed: uiSpeed, chargeRange: uiRange, chargeScale: 1 })
    if (Transform.has(engine.PlayerEntity)) {
      const playerPos = Transform.get(engine.PlayerEntity).position
      const spawnPos = Vector3.create(playerPos.x + dirX * 1.0, playerPos.y + 0.8, playerPos.z + dirZ * 1.0)
      fireWallRaycast(spawnPos, dirX, dirZ)
    }
  } else {
    console.log('[Projectile] 🎯 UI tap — firing projectile locally (no server)')
    localThrowActive = true; localThrowSawVisual = false; localThrowStartMs = Date.now()
    updateHandBoomerangVisibility()
    fireProjectileLocally()
  }

  // Yellow: schedule second throw from UI tap too
  if (getBoomerangColor() === 'y') {
    yellowSecondThrowAt = now + YELLOW_SECOND_THROW_DELAY_MS
    yellowSecondThrowDir = { dirX, dirZ }
  }
}

// ── Main client system ──
export function projectileClientSystem(dt: number): void {
  updateHandBoomerangVisibility()
  const now = Date.now()

  // Track player Y for airborne detection (smoothed per-frame)
  if (!isCharging && Transform.has(engine.PlayerEntity)) {
    lastChargeGroundY = Transform.get(engine.PlayerEntity).position.y
  }
  const serverUp = isServerConnected()

  // During cinematic, cancel any active projectile stagger
  // Do NOT touch InputModifier — the cinematic system owns it during fadePhase
  if (isCinematicActive()) {
    projectileStaggerUntil = 0
  }

  // Release projectile stagger freeze
  if (projectileStaggerUntil > 0 && now >= projectileStaggerUntil) {
    projectileStaggerUntil = 0
    if (!isSpectatorMode() && InputModifier.has(engine.PlayerEntity)) {
      InputModifier.deleteFrom(engine.PlayerEntity)
    }
  }

  if (serverUp) {
    // Process wall raycasts
    processWallRaycasts()

    // Animate message-driven projectile visuals (movement, expiry)
    updateMsgProjectileVisuals(dt)

    // Clear local throw flag when projectile visual has appeared and then gone
    // Skip during green orbit — orbit manages localThrowActive itself via stopOrbitVisual()
    if (localThrowActive && !orbitActive) {
      const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
      const hasLocalVisual = msgProjectileVisuals.some(v => v.firedBy === localUserId)
      if (hasLocalVisual) {
        localThrowSawVisual = true
      } else if (localThrowSawVisual) {
        // Visual existed and is now gone — boomerang returned
        localThrowActive = false
        localThrowSawVisual = false
        localThrowStartMs = 0
        lastLocalProjectileFireTime = now // start post-catch cooldown
      } else if (localThrowStartMs > 0 && now - localThrowStartMs > PROJECTILE_LIFETIME_SEC * 1000) {
        // Ultimate safety: no matter what, clear after projectile lifetime (8s)
        console.log('[Projectile] ⚠️ localThrowActive stuck for', ((now - localThrowStartMs) / 1000).toFixed(1), 's (lifetime exceeded) — force-clearing')
        localThrowActive = false
        localThrowSawVisual = false
        localThrowStartMs = 0
        lastLocalProjectileFireTime = now
      } else if (localThrowStartMs > 0 && now - localThrowStartMs > LOCAL_THROW_SAFETY_MS) {
        // Safety: no visual appeared within 4s — message was lost or race condition
        console.log('[Projectile] ⚠️ localThrowActive stuck for', ((now - localThrowStartMs) / 1000).toFixed(1), 's with no visual — force-clearing')
        localThrowActive = false
        localThrowSawVisual = false
        localThrowStartMs = 0
        lastLocalProjectileFireTime = now // start post-catch cooldown
      }
    }
  } else {
    // Local test mode
    updateLocalProjectiles(dt)
  }

  // Green orbit visual
  updateOrbitVisual(dt)

  // Yellow double-throw: fire second boomerang after delay
  if (yellowSecondThrowAt > 0 && now >= yellowSecondThrowAt) {
    yellowSecondThrowAt = 0
    const serverUp = isServerConnected()
    if (serverUp) {
      room.send('requestShell', { dirX: yellowSecondThrowDir.dirX, dirZ: yellowSecondThrowDir.dirZ, color: 'y', chargeSpeed: CHARGE_MIN_SPEED, chargeRange: CHARGE_MIN_RANGE, chargeScale: 1 })
      if (Transform.has(engine.PlayerEntity)) {
        const playerPos = Transform.get(engine.PlayerEntity).position
        const spawnPos = Vector3.create(playerPos.x + yellowSecondThrowDir.dirX * 1.0, playerPos.y + 0.8, playerPos.z + yellowSecondThrowDir.dirZ * 1.0)
        fireWallRaycast(spawnPos, yellowSecondThrowDir.dirX, yellowSecondThrowDir.dirZ)
      }
    } else {
      fireProjectileLocally(CHARGE_MIN_SPEED, CHARGE_MIN_RANGE)
    }
    // Hide left-hand boomerang
    if (leftHandBoomerangEntity && Transform.has(leftHandBoomerangEntity)) {
      Transform.getMutable(leftHandBoomerangEntity).scale = Vector3.Zero()
    }
    console.log('[Projectile] 🎯 Yellow 2nd throw fired')
  }

  // E key — charge on press (blue only), instant fire for other colors
  if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN) && !isSpectatorMode() && !isCinematicActive() && !isDrownRespawning()) {
    const userId = getPlayerData()?.userId
    if (!userId) return

    // Client-side cooldown check
    const projectileCd = PROJECTILE_COOLDOWN_SEC + lastThrowExtraCooldown
    if (now - lastLocalProjectileFireTime < projectileCd * 1000) {
      const remaining = ((projectileCd * 1000 - (now - lastLocalProjectileFireTime)) / 1000).toFixed(1)
      console.log('[Projectile] E pressed but cooldown active —', remaining, 's remaining')
      playErrorSound()
      return
    }

    // Also block if a boomerang is already in flight
    if (localThrowActive || localProjectiles.length > 0) return

    // Green = orbit, Red/Yellow = instant throw, Blue = charge
    const currentColor = getBoomerangColor()

    // Green: orbit mechanic (no projectile)
    if (currentColor === 'g') {
      if (orbitActive) return // already orbiting
      lastLocalProjectileFireTime = now
      lastThrowExtraCooldown = 4
      const { dirX: eaDirX, dirZ: eaDirZ } = getPlayerForward()
      const eOrbitAngle = Math.atan2(eaDirX, eaDirZ) * (180 / Math.PI)
      const serverUp = isServerConnected()
      if (serverUp) {
        localThrowActive = true; localThrowSawVisual = false; localThrowStartMs = Date.now()
        updateHandBoomerangVisibility()
        room.send('requestOrbit', { t: now, startAngle: eOrbitAngle })
      } else {
        // Local test: start orbit visual directly
        startOrbitVisual()
      }
      console.log('[Projectile] 🌀 Green orbit requested')
      return
    }

    // Red/Yellow: instant throw (no charge)
    if (currentColor !== 'b') {
      lastLocalProjectileFireTime = now
      lastThrowExtraCooldown = currentColor === 'y' ? 1 : 0
      const { dirX, dirZ } = getPlayerForward()
      const serverUp = isServerConnected()
      const range = currentColor === 'r' ? RED_RANGE : CHARGE_MIN_RANGE
      const speed = CHARGE_MIN_SPEED
      if (serverUp) {
        localThrowActive = true; localThrowSawVisual = false; localThrowStartMs = Date.now()
        updateHandBoomerangVisibility()
        room.send('requestShell', { dirX, dirZ, color: currentColor, chargeSpeed: speed, chargeRange: range, chargeScale: 1 })
        if (Transform.has(engine.PlayerEntity)) {
          const playerPos = Transform.get(engine.PlayerEntity).position
          const spawnPos = Vector3.create(playerPos.x + dirX * 1.0, playerPos.y + 0.8, playerPos.z + dirZ * 1.0)
          fireWallRaycast(spawnPos, dirX, dirZ)
        }
      } else {
        localThrowActive = true; localThrowSawVisual = false; localThrowStartMs = Date.now()
        updateHandBoomerangVisibility()
        fireProjectileLocally(speed, range)
      }
      // Yellow: schedule a second throw after a short delay
      if (currentColor === 'y') {
        yellowSecondThrowAt = now + YELLOW_SECOND_THROW_DELAY_MS
        yellowSecondThrowDir = { dirX, dirZ }
      }
      console.log('[Projectile] 🎯 Instant throw (non-charge color)')
      return
    }

    // Blue only: block charging while airborne (gliding/jumping/falling)
    if (Transform.has(engine.PlayerEntity)) {
      const playerY = Transform.get(engine.PlayerEntity).position.y
      if (Math.abs(playerY - lastChargeGroundY) > 0.15) {
        lastChargeGroundY = playerY
        return
      }
      lastChargeGroundY = playerY
    }

    // Start charging (blue boomerang only)
    chargeStartMs = now
    isCharging = true
    orbitAngle = 0
    playChargeSound()
    applyChargeSlow()
    room.send('chargeStart', { t: now })
    console.log('[Projectile] ⚡ E pressed — charging started (blue)')
  }

  // Cancel charge if player enters spectator/cinematic/drown
  if (isCharging && (isSpectatorMode() || isCinematicActive() || isDrownRespawning())) {
    isCharging = false
    chargeStartMs = 0
    stopChargeSound()
    removeChargeSlow()
    room.send('chargeStop', { t: now })
    console.log('[Projectile] ⚡ Charge cancelled (state change)')
  }

  // Burnout — held too long, self-stun
  if (isCharging && chargeStartMs > 0 && (now - chargeStartMs) / 1000 >= CHARGE_TIME_SEC) {
    isCharging = false
    chargeStartMs = 0
    lastLocalProjectileFireTime = now  // trigger cooldown
    stopChargeSound()
    removeChargeSlow()
    room.send('chargeStop', { t: now })
    burnoutFlashUntil = Date.now() + BURNOUT_FLASH_MS
    console.log('[Projectile] 💥 BURNOUT — held too long, self-stun!')
    // Force flag drop if carrying
    if (isServerConnected()) {
      room.send('requestDrop', { t: 0 })
    }
    // Self-stagger — head explode for overcharge
    triggerEmote({ predefinedEmote: 'getHit' })
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({ disableAll: true, disableGliding: true, disableDoubleJump: true })
    })
    projectileStaggerUntil = now + PROJECTILE_STAGGER_MS
    if (Transform.has(engine.PlayerEntity)) {
      const pos = Transform.get(engine.PlayerEntity).position
      // Broadcast burnout VFX — server will send hitVfx back to ALL clients (including us)
      room.send('chargeBurnout', { x: pos.x, y: pos.y, z: pos.z })
    }
  }

  // E key released — fire with charged size
  if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_UP) && isCharging) {
    isCharging = false
    stopChargeSound()
    removeChargeSlow()
    room.send('chargeStop', { t: now })
    const chargeFrac = Math.min(1, (now - chargeStartMs) / 1000 / CHARGE_TIME_SEC)
    const currentColor = getBoomerangColor()

    // Blue: speed + range scale with charge. Green: size scales with charge, speed/range stay base.
    const chargeSpeed = currentColor === 'b' ? chargeToSpeed(chargeFrac) : CHARGE_MIN_SPEED
    const chargeRange = currentColor === 'b' ? chargeToRange(chargeFrac) : CHARGE_MIN_RANGE
    const chargeScale = 1 // only blue reaches here

    chargeStartMs = 0
    lastLocalProjectileFireTime = now
    // Extra cooldown: under 1s charge = +1s, over 1s charge = +2s
    const chargeElapsed = chargeFrac * CHARGE_TIME_SEC
    lastThrowExtraCooldown = chargeElapsed >= 1.0 ? 1 : 0

    console.log('[Projectile] 🎯 E released — charge:', (chargeFrac * 100).toFixed(0) + '%, speed:', chargeSpeed.toFixed(0), 'range:', chargeRange.toFixed(0), 'scale:', chargeScale.toFixed(1), 'extraCD:', lastThrowExtraCooldown)
    if (chargeElapsed >= 1.25) playReleaseSound()

    const { dirX, dirZ } = getPlayerForward()

    if (serverUp) {
      localThrowActive = true; localThrowSawVisual = false; localThrowStartMs = Date.now()
      updateHandBoomerangVisibility()
      room.send('requestShell', { dirX, dirZ, color: currentColor, chargeSpeed, chargeRange, chargeScale })
      if (Transform.has(engine.PlayerEntity)) {
        const playerPos = Transform.get(engine.PlayerEntity).position
        const spawnPos = Vector3.create(playerPos.x + dirX * 1.0, playerPos.y + 0.8, playerPos.z + dirZ * 1.0)
        fireWallRaycast(spawnPos, dirX, dirZ)
      }
    } else {
      localThrowActive = true; localThrowSawVisual = false; localThrowStartMs = Date.now()
      updateHandBoomerangVisibility()
      fireProjectileLocally(chargeSpeed, chargeRange)
    }
  }
}
