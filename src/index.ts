import { Vector3, Color4, Color3, Quaternion } from '@dcl/sdk/math'
import { engine, Entity, Transform, AudioSource, MeshCollider, MeshRenderer, Material, MaterialTransparencyMode, LightSource, AvatarModifierArea, AvatarModifierType, Name, VisibilityComponent, ColliderLayer } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { getPlayer, onEnterScene, onLeaveScene } from '@dcl/sdk/players'
import { setupUi } from './ui'
import { flagClientSystem } from './systems/flagSystem'
import { combatClientSystem } from './systems/combatSystem'
import { bananaClientSystem } from './systems/bananaSystem'
import { shellClientSystem } from './systems/shellSystem'
import { mushroomClientSystem } from './systems/mushroomSystem'
import { shieldSystem } from './systems/shieldSystem'
import { setupProximityLights, proximityLightSystem } from './systems/proximityLights'
import { setupSpectator } from './systems/spectatorSystem'
import { waterSystem } from './systems/waterSystem'
import { mailboxSystem } from './systems/mailboxSystem'

import { setupUpdraftSystem, updraftSystem } from './systems/updraftSystem'
import { waterBobSystem } from './systems/waterBobSystem'
import { waterSplashSystem } from './systems/waterSplashSystem'
import { setupBeacon, beaconClientSystem } from './systems/beaconSystem'
import { Portal } from './systems/portals/portal'
import { addPlayer, removePlayer, nameResolverSystem, updateHoldTimeInterpolation } from './gameState/flagHoldTime'
import { addPlayerSession, removePlayerSession } from './gameState/sceneTime'
import { createWinConditionOverlayEntity } from './components/winConditionOverlayState'
import { createLeaderboardOverlayEntity } from './components/leaderboardOverlayState'
import { createAnalyticsOverlayEntity } from './components/analyticsOverlayState'
import { movePlayerTo } from '~system/RestrictedActions'
import './shared/components'
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
    { x: 213, y: 1, z: 354.5 },       // Diamond - Green
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
    { x: 264.75, y: 18, z: 220.5 }
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
          console.log('[Main] Detected flag carry on scene load (likely /reload) — requesting drop')
          room.send('requestDrop', { t: 0 })
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

  // Water slowdown — disable running in water
  engine.addSystem(waterSystem)
  engine.addSystem(waterBobSystem)
  engine.addSystem(waterSplashSystem)

  // Mailbox — click to leave feedback
  engine.addSystem(mailboxSystem)



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
  engine.addSystem(bananaClientSystem)
  engine.addSystem(shellClientSystem)
  engine.addSystem(mushroomClientSystem)
  engine.addSystem(shieldSystem)
  engine.addSystem(updateHoldTimeInterpolation)

  // Respawn all players at spawn point when round ends
  room.onMessage('respawnPlayers', () => {
    // Spawn area from scene.json: x 261.75–264.75, y 47.48, z 296.5–299.5
    const spawnX = 261.75 + Math.random() * 3
    const spawnZ = 296.5 + Math.random() * 3
    void movePlayerTo({
      newRelativePosition: { x: spawnX, y: 47.48, z: spawnZ },
    })
    console.log('[Client] 📍 Respawned at spawn point for new round')
  })

}
