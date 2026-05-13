import { Vector3, Color4, Color3, Quaternion } from '@dcl/sdk/math'
import { engine, Entity, Transform, AudioSource, MeshRenderer, Material, MaterialTransparencyMode, AvatarModifierArea, AvatarModifierType, VisibilityComponent, ColliderLayer, GltfContainer, AvatarAttach, AvatarAnchorPointType, inputSystem, InputAction, PointerEventType } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { isMobile } from '@dcl/sdk/platform'
import { getPlayer, onEnterScene, onLeaveScene } from '@dcl/sdk/players'
import { setupUi } from './ui'
import { flagClientSystem } from './systems/flagSystem'
import { combatClientSystem, initPools as initCombatPools } from './systems/combatSystem'
import { trapClientSystem, initTrapPool } from './systems/trapSystem'
import { projectileClientSystem, setHandBoomerangEntity, setLeftHandBoomerangEntity, initProjectilePool, getChargeFraction, getChargePhase } from './systems/projectileSystem'
import { mushroomClientSystem } from './systems/mushroomSystem'
import { shieldSystem } from './systems/shieldSystem'
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
import { setupLightning, lightningSystem, setupLightningMessages } from './systems/lightningSystem'
import { setupBeacon, beaconClientSystem } from './systems/beaconSystem'
import { setupRemoteBoomerangs, cleanupRemoteBoomerang } from './systems/remoteBoomerangSystem'
import { getBoomerangColor, onBoomerangColorChange } from './gameState/boomerangColor'
import { setupLadder } from './systems/ladderSystem'
import { setupBoundaryWalls } from './systems/boundaryWalls'
import { setupTeleportOrbs } from './systems/teleportOrbs'
import { setupCinematicSystem } from './systems/cinematicSystem'
import { ghostClientSystem } from './systems/ghostSystem'
import { Portal } from './systems/portals/portal'
import { addPlayer, removePlayer, nameResolverSystem, updateHoldTimeInterpolation } from './gameState/flagHoldTime'
// sceneTime removed — visitor tracking is fully server-side via VisitorAnalytics
import { createWinConditionOverlayEntity } from './gameState/winConditionOverlayState'
import { createLeaderboardOverlayEntity } from './gameState/leaderboardOverlayState'
import { createAnalyticsOverlayEntity } from './gameState/analyticsOverlayState'
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
  // Pre-initialize entity pools so GLB models are loaded before first use
  // (fixes first boomerang/banana being invisible on fresh load)
  initProjectilePool()
  initTrapPool()
  initCombatPools()

  createWinConditionOverlayEntity()
  createLeaderboardOverlayEntity()
  createAnalyticsOverlayEntity()
  setupUi()
  setupBeacon()
  setupLadder()



  // Attach boomerang to local player's right hand (always visible)
  const boomerangHand = engine.addEntity()
  AvatarAttach.create(boomerangHand, {
    anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND
  })
  Transform.create(boomerangHand, { position: Vector3.Zero(), scale: Vector3.One() })
  const boomerangModel = engine.addEntity()
  Transform.create(boomerangModel, {
    parent: boomerangHand,
    position: isMobile() ? Vector3.create(-0.02, 0.13, -0.13) : Vector3.create(0.04, 0.15, 0.1),
    scale: Vector3.create(1, 1.5, 1),
    rotation: Quaternion.fromEulerDegrees(isMobile() ? 15 : 0, isMobile() ? 180 : 0, 90)
  })
  GltfContainer.create(boomerangModel, {
    src: 'assets/models/boomerang.r.glb',
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })
  setHandBoomerangEntity(boomerangModel)

  // ── Left-hand boomerang (yellow only) ──
  const leftHandAnchor = engine.addEntity()
  AvatarAttach.create(leftHandAnchor, {
    anchorPointId: AvatarAnchorPointType.AAPT_LEFT_HAND
  })
  Transform.create(leftHandAnchor, { position: Vector3.Zero(), scale: Vector3.One() })
  const leftBoomerangModel = engine.addEntity()
  Transform.create(leftBoomerangModel, {
    parent: leftHandAnchor,
    position: isMobile() ? Vector3.create(0.12, 0.01, -0.13) : Vector3.create(0.05, 0.03, 0.1),
    scale: getBoomerangColor() === 'y' ? Vector3.create(1, 1.5, 1) : Vector3.Zero(),
    rotation: Quaternion.fromEulerDegrees(isMobile() ? 15 : 0, isMobile() ? 180 : 0, -90)
  })
  GltfContainer.create(leftBoomerangModel, {
    src: `assets/models/boomerang.${getBoomerangColor()}.glb`,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  // Show/hide left hand boomerang when color changes
  onBoomerangColorChange((color) => {
    if (Transform.has(leftBoomerangModel)) {
      Transform.getMutable(leftBoomerangModel).scale = color === 'y' ? Vector3.create(1, 1.5, 1) : Vector3.Zero()
    }
    if (GltfContainer.has(leftBoomerangModel)) {
      GltfContainer.getMutable(leftBoomerangModel).src = `assets/models/boomerang.${color}.glb`
    }
  })

  setLeftHandBoomerangEntity(leftBoomerangModel)

  // ── Charging torus ring — small spheres arranged in a circle ──
  const RING_SEGMENTS = 16
  const RING_RADIUS = 0.35
  const RING_BEAD_SIZE = 0.06
  const ringParent = engine.addEntity()
  Transform.create(ringParent, {
    parent: boomerangHand,
    position: Vector3.create(0, 0.15, 0),
    scale: Vector3.Zero() // hidden by default
  })
  const ringBeads: Entity[] = []
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const angle = (i * 2 * Math.PI) / RING_SEGMENTS
    const bead = engine.addEntity()
    Transform.create(bead, {
      parent: ringParent,
      position: Vector3.create(Math.cos(angle) * RING_RADIUS, 0, Math.sin(angle) * RING_RADIUS),
      scale: Vector3.create(RING_BEAD_SIZE, RING_BEAD_SIZE, RING_BEAD_SIZE)
    })
    MeshRenderer.setSphere(bead)
    Material.setPbrMaterial(bead, {
      albedoColor: Color4.create(1, 0.85, 0, 0.5),
      emissiveColor: Color3.create(1, 0.8, 0),
      emissiveIntensity: 5,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })
    ringBeads.push(bead)
  }

  // Update charge ring each frame — grows + spins
  engine.addSystem((dt: number) => {
    if (getChargePhase() === 'charging' && getChargeFraction() > 0.15 && getBoomerangColor() !== 'g') {
      const cf = getChargeFraction()
      const size = 0.375 + cf * 0.75
      // Spin the ring parent
      const rot = Transform.getMutable(ringParent).rotation ?? Quaternion.fromEulerDegrees(0, 0, 0)
      const spinSpeed = 120 + cf * 360 // degrees/sec
      Transform.getMutable(ringParent).scale = Vector3.create(size, size, size)
      Transform.getMutable(ringParent).rotation = Quaternion.multiply(
        Quaternion.fromEulerDegrees(0, spinSpeed * dt, 0),
        Transform.get(ringParent).rotation
      )
      // Update bead color/intensity
      const r = cf > 0.75 ? 1.0 : 1.0
      const g = cf > 0.75 ? 0.3 : 0.8
      const b = cf > 0.75 ? 0.1 : 0.0
      for (const bead of ringBeads) {
        Material.setPbrMaterial(bead, {
          albedoColor: Color4.create(1, 0.85, 0, 0.3 + cf * 0.4),
          emissiveColor: Color3.create(r, g, b),
          emissiveIntensity: 3 + cf * 12,
          transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
        })
      }
    } else {
      if (Transform.has(ringParent)) {
        Transform.getMutable(ringParent).scale = Vector3.Zero()
      }
    }
  })

  // Set up remote player boomerang hand models (synced via messages)
  setupRemoteBoomerangs()
  // Broadcast initial boomerang color so other players see our hand model
  room.send('colorChanged', { color: getBoomerangColor() })

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
    cleanupRemoteBoomerang(userId)
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
    const { Flag, FlagState } = await import('./shared/components')
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

  // Lightning bolt system (probability-based, synced via messages)
  setupLightning()
  setupLightningMessages()
  engine.addSystem(lightningSystem)

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
  engine.addSystem(flagClientSystem)
  engine.addSystem(combatClientSystem)
  engine.addSystem(beaconClientSystem)
  engine.addSystem(nameResolverSystem)
  engine.addSystem(trapClientSystem)
  engine.addSystem(projectileClientSystem)
  engine.addSystem(mushroomClientSystem)
  engine.addSystem(speedBoostSystem)
  engine.addSystem(boostTrailSystem)
  engine.addSystem(shieldSystem)
  engine.addSystem(ghostClientSystem) // Ghost system enabled
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
