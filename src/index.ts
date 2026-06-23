import { engine } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
// Shared modules (safe for both client and server)
// These MUST be static imports so components are registered before the engine seals
import './shared/components'
import './shared/coins'
import './shared/upgrades'
import { room } from './shared/messages'
import { registerSystem, registerThrottled, initSystemManager } from './systems/systemManager'

export async function main() {
  if (isServer()) {
    console.log('[Main] ⚙️  SERVER MODE - Starting authoritative server...')
    try {
      const { setupServer } = await import('./server/server')
      await setupServer()
      console.log('[Main] ✅ Server setup complete')
    } catch (err) {
      console.error('[Main] ❌ SERVER STARTUP FAILED:', err)
      throw err
    }
    return
  }
  
  console.log('[Main] 🎮 CLIENT MODE - Starting client...')

  // ── Dynamic imports for client-only modules ──
  // These must NOT be static imports because this file also runs on the server.
  // Many client modules import from ~system/RestrictedActions or ~system/Runtime,
  // which don't exist on the server runtime and would crash it.
  const { isMobile } = await import('@dcl/sdk/platform')
  const { getPlayer, onEnterScene, onLeaveScene } = await import('@dcl/sdk/players')
  const { setupUi } = await import('./ui')
  const { flagClientSystem } = await import('./systems/flagSystem')
  const { combatClientSystem, initPools: initCombatPools } = await import('./systems/combatSystem')
  const { updateHitFlash } = await import('./gameState/hitFlashState')
  const { trapClientSystem, initTrapPool } = await import('./systems/trapSystem')
  const { bombClientSystem, initBombPool, setupBombMessages } = await import('./systems/bombSystem')
  const { projectileClientSystem, initProjectilePool } = await import('./systems/projectile')
  const { mushroomClientSystem } = await import('./systems/mushroomSystem')
  const { shieldSystem } = await import('./systems/shieldSystem')
  const { setupProximityLights, proximityLightSystem } = await import('./systems/proximityLights')
  const { setupWorldLeaderboard } = await import('./systems/worldLeaderboard')
  const { setupSpectator } = await import('./systems/spectatorSystem')
  const { waterSystem } = await import('./systems/waterSystem')
  const { mailboxSystem } = await import('./systems/mailboxSystem')
  const { gravestoneSystem } = await import('./systems/gravestoneSystem')
  const { terminalSystem } = await import('./systems/terminalSystem')
  const { chestSystem } = await import('./systems/chestSystem')
  const { boomboxSystem } = await import('./systems/boomboxSystem')
  const { upgradeStateSystem, initUpgradeListeners } = await import('./gameState/playerUpgradeState')
  const { updateWorldTime } = await import('./shared/dayNight')
  const { setupUpdraftSystem, updraftSystem, setSmokeMobileFlag } = await import('./systems/updraftSystem')
  const { waterBobSystem } = await import('./systems/waterBobSystem')
  const { coinBobSpinSystem } = await import('./systems/coinBobSpinSystem')
  const { coinPickupSystem, setupCoinMessages } = await import('./systems/coinPickupSystem')
  const { speedBoostSystem } = await import('./systems/speedBoostSystem')
  const { boostTrailSystem, setupBoostTrailMessages } = await import('./systems/boostTrailSystem')
  const { waterSplashSystem } = await import('./systems/waterSplashSystem')
  const { setupLightning, lightningSystem, setupLightningMessages } = await import('./systems/lightningSystem')
  const { setupBeacon, beaconClientSystem, startBeaconBlink } = await import('./systems/beaconSystem')
  const { setupRemoteBoomerangs, cleanupRemoteBoomerang } = await import('./systems/remoteBoomerangSystem')
  const { getBoomerangColor } = await import('./gameState/boomerangColor')
  const { setupHandBoomerangs } = await import('./systems/handBoomerangSetup')
  const { setupLadder } = await import('./systems/ladderSystem')
  const { setupBoundaryWalls } = await import('./systems/boundaryWalls')
  const { setupTeleportOrbs } = await import('./systems/teleportOrbs')
  const { setupCinematicSystem } = await import('./systems/cinematicSystem')
  const { ghostClientSystem } = await import('./systems/ghostSystem')
  const { pedestalSystem } = await import('./systems/pedestalSystem')
  const { Portal } = await import('./systems/portalSystem')
  const { addPlayer, removePlayer, nameResolverSystem, updateHoldTimeInterpolation } = await import('./gameState/flagHoldTime')
  await import('./gameState/overlayState')
  const { setupDeathPenaltyMessages } = await import('./systems/deathPenaltySystem')

  // ── Client setup ──
  // Pre-initialize entity pools so GLB models are loaded before first use
  // (fixes first boomerang/banana being invisible on fresh load)
  initProjectilePool()
  initTrapPool()
  // Bomb pool is lazy-initialized on first drop to avoid overloading GLB loading at startup
  initCombatPools()

  // Preload all sound effects at volume 0 so there's no delay on first play
  const { preloadAllSounds } = await import('./preloadSounds')
  preloadAllSounds()

  setupUi()
  setupBeacon()
  setupLadder()



  // Hand-held boomerang models + charge ring
  setupHandBoomerangs()

  // Set up remote player boomerang hand models (synced via messages)
  setupRemoteBoomerangs()
  // Broadcast initial boomerang color so other players see our hand model
  room.send('colorChanged', { color: getBoomerangColor() })

  const { setupNameRetry } = await import('./systems/nameRetrySystem')

  const local = getPlayer()
  let nameRetry: ReturnType<typeof setupNameRetry> | null = null
  if (local) {
    addPlayer(local.userId, local.name)
    const initialName = local.name || ''
    room.send('registerName', { name: initialName || local.userId.slice(0, 8) })
    nameRetry = setupNameRetry(initialName)
  }

  onEnterScene((player) => {
    // Skip local player - already added above (case-insensitive comparison)
    if (local && player.userId.toLowerCase() === local.userId.toLowerCase()) {
      // Update local player name if onEnterScene has better data
      const name = player.name || ''
      if (name && !name.startsWith('0x')) {
        nameRetry?.updateName(name)
        room.send('registerName', { name })
        addPlayer(player.userId, name)
      }
      return
    }
    
    // Add other players
    addPlayer(player.userId, player.name)
  })
  onLeaveScene((userId) => {
    removePlayer(userId)
    cleanupRemoteBoomerang(userId)
  })

  // Background music
  const { setupMusic } = await import('./systems/musicSetup')
  setupMusic()

  // Disable passport UI scene-wide
  const { setupAvatarModifier } = await import('./systems/avatarModifierSetup')
  setupAvatarModifier()

  // Boundary walls (cylindrical collider + proximity-fade visuals)
  setupBoundaryWalls()

  // Teleport orbs
  setupTeleportOrbs()

  // Portal to Genesis Plaza — placed at parcel (8,8) scene-local
  new Portal({
    locationId: 'genesis-plaza',
    position: { x: 225.95, y: 2.15, z: 224.9 },
    rotation: { x: 0, y: 167, z: 0 },
    size: 1.85,
    name: 'Genesis Plaza',
    mute: true,
    callback: () => {
      void import('~system/RestrictedActions').then(({ teleportTo }) =>
        teleportTo({ worldCoordinates: { x: 0, y: 0 } })
      )
    }
  })

  // Spectator camera
  setupSpectator()

  // Hide podium cubes (placed in Creator Hub, used by cinematicSystem for positioning)


  // Message handlers (no systems, just wire up listeners)
  setupCoinMessages()
  setupBoostTrailMessages()
  setupBombMessages()
  initUpgradeListeners()
  setupDeathPenaltyMessages()
  setupLightning()
  setupLightningMessages()

  // Beacon blink when flag hits water
  room.onMessage('flagSinking', () => {
    console.log('[Beacon] Flag sinking — starting blink')
    startBeaconBlink()
  })
  setupWorldLeaderboard()
  setupProximityLights()
  setSmokeMobileFlag(isMobile())

  const { setSpatialAudioMobile } = await import('./utils/spatialAudio')
  setSpatialAudioMobile(isMobile())
  setupUpdraftSystem()

  // ── Register all systems through the system manager ──

  // Per-frame visual/animation (only systems that need 60fps)
  registerSystem((dt) => {
    shieldSystem(dt)
    speedBoostSystem(dt)
    updateHoldTimeInterpolation()
  })

  // Per-frame gameplay — critical systems (every frame)
  registerSystem((dt) => {
    flagClientSystem(dt)
    combatClientSystem(dt)
    updateHitFlash(dt)
    projectileClientSystem(dt)
    trapClientSystem(dt)
    try { bombClientSystem(dt) } catch (e) { console.error('[Bomb] System error:', e) }
    waterSystem(dt)
    ghostClientSystem(dt)
  })

  // Per-frame smooth animations (coins, beacon, smoke need 60fps to look right)
  registerSystem((dt) => {
    coinBobSpinSystem(dt)
    beaconClientSystem(dt)
    updraftSystem(dt)
    updateWorldTime(dt)
  })

  // Per-frame gameplay — time-sliced systems (alternating frames, 30fps each)
  let oddFrame = false
  registerSystem((dt) => {
    oddFrame = !oddFrame
    if (oddFrame) {
      mushroomClientSystem(dt * 2)
      lightningSystem(dt * 2)
    } else {
      coinPickupSystem(dt * 2)
    }
  })

  // Throttled cosmetic animations (20fps)
  registerThrottled((dt) => {
    waterBobSystem(dt)
    waterSplashSystem(dt)
    boostTrailSystem(dt)
  }, 0.05)

  // Throttled proximity + ambient visuals (10fps)
  registerThrottled((dt) => {
    boomboxSystem(dt)
    pedestalSystem(dt)
  }, 0.1)

  // Throttled checks (every 0.25s)
  registerThrottled((_elapsed) => {
    mailboxSystem()
    chestSystem()
    gravestoneSystem()
    terminalSystem()
  }, 0.25)

  registerThrottled((elapsed) => {
    upgradeStateSystem(elapsed)
    proximityLightSystem(elapsed)
  }, 0.25)

  // Rare checks (every 2s)
  registerThrottled((elapsed) => {
    nameResolverSystem(elapsed)
  }, 2.0)

  // Cinematic system (round-end camera, fade state machine, respawnPlayers handler)
  setupCinematicSystem()

  // Interior room system (prototype)
  const { setupInteriorSystem } = await import('./systems/interiorSystem')
  setupInteriorSystem()

  // ── Initialize the system manager LAST — registers the 2 actual engine systems ──
  initSystemManager()
}
