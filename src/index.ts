import { Vector3, Quaternion } from '@dcl/sdk/math'
import { engine, Transform, AudioSource, AvatarModifierArea, AvatarModifierType, VisibilityComponent, ColliderLayer, GltfContainer, type Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { getPlayer, onEnterScene, onLeaveScene } from '@dcl/sdk/players'
import { setupUi } from './ui'
import { swordClientSystem } from './systems/swordSystem'
import { infectionClientSystem } from './systems/infectionSystem'
import { trapClientSystem, initTrapPool } from './systems/trapSystem'
import { setupProximityLights, proximityLightSystem } from './systems/proximityLights'
import { setupSpectator } from './systems/spectatorSystem'
import { waterSystem } from './systems/waterSystem'
import { mailboxSystem } from './systems/mailboxSystem'
import { gravestoneSystem } from './systems/gravestoneSystem'
import { terminalSystem } from './systems/terminalSystem'
import { chestSystem } from './systems/chestSystem'
import { upgradeStateSystem, initUpgradeListeners } from './gameState/playerUpgradeState'

import { updateWorldTime } from './shared/dayNight'
import { setupUpdraftSystem, updraftSystem } from './systems/updraftSystem'
import { waterBobSystem } from './systems/waterBobSystem'
import { coinBobSpinSystem } from './systems/coinBobSpinSystem'
import { coinPickupSystem, setupCoinMessages } from './systems/coinPickupSystem'
import { speedBoostSystem } from './systems/speedBoostSystem'
import { boostTrailSystem, setupBoostTrailMessages } from './systems/boostTrailSystem'
import { waterSplashSystem } from './systems/waterSplashSystem'
import { setupBeacon, beaconClientSystem } from './systems/beaconSystem'
import { setupLadder } from './systems/ladderSystem'
import { setupBoundaryWalls } from './systems/boundaryWalls'
import { setupTeleportOrbs } from './systems/teleportOrbs'
import { setupCinematicSystem } from './systems/cinematicSystem'
import { Portal } from './systems/portals/portal'
import { addPlayer, removePlayer, nameResolverSystem, updateHoldTimeInterpolation } from './gameState/flagHoldTime'
// sceneTime removed — visitor tracking is fully server-side via VisitorAnalytics
import { createWinConditionOverlayEntity } from './components/winConditionOverlayState'
import { createLeaderboardOverlayEntity } from './components/leaderboardOverlayState'
import { createAnalyticsOverlayEntity } from './components/analyticsOverlayState'
import './shared/components'
import { room } from './shared/messages'
import { setupDeathPenaltyMessages } from './systems/deathPenaltySystem'

export let musicEntity: ReturnType<typeof engine.addEntity>

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

  // ── Client setup ──
  // Pre-initialize entity pools so models are loaded before first use
  initTrapPool()

  createWinConditionOverlayEntity()
  createLeaderboardOverlayEntity()
  createAnalyticsOverlayEntity()
  setupUi()
  setupBeacon()
  setupLadder()



  // (Boomerang hand models and charge ring removed for Contagion mode)

  const local = getPlayer()
  let registeredName = ''
  if (local) {
    addPlayer(local.userId, local.name)
    registeredName = local.name || ''
    room.send('registerName', { name: registeredName || local.userId.slice(0, 8) })

    // Retry periodically until we get a real name (not empty, not 0x prefix)
    let retryTimer = 2.0
    let retryCount = 0
    engine.addSystem((dt: number) => {
      if (retryCount >= 10) return
      retryTimer -= dt
      if (retryTimer <= 0) {
        retryCount++
        retryTimer = 5.0
        const updated = getPlayer()
        const newName = updated?.name || ''
        const isRealName = newName.length > 0 && !newName.startsWith('0x')
        if (isRealName && newName !== registeredName) {
          registeredName = newName
          room.send('registerName', { name: newName })
          addPlayer(updated!.userId, newName)
        }
      }
    })
  }

  onEnterScene((player) => {
    // Skip local player - already added above (case-insensitive comparison)
    if (local && player.userId.toLowerCase() === local.userId.toLowerCase()) {
      // Update local player name if onEnterScene has better data
      const name = player.name || ''
      if (name && !name.startsWith('0x') && name !== registeredName) {
        registeredName = name
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
  })

  // Background music
  musicEntity = engine.addEntity()
  Transform.create(musicEntity, { position: Vector3.create(0, 0, 0) })
  AudioSource.create(musicEntity, {
    audioClipUrl: 'assets/sounds/SpriteSprint_Loop.wav',
    playing: true,
    loop: true,
    volume: 0.0984375,
    global: true
  })

  // Disable passport UI (clicking on avatars to view profiles)
  // NOTE: The SDK does not provide a way to disable smart wearables/portable experiences.
  // Only AMT_HIDE_AVATARS and AMT_DISABLE_PASSPORTS are available as modifiers.
  // Smart wearables run in a separate context and cannot be disabled by scene code.
  const avatarModArea = engine.addEntity()
  Transform.create(avatarModArea, { position: Vector3.create(256, 11, 256) })
  AvatarModifierArea.create(avatarModArea, {
    area: Vector3.create(522, 50, 522), // Cover entire scene
    modifiers: [AvatarModifierType.AMT_DISABLE_PASSPORTS], // Disables passport UI only
    excludeIds: []
  })

  // Boundary walls (cylindrical collider + proximity-fade visuals)
  setupBoundaryWalls()

  // Teleport orbs
  setupTeleportOrbs()

  // ── Reload drop: if we were carrying the flag when /reload happened, drop it ──
  // Flag CRDT data arrives after a few frames, so we poll briefly on startup.
  if (local) {
    const { Sword: Flag, SwordState: FlagState } = await import('./shared/components')
    let reloadCheckFrames = 0
    const RELOAD_CHECK_MAX_FRAMES = 60 // ~1 second at 60fps
    engine.addSystem(function reloadDropSystem() {
      reloadCheckFrames++
      for (const [, flag] of engine.getEntitiesWith(Flag)) {
        if (flag.state === FlagState.Carried && flag.carrierPlayerId === local.userId.toLowerCase()) {
          console.log('[Main] Detected flag carry on scene load (likely /reload) — requesting respawn')
          room.send('requestReloadRespawn', { t: 0 })
        }
        // Flag data found — remove this system regardless
        engine.removeSystem(reloadDropSystem)
        return
      }
      // Give up after max frames
      if (reloadCheckFrames >= RELOAD_CHECK_MAX_FRAMES) {
        engine.removeSystem(reloadDropSystem)
      }
    })
  }

  // Portal to Genesis Plaza — placed at parcel (8,8) scene-local
  new Portal({
    locationId: 'genesis-plaza',
    position: { x: 225.95, y: 2.15, z: 224.9 },
    rotation: { x: 0, y: 167, z: 0 },
    size: 1.85,
    name: 'Genesis Plaza',
    callback: () => {
      void import('~system/RestrictedActions').then(({ teleportTo }) =>
        teleportTo({ worldCoordinates: { x: 0, y: 0 } })
      )
    }
  })

  // Spectator camera
  setupSpectator()

  // ── Hide podium cubes (placed in Creator Hub) ──
  // NOTE: Keep these entities in the composite! They mark podium positions for 1st/2nd/3rd place.
  // Red=1st, Gold=2nd, Blue=3rd, Green=camera target. Hidden here to be invisible at runtime.
  const PODIUM_CUBE_SRCS = new Set([
    'assets/models/solid_red.glb',
    'assets/models/gold.glb',
    'assets/models/solid_blue.glb',
    'assets/models/solid_green.glb',
  ])
  const hiddenPodiumCubes = new Set<Entity>()

  engine.addSystem(function hidePodiumCubes() {
    for (const [entity] of engine.getEntitiesWith(GltfContainer)) {
      if (hiddenPodiumCubes.has(entity)) continue
      const gltf = GltfContainer.get(entity)
      if (PODIUM_CUBE_SRCS.has(gltf.src)) {
        VisibilityComponent.createOrReplace(entity, { visible: false })
        // Remove colliders by setting invisible mesh collider layer
        GltfContainer.createOrReplace(entity, {
          ...gltf,
          invisibleMeshesCollisionMask: ColliderLayer.CL_NONE,
          visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
        })
        hiddenPodiumCubes.add(entity)
        console.log(`[Client] 🎯 Hidden podium cube: ${gltf.src}`)
      }
    }
    // Remove system once all 4 found
    if (hiddenPodiumCubes.size >= 4) {
      engine.removeSystem(hidePodiumCubes)
      console.log('[Client] ✅ All 4 podium cubes hidden')
    }
  })

  // Water slowdown — disable running in water
  engine.addSystem(waterSystem)
  engine.addSystem(waterBobSystem)
  engine.addSystem(coinBobSpinSystem)
  setupCoinMessages()
  setupBoostTrailMessages()
  initUpgradeListeners()
  setupDeathPenaltyMessages()
  engine.addSystem(coinPickupSystem)
  engine.addSystem(waterSplashSystem)

  // (Lightning system removed for Contagion mode)

  // Mailbox — click to leave feedback
  engine.addSystem(mailboxSystem)
  engine.addSystem(chestSystem)
  engine.addSystem(upgradeStateSystem)
  engine.addSystem(gravestoneSystem)
  engine.addSystem(terminalSystem)



  // Proximity lighting
  setupProximityLights()
  engine.addSystem(proximityLightSystem)

  // Updraft smoke stacks
  setupUpdraftSystem()
  engine.addSystem(updraftSystem)

  // Client systems
  engine.addSystem(swordClientSystem)
  engine.addSystem(infectionClientSystem)
  engine.addSystem(beaconClientSystem)
  engine.addSystem(nameResolverSystem)
  engine.addSystem(trapClientSystem)
  engine.addSystem(speedBoostSystem)
  engine.addSystem(boostTrailSystem)
  engine.addSystem(updateHoldTimeInterpolation)

  // ── Day/Night Cycle ──
  // Polls getWorldTime() to keep server-side ghost spawn logic in sync.
  // Skybox is NOT overridden — players can use auto or manual settings.
  // Ghost appears regardless of local skybox (server-authoritative).
  engine.addSystem(function dayNightPollSystem(_dt: number) {
    updateWorldTime()
  })

  // Cinematic system (round-end camera, fade state machine, respawnPlayers handler)
  setupCinematicSystem()
}
