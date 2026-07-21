/**
 * Projectile system — orchestrator.
 * Registers message listeners, handles input (E key + UI), runs the per-frame system.
 *
 * Re-exports the public API so external files can import from here.
 */
import {
  engine, Transform, InputModifier, inputSystem, InputAction, PointerEventType,
  PlayerIdentityData
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { triggerEmote } from '~system/RestrictedActions'
import { PROJECTILE_COOLDOWN_SEC, PROJECTILE_LIFETIME_SEC } from '../../shared/components'
import { room } from '../../shared/messages'
import { playErrorSound, isServerConnected } from '../clientUtils'
import { isSpectatorMode } from '../spectatorSystem'
import { isCinematicActive } from '../../gameState/cinematicState'
import { triggerHitFlash } from '../../gameState/hitFlashState'
import { isDrownRespawning } from '../waterSystem'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { isWinsLoaded } from '../../gameState/playerUpgradeState'

import { showHitEffect, showMissEffect, playHitSound, playMissSound } from '../combatSystem'

// Sub-modules
import {
  charge, cooldown, localThrow, yellow, stagger, hand,
  localProjectiles, msgProjectileVisuals, predictedHitShellIds,
  CHARGE_TIME_SEC, CHARGE_MIN_SPEED, CHARGE_MIN_RANGE, RED_RANGE,
  PROJECTILE_STAGGER_MS, LOCAL_THROW_SAFETY_MS, YELLOW_SECOND_THROW_DELAY_MS,
  BURNOUT_FLASH_MS
} from './state'
import { playChargeSound, stopChargeSound, playReleaseSound, playReleaseSoundAt } from './sound'
import { getChargeFraction, getIsCharging, getBurnoutFlash, getChargePhase, applyChargeSlow, removeChargeSlow, chargeToSpeed, chargeToRange } from './charge'
import { updateHandBoomerangVisibility, setHandBoomerangEntity, setLeftHandBoomerangEntity } from './handVisual'
import { isOrbitActive, startOrbitVisual, endOrbitEarly, stopOrbitVisual, updateOrbitVisual } from './orbit'
import { initProjectilePool } from './pool'
import { releaseProjectileToPool } from './pool'
import { fireWallRaycast, processWallRaycasts, fireProjectileLocally, updateLocalProjectiles, createMsgProjectileVisual, removeMsgProjectileVisualByThrower, updateMsgProjectileVisuals } from './flight'
import { getPlayerForward } from './utils'

// ── Re-exports (public API) ──
export {
  getChargeFraction, getIsCharging, getBurnoutFlash, getChargePhase,
  setHandBoomerangEntity, setLeftHandBoomerangEntity,
  isOrbitActive, initProjectilePool,
}

/** Returns true if a boomerang is currently in flight (local or server-driven). */
export function isProjectileInFlight(): boolean {
  return localProjectiles.length > 0 || localThrow.active
}

/** Returns true if projectile is unavailable — either on cooldown or in flight (for UI). */
export function isProjectileOnCooldown(): boolean {
  if (isOrbitActive()) return true
  if (isProjectileInFlight()) return true
  if (cooldown.lastFireTime === 0) return false
  const cd = PROJECTILE_COOLDOWN_SEC + cooldown.extraCooldown
  return (Date.now() - cooldown.lastFireTime) < cd * 1000
}

/** Returns cooldown remaining in seconds (0 if ready). -1 if boomerang is in flight. */
export function getProjectileCooldownRemaining(): number {
  if (isOrbitActive()) return -1
  if (isProjectileInFlight()) return -1
  if (cooldown.lastFireTime === 0) return 0
  const cd = PROJECTILE_COOLDOWN_SEC + cooldown.extraCooldown
  const elapsed = Date.now() - cooldown.lastFireTime
  const remaining = cd * 1000 - elapsed
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

// ── Message listeners ──
room.onMessage('shellDropped', (data) => {
  createMsgProjectileVisual(data.x, data.y, data.z, data.dirX, data.dirZ, data.color, data.firedBy, data.chargeSpeed, data.chargeRange, data.chargeScale, data.shellId)
  const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
  const throwerId = (data.firedBy || '').toLowerCase()
  if (throwerId && throwerId !== localUserId && data.color === 'b' && data.chargeSpeed >= 55) {
    playReleaseSoundAt(Vector3.create(data.x, data.y, data.z))
  }
})

/**
 * The sender's own position, attached to requestShell so the server spawns the
 * projectile where the shooter actually IS — its replicated view can lag several
 * meters under load, making boomerangs fly from the shooter's OLD position.
 * (0,0,0) when the Transform isn't ready; the server treats that as absent.
 */
function myFirePositionPayload(): { x: number; y: number; z: number } {
  if (!Transform.has(engine.PlayerEntity)) return { x: 0, y: 0, z: 0 }
  const p = Transform.get(engine.PlayerEntity).position
  return { x: p.x, y: p.y, z: p.z }
}

room.onMessage('shellTriggered', (data) => {
  const pos = Vector3.create(data.x, data.y, data.z)
  removeMsgProjectileVisualByThrower(data.firedBy || '', data.x, data.y, data.z, !!data.peak, data.shellId || 0)
  // Dedup: if client-side prediction already showed hit VFX for this shell, skip VFX
  const alreadyPredicted = (data.shellId && data.shellId > 0) ? predictedHitShellIds.delete(data.shellId) : false
  if (data.victimId && data.victimId !== '') {
    if (!alreadyPredicted) {
      showHitEffect(pos)
      playHitSound(pos)
    }
    const me = getPlayerData()?.userId?.toLowerCase()
    if (me && data.victimId === me && !isCinematicActive()) {
      triggerHitFlash(PROJECTILE_STAGGER_MS)
      triggerEmote({ predefinedEmote: 'getHit' })
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: true, disableGliding: true, disableDoubleJump: true })
      })
      stagger.until = Date.now() + PROJECTILE_STAGGER_MS
    }
  } else if (!data.peak) {
    showMissEffect(pos)
    const playerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : pos
    playMissSound(playerPos)
  }
})

