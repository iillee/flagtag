import { Vector3, Color4, Color3 } from '@dcl/sdk/math'
import { engine, Transform, AudioSource, MeshCollider, MeshRenderer, Material, MaterialTransparencyMode, LightSource, AvatarModifierArea, AvatarModifierType } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { getPlayer, onEnterScene, onLeaveScene } from '@dcl/sdk/players'
import { setupUi } from './ui'
import { flagClientSystem } from './systems/flagSystem'
import { combatClientSystem } from './systems/combatSystem'
import { bananaClientSystem } from './systems/bananaSystem'
import { shellClientSystem } from './systems/shellSystem'
import { setupBeacon, beaconClientSystem } from './systems/beaconSystem'
import { addPlayer, removePlayer, nameResolverSystem, updateHoldTimeInterpolation } from './gameState/flagHoldTime'
import { addPlayerSession, removePlayerSession } from './gameState/sceneTime'
import { createWinConditionOverlayEntity } from './components/winConditionOverlayState'
import { createLeaderboardOverlayEntity } from './components/leaderboardOverlayState'
import { createAnalyticsOverlayEntity } from './components/analyticsOverlayState'
import { movePlayerTo } from '~system/RestrictedActions'
import './shared/components'
import { room } from './shared/messages'

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
  const musicEntity = engine.addEntity()
  Transform.create(musicEntity, { position: Vector3.create(0, 0, 0) })
  AudioSource.create(musicEntity, {
    audioClipUrl: 'assets/sounds/Medieval.mp3',
    playing: true,
    loop: true,
    volume: 0.175,
    global: true
  })

  // Disable passport UI (clicking on avatars to view profiles)
  // NOTE: The SDK does not provide a way to disable smart wearables/portable experiences.
  // Only AMT_HIDE_AVATARS and AMT_DISABLE_PASSPORTS are available as modifiers.
  // Smart wearables run in a separate context and cannot be disabled by scene code.
  const avatarModArea = engine.addEntity()
  Transform.create(avatarModArea, { position: Vector3.create(80, 10, 120) })
  AvatarModifierArea.create(avatarModArea, {
    area: Vector3.create(170, 50, 250), // Cover entire scene
    modifiers: [AvatarModifierType.AMT_DISABLE_PASSPORTS], // Disables passport UI only
    excludeIds: []
  })

  // Invisible boundary walls
  const SCENE_W = 160
  const SCENE_D = 240
  const WALL_H = 30
  const WALL_T = 1
  const walls = [
    { position: [WALL_T / 2, WALL_H / 2, SCENE_D / 2], scale: [WALL_T, WALL_H, SCENE_D] },
    { position: [SCENE_W - WALL_T / 2, WALL_H / 2, SCENE_D / 2], scale: [WALL_T, WALL_H, SCENE_D] },
    { position: [SCENE_W / 2, WALL_H / 2, WALL_T / 2], scale: [SCENE_W, WALL_H, WALL_T] },
    { position: [SCENE_W / 2, WALL_H / 2, SCENE_D - WALL_T / 2], scale: [SCENE_W, WALL_H, WALL_T] }
  ]
  for (const w of walls) {
    const e = engine.addEntity()
    Transform.create(e, {
      position: Vector3.create(w.position[0], w.position[1], w.position[2]),
      scale: Vector3.create(w.scale[0], w.scale[1], w.scale[2])
    })
    MeshCollider.setBox(e)
  }

  // Glowing orbs at green diamond block locations
  const greenDiamondPositions = [
    { x: 37, y: 0, z: 218.5 },       // Diamond - Green
    { x: 100.56, y: 51.25, z: 165.5 } // Diamond - Green_2
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
    { x: 54, y: 0.3, z: 152 },
    { x: 88.75, y: 17, z: 84.5 }
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

  // Client systems
  engine.addSystem(flagClientSystem)
  engine.addSystem(combatClientSystem)
  engine.addSystem(beaconClientSystem)
  engine.addSystem(nameResolverSystem)
  engine.addSystem(bananaClientSystem)
  engine.addSystem(shellClientSystem)
  engine.addSystem(updateHoldTimeInterpolation)


}
