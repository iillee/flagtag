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
import { registerDeferredBalanceApplier } from '../shared/clientState'


// ── Types ──

interface TrackedCoin {
  /** Original base Y position (for bob reset on respawn) */
  baseY: number
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

// ── Spatial coin sound pool (for other players' pickups) ──
// Round-robin a small fixed set of entities instead of creating + destroying one per
// pickup. Per-pickup entity churn is the failure class that historically broke the
// engine renderer (see KNOWN_BUGS.md); the clip is short so a 4-deep ring never cuts
// off an audible sound under normal play.
const SPATIAL_SOUND_POOL_SIZE = 4
const spatialSoundPool: Entity[] = []
let spatialSoundNext = 0
let spatialSoundPoolReady = false

function initSpatialSoundPool(): void {
  if (spatialSoundPoolReady) return
  spatialSoundPoolReady = true
  for (let i = 0; i < SPATIAL_SOUND_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: Vector3.Zero() })
    spatialSoundPool.push(e)
  }
}

function playCoinSoundAt(pos: { x: number; y: number; z: number }): void {
  initSpatialSoundPool()
  const e = spatialSoundPool[spatialSoundNext]
  spatialSoundNext = (spatialSoundNext + 1) % SPATIAL_SOUND_POOL_SIZE
  Transform.getMutable(e).position = Vector3.create(pos.x, pos.y, pos.z)
  AudioSource.createOrReplace(e, {
    audioClipUrl: 'assets/sounds/coin.mp3',
    playing: true,
    loop: false,
    volume: 0.5,
    global: false, // spatial sound
  })
}

// ── Head-bounce coin VFX pool ──
// A coin pops up over the picker's head then falls + shrinks away. Pre-create a fixed set
// of rigs (anchor -> shrinkParent -> coin) once and reuse them via AvatarAttach re-anchoring
// + tween restart, instead of creating/destroying ~3 entities on every pickup (the churn
// class that historically broke the renderer — see KNOWN_BUGS.md).
const HEAD_BOUNCE_POOL_SIZE = 6
// Matches the original's 0.6s lifetime: the pop-up (200ms) + fall/shrink (350ms) finishes at
// 550ms, so parking at 600ms hides the rig right as the shrink completes — before the YOYO
// loop would visibly grow the coin back up. Longer would add an unwanted "second bounce".
const HEAD_BOUNCE_DURATION = 0.6 // seconds a rig stays busy before it's parked
const COIN_MODEL_SRC = 'assets/asset-packs/doubloon/Coin_01/Coin_01.glb'

interface HeadBounceRig {
  anchor: Entity        // AvatarAttach to the picker's head (added on acquire, removed on release)
  shrinkParent: Entity  // runs the scale animation
  coin: Entity          // GltfContainer + move animation
  timer: number         // seconds remaining while busy
  busy: boolean
}
const headBouncePool: HeadBounceRig[] = []
let headBouncePoolReady = false

function initHeadBouncePool(): void {
  if (headBouncePoolReady) return
  headBouncePoolReady = true
  for (let i = 0; i < HEAD_BOUNCE_POOL_SIZE; i++) {
    const anchor = engine.addEntity()
    Transform.create(anchor, { position: Vector3.Zero() })
    const shrinkParent = engine.addEntity()
    Transform.create(shrinkParent, { parent: anchor, position: Vector3.Zero(), scale: Vector3.Zero() }) // parked hidden
    const coin = engine.addEntity()
    Transform.create(coin, {
      parent: shrinkParent,
      position: Vector3.create(0, 0.5, 0),
      scale: Vector3.create(10, 10, 10),
      rotation: Quaternion.fromEulerDegrees(90, 0, 0),
    })
    GltfContainer.create(coin, {
      src: COIN_MODEL_SRC,
      visibleMeshesCollisionMask: 0,
      invisibleMeshesCollisionMask: 0,
    })
    headBouncePool.push({ anchor, shrinkParent, coin, timer: 0, busy: false })
  }
}

