import {
  engine,
  Transform,
  GltfContainer,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { Zombie } from '../shared/components'
import { room } from '../shared/messages'
import { showHitEffect, initPools as initCombatPools } from './combatSystem'

// ── Visual constants ──
const GHOST_MODEL_SRC = 'models/ghost.glb'

// ── Client-side zombie tracking ──
interface ClientZombie {
  entity: Entity
  modelEntity: Entity    // GLB model
  time: number           // accumulated time for bob/drift
  lastServerPos: Vector3 // last known server position
  renderPos: Vector3     // interpolated render position
  dead: boolean
}

const clientZombies = new Map<Entity, ClientZombie>()

// ── Death VFX from server ──
const pendingDeathPositions: Vector3[] = []

room.onMessage('zombieKilled', (data) => {
  pendingDeathPositions.push(Vector3.create(data.x, data.y, data.z))
})

// ── Detect boomerang hits on zombies (client reports to server) ──
// We check distance from active projectiles to zombie positions each frame.
// Import projectile tracking if needed — for now we use a simpler approach:
// The server checks projectile-zombie collisions directly.

export function zombieClientSystem(dt: number): void {
  initCombatPools()

  // Process death VFX
  for (const pos of pendingDeathPositions) {
    showHitEffect(pos)
  }
  pendingDeathPositions.length = 0

  // Track which zombie entities currently exist (server-synced via CRDT)
  const activeZombieEntities = new Set<Entity>()

  for (const [entity] of engine.getEntitiesWith(Zombie, Transform)) {
    activeZombieEntities.add(entity)
    const zombie = Zombie.get(entity)
    const serverTransform = Transform.get(entity)

    if (!zombie.active) {
      // Zombie deactivated — remove visual if exists
      removeZombieVisual(entity)
      continue
    }

    let cz = clientZombies.get(entity)
    if (!cz) {
      // Create visual for new zombie
      cz = createZombieVisual(entity, serverTransform.position)
      clientZombies.set(entity, cz)
    }

    // Update time for animations
    cz.time += dt
    cz.lastServerPos = Vector3.create(serverTransform.position.x, serverTransform.position.y, serverTransform.position.z)

    // Smooth interpolation toward server position
    const lerpSpeed = 5.0
    cz.renderPos = Vector3.lerp(cz.renderPos, cz.lastServerPos, Math.min(1, lerpSpeed * dt))

    // Add floaty bob and lateral drift
    const bobY = Math.sin(cz.time * 3.14) * 0.3
    const driftX = Math.sin(cz.time * 1.7) * 0.3
    const driftZ = Math.cos(cz.time * 1.3) * 0.3

    const finalPos = Vector3.create(
      cz.renderPos.x + driftX,
      cz.renderPos.y + bobY + 1.0, // float above ground
      cz.renderPos.z + driftZ
    )

    // Update model transform
    const modelT = Transform.getMutable(cz.modelEntity)
    modelT.position = finalPos

    // Face toward movement direction (smooth rotation)
    const dx = cz.lastServerPos.x - cz.renderPos.x
    const dz = cz.lastServerPos.z - cz.renderPos.z
    if (dx * dx + dz * dz > 0.001) {
      const angle = Math.atan2(dx, dz) * (180 / Math.PI)
      modelT.rotation = Quaternion.fromEulerDegrees(0, angle, 0)
    }

    // Gentle scale pulse
    const pulse = 1.0 + Math.sin(cz.time * 5.0) * 0.03
    modelT.scale = Vector3.create(1.2 * pulse, 1.2 * pulse, 1.2 * pulse)
  }

  // Clean up visuals for zombies that no longer exist
  for (const [entity, cz] of clientZombies) {
    if (!activeZombieEntities.has(entity)) {
      destroyZombieVisual(cz)
      clientZombies.delete(entity)
    }
  }
}

function createZombieVisual(serverEntity: Entity, pos: Vector3): ClientZombie {
  const modelEntity = engine.addEntity()
  Transform.create(modelEntity, {
    position: Vector3.create(pos.x, pos.y + 1.0, pos.z),
    scale: Vector3.create(1.2, 1.2, 1.2)
  })
  GltfContainer.create(modelEntity, { src: GHOST_MODEL_SRC })

  return {
    entity: serverEntity,
    modelEntity,
    time: Math.random() * 10,
    lastServerPos: Vector3.create(pos.x, pos.y, pos.z),
    renderPos: Vector3.create(pos.x, pos.y, pos.z),
    dead: false
  }
}

function removeZombieVisual(entity: Entity): void {
  const cz = clientZombies.get(entity)
  if (cz) {
    destroyZombieVisual(cz)
    clientZombies.delete(entity)
  }
}

function destroyZombieVisual(cz: ClientZombie): void {
  engine.removeEntity(cz.modelEntity)
}
