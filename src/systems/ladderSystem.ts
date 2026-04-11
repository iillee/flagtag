import { engine, Transform, MeshCollider, pointerEventsSystem, InputAction, Name, ColliderLayer, GltfContainer } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'

const LADDER_TOP = Vector3.create(230.1, 17.9, 337.8)
const MAX_CLICK_DISTANCE = 6

function climb() {
  void movePlayerTo({
    newRelativePosition: LADDER_TOP,
    cameraTarget: Vector3.create(LADDER_TOP.x, LADDER_TOP.y + 1, LADDER_TOP.z - 2)
  })
}

export function setupLadder() {
  engine.addSystem(function findLadder() {
    for (const [entity] of engine.getEntitiesWith(Name)) {
      const name = Name.get(entity).value
      if (name === 'ladder.glb') {
        // Make ladder mesh clickable (gives the green highlight)
        const gltf = GltfContainer.getMutable(entity)
        gltf.visibleMeshesCollisionMask = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS
        gltf.invisibleMeshesCollisionMask = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS

        pointerEventsSystem.onPointerDown(
          {
            entity: entity,
            opts: {
              button: InputAction.IA_POINTER,
              hoverText: 'Climb',
              maxDistance: MAX_CLICK_DISTANCE
            }
          },
          climb
        )

        // Generous invisible click box (easier to grab)
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
              maxDistance: MAX_CLICK_DISTANCE
            }
          },
          climb
        )

        console.log('[Ladder] Setup complete')
        engine.removeSystem(findLadder)
        return
      }
    }
  })
}