/** Park a rig back into the pool: stop its tweens, hide it, detach from the avatar. */
function releaseHeadBounceRig(rig: HeadBounceRig): void {
  rig.busy = false
  rig.timer = 0
  Tween.deleteFrom(rig.coin)
  TweenSequence.deleteFrom(rig.coin)
  Tween.deleteFrom(rig.shrinkParent)
  TweenSequence.deleteFrom(rig.shrinkParent)
  if (AvatarAttach.has(rig.anchor)) AvatarAttach.deleteFrom(rig.anchor)
  Transform.getMutable(rig.shrinkParent).scale = Vector3.Zero()
}

function spawnHeadBounceCoin(playerId: string): void {
  // Don't create the pooled coin rigs until the one-shot scene scanners have run:
  // coinBobSpinSystem (@3s) and setupCoins (@>=4s, which then sets setupDone) both scan
  // for GltfContainers whose src matches 'coin_01'/'doubloon' — which the pool coins' model
  // also matches. Creating the pool earlier would let those scanners capture the 6 permanent
  // pool entities as if they were real scene coins (breaking bob/spin + coin tracking).
  // Skipping a head-bounce for a remote pickup in the first few seconds is imperceptible.
  if (!setupDone) return
  initHeadBouncePool()

  // Acquire a free rig, or steal the one that will free soonest (a burst of >6 simultaneous
  // pickups just reuses the oldest — a clipped frame of a cosmetic bounce is imperceptible).
  let rig = headBouncePool.find(r => !r.busy)
  if (!rig) {
    rig = headBouncePool[0]
    for (const r of headBouncePool) if (r.timer < rig.timer) rig = r
  }

  rig.busy = true
  rig.timer = HEAD_BOUNCE_DURATION

  AvatarAttach.createOrReplace(rig.anchor, {
    avatarId: playerId,
    anchorPointId: AvatarAnchorPointType.AAPT_HEAD,
  })

  // Reset transforms then restart the two-phase animation (pop up, then fall + shrink).
  Transform.getMutable(rig.shrinkParent).scale = Vector3.One()
  const ct = Transform.getMutable(rig.coin)
  ct.position = Vector3.create(0, 0.5, 0)
  ct.scale = Vector3.create(10, 10, 10)
  ct.rotation = Quaternion.fromEulerDegrees(90, 0, 0)

  // Pop up fast then fall + shrink away
  Tween.createOrReplace(rig.coin, {
    mode: Tween.Mode.Move({ start: Vector3.create(0, 0.5, 0), end: Vector3.create(0, 2.0, 0) }),
    duration: 200,
    easingFunction: EasingFunction.EF_EASEOUTQUAD,
  })
  TweenSequence.createOrReplace(rig.coin, {
    sequence: [{
      mode: Tween.Mode.Move({ start: Vector3.create(0, 2.0, 0), end: Vector3.create(0, 0.8, 0) }),
      duration: 350,
      easingFunction: EasingFunction.EF_EASEINQUAD,
    }],
    loop: TweenLoop.TL_YOYO,
  })

  // Hold full size during pop-up (200ms), then shrink during fall (350ms)
  Tween.createOrReplace(rig.shrinkParent, {
    mode: Tween.Mode.Scale({ start: Vector3.One(), end: Vector3.One() }),
    duration: 200,
    easingFunction: EasingFunction.EF_LINEAR,
  })
  TweenSequence.createOrReplace(rig.shrinkParent, {
    sequence: [{
      mode: Tween.Mode.Scale({ start: Vector3.One(), end: Vector3.create(0, 0, 0) }),
      duration: 350,
      easingFunction: EasingFunction.EF_EASEINQUAD,
    }],
    loop: TweenLoop.TL_YOYO,
  })
}

// ── State ──