room.onMessage('shellReturned', (data) => {
  const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
  const playerId = (data.firedBy || '').toLowerCase()
  if (!playerId) return
  const shellId = data.shellId || 0
  // Find the matching visual by exact shellId
  let bestIdx = -1
  if (shellId > 0) {
    for (let i = 0; i < msgProjectileVisuals.length; i++) {
      if (msgProjectileVisuals[i].shellId === shellId) { bestIdx = i; break }
    }
    // If shellId was provided but not found, the visual was already cleaned up
    // client-side (dist < 2.0 check). Do NOT fall through to legacy matching
    // or we'll accidentally kill a different projectile (e.g. yellow's 2nd throw).
    if (bestIdx === -1) {
    }
  }

  // Legacy fallback: only for messages without shellId (shouldn't happen anymore)
  if (bestIdx === -1 && shellId === 0) {
    let bestScore = Infinity
    for (let i = 0; i < msgProjectileVisuals.length; i++) {
      if (msgProjectileVisuals[i].firedBy !== playerId) continue
      const vis = msgProjectileVisuals[i]
      const returningBonus = vis.returning ? 0 : 10000
      const pos = Transform.get(vis.entity).position
      let dist = 0
      if (vis.returning) {
        const playerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : Vector3.create(vis.startX, vis.startY, vis.startZ)
        const dx = pos.x - playerPos.x, dy = pos.y - playerPos.y, dz = pos.z - playerPos.z
        dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      } else {
        dist = vis.distanceTraveled
      }
      const score = returningBonus + dist
      if (score < bestScore) { bestScore = score; bestIdx = i }
    }
  }

  if (bestIdx !== -1) {
    const vis = msgProjectileVisuals[bestIdx]
    const age = Date.now() - vis.createdAtMs
    const pos = Transform.get(vis.entity).position
    const playerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : Vector3.create(vis.startX, vis.startY, vis.startZ)
    const dx = pos.x - playerPos.x, dy = pos.y - playerPos.y, dz = pos.z - playerPos.z
    const distToPlayer = Math.sqrt(dx * dx + dy * dy + dz * dz)

    // If the visual is young and still far away, let it fly back naturally
    // instead of popping it out of existence
    if (distToPlayer > 3.0 && !vis.returning && age < 3000) {
      vis.returning = true
      vis.returnDistance = 0

    } else if (distToPlayer < 3.0 || vis.returning) {
      if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity!)
      releaseProjectileToPool(vis.entity)
      msgProjectileVisuals.splice(bestIdx, 1)
    } else {
      vis.returning = true
      vis.returnDistance = 0
    }
  }

  // Only clear localThrow when NO visuals remain for this player
  if (playerId === localUserId && localThrow.active && !isOrbitActive()) {
    const hasRemaining = msgProjectileVisuals.some(v => v.firedBy === playerId)
    if (!hasRemaining) {
      console.log('[Projectile] ✅ shellReturned for local player — all projectiles returned, clearing localThrowActive')
      localThrow.active = false
      localThrow.sawVisual = false
      localThrow.startMs = 0
      cooldown.lastFireTime = Date.now()
      updateHandBoomerangVisibility()
    } else {
      console.log('[Projectile] ✅ shellReturned for local player — one returned, but others still in flight')
    }
  }
})

