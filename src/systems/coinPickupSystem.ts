/**
 * Coin Pickup System (Client)
 * 
 * Detects player proximity to coin entities, sends pickup requests to the server,
 * and hides/shows coins based on the synced CoinState cooldown data.
 * 
 * Coin IDs are derived from their world position (deterministic, no registration needed).
 */
import {
  engine, Transform, GltfContainer, VisibilityComponent, Entity, AudioSource,
  Tween, TweenSequence, TweenLoop, EasingFunction, AvatarAttach, AvatarAnchorPointType
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { CoinState, COIN_PICKUP_RADIUS } from '../shared/coins'
import { room } from '../shared/messages'
import { setPendingRoundEarnings } from '../gameState/roundEarnings'


// ── Types ──

interface TrackedCoin {
  /** The bob-parent entity (has the world position) */
  bobParent: Entity
  /** The coin entity itself (has GltfContainer + visibility) */
  coinEntity: Entity
  /** Deterministic ID based on position */
  coinId: string
  /** World position of the coin */
  position: { x: number; y: number; z: number }
  /** Whether currently hidden (on cooldown) */
  hidden: boolean
}

// ── Pickup sound ──

let coinSoundEntity: Entity | null = null

function playCoinSound(): void {
  if (!coinSoundEntity) {
    coinSoundEntity = engine.addEntity()
    Transform.create(coinSoundEntity, { position: Vector3.Zero() })
  }
  AudioSource.createOrReplace(coinSoundEntity, {
    audioClipUrl: 'assets/sounds/coin.mp3',
    playing: true,
    loop: false,
    volume: 0.7,
    global: true,
  })
}

// ── Head bounce state ──
interface HeadBounce {
  entity: Entity
  timer: number
}
const activeHeadBounces: HeadBounce[] = []
const HEAD_BOUNCE_DURATION = 0.7 // seconds

function spawnHeadBounceCoin(playerId: string): void {
  const headAnchor = engine.addEntity()
  AvatarAttach.create(headAnchor, {
    avatarId: playerId,
    anchorPointId: AvatarAnchorPointType.AAPT_HEAD,
  })

  const coinClone = engine.addEntity()
  Transform.create(coinClone, {
    parent: headAnchor,
    position: Vector3.create(0, 0.5, 0),
    scale: Vector3.create(10, 10, 10),
    rotation: Quaternion.fromEulerDegrees(90, 0, 0),
  })
  GltfContainer.create(coinClone, {
    src: 'assets/asset-packs/doubloon/Coin_01/Coin_01.glb',
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0,
  })

  // Pop up fast then fall + shrink away
  Tween.create(coinClone, {
    mode: Tween.Mode.Move({
      start: Vector3.create(0, 0.5, 0),
      end: Vector3.create(0, 2.0, 0),
    }),
    duration: 200,
    easingFunction: EasingFunction.EF_EASEOUTQUAD,
  })
  TweenSequence.create(coinClone, {
    sequence: [
      {
        mode: Tween.Mode.Move({
          start: Vector3.create(0, 2.0, 0),
          end: Vector3.create(0, 0.8, 0),
        }),
        duration: 350,
        easingFunction: EasingFunction.EF_EASEINQUAD,
      },
    ],
    loop: TweenLoop.TL_YOYO,
  })

  // Shrink on a separate parent so both run simultaneously
  // Use a delay by starting full scale, holding, then shrinking
  const shrinkParent = engine.addEntity()
  Transform.create(shrinkParent, {
    parent: headAnchor,
    position: Vector3.Zero(),
    scale: Vector3.One(),
  })
  // Re-parent coin under shrink parent
  Transform.getMutable(coinClone).parent = shrinkParent

  // Hold full size during pop-up (200ms), then shrink during fall (350ms)
  Tween.create(shrinkParent, {
    mode: Tween.Mode.Scale({
      start: Vector3.One(),
      end: Vector3.One(),
    }),
    duration: 200,
    easingFunction: EasingFunction.EF_LINEAR,
  })
  TweenSequence.create(shrinkParent, {
    sequence: [
      {
        mode: Tween.Mode.Scale({
          start: Vector3.One(),
          end: Vector3.create(0, 0, 0),
        }),
        duration: 350,
        easingFunction: EasingFunction.EF_EASEINQUAD,
      },
    ],
    loop: TweenLoop.TL_YOYO,
  })

  const totalDuration = 0.6
  activeHeadBounces.push({ entity: coinClone, timer: totalDuration })
  activeHeadBounces.push({ entity: shrinkParent, timer: totalDuration + 0.05 })
  // Also clean up anchor after
  activeHeadBounces.push({ entity: headAnchor, timer: HEAD_BOUNCE_DURATION + 0.1 })
}

// ── State ──

const trackedCoins: TrackedCoin[] = []
let setupDone = false
let waitTimer = 0
let localPickupCooldowns = new Set<string>() // prevent spamming requests
let walletBalance = 0
let balanceRequested = false
let balanceReceived = false
let balanceRetryTimer = 0
const BALANCE_RETRY_INTERVAL = 2 // seconds
const BALANCE_MAX_RETRIES = 5
let balanceRetryCount = 0

/** Get the current coin balance for UI display */
export function getCoinBalance(): number {
  return walletBalance
}

/** Apply deferred round-end balance (called when coin animation triggers) */
export function applyDeferredBalance(newBalance: number): void {
  walletBalance = newBalance
}

/** Generate a deterministic coin ID from position */
function coinIdFromPosition(x: number, y: number, z: number): string {
  // Round to 1 decimal to handle floating point, gives unique ID per placed coin
  return `coin_${Math.round(x * 10)}_${Math.round(y * 10)}_${Math.round(z * 10)}`
}

// ── Setup: find coins after composites load ──

function setupCoins(): void {
  let count = 0
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    const gltf = GltfContainer.get(entity)
    const src = gltf.src.toLowerCase()
    if (!src.includes('coin_01') && !src.includes('doubloon')) continue

    const t = Transform.get(entity)

    // After coinBobSpinSystem runs, the coin is parented to a bobParent.
    // The bobParent has the world position. The coin entity is at local (0,0,0).
    // We need the bobParent's position for proximity checks.
    const parent = t.parent
    if (parent && Transform.has(parent)) {
      const parentT = Transform.get(parent)
      const pos = { x: parentT.position.x, y: parentT.position.y, z: parentT.position.z }
      const coinId = coinIdFromPosition(pos.x, pos.y, pos.z)

      trackedCoins.push({
        bobParent: parent,
        coinEntity: entity,
        coinId,
        position: pos,
        hidden: false
      })
      count++
    } else {
      // No parent — coin hasn't been processed by bobSpinSystem yet, use own position
      const pos = { x: t.position.x, y: t.position.y, z: t.position.z }
      const coinId = coinIdFromPosition(pos.x, pos.y, pos.z)

      trackedCoins.push({
        bobParent: entity,
        coinEntity: entity,
        coinId,
        position: pos,
        hidden: false
      })
      count++
    }
  }
  console.log(`[CoinPickup] Tracking ${count} coins`)
}

