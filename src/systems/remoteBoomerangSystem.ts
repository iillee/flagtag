/**
 * Manages boomerang hand models for remote players.
 * When a player changes their boomerang color, the server broadcasts it.
 * Each client creates/updates AvatarAttach boomerangs for other players.
 */
import {
  engine,
  Transform,
  GltfContainer,
  AvatarAttach,
  AvatarAnchorPointType,
  VisibilityComponent,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import { room } from '../shared/messages'
import { BoomerangColor, getBoomerangColor, onBoomerangColorChange } from '../gameState/boomerangColor'

interface RemoteBoomerang {
  anchor: Entity
  model: Entity
  color: BoomerangColor
}

const remoteBoomerangs = new Map<string, RemoteBoomerang>()

function createRemoteBoomerang(playerId: string, color: BoomerangColor): void {
  if (remoteBoomerangs.has(playerId)) {
    // Update existing
    const rb = remoteBoomerangs.get(playerId)!
    if (rb.color !== color) {
      rb.color = color
      GltfContainer.createOrReplace(rb.model, {
        src: `models/boomerang.${color}.glb`,
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })
    }
    VisibilityComponent.createOrReplace(rb.model, { visible: true })
    return
  }

  const anchor = engine.addEntity()
  AvatarAttach.create(anchor, {
    avatarId: playerId,
    anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND
  })
  Transform.create(anchor, { position: Vector3.Zero(), scale: Vector3.One() })

  const model = engine.addEntity()
  Transform.create(model, {
    parent: anchor,
    position: Vector3.create(0.04, 0.15, 0.1),
    scale: Vector3.create(1, 1.5, 1),
    rotation: Quaternion.fromEulerDegrees(0, 0, 90)
  })
  GltfContainer.create(model, {
    src: `models/boomerang.${color}.glb`,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  remoteBoomerangs.set(playerId, { anchor, model, color })
  console.log(`[RemoteBoomerang] Created hand boomerang for ${playerId} (${color})`)
}

function removeRemoteBoomerang(playerId: string): void {
  const rb = remoteBoomerangs.get(playerId)
  if (!rb) return
  engine.removeEntity(rb.model)
  engine.removeEntity(rb.anchor)
  remoteBoomerangs.delete(playerId)
}

export function setupRemoteBoomerangs(): void {
  // Listen for color changes from other players
  room.onMessage('playerColorChanged', (data) => {
    const playerId = data.playerId?.toLowerCase()
    if (!playerId) return

    // Skip local player — their hand boomerang is managed by projectileSystem
    // Re-fetch each time since getPlayerData() may return null during early setup
    const localUserId = getPlayerData()?.userId?.toLowerCase()
    if (localUserId && playerId === localUserId) return

    const color = (['r', 'y', 'b', 'g'].includes(data.color) ? data.color : 'r') as BoomerangColor
    console.log(`[RemoteBoomerang] Player ${playerId} color → ${color}`)
    createRemoteBoomerang(playerId, color)
  })

  // When LOCAL player changes color, notify server
  onBoomerangColorChange((color) => {
    room.send('colorChanged', { color })
  })
}

/** Remove a remote player's hand boomerang when they leave the scene. */
export function cleanupRemoteBoomerang(userId: string): void {
  removeRemoteBoomerang(userId.toLowerCase())
}