room.onMessage('shellDenied', (data) => {
  console.log('[Projectile] ⚠️ Server denied throw:', data.reason)
  // The server did not spawn a projectile — recover the local throw state so
  // the player isn't stuck behind a phantom in-flight boomerang.
  localThrow.active = false
  localThrow.sawVisual = false
  localThrow.startMs = 0
  if (data.reason !== 'cooldown') {
    cooldown.lastFireTime = 0
    cooldown.extraCooldown = 0
  }
  updateHandBoomerangVisibility()
})

room.onMessage('orbitStarted', (data) => {
  const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
  const playerId = data.playerId?.toLowerCase() || ''
  if (playerId === localUserId) {
    startOrbitVisual()
  }
})

room.onMessage('orbitHit', (data) => {
  const pos = Vector3.create(data.x, data.y, data.z)
  showHitEffect(pos)
  playHitSound(pos)
  const me = getPlayerData()?.userId?.toLowerCase()
  if (me && data.victimId === me && !isCinematicActive()) {
    triggerHitFlash(PROJECTILE_STAGGER_MS)
    triggerEmote({ predefinedEmote: 'getHit' })
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({ disableAll: true, disableGliding: true, disableDoubleJump: true })
    })
    stagger.until = Date.now() + PROJECTILE_STAGGER_MS
  }
})

room.onMessage('orbitEnded', (data) => {
  const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
  const playerId = data.playerId?.toLowerCase() || ''
  if (playerId === localUserId) {
    endOrbitEarly()
  }
})

// ── UI triggers (mobile) ──

