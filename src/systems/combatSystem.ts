import {
  engine,
  Transform,
  inputSystem,
  InputAction,
  PointerEventType,
  InputModifier,
  AudioSource,
  MeshRenderer,
  Material,
  Tween,
  TweenSequence,
  EasingFunction,
  MaterialTransparencyMode,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { PlayerIdentityData } from '@dcl/sdk/ecs'
import { room } from '../shared/messages'
import { Flag, FlagState } from '../shared/components'
import { triggerEmote } from '~system/RestrictedActions'

// ── VFX Constants ──
const VFX_DURATION_MS = 250
const SPIKES_PER_HIT = 6
const SPIKE_THIN = 0.08
const SPIKE_START_LEN = 0.10
const SPIKE_END_LEN = 1.10

const HIT_MATERIAL = {
  albedoColor: Color4.create(0.7, 0.05, 0.05, 0.8),
  emissiveColor: Color4.create(0.9, 0.1, 0.05, 1),
  emissiveIntensity: 2.5,
  roughness: 1.0, metallic: 0.0, specularIntensity: 0.0,
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
}

const CLOUD_MATERIAL = {
  albedoColor: Color4.create(1, 1, 1, 0.6),
  roughness: 1.0, metallic: 0.0, specularIntensity: 0.0,
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
}

const CLOUD_CONFIGS = [
  [
    { offset: Vector3.create(0, 0, 0), startScale: 0.14, endScale: 0.48 },
    { offset: Vector3.create(0.2, 0.18, 0.08), startScale: 0.10, endScale: 0.34 },
    { offset: Vector3.create(-0.16, -0.12, -0.06), startScale: 0.08, endScale: 0.26 },
  ],
  [
    { offset: Vector3.create(-0.22, 0.05, 0), startScale: 0.12, endScale: 0.40 },
    { offset: Vector3.create(0.08, -0.05, 0.05), startScale: 0.16, endScale: 0.52 },
    { offset: Vector3.create(0.25, 0.12, -0.04), startScale: 0.09, endScale: 0.30 },
  ],
  [
    { offset: Vector3.create(0.05, 0.2, 0), startScale: 0.13, endScale: 0.44 },
    { offset: Vector3.create(-0.08, -0.05, 0.06), startScale: 0.15, endScale: 0.50 },
    { offset: Vector3.create(0.12, -0.18, -0.03), startScale: 0.07, endScale: 0.24 },
  ],
]
let cloudConfigIndex = 0

// ── Entity Pools ──
const HIT_POOL_SIZE = SPIKES_PER_HIT * 3
const MISS_POOL_SIZE = 3 * 2
const hitPool: Entity[] = []
let hitPoolIdx = 0
const missPool: Entity[] = []
let missPoolIdx = 0
let poolsReady = false
const HIDDEN_POS = Vector3.create(0, -100, 0)
const activeVfx: { entity: Entity; expiresAt: number }[] = []

function initPools(): void {
  if (poolsReady) return
  poolsReady = true
  for (let i = 0; i < HIT_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setBox(e)
    Material.setPbrMaterial(e, HIT_MATERIAL)
    hitPool.push(e)
  }
  for (let i = 0; i < MISS_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, CLOUD_MATERIAL)
    missPool.push(e)
  }
}

function hideVfxEntity(entity: Entity): void {
  const t = Transform.getMutable(entity)
  t.position = HIDDEN_POS
  t.scale = Vector3.Zero()
  if (TweenSequence.has(entity)) TweenSequence.deleteFrom(entity)
  if (Tween.has(entity)) Tween.deleteFrom(entity)
}

