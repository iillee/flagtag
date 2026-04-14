import { Vector3, Color4, Color3, Quaternion } from '@dcl/sdk/math'
import { engine, Entity, Transform, AudioSource, MeshCollider, MeshRenderer, Material, MaterialTransparencyMode, LightSource, AvatarModifierArea, AvatarModifierType, Name, VisibilityComponent, ColliderLayer, VirtualCamera, MainCamera, InputModifier, GltfContainer, GltfContainerLoadingState, LoadingState, AvatarAttach, AvatarAnchorPointType } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { getPlayer, onEnterScene, onLeaveScene } from '@dcl/sdk/players'
import { setupUi, setCinematicFade, setCinematicShowing, hideMailboxPopup, hideChestPopup } from './ui'
import { flagClientSystem } from './systems/flagSystem'
import { combatClientSystem } from './systems/combatSystem'
import { trapClientSystem } from './systems/trapSystem'
import { projectileClientSystem, setHandBoomerangEntity } from './systems/projectileSystem'
import { mushroomClientSystem } from './systems/mushroomSystem'
import { shieldSystem } from './systems/shieldSystem'
import { setupProximityLights, proximityLightSystem } from './systems/proximityLights'
import { setupSpectator, exitSpectatorMode } from './systems/spectatorSystem'
import { waterSystem } from './systems/waterSystem'
import { mailboxSystem } from './systems/mailboxSystem'
import { chestSystem } from './systems/chestSystem'

