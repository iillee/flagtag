/**
 * bombSystem.ts — Client-side bomb visuals, blinking, explosion VFX, and stagger.
 *
 * Bombs are an alternate trap type. They blink red for 5 seconds, then explode
 * knocking all nearby players into the death emote for a few seconds.
 * Bombs also explode on player contact or when dropped from height.
 */
import {
  engine,
  Transform,
  GltfContainer,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  AudioSource,
  InputModifier,
  Tween,
  TweenSequence,
  EasingFunction,
  Raycast,
  RaycastResult,
  RaycastQueryType,
  Physics,
  KnockbackFalloff,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { triggerEmote } from '~system/RestrictedActions'

import { room } from '../shared/messages'
import { BOMB_FUSE_SEC, BOMB_EXPLOSION_RADIUS } from '../shared/components'

const BOMB_STAGGER_MS = 1000 // match regular hit stun duration
import { triggerHitFlash } from '../gameState/hitFlashState'
import { hasLocalFlagImmunity } from '../gameState/flagImmunityState'
import { showHitEffect, playHitSound } from './combatSystem'
import { isCinematicActive } from '../gameState/cinematicState'
import { isDrownRespawning } from './waterSystem'
import { isSpectatorMode } from './spectatorSystem'
import { playSpatialSound } from '../utils/spatialAudio'

const BOMB_MODEL_SRC = 'assets/asset-packs/iron_grenade/Bomb_01/Bomb_01.glb'
const BOMB_RED_MODEL_SRC = 'assets/asset-packs/iron_grenade/Bomb_01/Bomb_red.glb'
const BOMB_SCALE = Vector3.create(2, 2, 2)
const LOCAL_GRAVITY = 15

const HIDDEN_POS = Vector3.create(0, -200, 0)

// ── Bomb visual pool ──
// Each pooled bomb is a parent Transform holding TWO preloaded child GltfContainers
// (normal + red). Blinking toggles their scale instead of swapping the GLB via
// GltfContainer.createOrReplace — the latter accelerates to every 100ms and is
// exactly the model-swap churn the pool exists to avoid (see projectile/pool.ts).
const BOMB_POOL_SIZE = 6
const bombPool: Entity[] = []
const bombModelChildren = new Map<Entity, { normal: Entity; red: Entity }>()
let bombPoolReady = false

export function initBombPool(): void {
  if (bombPoolReady) return
  bombPoolReady = true
  for (let i = 0; i < BOMB_POOL_SIZE; i++) {
    const e = engine.addEntity()
    // Use tiny scale (not zero) so the engine actually loads the child GLB models
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.create(0.001, 0.001, 0.001) })
    // Two child models, both preloaded once. Children inherit the parent scale,
    // so identity scale here renders at the parent's scale.
    const normal = engine.addEntity()
    Transform.create(normal, { parent: e, position: Vector3.Zero(), scale: Vector3.One() })
    GltfContainer.create(normal, {
      src: BOMB_MODEL_SRC,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    const red = engine.addEntity()
    Transform.create(red, { parent: e, position: Vector3.Zero(), scale: Vector3.One() })
    GltfContainer.create(red, {
      src: BOMB_RED_MODEL_SRC,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0
    })
    bombPool.push(e)
    bombModelChildren.set(e, { normal, red })
  }
  console.log('[Bomb] 💣 Pre-created bomb visual pool of', BOMB_POOL_SIZE)
}

/** Show the normal model and hide the red one (or vice versa) via child scale. */
function setBombBlinkModel(bombEntity: Entity, showRed: boolean): void {
  const children = bombModelChildren.get(bombEntity)
  if (!children) return
  if (Transform.has(children.normal)) Transform.getMutable(children.normal).scale = showRed ? Vector3.Zero() : Vector3.One()
  if (Transform.has(children.red)) Transform.getMutable(children.red).scale = showRed ? Vector3.One() : Vector3.Zero()
}

function acquireBombFromPool(): Entity | null {
  initBombPool()
  for (const e of bombPool) {
    const t = Transform.get(e)
    if (t.position.y < -100) return e
  }
  console.error('[Bomb] Pool exhausted!')
  return null
}

function releaseBombToPool(entity: Entity): void {
  const t = Transform.getMutable(entity)
  t.position = HIDDEN_POS
  t.scale = Vector3.create(0.001, 0.001, 0.001)
}

// ── Explosion VFX pool ──
const EXPLOSION_POOL_SIZE = 12
const explosionPool: Entity[] = []
let explosionPoolReady = false
const EXPLOSION_DURATION_MS = 600

function initExplosionPool(): void {
  if (explosionPoolReady) return
  explosionPoolReady = true
  for (let i = 0; i < EXPLOSION_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, {
      albedoColor: Color4.create(1, 0.65, 0.1, 0.8),
      emissiveColor: Color4.create(1, 0.6, 0.1, 1),
      emissiveIntensity: 5.0,
      roughness: 1.0,
      metallic: 0.0,
      specularIntensity: 0.0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    explosionPool.push(e)
  }
}

let explosionPoolIdx = 0

interface ActiveExplosionVfx {
  entity: Entity
  expiresAt: number
}
const activeExplosionVfx: ActiveExplosionVfx[] = []

function showExplosionVFX(position: Vector3): void {
  initExplosionPool()
  const expiresAt = Date.now() + EXPLOSION_DURATION_MS + 100

  // Central fireball — big expanding sphere
  {
    const sphere = explosionPool[explosionPoolIdx % EXPLOSION_POOL_SIZE]
    explosionPoolIdx++
    const t = Transform.getMutable(sphere)
    t.position = Vector3.create(position.x, position.y + 0.5, position.z)
    t.scale = Vector3.create(0.3, 0.3, 0.3)
    Material.setPbrMaterial(sphere, {
      albedoColor: Color4.create(1, 0.7, 0.15, 0.9),
      emissiveColor: Color4.create(1, 0.65, 0.1, 1),
      emissiveIntensity: 8.0,
      roughness: 1.0, metallic: 0.0, specularIntensity: 0.0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    Tween.createOrReplace(sphere, {
      mode: Tween.Mode.Scale({ start: Vector3.create(0.3, 0.3, 0.3), end: Vector3.create(4, 4, 4) }),
      duration: EXPLOSION_DURATION_MS * 0.5,
      easingFunction: EasingFunction.EF_EASEOUTEXPO,
    })
    TweenSequence.createOrReplace(sphere, {
      sequence: [{
        mode: Tween.Mode.Scale({ start: Vector3.create(4, 4, 4), end: Vector3.Zero() }),
        duration: EXPLOSION_DURATION_MS * 0.5,
        easingFunction: EasingFunction.EF_EASEINQUAD,
      }]
    })
    activeExplosionVfx.push({ entity: sphere, expiresAt })
  }

  // Shockwave ring — flat expanding disc
  {
    const ring = explosionPool[explosionPoolIdx % EXPLOSION_POOL_SIZE]
    explosionPoolIdx++
    const t = Transform.getMutable(ring)
    t.position = Vector3.create(position.x, position.y + 0.2, position.z)
    t.scale = Vector3.create(0.5, 0.05, 0.5)
    Material.setPbrMaterial(ring, {
      albedoColor: Color4.create(1, 0.75, 0.25, 0.6),
      emissiveColor: Color4.create(1, 0.7, 0.15, 1),
      emissiveIntensity: 4.0,
      roughness: 1.0, metallic: 0.0, specularIntensity: 0.0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    const endSize = BOMB_EXPLOSION_RADIUS * 1.5
    Tween.createOrReplace(ring, {
      mode: Tween.Mode.Scale({ start: Vector3.create(0.5, 0.05, 0.5), end: Vector3.create(endSize, 0.02, endSize) }),
      duration: EXPLOSION_DURATION_MS * 0.6,
      easingFunction: EasingFunction.EF_EASEOUTQUAD,
    })
    TweenSequence.createOrReplace(ring, {
      sequence: [{
        mode: Tween.Mode.Scale({ start: Vector3.create(endSize, 0.02, endSize), end: Vector3.Zero() }),
        duration: EXPLOSION_DURATION_MS * 0.4,
        easingFunction: EasingFunction.EF_EASEINQUAD,
      }]
    })
    activeExplosionVfx.push({ entity: ring, expiresAt })
  }

  // Debris fragments — small spheres flying outward
  for (let i = 0; i < 6; i++) {
    const frag = explosionPool[explosionPoolIdx % EXPLOSION_POOL_SIZE]
    explosionPoolIdx++
    const angle = (i / 6) * Math.PI * 2 + Math.random() * 0.5
    const dist = 1.5 + Math.random() * 2.5
    const endX = position.x + Math.cos(angle) * dist
    const endZ = position.z + Math.sin(angle) * dist
    const endY = position.y + 1 + Math.random() * 3
    const fragSize = 0.15 + Math.random() * 0.25

    const t = Transform.getMutable(frag)
    t.position = Vector3.create(position.x, position.y + 0.5, position.z)
    t.scale = Vector3.create(fragSize, fragSize, fragSize)

    // Alternate between orange and dark red fragments
    const isDark = i % 2 === 0
    Material.setPbrMaterial(frag, {
      albedoColor: isDark ? Color4.create(1, 0.5, 0.1, 0.9) : Color4.create(1, 0.7, 0.15, 0.9),
      emissiveColor: isDark ? Color4.create(1, 0.55, 0.1, 1) : Color4.create(1, 0.7, 0.15, 1),
      emissiveIntensity: 3.0,
      roughness: 1.0, metallic: 0.0, specularIntensity: 0.0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })

    Tween.createOrReplace(frag, {
      mode: Tween.Mode.Move({ start: Vector3.create(position.x, position.y + 0.5, position.z), end: Vector3.create(endX, endY, endZ) }),
      duration: EXPLOSION_DURATION_MS * 0.5,
      easingFunction: EasingFunction.EF_EASEOUTQUAD,
    })
    TweenSequence.createOrReplace(frag, {
      sequence: [{
        mode: Tween.Mode.Scale({ start: Vector3.create(fragSize, fragSize, fragSize), end: Vector3.Zero() }),
        duration: EXPLOSION_DURATION_MS * 0.5,
        easingFunction: EasingFunction.EF_EASEINQUAD,
      }]
    })
    activeExplosionVfx.push({ entity: frag, expiresAt })
  }
}

// ── Sound ──
let bombFuseSoundEntity: Entity | null = null
let bombExplodeSoundEntity: Entity | null = null

function playBombFuseSound(position: Vector3): void {
  if (!bombFuseSoundEntity) {
    bombFuseSoundEntity = engine.addEntity()
    Transform.create(bombFuseSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(bombFuseSoundEntity, { audioClipUrl: 'assets/sounds/fuse.mp3', playing: false, loop: false, volume: 0.5, global: false })
  }
  playSpatialSound(bombFuseSoundEntity, 'assets/sounds/fuse.mp3', position, 0.5)
}

function stopBombFuseSound(): void {
  if (bombFuseSoundEntity && AudioSource.has(bombFuseSoundEntity)) {
    const a = AudioSource.getMutable(bombFuseSoundEntity)
    a.playing = false
    a.volume = 0
  }
}

function playBombExplodeSound(position: Vector3): void {
  if (!bombExplodeSoundEntity) {
    bombExplodeSoundEntity = engine.addEntity()
    Transform.create(bombExplodeSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(bombExplodeSoundEntity, { audioClipUrl: 'assets/sounds/bomb_exploding.mp3', playing: false, loop: false, volume: 1.0, global: false })
  }
  playSpatialSound(bombExplodeSoundEntity, 'assets/sounds/bomb_exploding.mp3', position, 50)
}

// ── Active bomb visuals (message-driven) ──

// ── Fuse flame pool ──
const FLAME_POOL_SIZE = 6
const flamePool: Entity[] = []
let flamePoolReady = false

function initFlamePool(): void {
  if (flamePoolReady) return
  flamePoolReady = true
  for (let i = 0; i < FLAME_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, {
      albedoColor: Color4.create(1, 0.7, 0.15, 0.9),
      emissiveColor: Color4.create(1, 0.65, 0.1, 1),
      emissiveIntensity: 6.0,
      roughness: 1.0,
      metallic: 0.0,
      specularIntensity: 0.0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    flamePool.push(e)
  }
}

function acquireFlame(): Entity | null {
  initFlamePool()
  for (const e of flamePool) {
    const t = Transform.get(e)
    if (t.position.y < -100) return e
  }
  return null
}

function releaseFlame(entity: Entity): void {
  const t = Transform.getMutable(entity)
  t.position = HIDDEN_POS
  t.scale = Vector3.Zero()
}

interface MsgBombVisual {
  entity: Entity
  flameEntity: Entity | null
  bombId: number
  x: number
  z: number
  ownerId: string
  createdAtMs: number
  falling: boolean
  fallVelocity: number
  currentY: number
  targetY: number
  groundResolved: boolean
  groundRayEntity: Entity | null
  lastBlinkMs: number
  blinkOn: boolean
}
const msgBombVisuals: MsgBombVisual[] = []

// ── Bomb stagger state ──
let bombStaggerUntil = 0

// ── Message listeners ──
let bombMessagesRegistered = false

export function setupBombMessages(): void {
  if (bombMessagesRegistered) return
  bombMessagesRegistered = true

room.onMessage('bombDropped', (data) => {
  console.log('[Bomb] 💣 bombDropped msg:', JSON.stringify(data))
  playBombFuseSound(Vector3.create(data.x, data.y, data.z))
  createBombVisual(data.x, data.y, data.z, data.ownerId || '', data.bombId)
})

room.onMessage('bombExploded', (data) => {
  const pos = Vector3.create(data.x, data.y, data.z)
  console.log('[Bomb] 💣 bombExploded at', data.x.toFixed(1), data.y.toFixed(1), data.z.toFixed(1))

  // Stop fuse sound immediately
  stopBombFuseSound()

  // Remove the bomb visual
  removeBombVisualById(data.bombId)

  // Show explosion VFX + sound
  showExplosionVFX(pos)
  playBombExplodeSound(pos)

  // Check if local player is a victim — also do client-side proximity check as fallback
  const me = getPlayerData()?.userId?.toLowerCase()
  if (me && !isCinematicActive()) {
    let isVictim = false

    // Check server victim list
    try {
      const victims: string[] = JSON.parse(data.victimsJson)
      if (victims.includes(me)) isVictim = true
    } catch { /* ignore parse errors */ }

    // Client-side proximity fallback
    if (!isVictim && Transform.has(engine.PlayerEntity)) {
      const playerPos = Transform.get(engine.PlayerEntity).position
      const dist = Vector3.distance(playerPos, pos)
      if (dist < BOMB_EXPLOSION_RADIUS) isVictim = true
    }

    if (isVictim) {
      const now = Date.now()
      if (bombStaggerUntil <= now) {
        // Flag pickup/steal shield: keep the knockback impulse (feels good,
        // tactical juice), but skip the stun, flash, hit VFX, sound, emote,
        // and InputModifier lock. Server also ignores the hit for flag-drop
        // purposes, so the flag stays safe.
        const immune = hasLocalFlagImmunity()
        console.log(immune
          ? '[Bomb] 🛡️ Local player in explosion but flag-immune — knockback only'
          : '[Bomb] 💣 Local player hit by explosion!')
        // ORDER MATTERS: knockback FIRST, InputModifier LAST.
        // If InputModifier is applied before knockback, the SDK's knockback conflicts
        // with the movement lock and leaves the player unable to move until any input
        // event (throwing a boomerang, reload) shakes it loose.
        Physics.applyKnockbackToPlayer(pos, 40, BOMB_EXPLOSION_RADIUS, KnockbackFalloff.LINEAR)
        if (!immune) {
          triggerHitFlash(BOMB_STAGGER_MS)
          // Red-star hit VFX + sound at player position (parity with boomerang hits)
          const vfxPos = Transform.has(engine.PlayerEntity)
            ? Transform.get(engine.PlayerEntity).position
            : pos
          showHitEffect(vfxPos)
          playHitSound(vfxPos)
          triggerEmote({ predefinedEmote: 'getHit' })
          InputModifier.createOrReplace(engine.PlayerEntity, {
            mode: InputModifier.Mode.Standard({ disableAll: true, disableGliding: true, disableDoubleJump: true })
          })
          bombStaggerUntil = now + BOMB_STAGGER_MS
        }
      }
    }
  }
})

} // end setupBombMessages

function createBombVisual(x: number, y: number, z: number, ownerId: string, bombId: number): void {
  const entity = acquireBombFromPool()
  if (!entity) return

  const t = Transform.getMutable(entity)
  t.position = Vector3.create(x, y, z)
  t.scale = BOMB_SCALE
  // Models are already loaded on the pooled children — just show the normal one.
  setBombBlinkModel(entity, false)

  // Fire ground raycast
  const groundRayEntity = engine.addEntity()
  Transform.create(groundRayEntity, { position: Vector3.create(x, y + 0.5, z) })
  Raycast.create(groundRayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
    maxDistance: 200, queryType: RaycastQueryType.RQT_HIT_FIRST, continuous: false
  })

  // Create fuse flame
  const flameEntity = acquireFlame()
  if (flameEntity) {
    const ft = Transform.getMutable(flameEntity)
    ft.position = Vector3.create(x, y + 0.8, z)
    ft.scale = Vector3.create(0.15, 0.2, 0.15)
  }

  msgBombVisuals.push({
    entity, flameEntity, bombId, x, z, ownerId,
    createdAtMs: Date.now(),
    falling: true, fallVelocity: 0, currentY: y, targetY: 0,
    groundResolved: false, groundRayEntity,
    lastBlinkMs: Date.now(), blinkOn: false,
  })
}

function removeBombVisualById(bombId: number): void {
  const idx = msgBombVisuals.findIndex(v => v.bombId === bombId)
  if (idx !== -1) {
    const vis = msgBombVisuals[idx]
    if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
    if (vis.flameEntity !== null) releaseFlame(vis.flameEntity)
    releaseBombToPool(vis.entity)
    msgBombVisuals.splice(idx, 1)
  }
}

// ── Main client system ──

export function bombClientSystem(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  // Release bomb stagger freeze
  if (isCinematicActive() && bombStaggerUntil > 0) {
    bombStaggerUntil = 0
  }
  if (bombStaggerUntil > 0 && now >= bombStaggerUntil) {
    bombStaggerUntil = 0
    if (!isSpectatorMode() && InputModifier.has(engine.PlayerEntity)) {
      InputModifier.deleteFrom(engine.PlayerEntity)
    }
  }

  // Update bomb visuals
  for (let i = msgBombVisuals.length - 1; i >= 0; i--) {
    const vis = msgBombVisuals[i]

    // Safety expiry (fuse + 2s margin)
    if (now - vis.createdAtMs > (BOMB_FUSE_SEC + 2) * 1000) {
      if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
      if (vis.flameEntity !== null) releaseFlame(vis.flameEntity)
      releaseBombToPool(vis.entity)
      msgBombVisuals.splice(i, 1)
      continue
    }

    // Ground raycast result
    if (vis.groundRayEntity !== null) {
      const result = RaycastResult.getOrNull(vis.groundRayEntity)
      if (result) {
        if (result.hits.length > 0) vis.targetY = Math.max(0, result.hits[0].position!.y)
        vis.groundResolved = true
        engine.removeEntity(vis.groundRayEntity)
        vis.groundRayEntity = null

        // Report ground Y to server
        room.send('reportBombGroundY', { bombId: vis.bombId, groundY: vis.targetY })

        if (vis.currentY <= vis.targetY) {
          vis.currentY = vis.targetY
          vis.falling = false
          vis.fallVelocity = 0
        }
      }
    }

    // Gravity
    if (vis.falling) {
      vis.fallVelocity += LOCAL_GRAVITY * clampedDt
      vis.currentY -= vis.fallVelocity * clampedDt
      if (vis.currentY <= vis.targetY) {
        vis.currentY = vis.targetY
        vis.falling = false
        vis.fallVelocity = 0
      }
    }

    const t = Transform.getMutable(vis.entity)
    t.position = Vector3.create(vis.x, vis.currentY, vis.z)

    // Blinking: accelerate blink rate as fuse runs out
    const age = now - vis.createdAtMs
    const fuseProgress = Math.min(age / (BOMB_FUSE_SEC * 1000), 1)
    // Blink interval: 800ms → 100ms as fuse runs out
    const blinkInterval = 800 - fuseProgress * 700

    if (age >= 2000 && now - vis.lastBlinkMs > blinkInterval) {
      vis.blinkOn = !vis.blinkOn
      vis.lastBlinkMs = now

      // Flash red model by toggling child visibility (no GltfContainer swap)
      setBombBlinkModel(vis.entity, vis.blinkOn)
    }

    // Update fuse flame — flicker size/position
    if (vis.flameEntity !== null && Transform.has(vis.flameEntity)) {
      try {
        const ft = Transform.getMutable(vis.flameEntity)
        const flicker = 0.8 + Math.random() * 0.4
        const baseSize = 0.15 + fuseProgress * 0.1
        const sx = baseSize * flicker
        const sy = (baseSize + 0.05) * flicker * (1 + Math.random() * 0.3)
        const sz = baseSize * flicker
        ft.scale = Vector3.create(sx, sy, sz)
        const jx = (Math.random() - 0.5) * 0.08
        const jz = (Math.random() - 0.5) * 0.08
        ft.position = Vector3.create(vis.x + jx, vis.currentY + 0.8, vis.z + jz)
      } catch { /* flame entity may have been recycled */ }
    }
  }

  // Clean up explosion VFX
  for (let i = activeExplosionVfx.length - 1; i >= 0; i--) {
    if (now >= activeExplosionVfx[i].expiresAt) {
      const e = activeExplosionVfx[i].entity
      const t = Transform.getMutable(e)
      t.position = HIDDEN_POS
      t.scale = Vector3.Zero()
      if (Tween.has(e)) Tween.deleteFrom(e)
      if (TweenSequence.has(e)) TweenSequence.deleteFrom(e)
      activeExplosionVfx.splice(i, 1)
    }
  }
}