const trackedCoins: TrackedCoin[] = []
let setupDone = false
let waitTimer = 0
// Client-side spam guard: coinId -> timestamp (ms) when we sent requestCoinPickup.
// Cleared on coinPickedUp/coinRespawned. An entry older than LOCAL_PICKUP_TIMEOUT_MS
// is treated as expired so a lost request/silent rejection can't make a coin
// permanently unpickable for this client.
const localPickupCooldowns = new Map<string, number>()
const LOCAL_PICKUP_TIMEOUT_MS = 5000
let walletBalance = 0
let balanceRequested = false
let balanceReceived = false
let balanceRetryTimer = 0
const BALANCE_RETRY_INTERVAL = 3 // seconds
const BALANCE_MAX_RETRIES = 20
let balanceRetryCount = 0

/** Get the current coin balance for UI display */
export function getCoinBalance(): number {
  return walletBalance
}

/** Whether coin balance has been loaded from server */
export function isCoinBalanceLoaded(): boolean {
  return balanceReceived
}

/** Apply deferred round-end balance (called when coin animation triggers) */
export function applyDeferredBalance(newBalance: number): void {
  walletBalance = newBalance
}

// Register so UI can call via shared/clientState (avoids circular import)
registerDeferredBalanceApplier(applyDeferredBalance)

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
        baseY: pos.y,
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
        baseY: pos.y,
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

    // Play coin sound for everyone (spatial for others, global for picker)
    const player = getPlayer()
    const isMe = player && data.playerId === player.userId.toLowerCase()
    if (isMe) {
      walletBalance = data.newBalance
      playCoinSound() // global sound for the picker
      console.log('[CoinPickup] You picked up a coin! Balance:', walletBalance)
    } else if (coin) {
      // Spatial sound at the coin's position for other players
      playCoinSoundAt(coin.position)
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

  // Park head-bounce rigs whose animation has finished (spatial sounds are round-robin,
  // so they need no per-frame cleanup). No entity create/destroy happens here anymore.
  for (const rig of headBouncePool) {
    if (!rig.busy) continue
    rig.timer -= dt
    if (rig.timer <= 0) releaseHeadBounceRig(rig)
  }

  // Read synced coin state to determine which coins are on cooldown
  const cooldowns = getCooldownMap()

  // Get player position
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position

  // Update visibility & check proximity
  for (const coin of trackedCoins) {
    const onCooldown = cooldowns.has(coin.coinId)

    // Hide coins that are on cooldown but still showing (e.g. already picked up before we joined)
    if (onCooldown && !coin.hidden) {
      coin.hidden = true
      setCoinVisible(coin, false)
    }

    // Respawn: coin is no longer on cooldown, restore visibility + bob/spin
    if (!onCooldown && coin.hidden) {
      coin.hidden = false
      setCoinVisible(coin, true)
      restoreBobSpin(coin)
    }

    // Skip proximity check if on cooldown or animating
    if (onCooldown || coin.hidden) continue

    // Skip if we sent a pickup request recently. A stale entry (older than
    // LOCAL_PICKUP_TIMEOUT_MS) means the request or its server response was lost,
    // so drop it and allow a re-request instead of the coin being stuck forever.
    const requestedAt = localPickupCooldowns.get(coin.coinId)
    if (requestedAt !== undefined) {
      if (Date.now() - requestedAt < LOCAL_PICKUP_TIMEOUT_MS) continue
      localPickupCooldowns.delete(coin.coinId)
    }

    // Check proximity
    const dx = playerPos.x - coin.position.x
    const dy = playerPos.y - coin.position.y
    const dz = playerPos.z - coin.position.z
    const distSq = dx * dx + dy * dy + dz * dz

    if (distSq <= COIN_PICKUP_RADIUS * COIN_PICKUP_RADIUS) {
      // Request pickup from server
      localPickupCooldowns.set(coin.coinId, Date.now())
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

  // Restore bob on parent — use stored base Y to prevent drift across respawn cycles
  const t = Transform.get(coin.bobParent)
  const baseY = coin.baseY
  // Reset bobParent to original base position before applying new tween
  Transform.getMutable(coin.bobParent).position = Vector3.create(t.position.x, baseY, t.position.z)
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