/** Fire a projectile from the UI (mobile tap). For blue: starts charging on press. */
export function triggerProjectileFromUI(): void {
  // Match the keyboard path's guards so mobile can't throw during the round-end
  // cinematic or while spectating.
  if (isCinematicActive() || isSpectatorMode()) return
  if (isDrownRespawning()) return
  if (!isWinsLoaded() && isServerConnected()) return  // Block firing until profile loaded (skip if no server)
  const now = Date.now()
  const userId = getPlayerData()?.userId
  if (!userId) return

  if (now - cooldown.lastFireTime < (PROJECTILE_COOLDOWN_SEC + cooldown.extraCooldown) * 1000) { playErrorSound(); return }
  if (localThrow.active || localProjectiles.length > 0) return

  const uiColor = getBoomerangColor()

  // Blue: start charging on press
  if (uiColor === 'b') {
    if (charge.isCharging) return
    // Don't start a charge while staggered — starting/releasing a charge deletes
    // the shared InputModifier mid-stun, letting the player escape the stun.
    if (now < stagger.until) return
    if (Transform.has(engine.PlayerEntity)) {
      const playerY = Transform.get(engine.PlayerEntity).position.y
      if (Math.abs(playerY - charge.lastGroundY) > 0.15) {
        charge.lastGroundY = playerY
        return
      }
      charge.lastGroundY = playerY
    }
    charge.startMs = now
    charge.isCharging = true
    playChargeSound()
    applyChargeSlow()
    room.send('chargeStart', { t: now })
    console.log('[Projectile] ⚡ UI press — charging started (blue)')
    return
  }

  cooldown.lastFireTime = now

  // Green: orbit mechanic
  if (uiColor === 'g') {
    if (isOrbitActive()) return
    cooldown.extraCooldown = 4
    const { dirX: oaDirX, dirZ: oaDirZ } = getPlayerForward()
    const uiOrbitAngle = Math.atan2(oaDirX, oaDirZ) * (180 / Math.PI)
    const serverUp = isServerConnected()
    if (serverUp) {
      localThrow.active = true; localThrow.sawVisual = false; localThrow.startMs = Date.now()
      updateHandBoomerangVisibility()
      room.send('requestOrbit', { t: now, startAngle: uiOrbitAngle })
    } else {
      startOrbitVisual()
    }
    console.log('[Projectile] 🌀 UI tap — green orbit requested')
    return
  }

  cooldown.extraCooldown = uiColor === 'y' ? 2 : 1
  const { dirX, dirZ } = getPlayerForward()
  const serverUp = isServerConnected()

  if (serverUp) {
    console.log('[Projectile] 🎯 UI tap — requesting projectile fire (server)')
    localThrow.active = true; localThrow.sawVisual = false; localThrow.startMs = Date.now()
    updateHandBoomerangVisibility()
    const uiRange = uiColor === 'r' ? RED_RANGE : CHARGE_MIN_RANGE
    room.send('requestShell', { dirX, dirZ, color: uiColor, chargeSpeed: CHARGE_MIN_SPEED, chargeRange: uiRange, chargeScale: 1 , ...myFirePositionPayload() })
    if (Transform.has(engine.PlayerEntity)) {
      const playerPos = Transform.get(engine.PlayerEntity).position
      const spawnPos = Vector3.create(playerPos.x + dirX * 1.0, playerPos.y + 0.8, playerPos.z + dirZ * 1.0)
      fireWallRaycast(spawnPos, dirX, dirZ)
    }
  } else {
    console.log('[Projectile] 🎯 UI tap — firing projectile locally (no server)')
    localThrow.active = true; localThrow.sawVisual = false; localThrow.startMs = Date.now()
    updateHandBoomerangVisibility()
    fireProjectileLocally()
  }

  if (getBoomerangColor() === 'y') {
    yellow.secondThrowAt = now + YELLOW_SECOND_THROW_DELAY_MS
    yellow.secondThrowDir = { dirX, dirZ }
  }
}

/** Release charge from UI (mobile). Fires the blue boomerang with accumulated charge. */
export function triggerProjectileReleaseFromUI(): void {
  if (!charge.isCharging) return
  const now = Date.now()
  charge.isCharging = false
  stopChargeSound()
  removeChargeSlow()
  room.send('chargeStop', { t: now })
  const chargeFrac = Math.min(1, (now - charge.startMs) / 1000 / CHARGE_TIME_SEC)
  const chargeSpeed = chargeToSpeed(chargeFrac)
  const chargeRange = chargeToRange(chargeFrac)
  charge.startMs = 0
  cooldown.lastFireTime = now
  const chargeElapsed = chargeFrac * CHARGE_TIME_SEC
  cooldown.extraCooldown = chargeElapsed >= 1 ? 2 : 1

  const { dirX, dirZ } = getPlayerForward()
  const serverUp = isServerConnected()
  if (serverUp) {
    localThrow.active = true; localThrow.sawVisual = false; localThrow.startMs = Date.now()
    updateHandBoomerangVisibility()
    room.send('requestShell', { dirX, dirZ, color: 'b', chargeSpeed, chargeRange, chargeScale: 1 , ...myFirePositionPayload() })
    if (Transform.has(engine.PlayerEntity)) {
      const playerPos = Transform.get(engine.PlayerEntity).position
      const spawnPos = Vector3.create(playerPos.x + dirX * 1.0, playerPos.y + 0.8, playerPos.z + dirZ * 1.0)
      fireWallRaycast(spawnPos, dirX, dirZ)
    }
  } else {
    localThrow.active = true; localThrow.sawVisual = false; localThrow.startMs = Date.now()
    updateHandBoomerangVisibility()
    fireProjectileLocally(chargeSpeed, chargeRange)
  }
  console.log(`[Projectile] ⚡ UI release — blue fired with charge ${(chargeFrac * 100).toFixed(0)}%`)
}