// ── Message handlers ──

export function setupCoinMessages(): void {
  // Server confirmed a coin was picked up (broadcast to all)
  room.onMessage('coinPickedUp', (data) => {
    const coinId = data.coinId
    localPickupCooldowns.delete(coinId) // clear local spam guard

    // Immediately hide the coin
    const coin = trackedCoins.find(c => c.coinId === coinId)
    if (coin && !coin.hidden) {
      coin.hidden = true
      setCoinVisible(coin, false)
    }

    // Head bounce on the picker's avatar
    spawnHeadBounceCoin(data.playerId)

    // Check if this pickup was by us
    const player = getPlayer()
    if (player && data.playerId === player.userId.toLowerCase()) {
      walletBalance = data.newBalance
      playCoinSound()
      console.log('[CoinPickup] You picked up a coin! Balance:', walletBalance)
    }
  })

  // Coin respawned
  room.onMessage('coinRespawned', (data) => {
    const coinId = data.coinId
    localPickupCooldowns.delete(coinId)
    // Visibility will be updated in the system based on CoinState
  })

  // Wallet balance response (on join)
  room.onMessage('walletBalance', (data) => {
    // Only accept balance updates meant for us
    const player = getPlayer()
    if (!player) return
    if (data.playerId && data.playerId !== player.userId.toLowerCase()) return
    walletBalance = data.coins
    balanceReceived = true
    console.log('[CoinPickup] Wallet balance loaded:', walletBalance)
  })

  // Request balance + upgrades immediately on connect (don't wait for coin setup)
  room.send('requestWalletBalance', { t: 0 })
  room.send('requestUpgrades', { t: 0 })
  balanceRequested = true

  // Round-end coin earnings breakdown (personalized)
  room.onMessage('roundCoinsEarned', (data) => {
    const player = getPlayer()
    if (!player) return
    if (data.playerId !== player.userId.toLowerCase()) return
    // Don't update walletBalance yet — defer until coin animation plays
    setPendingRoundEarnings({
      total: data.total,
      participation: data.participation,
      holdTime: data.holdTime,
      placement: data.placement,
      rank: data.rank,
      newBalance: data.newBalance
    })
    console.log('[CoinPickup] Round earnings received:', data.total, 'coins (deferred until animation)')
  })
}

