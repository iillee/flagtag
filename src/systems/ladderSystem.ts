import { engine, Transform, MeshCollider, pointerEventsSystem, InputAction, Name, ColliderLayer, GltfContainer } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'

const MAX_CLICK_DISTANCE = 6

const LADDERS = [
  {
    base: Vector3.create(230.1, 0, 337.8),
    top: Vector3.create(230.1, 17.9, 337.8),
    cameraTarget: Vector3.create(230.1, 18.9, 335.8)
  },
  {
    base: Vector3.create(284.13, 1.25, 333.75),
    top: Vector3.create(282.7, 17.6, 332.8),
    cameraTarget: Vector3.create(282.7, 18.6, 330.8)
  }
]

function climbTo(top: Vector3, cameraTarget: Vector3) {
  void movePlayerTo({
    newRelativePosition: top,
    cameraTarget
  })
}

export function setupLadder() {
  let found = 0

  engine.addSystem(function findLadders() {
    for (const [entity] of engine.getEntitiesWith(Name)) {
      const name = Name.get(entity).value
      if (name.toLowerCase().includes('ladder')) {
        console.log(`[Ladder] Found entity named "${name}" at`, JSON.stringify(Transform.get(entity).position))
      }
      if (name.startsWith('ladder.glb')) {
        const pos = Transform.get(entity).position

        // Match this entity to the closest ladder config
        let closest = LADDERS[0]
        let closestDist = Infinity
        for (const ladder of LADDERS) {
          const dist = Vector3.distanceSquared(pos, ladder.base)
          if (dist < closestDist) {
            closestDist = dist
            closest = ladder
          }
        }

        // Make ladder mesh clickable
        const gltf = GltfContainer.getMutable(entity)
        gltf.visibleMeshesCollisionMask = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS
        gltf.invisibleMeshesCollisionMask = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS

        const ladderTop = closest.top
        const camTarget = closest.cameraTarget
        const climb = () => climbTo(ladderTop, camTarget)

        pointerEventsSystem.onPointerDown(
          {
            entity,
            opts: {
              button: InputAction.IA_POINTER,
              hoverText: 'Climb',
              maxDistance: MAX_CLICK_DISTANCE
            }
          },
          climb
        )

        // Generous invisible click box
        const clickBox = engine.addEntity()
        Transform.create(clickBox, {
          position: Vector3.create(0, 17, 0),
          scale: Vector3.create(1, 70, 30),
          parent: entity
        })
        MeshCollider.setBox(clickBox, ColliderLayer.CL_POINTER)

        pointerEventsSystem.onPointerDown(
          {
            entity: clickBox,
            opts: {
              button: InputAction.IA_POINTER,
              hoverText: 'Climb',
              maxDistance: MAX_CLICK_DISTANCE,
              showFeedback: false
            }
          },
          climb
        )

        found++
        console.log(`[Ladder] Setup #${found} at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`)

        if (found >= LADDERS.length) {
          console.log('[Ladder] All ladders configured')
          engine.removeSystem(findLadders)
          return
        }
      }
    }
  })
}