import { setCinematicActive } from './cinematicState'
import { setupUpdraftSystem, updraftSystem } from './systems/updraftSystem'
import { waterBobSystem } from './systems/waterBobSystem'
import { waterSplashSystem } from './systems/waterSplashSystem'
import { setupBeacon, beaconClientSystem } from './systems/beaconSystem'
import { setupRemoteBoomerangs, cleanupRemoteBoomerang } from './systems/remoteBoomerangSystem'
import { getBoomerangColor } from './gameState/boomerangColor'
import { setupLadder } from './systems/ladderSystem'
import { Portal } from './systems/portals/portal'
import { addPlayer, removePlayer, nameResolverSystem, updateHoldTimeInterpolation } from './gameState/flagHoldTime'
import { addPlayerSession, removePlayerSession } from './gameState/sceneTime'
import { createWinConditionOverlayEntity, setWinConditionOverlayVisible } from './components/winConditionOverlayState'
import { createLeaderboardOverlayEntity, setLeaderboardOverlayVisible } from './components/leaderboardOverlayState'
import { createAnalyticsOverlayEntity, setAnalyticsOverlayVisible } from './components/analyticsOverlayState'
import { movePlayerTo, triggerEmote } from '~system/RestrictedActions'
import './shared/components'
import { CountdownTimer } from './shared/components'
import { room } from './shared/messages'

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
    position: Vector3.create(0.04, 0.15, 0.1),
    scale: Vector3.create(1, 1.5, 1),
    rotation: Quaternion.fromEulerDegrees(0, 0, 90)
  })
  GltfContainer.create(boomerangModel, {
    src: 'models/boomerang.r.glb',
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })
  setHandBoomerangEntity(boomerangModel)

  // Set up remote player boomerang hand models (synced via messages)
  setupRemoteBoomerangs()
  // Broadcast initial boomerang color so other players see our hand model
  room.send('colorChanged', { color: getBoomerangColor() })

  const local = getPlayer()
  let registeredName = ''
  if (local) {
    addPlayer(local.userId, local.name)
    addPlayerSession(local.userId, local.name || local.userId.slice(0, 8))
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
    addPlayerSession(player.userId, player.name || player.userId.slice(0, 8))
  })
  onLeaveScene((userId) => {
    removePlayer(userId)
    removePlayerSession(userId)
    cleanupRemoteBoomerang(userId)
  })

  // Background music
  musicEntity = engine.addEntity()
  Transform.create(musicEntity, { position: Vector3.create(0, 0, 0) })
  AudioSource.create(musicEntity, {
    audioClipUrl: 'assets/sounds/Medieval.mp3',
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

  // Cylindrical boundary wall centered on castle — faceted planes with gradient fade
  {
    const BOUNDARY_CX = 250.75
    const BOUNDARY_CZ = 255.5
    const BOUNDARY_RADIUS = 128
    const BOUNDARY_HEIGHT = 200
    const BOUNDARY_SEGMENTS = 48
    const BOUNDARY_SHOW_DIST = 40 // meters — planes fade in when player is this close
    const angleStep = (Math.PI * 2) / BOUNDARY_SEGMENTS
    const planeWidth = 2 * BOUNDARY_RADIUS * Math.sin(angleStep / 2) + 0.2
    const BOUNDARY_TEX = Material.Texture.Common({ src: 'images/boundary-rgba.png' })

    const boundaryPlanes: { entity: Entity; px: number; pz: number; lastAlpha: number }[] = []

    for (let i = 0; i < BOUNDARY_SEGMENTS; i++) {
      const angle = angleStep * i + angleStep / 2
      const px = BOUNDARY_CX + Math.cos(angle) * BOUNDARY_RADIUS
      const pz = BOUNDARY_CZ + Math.sin(angle) * BOUNDARY_RADIUS
      const rotY = -angle * (180 / Math.PI) + 90
      const py = BOUNDARY_HEIGHT / 2

      // Invisible collider wall — stacked 10m segments for reliable physics
      const WALL_SEGMENT_H = 10
      const WALL_SEGMENTS = Math.ceil(BOUNDARY_HEIGHT / WALL_SEGMENT_H)
      for (let s = 0; s < WALL_SEGMENTS; s++) {
        const wall = engine.addEntity()
        const segY = WALL_SEGMENT_H / 2 + s * WALL_SEGMENT_H
        Transform.create(wall, {
          position: Vector3.create(px, segY, pz),
          scale: Vector3.create(planeWidth, WALL_SEGMENT_H, 4),
          rotation: Quaternion.fromEulerDegrees(0, rotY, 0)
        })
        MeshCollider.setBox(wall, ColliderLayer.CL_PHYSICS)
      }

      // Visual plane — fades in/out based on proximity
      const plane = engine.addEntity()
      Transform.create(plane, {
        position: Vector3.create(px, py, pz),
        scale: Vector3.create(planeWidth, BOUNDARY_HEIGHT, 1),
        rotation: Quaternion.fromEulerDegrees(0, rotY, 0)
      })
      MeshRenderer.setPlane(plane)
      Material.setPbrMaterial(plane, {
        texture: BOUNDARY_TEX,
        albedoColor: Color4.White(),
        emissiveColor: Color3.create(0.6, 0.1, 0.0),
        emissiveIntensity: 1.5,
        transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
        castShadows: false
      })
      VisibilityComponent.create(plane, { visible: false })
      boundaryPlanes.push({ entity: plane, px, pz, lastAlpha: 0 })
    }

    // Fade boundary planes based on player proximity
    engine.addSystem(() => {
      const playerPos = Transform.getOrNull(engine.PlayerEntity)
      if (!playerPos) return
      const playerX = playerPos.position.x
      const playerZ = playerPos.position.z

      for (const bp of boundaryPlanes) {
        const dx = playerX - bp.px
        const dz = playerZ - bp.pz
        const dist = Math.sqrt(dx * dx + dz * dz)

        const alpha = dist < BOUNDARY_SHOW_DIST ? 1.0 - (dist / BOUNDARY_SHOW_DIST) : 0

        if (Math.abs(alpha - bp.lastAlpha) < 0.05) continue
        bp.lastAlpha = alpha

        const vis = VisibilityComponent.getMutable(bp.entity)
        if (alpha < 0.01) {
          vis.visible = false
        } else {
          vis.visible = true
          Material.setPbrMaterial(bp.entity, {
            texture: BOUNDARY_TEX,
            albedoColor: Color4.create(1, 1, 1, alpha),
            emissiveColor: Color3.create(0.6, 0.1, 0.0),
            emissiveIntensity: 1.5,
            transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
            castShadows: false
          })
        }
      }
    })
  }

  // Glowing orbs at green diamond block locations
  const greenDiamondPositions = [
    { x: 290.5, y: 2.6, z: 254.7 },    // Diamond - Green
    { x: 276.56, y: 52.25, z: 301.5 } // Diamond - Green_2
  ]
  const ORB_COLOR = Color3.create(1.0, 0.45, 0.05) // Orange
  const ORB_BASE_SCALE = 1.2

  const orbEntities: ReturnType<typeof engine.addEntity>[] = []

  for (const pos of greenDiamondPositions) {
    const baseY = pos.y + 1

    // Orb sphere with emissive glow material
    const orb = engine.addEntity()
    Transform.create(orb, {
      position: Vector3.create(pos.x, baseY, pos.z),
      scale: Vector3.create(ORB_BASE_SCALE, ORB_BASE_SCALE, ORB_BASE_SCALE)
    })
    MeshRenderer.setSphere(orb)
    Material.setPbrMaterial(orb, {
      albedoColor: Color4.create(1.0, 0.4, 0.0, 0.85),
      emissiveColor: ORB_COLOR,
      emissiveIntensity: 4.0,
      roughness: 0.2,
      metallic: 0.0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
    })

    // Point light for glow bounce on surroundings
    const light = engine.addEntity()
    Transform.create(light, {
      parent: orb,
      position: Vector3.Zero()
    })
    LightSource.create(light, {
      type: LightSource.Type.Point({}),
      color: ORB_COLOR,
      intensity: 150,
      range: 12
    })

    orbEntities.push(orb)
  }

  // Pulsate all orb scales over time (orange + blue share the same timer)
  let orbPulseTime = 0
  const ORB_PULSE_SPEED = 3.0
  const ORB_PULSE_RANGE = 0.15 // ±15% scale oscillation

  // Teleport sounds — one per orb, both fire on teleport
  const orbSoundEntities: ReturnType<typeof engine.addEntity>[] = []
  for (const pos of greenDiamondPositions) {
    const snd = engine.addEntity()
    Transform.create(snd, { position: Vector3.create(pos.x, pos.y + 1, pos.z) })
    AudioSource.create(snd, {
      audioClipUrl: 'assets/sounds/rs-teleport.mp3',
      playing: false,
      loop: false,
      volume: 1,
      global: false
    })
    orbSoundEntities.push(snd)
  }

  // Orb teleportation constants
  const ORB_TRIGGER_RADIUS = 1.5
  const ORB_LAND_OFFSET = 3 // meters away from destination orb
  const TELEPORT_COOLDOWN = 1.0 // seconds

  // Teleport state for each orb pair
  const wasInsideOrb = [false, false]
  let orangeOrbCooldown = 0
  const wasInsideBlueOrb = [false, false]
  let blueOrbCooldown = 0

  // Combined teleportation system for all orb pairs
  engine.addSystem((dt: number) => {
    if (orangeOrbCooldown > 0) orangeOrbCooldown -= dt
    if (blueOrbCooldown > 0) blueOrbCooldown -= dt
    if (!Transform.has(engine.PlayerEntity)) return
    const playerPos = Transform.get(engine.PlayerEntity).position

    // Orange orbs
    for (let i = 0; i < greenDiamondPositions.length; i++) {
      const orbPos = greenDiamondPositions[i]
      const dist = Vector3.distance(playerPos, Vector3.create(orbPos.x, orbPos.y + 1, orbPos.z))
      const isInside = dist < ORB_TRIGGER_RADIUS

      if (isInside && !wasInsideOrb[i] && orangeOrbCooldown <= 0) {
        const destIndex = i === 0 ? 1 : 0
        const dest = greenDiamondPositions[destIndex]

        for (const snd of orbSoundEntities) {
          const a = AudioSource.getMutable(snd)
          a.currentTime = 0
          a.playing = true
        }

        orangeOrbCooldown = TELEPORT_COOLDOWN
        void movePlayerTo({
          newRelativePosition: Vector3.create(dest.x + ORB_LAND_OFFSET, dest.y + 1, dest.z)
        })
      }

      wasInsideOrb[i] = isInside
    }

    // Blue orbs
    for (let i = 0; i < blueOrbPositions.length; i++) {
      const orbPos = blueOrbPositions[i]
      const dist = Vector3.distance(playerPos, Vector3.create(orbPos.x, orbPos.y + 1, orbPos.z))
      const isInside = dist < ORB_TRIGGER_RADIUS

      if (isInside && !wasInsideBlueOrb[i] && blueOrbCooldown <= 0) {
        const destIndex = i === 0 ? 1 : 0
        const dest = blueOrbPositions[destIndex]

        for (const snd of blueOrbSoundEntities) {
          const a = AudioSource.getMutable(snd)
          a.currentTime = 0
          a.playing = true
        }

        blueOrbCooldown = TELEPORT_COOLDOWN
        void movePlayerTo({
          newRelativePosition: Vector3.create(dest.x + ORB_LAND_OFFSET, dest.y + 1, dest.z)
        })
      }

      wasInsideBlueOrb[i] = isInside
    }
  })

  // ── Blue Orb Pair ──
  const blueOrbPositions = [
    { x: 224, y: 2.3, z: 288 },
    { x: 226.3, y: 2.8, z: 211.3 }
  ]
  const BLUE_ORB_COLOR = Color3.create(0.05, 0.3, 1.0) // Blue
  const BLUE_ORB_BASE_SCALE = 1.2

  const blueOrbEntities: ReturnType<typeof engine.addEntity>[] = []

  for (const pos of blueOrbPositions) {
    const baseY = pos.y + 1

    const orb = engine.addEntity()
    Transform.create(orb, {
      position: Vector3.create(pos.x, baseY, pos.z),
      scale: Vector3.create(BLUE_ORB_BASE_SCALE, BLUE_ORB_BASE_SCALE, BLUE_ORB_BASE_SCALE)
    })
    MeshRenderer.setSphere(orb)
    Material.setPbrMaterial(orb, {
      albedoColor: Color4.create(0.0, 0.2, 1.0, 0.85),
      emissiveColor: BLUE_ORB_COLOR,
      emissiveIntensity: 4.0,
      roughness: 0.2,
      metallic: 0.0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
    })

    const light = engine.addEntity()
    Transform.create(light, {
      parent: orb,
      position: Vector3.Zero()
    })
    LightSource.create(light, {
      type: LightSource.Type.Point({}),
      color: BLUE_ORB_COLOR,
      intensity: 150,
      range: 12
    })

    blueOrbEntities.push(orb)
  }

  // Combined pulse system for all orbs
  engine.addSystem((dt: number) => {
    orbPulseTime += dt
    const pulse = 1 + ORB_PULSE_RANGE * Math.sin(orbPulseTime * ORB_PULSE_SPEED)
    const sOrange = ORB_BASE_SCALE * pulse
    for (const orb of orbEntities) {
      if (Transform.has(orb)) {
        const t = Transform.getMutable(orb)
        t.scale = Vector3.create(sOrange, sOrange, sOrange)
      }
    }
    const sBlue = BLUE_ORB_BASE_SCALE * pulse
    for (const orb of blueOrbEntities) {
      if (Transform.has(orb)) {
        const t = Transform.getMutable(orb)
        t.scale = Vector3.create(sBlue, sBlue, sBlue)
      }
    }
  })

  // Blue orb teleport sounds
  const blueOrbSoundEntities: ReturnType<typeof engine.addEntity>[] = []
  for (const pos of blueOrbPositions) {
    const snd = engine.addEntity()
    Transform.create(snd, { position: Vector3.create(pos.x, pos.y + 1, pos.z) })
    AudioSource.create(snd, {
      audioClipUrl: 'assets/sounds/rs-teleport.mp3',
      playing: false,
      loop: false,
      volume: 1,
      global: false
    })
    blueOrbSoundEntities.push(snd)
  }

  // ── Reload drop: if we were carrying the flag when /reload happened, drop it ──
  // Flag CRDT data arrives after a few frames, so we poll briefly on startup.
  if (local) {
    const { Flag, FlagState } = await import('./shared/components')
    let reloadCheckFrames = 0
    const RELOAD_CHECK_MAX_FRAMES = 60 // ~1 second at 60fps
    engine.addSystem(function reloadDropSystem() {
      reloadCheckFrames++
      for (const [, flag] of engine.getEntitiesWith(Flag)) {
        if (flag.state === FlagState.Carried && flag.carrierPlayerId === local.userId) {
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
    'models/solid_red.glb',
    'models/gold.glb',
    'models/solid_blue.glb',
    'models/solid_green.glb',
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
  engine.addSystem(waterSplashSystem)

  // Mailbox — click to leave feedback
  engine.addSystem(mailboxSystem)
  engine.addSystem(chestSystem)



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
  engine.addSystem(shieldSystem)
  engine.addSystem(updateHoldTimeInterpolation)

  // ── Round-end cinematic camera ──
  // Camera at green cube looking toward red cube
  const GREEN_CUBE_POS = Vector3.create(258.78, 19.25, 227.81)
  const RED_CUBE_POS = Vector3.create(265.57, 19.51, 219.65)

  const cinematicCam = engine.addEntity()
  Transform.create(cinematicCam, {
    position: GREEN_CUBE_POS,
  })

  const lookTarget = engine.addEntity()
  Transform.create(lookTarget, { position: RED_CUBE_POS })

  VirtualCamera.create(cinematicCam, {
    lookAtEntity: lookTarget,
    defaultTransition: {
      transitionMode: VirtualCamera.Transition.Time(0.01)
    }
  })

  let cinematicTimer = 0
  let isWinnerLocalPlayer = false
  let isPodiumPlayer = false // true for 1st, 2nd, or 3rd place

  // Fade state machine: 0=idle, 1=fading in (to black), 2=holding black, 3=fading out (reveal), 4=showing, 5=end fade in, 6=end hold black, 7=end fade out
  let fadePhase = 0
  let fadeTimer = 0
  const FADE_IN_DUR = 1.5    // fade to black
  const FADE_HOLD_DUR = 0.3  // hold black while teleport settles
  const FADE_OUT_DUR = 1.0   // reveal cinematic
  const END_FADE_IN_DUR = 0.8  // fade to black at end
  const END_FADE_HOLD_DUR = 0.3
  const END_FADE_OUT_DUR = 0.8 // reveal gameplay

  engine.addSystem((dt: number) => {
    // ── Fade overlay system ──
    if (fadePhase > 0) {
      fadeTimer -= dt
      if (fadePhase === 1) {
        // Fading to black
        const progress = 1 - Math.max(0, fadeTimer / FADE_IN_DUR)
        setCinematicFade(progress)
        if (fadeTimer <= 0) {
          setCinematicFade(1)
          fadePhase = 2
          fadeTimer = FADE_HOLD_DUR
        }
      } else if (fadePhase === 2) {
        // Hold black — camera is already active, teleport already done
        setCinematicFade(1)
        if (fadeTimer <= 0) {
          setCinematicShowing(true)
          fadePhase = 3
          fadeTimer = FADE_OUT_DUR
        }
      } else if (fadePhase === 3) {
        // Fading from black to reveal cinematic
        const progress = Math.max(0, fadeTimer / FADE_OUT_DUR)
        setCinematicFade(progress)
        if (fadeTimer <= 0) {
          setCinematicFade(0)
          fadePhase = 4 // now just wait for cinematicTimer to expire
        }
      } else if (fadePhase === 4) {
        // Showing cinematic — wait for cinematicTimer
        // (handled below)
      } else if (fadePhase === 5) {
        // End: fading to black
        const progress = 1 - Math.max(0, fadeTimer / END_FADE_IN_DUR)
        setCinematicFade(progress)
        if (fadeTimer <= 0) {
          setCinematicFade(1)
          setCinematicShowing(false)
          // Release camera and restore movement while black
          MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = undefined as any
          if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
          console.log('[Client] 🎬 Cinematic camera released, movement restored')

          if (isPodiumPlayer) {
            isWinnerLocalPlayer = false
            isPodiumPlayer = false
            const spawnX = 261.75 + Math.random() * 3
            const spawnZ = 296.5 + Math.random() * 3
            void movePlayerTo({
              newRelativePosition: { x: spawnX, y: 47.48, z: spawnZ },
            })
            console.log('[Client] 📍 Podium player returned to spawn')
          }

          fadePhase = 6
          fadeTimer = END_FADE_HOLD_DUR
        }
      } else if (fadePhase === 6) {
        // End: hold black
        setCinematicFade(1)
        if (fadeTimer <= 0) {
          fadePhase = 7
          fadeTimer = END_FADE_OUT_DUR
        }
      } else if (fadePhase === 7) {
        // End: fade from black to gameplay
        const progress = Math.max(0, fadeTimer / END_FADE_OUT_DUR)
        setCinematicFade(progress)
        if (fadeTimer <= 0) {
          setCinematicFade(0)
          fadePhase = 0
          setCinematicActive(false)
          console.log('[Client] 🎬 Cinematic sequence complete')
        }
      }
    }

    // ── Cinematic timer (how long to show the podium view) ──
    if (cinematicTimer <= 0) return
    cinematicTimer -= dt
    if (cinematicTimer <= 0 && fadePhase === 4) {
      // Start end-fade sequence
      fadePhase = 5
      fadeTimer = END_FADE_IN_DUR
    }
  })

  // Respawn all players at spawn point when round ends
  room.onMessage('respawnPlayers', () => {
    const localPlayer = getPlayer()
    const localUserId = localPlayer?.userId?.toLowerCase() ?? ''

    // Read top 3 from CountdownTimer CRDT (roundWinnerJson)
    let topPlayers: Array<{ userId: string; seconds: number }> = []
    for (const [, timer] of engine.getEntitiesWith(CountdownTimer)) {
      if (timer.roundWinnerJson) {
        try {
          const data = JSON.parse(timer.roundWinnerJson) as Array<{ userId?: string; seconds: number }>
          topPlayers = data
            .filter(d => d.userId && d.seconds > 0)
            .map(d => ({ userId: d.userId!.toLowerCase(), seconds: d.seconds }))
        } catch { /* ignore */ }
      }
      break
    }

    const place1 = topPlayers[0]?.userId ?? null
    const place2 = topPlayers[1]?.userId ?? null
    const place3 = topPlayers[2]?.userId ?? null

    isWinnerLocalPlayer = !!(place1 && place1 === localUserId)
    const isSecondPlace = !!(place2 && place2 === localUserId)
    const isThirdPlace = !!(place3 && place3 === localUserId)
    isPodiumPlayer = isWinnerLocalPlayer || isSecondPlace || isThirdPlace
    console.log('[Client] Top 3:', place1, place2, place3, '| Local:', localUserId)

    const GREEN_CUBE = { x: 258.78, y: 19.25, z: 227.81 }

    // Freeze movement IMMEDIATELY
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({
        disableWalk: true,
        disableRun: true,
        disableJump: true,
        disableJog: true,
        disableGliding: true,
        disableDoubleJump: true,
        // disableEmote intentionally omitted — allow players to override celebration emotes
      })
    })

    // Start fade to black FIRST — then teleport once fully black
    fadePhase = 1
    fadeTimer = FADE_IN_DUR
    cinematicTimer = 10
    setCinematicActive(true)

    // Close all open UIs when cinematic begins
    setWinConditionOverlayVisible(false)
    setLeaderboardOverlayVisible(false)
    setAnalyticsOverlayVisible(false)
    hideMailboxPopup()
    hideChestPopup()
    exitSpectatorMode()

    // Delay teleport + camera until screen is fully black
    setTimeout(() => {
    if (isWinnerLocalPlayer) {
      void movePlayerTo({
        newRelativePosition: { x: 265.57, y: 19.51, z: 219.65 },
        cameraTarget: GREEN_CUBE,
      })
      setTimeout(() => { void triggerEmote({ predefinedEmote: 'handsair' }) }, 1500)
      console.log('[Client] 🏆 1st place teleported to red cube!')
    } else if (isSecondPlace) {
      void movePlayerTo({
        newRelativePosition: { x: 266.97, y: 18.85, z: 220.87 },
        cameraTarget: GREEN_CUBE,
      })
      setTimeout(() => { void triggerEmote({ predefinedEmote: 'clap' }) }, 1500)
      console.log('[Client] 🥈 2nd place teleported to gold cube!')
    } else if (isThirdPlace) {
      void movePlayerTo({
        newRelativePosition: { x: 264.25, y: 18.16, z: 218.57 },
        cameraTarget: GREEN_CUBE,
      })
      setTimeout(() => { void triggerEmote({ predefinedEmote: 'clap' }) }, 1500)
      console.log('[Client] 🥉 3rd place teleported to blue cube!')
    } else {
      const spawnX = 261.75 + Math.random() * 3
      const spawnZ = 296.5 + Math.random() * 3
      void movePlayerTo({
        newRelativePosition: { x: spawnX, y: 47.48, z: spawnZ },
      })
    }

      // Activate cinematic camera (screen is fully black now)
      MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = cinematicCam
      console.log('[Client] 📍 Round ended — players repositioned')
    }, FADE_IN_DUR * 1000 + 50) // wait for fade to complete + small buffer

    console.log('[Client] 🎬 Cinematic fade sequence started (10 seconds)')
  })

}