// ── System ──

export function coinPickupSystem(dt: number): void {
  // Wait for composites + bobSpinSystem to set up (needs to run after bobSpinSystem's 3s wait)
  // Retry wallet balance request if we haven't received it yet
  if (balanceRequested && !balanceReceived && balanceRetryCount < BALANCE_MAX_RETRIES) {
    balanceRetryTimer += dt
    if (balanceRetryTimer >= BALANCE_RETRY_INTERVAL) {
      balanceRetryTimer = 0
      balanceRetryCount++
      room.send('requestWalletBalance', { t: balanceRetryCount })
      console.log('[CoinPickup] Retrying wallet balance request, attempt', balanceRetryCount)
    }
  }

  if (!setupDone) {
    waitTimer += dt
    if (waitTimer < 4) return // 4s: after bobSpinSystem's 3s setup
    if (trackedCoins.length === 0) {
      setupCoins()
      if (trackedCoins.length === 0 && waitTimer < 10) return // retry until 10s
    }
    setupDone = true
  }



  if (trackedCoins.length === 0) return

  // Tick head bounces — clean up expired
  for (let i = activeHeadBounces.length - 1; i >= 0; i--) {
    activeHeadBounces[i].timer -= dt
    if (activeHeadBounces[i].timer <= 0) {
      engine.removeEntity(activeHeadBounces[i].entity)
      activeHeadBounces.splice(i, 1)
    }
  }

  // Read synced coin state to determine which coins are on cooldown
  const cooldowns = getCooldownMap()

  // Get player position
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position

  // Update visibility & check proximity
  for (const coin of trackedCoins) {
    const onCooldown = cooldowns.has(coin.coinId)

    // Respawn: coin is no longer on cooldown, restore visibility + bob/spin
    if (!onCooldown && coin.hidden) {
      coin.hidden = false
      setCoinVisible(coin, true)
      restoreBobSpin(coin)
    }

    // Skip proximity check if on cooldown, animating, or we already sent a request
    if (onCooldown || coin.hidden || localPickupCooldowns.has(coin.coinId)) continue

    // Check proximity
    const dx = playerPos.x - coin.position.x
    const dy = playerPos.y - coin.position.y
    const dz = playerPos.z - coin.position.z
    const distSq = dx * dx + dy * dy + dz * dz

    if (distSq <= COIN_PICKUP_RADIUS * COIN_PICKUP_RADIUS) {
      // Request pickup from server
      localPickupCooldowns.add(coin.coinId)
      room.send('requestCoinPickup', { coinId: coin.coinId })
      console.log('[CoinPickup] Requesting pickup:', coin.coinId)
    }
  }
}

// ── Helpers ──

