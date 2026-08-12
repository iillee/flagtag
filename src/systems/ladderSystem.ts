import { engine, Transform, MeshCollider, pointerEventsSystem, InputAction, Name, ColliderLayer, GltfContainer } from '@dcl/sdk/ecs'
import { registerThrottled, removeSystem } from './systemManager'
import { Vector3 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'

const MAX_CLICK_DISTANCE = 12

const LADDERS = [
  {
    base: Vector3.create(352.1, 48, 431.8),
    top: Vector3.create(352.1, 65.9, 431.8),
    cameraTarget: Vector3.create(352.1, 66.9, 429.8)
  },
  {
    base: Vector3.create(406.13, 49.25, 427.75),
    top: Vector3.create(404.7, 65.6, 426.8),
    cameraTarget: Vector3.create(404.7, 66.6, 424.8)
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

  const findLadders = (dt: number) => {
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

        // Keep the ladder GLB as a physical collider only — do NOT make it
        // pointer-clickable. The thin ladder mesh sat in front of our invisible
        // click box and stole every click, making the ladder frustrating to tap
        // (especially on mobile). All click handling now goes through the
        // generous invisible box below.
        const gltf = GltfContainer.getMutable(entity)
        gltf.visibleMeshesCollisionMask = ColliderLayer.CL_PHYSICS
        gltf.invisibleMeshesCollisionMask = ColliderLayer.CL_PHYSICS

        const ladderTop = closest.top
        const camTarget = closest.cameraTarget
        const climb = () => climbTo(ladderTop, camTarget)

        // Generous invisible click box, positioned in WORLD space using the
        // known ladder config — not parented to the GLB, because the GLB's
        // local origin is not guaranteed to be at the ladder base (a previous
        // attempt used a huge parented box to hide that uncertainty). Fat on
        // both horizontal axes so the ladder is easy to tap from any angle,
        // especially on mobile.
        const midY = (closest.base.y + closest.top.y) / 2
        const height = (closest.top.y - closest.base.y) + 4 // 2m padding above/below
        const clickBox = engine.addEntity()
        Transform.create(clickBox, {
          position: Vector3.create(closest.base.x, midY, closest.base.z),
          scale: Vector3.create(5, height, 5)
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

        found++
        console.log(`[Ladder] Setup #${found} at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`)

        if (found >= LADDERS.length) {
          console.log('[Ladder] All ladders configured')
          removeSystem(findLadders)
          return
        }
      }
    }
  }
  registerThrottled(findLadders, 1.0)
}
