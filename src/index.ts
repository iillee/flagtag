import { Vector3 } from '@dcl/sdk/math'
import { engine, Transform, AudioSource, MeshCollider, AvatarModifierArea, AvatarModifierType } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { getPlayer, onEnterScene, onLeaveScene } from '@dcl/sdk/players'
import { setupUi } from './ui'
import { flagClientSystem } from './systems/flagSystem'
import { combatClientSystem } from './systems/combatSystem'

import { setupBeacon, beaconClientSystem } from './systems/beaconSystem'

import { addPlayer, removePlayer } from './gameState/flagHoldTime'
import { addPlayerSession, removePlayerSession } from './gameState/sceneTime'
import { createWinConditionOverlayEntity } from './components/winConditionOverlayState'
import { createLeaderboardOverlayEntity } from './components/leaderboardOverlayState'
import { createAnalyticsOverlayEntity } from './components/analyticsOverlayState'
// Import shared components so they are registered on both server and client
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
    // Skip local player - already added above
    if (local && player.userId === local.userId) {
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

  // Client systems
  engine.addSystem(flagClientSystem)
  engine.addSystem(combatClientSystem)
  engine.addSystem(beaconClientSystem)
}