function getCooldownMap(): Set<string> {
  const result = new Set<string>()
  for (const [_entity] of engine.getEntitiesWith(CoinState)) {
    const state = CoinState.get(_entity)
    try {
      const obj = JSON.parse(state.cooldownJson) as Record<string, number>
      for (const coinId of Object.keys(obj)) {
        result.add(coinId)
      }
    } catch { }
  }
  return result
}

function restoreBobSpin(coin: TrackedCoin): void {
  const BOB_AMOUNT = 0.15
  const BOB_DURATION = 1500
  const SPIN_DURATION = 2000

  // Restore bob on parent
  const t = Transform.get(coin.bobParent)
  const baseY = t.position.y
  const upPos = Vector3.create(t.position.x, baseY + BOB_AMOUNT, t.position.z)
  const downPos = Vector3.create(t.position.x, baseY - BOB_AMOUNT, t.position.z)

  if (Tween.has(coin.bobParent)) Tween.deleteFrom(coin.bobParent)
  if (TweenSequence.has(coin.bobParent)) TweenSequence.deleteFrom(coin.bobParent)

  Tween.create(coin.bobParent, {
    mode: Tween.Mode.Move({ start: downPos, end: upPos }),
    duration: BOB_DURATION,
    easingFunction: EasingFunction.EF_EASESINE,
  })
  TweenSequence.create(coin.bobParent, {
    sequence: [{ mode: Tween.Mode.Move({ start: upPos, end: downPos }), duration: BOB_DURATION, easingFunction: EasingFunction.EF_EASESINE }],
    loop: TweenLoop.TL_YOYO,
  })

  // Restore spin on coin — must match the original composite rotation (90° X)
  // Reset to original rotation first
  Transform.getMutable(coin.coinEntity).rotation = Quaternion.fromEulerDegrees(90, 0, 0)
  const rot0 = Quaternion.fromEulerDegrees(90, 0, 0)
  const rot90 = Quaternion.multiply(rot0, Quaternion.fromEulerDegrees(0, 0, 90))
  const rot180 = Quaternion.multiply(rot0, Quaternion.fromEulerDegrees(0, 0, 180))
  const rot270 = Quaternion.multiply(rot0, Quaternion.fromEulerDegrees(0, 0, 270))
  const quarterDuration = SPIN_DURATION / 4

  if (Tween.has(coin.coinEntity)) Tween.deleteFrom(coin.coinEntity)
  if (TweenSequence.has(coin.coinEntity)) TweenSequence.deleteFrom(coin.coinEntity)

  Tween.create(coin.coinEntity, {
    mode: Tween.Mode.Rotate({ start: rot0, end: rot90 }),
    duration: quarterDuration,
    easingFunction: EasingFunction.EF_LINEAR,
  })
  TweenSequence.create(coin.coinEntity, {
    sequence: [
      { mode: Tween.Mode.Rotate({ start: rot90, end: rot180 }), duration: quarterDuration, easingFunction: EasingFunction.EF_LINEAR },
      { mode: Tween.Mode.Rotate({ start: rot180, end: rot270 }), duration: quarterDuration, easingFunction: EasingFunction.EF_LINEAR },
      { mode: Tween.Mode.Rotate({ start: rot270, end: rot0 }), duration: quarterDuration, easingFunction: EasingFunction.EF_LINEAR },
    ],
    loop: TweenLoop.TL_RESTART,
  })
}

function setCoinVisible(coin: TrackedCoin, visible: boolean): void {
  // Hide/show both the coin entity and its bob parent
  if (VisibilityComponent.has(coin.coinEntity)) {
    VisibilityComponent.getMutable(coin.coinEntity).visible = visible
  } else {
    VisibilityComponent.create(coin.coinEntity, { visible })
  }

  if (coin.bobParent !== coin.coinEntity) {
    if (VisibilityComponent.has(coin.bobParent)) {
      VisibilityComponent.getMutable(coin.bobParent).visible = visible
    } else {
      VisibilityComponent.create(coin.bobParent, { visible })
    }
  }
}