export function showHitEffect(targetPos: Vector3): void {
  initPools()
  const centerPos = Vector3.add(targetPos, Vector3.create(0, 1.2, 0))
  const hitRotY = Math.random() * 360
  const hitRotX = (Math.random() - 0.5) * 30
  const scaleMult = 0.9 + Math.random() * 0.25
  const expiresAt = Date.now() + VFX_DURATION_MS + 50

  for (let i = 0; i < SPIKES_PER_HIT; i++) {
    const spike = hitPool[hitPoolIdx % HIT_POOL_SIZE]
    hitPoolIdx++
    const baseAngle = (i / SPIKES_PER_HIT) * 180 + (Math.random() - 0.5) * 25
    let rotX = 0, rotY = 0, rotZ = 0
    if (i % 3 === 0) rotZ = baseAngle
    else if (i % 3 === 1) { rotY = baseAngle; rotX = 90 }
    else rotX = baseAngle
    const sj = 0.8 + Math.random() * 0.4
    const sLen = SPIKE_START_LEN * scaleMult * sj
    const eLen = SPIKE_END_LEN * scaleMult * sj
    const sThin = SPIKE_THIN * scaleMult
    const eThin = SPIKE_THIN * scaleMult * 1.8
    const t = Transform.getMutable(spike)
    t.position = centerPos
    t.scale = Vector3.create(sThin, sLen, sThin)
    t.rotation = Quaternion.fromEulerDegrees(rotX + hitRotX, rotY + hitRotY, rotZ)
    Tween.createOrReplace(spike, {
      mode: Tween.Mode.Scale({ start: Vector3.create(sThin, sLen, sThin), end: Vector3.create(eThin, eLen, eThin) }),
      duration: VFX_DURATION_MS * 0.7,
      easingFunction: EasingFunction.EF_EASEOUTEXPO,
    })
    // Chain a shrink-to-zero so the spike disappears even if the timer cleanup doesn't fire (mobile bug)
    TweenSequence.createOrReplace(spike, {
      sequence: [{
        mode: Tween.Mode.Scale({ start: Vector3.create(eThin, eLen, eThin), end: Vector3.Zero() }),
        duration: VFX_DURATION_MS * 0.3,
        easingFunction: EasingFunction.EF_EASEINQUAD,
      }]
    })
    activeVfx.push({ entity: spike, expiresAt })
  }
}