// ── Main client system ──
export function projectileClientSystem(dt: number): void {
  updateHandBoomerangVisibility()
  const now = Date.now()

  if (!charge.isCharging && Transform.has(engine.PlayerEntity)) {
    charge.lastGroundY = Transform.get(engine.PlayerEntity).position.y
  }
  const serverUp = isServerConnected()

  if (isCinematicActive()) {
    stagger.until = 0
  }

  // Release stagger freeze
  if (stagger.until > 0 && now >= stagger.until) {
    stagger.until = 0
    if (!isSpectatorMode() && InputModifier.has(engine.PlayerEntity)) {
      InputModifier.deleteFrom(engine.PlayerEntity)
    }
  }

  if (serverUp) {
    processWallRaycasts()
    updateMsgProjectileVisuals(dt)

    // Clear local throw flag when projectile visual has appeared and then gone
    if (localThrow.active && !isOrbitActive()) {
      const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
      const hasLocalVisual = msgProjectileVisuals.some(v => v.firedBy === localUserId)
      if (hasLocalVisual) {
        localThrow.sawVisual = true
      } else if (localThrow.sawVisual) {
        localThrow.active = false
        localThrow.sawVisual = false
        localThrow.startMs = 0
        cooldown.lastFireTime = now
      } else if (localThrow.startMs > 0 && now - localThrow.startMs > PROJECTILE_LIFETIME_SEC * 1000) {
        console.log('[Projectile] ⚠️ localThrowActive stuck for', ((now - localThrow.startMs) / 1000).toFixed(1), 's (lifetime exceeded) — force-clearing')
        localThrow.active = false
        localThrow.sawVisual = false
        localThrow.startMs = 0
        cooldown.lastFireTime = now
      } else if (localThrow.startMs > 0 && now - localThrow.startMs > LOCAL_THROW_SAFETY_MS) {
        console.log('[Projectile] ⚠️ localThrowActive stuck for', ((now - localThrow.startMs) / 1000).toFixed(1), 's with no visual — force-clearing')
        localThrow.active = false
        localThrow.sawVisual = false
        localThrow.startMs = 0
        cooldown.lastFireTime = now
      }
    }
  } else {
    updateLocalProjectiles(dt)
  }

  updateOrbitVisual(dt)

  // Yellow double-throw
  if (yellow.secondThrowAt > 0 && now >= yellow.secondThrowAt) {
    yellow.secondThrowAt = 0
    if (serverUp) {
      room.send('requestShell', { dirX: yellow.secondThrowDir.dirX, dirZ: yellow.secondThrowDir.dirZ, color: 'y', chargeSpeed: CHARGE_MIN_SPEED, chargeRange: CHARGE_MIN_RANGE, chargeScale: 1 , ...myFirePositionPayload() })
      if (Transform.has(engine.PlayerEntity)) {
        const playerPos = Transform.get(engine.PlayerEntity).position
        const spawnPos = Vector3.create(playerPos.x + yellow.secondThrowDir.dirX * 1.0, playerPos.y + 0.8, playerPos.z + yellow.secondThrowDir.dirZ * 1.0)
        fireWallRaycast(spawnPos, yellow.secondThrowDir.dirX, yellow.secondThrowDir.dirZ)
      }
    } else {
      fireProjectileLocally(CHARGE_MIN_SPEED, CHARGE_MIN_RANGE)
    }
    if (hand.leftEntity && Transform.has(hand.leftEntity)) {
      Transform.getMutable(hand.leftEntity).scale = Vector3.Zero()
    }
    console.log('[Projectile] 🎯 Yellow 2nd throw fired')
  }

  // Projectile key — charge on press (blue only), instant fire for other colors
  const projAction = InputAction.IA_PRIMARY
  if (inputSystem.isTriggered(projAction, PointerEventType.PET_DOWN) && !isSpectatorMode() && !isCinematicActive() && !isDrownRespawning() && (isWinsLoaded() || !isServerConnected())) {
    const userId = getPlayerData()?.userId
    if (!userId) return

    const projectileCd = PROJECTILE_COOLDOWN_SEC + cooldown.extraCooldown
    if (now - cooldown.lastFireTime < projectileCd * 1000) {
      const remaining = ((projectileCd * 1000 - (now - cooldown.lastFireTime)) / 1000).toFixed(1)
      console.log('[Projectile] E pressed but cooldown active —', remaining, 's remaining')
      playErrorSound()
      return
    }

    if (localThrow.active || localProjectiles.length > 0) return

    const currentColor = getBoomerangColor()

    // Green: orbit
    if (currentColor === 'g') {
      if (isOrbitActive()) return
      cooldown.lastFireTime = now
      cooldown.extraCooldown = 4
      const { dirX: eaDirX, dirZ: eaDirZ } = getPlayerForward()
      const eOrbitAngle = Math.atan2(eaDirX, eaDirZ) * (180 / Math.PI)
      if (serverUp) {
        localThrow.active = true; localThrow.sawVisual = false; localThrow.startMs = Date.now()
        updateHandBoomerangVisibility()
        room.send('requestOrbit', { t: now, startAngle: eOrbitAngle })
      } else {
        startOrbitVisual()
      }
      console.log('[Projectile] 🌀 Green orbit requested')
      return
    }

    // Red/Yellow: instant throw
    if (currentColor !== 'b') {
      cooldown.lastFireTime = now
      cooldown.extraCooldown = currentColor === 'y' ? 2 : 1
      const { dirX, dirZ } = getPlayerForward()
      const range = currentColor === 'r' ? RED_RANGE : CHARGE_MIN_RANGE
      const speed = CHARGE_MIN_SPEED
      if (serverUp) {
        localThrow.active = true; localThrow.sawVisual = false; localThrow.startMs = Date.now()
        updateHandBoomerangVisibility()
        room.send('requestShell', { dirX, dirZ, color: currentColor, chargeSpeed: speed, chargeRange: range, chargeScale: 1 , ...myFirePositionPayload() })
        if (Transform.has(engine.PlayerEntity)) {
          const playerPos = Transform.get(engine.PlayerEntity).position
          const spawnPos = Vector3.create(playerPos.x + dirX * 1.0, playerPos.y + 0.8, playerPos.z + dirZ * 1.0)
          fireWallRaycast(spawnPos, dirX, dirZ)
        }
      } else {
        localThrow.active = true; localThrow.sawVisual = false; localThrow.startMs = Date.now()
        updateHandBoomerangVisibility()
        fireProjectileLocally(speed, range)
      }
      if (currentColor === 'y') {
        yellow.secondThrowAt = now + YELLOW_SECOND_THROW_DELAY_MS
        yellow.secondThrowDir = { dirX, dirZ }
      }
      console.log('[Projectile] 🎯 Instant throw (non-charge color)')
      return
    }

    // Don't start a charge while staggered — starting/releasing a charge deletes
    // the shared InputModifier mid-stun, letting the player escape the stun.
    if (now < stagger.until) return

    // Blue: block charging while airborne
    if (Transform.has(engine.PlayerEntity)) {
      const playerY = Transform.get(engine.PlayerEntity).position.y
      if (Math.abs(playerY - charge.lastGroundY) > 0.15) {
        charge.lastGroundY = playerY
        return
      }
      charge.lastGroundY = playerY
    }

    // Start charging (blue)
    charge.startMs = now
    charge.isCharging = true
    playChargeSound()
    applyChargeSlow()
    room.send('chargeStart', { t: now })
    console.log('[Projectile] ⚡ E pressed — charging started (blue)')
  }

  // Cancel charge if player enters spectator/cinematic/drown
  if (charge.isCharging && (isSpectatorMode() || isCinematicActive() || isDrownRespawning())) {
    charge.isCharging = false
    charge.startMs = 0
    stopChargeSound()
    removeChargeSlow()
    room.send('chargeStop', { t: now })
    console.log('[Projectile] ⚡ Charge cancelled (state change)')
  }

  // Burnout — held too long
  if (charge.isCharging && charge.startMs > 0 && (now - charge.startMs) / 1000 >= CHARGE_TIME_SEC) {
    charge.isCharging = false
    charge.startMs = 0
    cooldown.lastFireTime = now
    stopChargeSound()
    removeChargeSlow()
    room.send('chargeStop', { t: now })
    charge.burnoutFlashUntil = Date.now() + BURNOUT_FLASH_MS
    console.log('[Projectile] 💥 BURNOUT — held too long, self-stun!')
    triggerHitFlash(PROJECTILE_STAGGER_MS)
    if (isServerConnected()) {
      room.send('requestDrop', { t: 0 })
    }
    triggerEmote({ predefinedEmote: 'getHit' })
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({ disableAll: true, disableGliding: true, disableDoubleJump: true })
    })
    stagger.until = now + PROJECTILE_STAGGER_MS
    if (Transform.has(engine.PlayerEntity)) {
      const pos = Transform.get(engine.PlayerEntity).position
      room.send('chargeBurnout', { x: pos.x, y: pos.y, z: pos.z })
    }
  }

  // Projectile key released — fire with charged size
  if (inputSystem.isTriggered(projAction, PointerEventType.PET_UP) && charge.isCharging) {
    charge.isCharging = false
    stopChargeSound()
    removeChargeSlow()
    room.send('chargeStop', { t: now })
    const chargeFrac = Math.min(1, (now - charge.startMs) / 1000 / CHARGE_TIME_SEC)
    const currentColor = getBoomerangColor()

    const chargeSpeed = currentColor === 'b' ? chargeToSpeed(chargeFrac) : CHARGE_MIN_SPEED
    const chargeRange = currentColor === 'b' ? chargeToRange(chargeFrac) : CHARGE_MIN_RANGE
    const chargeScale = 1

    charge.startMs = 0
    cooldown.lastFireTime = now
    const chargeElapsed = chargeFrac * CHARGE_TIME_SEC
    cooldown.extraCooldown = chargeElapsed >= 1.0 ? 2 : 1

    console.log('[Projectile] 🎯 E released — charge:', (chargeFrac * 100).toFixed(0) + '%, speed:', chargeSpeed.toFixed(0), 'range:', chargeRange.toFixed(0), 'scale:', chargeScale.toFixed(1), 'extraCD:', cooldown.extraCooldown)
    if (chargeElapsed >= 1.25) playReleaseSound()

    const { dirX, dirZ } = getPlayerForward()

    if (serverUp) {
      localThrow.active = true; localThrow.sawVisual = false; localThrow.startMs = Date.now()
      updateHandBoomerangVisibility()
      room.send('requestShell', { dirX, dirZ, color: currentColor, chargeSpeed, chargeRange, chargeScale , ...myFirePositionPayload() })
      if (Transform.has(engine.PlayerEntity)) {
        const playerPos = Transform.get(engine.PlayerEntity).position
        const spawnPos = Vector3.create(playerPos.x + dirX * 1.0, playerPos.y + 0.8, playerPos.z + dirZ * 1.0)
        fireWallRaycast(spawnPos, dirX, dirZ)
      }
    } else {
      localThrow.active = true; localThrow.sawVisual = false; localThrow.startMs = Date.now()
      updateHandBoomerangVisibility()
      fireProjectileLocally(chargeSpeed, chargeRange)
    }
  }
}
