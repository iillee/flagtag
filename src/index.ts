import { Vector3 } from '@dcl/sdk/math'
import { engine, Transform, AudioSource, MeshCollider, CameraModeArea, CameraType } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { getPlayer, onEnterScene, onLeaveScene } from '@dcl/sdk/players'
import { setupUi } from './ui'
import { flagClientSystem } from './systems/flagSystem'
import { combatClientSystem } from './systems/combatSystem'
import { countdownClientSystem } from './systems/countdownTimerSystem'
import { setupLocalTestFlag } from './systems/localTestFlag'
import { setupBeacon, beaconClientSystem } from './systems/beaconSystem'
import { addPlayer, removePlayer } from './gameState/flagHoldTime'
import { createWinConditionOverlayEntity } from './components/winConditionOverlayState'
import { createLeaderboardOverlayEntity } from './components/leaderboardOverlayState'
// Import shared components so they are registered on both server and client
import './shared/components'
import { room } from './shared/messages'

export async function main() {
  if (isServer()) {
    const { setupServer } = await import('./server/server')
    await setupServer()
    return
  }

  // ── Client setup ──
  createWinConditionOverlayEntity()
  createLeaderboardOverlayEntity()
  setupUi()
  setupBeacon()

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
    addPlayer(player.userId, player.name)
    // Also register name for other players entering
    const name = player.name || ''
    if (name && !name.startsWith('0x') && (!registeredName || registeredName.startsWith('0x'))) {
      // This is for the local player if onEnterScene fires with better data
      if (local && player.userId === local.userId) {
        registeredName = name
        room.send('registerName', { name })
      }
    }
  })
  onLeaveScene((userId) => removePlayer(userId))

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

  // Default to third-person camera, then remove the area so player can change freely
  const camArea = engine.addEntity()
  Transform.create(camArea, { position: Vector3.create(80, 120, 120) })
  CameraModeArea.create(camArea, {
    area: Vector3.create(200, 300, 280),
    mode: CameraType.CT_THIRD_PERSON
  })
  let camRemoveTimer = 2.0
  engine.addSystem((dt: number) => {
    camRemoveTimer -= dt
    if (camRemoveTimer <= 0) {
      engine.removeEntity(camArea)
      return camRemoveTimer = -999 // stop checking
    }
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
  engine.addSystem(countdownClientSystem)
  engine.addSystem(beaconClientSystem)

  // Local-only test flag (blue) — uncomment for local preview testing without server
  // setupLocalTestFlag() // Hidden for production deployment
}