function showMissEffect(targetPos: Vector3): void {
  initPools()
  const centerPos = Vector3.add(targetPos, Vector3.create(0, 1.2, 0))
  const config = CLOUD_CONFIGS[cloudConfigIndex % CLOUD_CONFIGS.length]
  cloudConfigIndex++
  const scaleMult = 0.85 + Math.random() * 0.3
  const clusterRotY = Math.random() * 360
  const expiresAt = Date.now() + VFX_DURATION_MS + 80

  for (const cfg of config) {
    const sphere = missPool[missPoolIdx % MISS_POOL_SIZE]
    missPoolIdx++
    const rotOff = Vector3.rotate(cfg.offset, Quaternion.fromEulerDegrees(0, clusterRotY, 0))
    const jitter = Vector3.create((Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1)
    const sPos = Vector3.add(centerPos, Vector3.add(rotOff, jitter))
    const sj = 0.9 + Math.random() * 0.2
    const s = cfg.startScale * scaleMult * sj
    const e = cfg.endScale * scaleMult * sj
    const t = Transform.getMutable(sphere)
    t.position = sPos
    t.scale = Vector3.create(s, s, s)
    Tween.createOrReplace(sphere, {
      mode: Tween.Mode.Scale({ start: Vector3.create(s, s, s), end: Vector3.create(e, e, e) }),
      duration: VFX_DURATION_MS,
      easingFunction: EasingFunction.EF_EASEOUTQUAD,
    })
    // Chain a shrink-to-zero so the bubble disappears even if the timer cleanup doesn't fire (mobile bug)
    TweenSequence.createOrReplace(sphere, {
      sequence: [{
        mode: Tween.Mode.Scale({ start: Vector3.create(e, e, e), end: Vector3.Zero() }),
        duration: VFX_DURATION_MS * 0.3,
        easingFunction: EasingFunction.EF_EASEINQUAD,
      }]
    })
    activeVfx.push({ entity: sphere, expiresAt })
  }
}

// ── Sound pools ──
const HIT_SOUND_PATH = 'assets/sounds/rs-hit.mp3'
const MISS_SOUND_PATH = 'assets/sounds/rs-miss.mp3'
const HIT_SOUND_POOL_SIZE = 5
const hitSoundPool: Entity[] = []
let hitSoundPoolIndex = 0
let missSoundEntity: Entity | null = null

export function playHitSound(position: Vector3): void {
  while (hitSoundPool.length < HIT_SOUND_POOL_SIZE) {
    const e = engine.addEntity()
    Transform.create(e, { position: Vector3.Zero() })
    AudioSource.create(e, { audioClipUrl: HIT_SOUND_PATH, playing: false, loop: false, volume: 1, global: false })
    hitSoundPool.push(e)
  }
  const e = hitSoundPool[hitSoundPoolIndex % HIT_SOUND_POOL_SIZE]
  hitSoundPoolIndex++
  // Position the sound at the hit location
  const t = Transform.getMutable(e)
  t.position = position
  const a = AudioSource.getMutable(e)
  a.currentTime = 0
  a.playing = true
}

function playMissSound(position: Vector3): void {
  if (!missSoundEntity) {
    missSoundEntity = engine.addEntity()
    Transform.create(missSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(missSoundEntity, { audioClipUrl: MISS_SOUND_PATH, playing: false, loop: false, volume: 1, global: false })
  }
  // Position the sound at the miss location
  const t = Transform.getMutable(missSoundEntity)
  t.position = position
  const a = AudioSource.getMutable(missSoundEntity)
  a.currentTime = 0
  a.playing = true
}

// CONTINUED IN STEP 4b-ii — stagger, message listeners, main system loop
// (placeholder exports so the file compiles)
const STAGGER_EMOTE = 'getHit' as const
const STAGGER_FREEZE_MS = 800   // Reduced from 1500ms - shorter stun duration
const STAGGER_DELAY_MS = 0      // Reduced from 100ms - instant emote trigger
let staggerFreezeUntil = 0
let staggerTriggerAt = 0
let pendingStagger = false
const pendingHitPositions: Vector3[] = []
const pendingMissPositions: Vector3[] = []

// Optimistic attack prediction — skip the next server VFX if we already played it locally
let skipNextServerVfx = false
let skipNextServerVfxExpiry = 0
const HIT_RADIUS_CLIENT = 2.5 // Must match server HIT_RADIUS

// Client-side steal immunity tracking (mirrors server STEAL_IMMUNITY_MS)
const STEAL_IMMUNITY_MS_CLIENT = 3000
const clientStealImmunity = new Map<string, number>() // playerId → timestamp when they stole the flag

// Register message listeners
room.onMessage('hitVfx', (data) => {
  const now = Date.now()
  if (skipNextServerVfx && now < skipNextServerVfxExpiry) {
    // We already played this optimistically — skip the server echo
    skipNextServerVfx = false
    return
  }
  skipNextServerVfx = false
  pendingHitPositions.push(Vector3.create(data.x, data.y, data.z))
})
room.onMessage('missVfx', (data) => {
  const now = Date.now()
  if (skipNextServerVfx && now < skipNextServerVfxExpiry) {
    // We already played this optimistically — skip the server echo
    skipNextServerVfx = false
    return
  }
  skipNextServerVfx = false
  pendingMissPositions.push(Vector3.create(data.x, data.y, data.z))
})
room.onMessage('stagger', (data) => {
  const me = getPlayerData()?.userId?.toLowerCase()
  if (me && data.victimId === me) pendingStagger = true
})

/**
 * Optimistic attack prediction — called immediately on E press (before server round-trip).
 * Runs the same hit/miss check the server does and plays VFX/sound instantly.
 * Sets a flag so the server's echo message is skipped to prevent duplicates.
 */
export function predictAttackLocally(): void {
  if (!Transform.has(engine.PlayerEntity)) return

  const myPos = Transform.get(engine.PlayerEntity).position
  const myRot = Transform.get(engine.PlayerEntity).rotation
  const myUserId = getPlayerData()?.userId
  if (!myUserId) return

  // Find closest other player (mirror server logic, including steal immunity check)
  let closestPos: Vector3 | null = null
  let closestDist = HIT_RADIUS_CLIENT
  const now = Date.now()

  for (const [, identity, transform] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address === myUserId) continue
    // Skip players with steal immunity (just stole the flag)
    const stealTime = clientStealImmunity.get(identity.address) ?? 0
    if (now - stealTime < STEAL_IMMUNITY_MS_CLIENT) continue
    const dist = Vector3.distance(myPos, transform.position)
    if (dist < closestDist) {
      closestDist = dist
      closestPos = Vector3.create(transform.position.x, transform.position.y, transform.position.z)
    }
  }

  // Mark to skip the next server echo (within a generous time window)
  skipNextServerVfx = true
  skipNextServerVfxExpiry = Date.now() + 2000

  if (closestPos) {
    // Predicted hit
    showHitEffect(closestPos)
    playHitSound(closestPos)
  } else {
    // Predicted miss — show in front of player
    const forward = Vector3.rotate(Vector3.Forward(), myRot)
    const missPos = Vector3.add(myPos, Vector3.scale(forward, 1.2))
    showMissEffect(missPos)
    playMissSound(missPos)
  }
}

// Track previous flag carrier to detect steals on the client
let prevCombatCarrierId = ''
let prevCombatFlagState: FlagState | null = null

export function combatClientSystem(_dt: number): void {
  const now = Date.now()
  initPools()

  // Detect flag steals (carrier changed while flag stayed in Carried state) to track client-side immunity
  for (const [, flag] of engine.getEntitiesWith(Flag)) {
    if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
      if (prevCombatFlagState === FlagState.Carried && prevCombatCarrierId && prevCombatCarrierId !== flag.carrierPlayerId) {
        // Carrier changed while flag was carried = steal. New carrier gets immunity.
        clientStealImmunity.set(flag.carrierPlayerId, now)
      }
    }
    prevCombatFlagState = flag.state
    prevCombatCarrierId = flag.carrierPlayerId
    break
  }

  // Cleanup expired VFX
  for (let i = activeVfx.length - 1; i >= 0; i--) {
    if (now >= activeVfx[i].expiresAt) {
      hideVfxEntity(activeVfx[i].entity)
      activeVfx.splice(i, 1)
    }
  }

  // Show VFX from server messages
  for (const pos of pendingHitPositions) { showHitEffect(pos); playHitSound(pos) }
  pendingHitPositions.length = 0
  for (const attackerPos of pendingMissPositions) {
    // Find the attacker's rotation to compute "in front" position
    let missPos = attackerPos
    // Check if it's our own miss (closest to our position)
    if (Transform.has(engine.PlayerEntity)) {
      const myPos = Transform.get(engine.PlayerEntity).position
      if (Vector3.distance(myPos, attackerPos) < 2) {
        const myRot = Transform.get(engine.PlayerEntity).rotation
        const forward = Vector3.rotate(Vector3.Forward(), myRot)
        missPos = Vector3.add(myPos, Vector3.scale(forward, 1.2))
      } else {
        // Find the attacker among other players
        let closest: { pos: Vector3; rot: any } | null = null
        let closestDist = 3
        for (const [ent, , transform] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
          const d = Vector3.distance(transform.position, attackerPos)
          if (d < closestDist) {
            closestDist = d
            closest = { pos: transform.position, rot: transform.rotation }
          }
        }
        if (closest) {
          const forward = Vector3.rotate(Vector3.Forward(), closest.rot)
          missPos = Vector3.add(closest.pos, Vector3.scale(forward, 1.2))
        }
      }
    }
    showMissEffect(missPos)
    playMissSound(missPos)
  }
  pendingMissPositions.length = 0

  // Stagger: end freeze
  if (staggerFreezeUntil > 0 && now >= staggerFreezeUntil) {
    staggerFreezeUntil = 0
    if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
  }

  // Stagger: received from server
  if (pendingStagger) {
    pendingStagger = false
    if (staggerFreezeUntil > 0 && InputModifier.has(engine.PlayerEntity)) {
      InputModifier.deleteFrom(engine.PlayerEntity)
    }
    staggerTriggerAt = now + STAGGER_DELAY_MS
  }

  // Stagger: apply
  if (staggerTriggerAt > 0 && now >= staggerTriggerAt) {
    staggerTriggerAt = 0
    triggerEmote({ predefinedEmote: STAGGER_EMOTE })
    if (!InputModifier.has(engine.PlayerEntity)) {
      InputModifier.create(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true, disableGliding: true, disableDoubleJump: true }) })
    }
    staggerFreezeUntil = now + STAGGER_FREEZE_MS
  }

}
