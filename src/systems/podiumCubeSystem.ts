import { engine, Entity, GltfContainer, VisibilityComponent, ColliderLayer } from '@dcl/sdk/ecs'

/**
 * Hides the 4 podium marker cubes placed via Creator Hub composite.
 * Red=1st, Gold=2nd, Blue=3rd, Green=camera target.
 * They must stay in the composite so cinematicSystem can find them by GLB src,
 * but they should be invisible and non-collidable at runtime.
 */
const PODIUM_CUBE_SRCS = new Set([
  'assets/models/solid_red.glb',
  'assets/models/gold.glb',
  'assets/models/solid_blue.glb',
  'assets/models/solid_green.glb',
])

export function setupPodiumCubeHiding() {
  const hiddenPodiumCubes = new Set<Entity>()

  engine.addSystem(function hidePodiumCubes() {
    for (const [entity] of engine.getEntitiesWith(GltfContainer)) {
      if (hiddenPodiumCubes.has(entity)) continue
      const gltf = GltfContainer.get(entity)
      if (PODIUM_CUBE_SRCS.has(gltf.src)) {
        VisibilityComponent.createOrReplace(entity, { visible: false })
        GltfContainer.createOrReplace(entity, {
          ...gltf,
          invisibleMeshesCollisionMask: ColliderLayer.CL_NONE,
          visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
        })
        hiddenPodiumCubes.add(entity)
        console.log(`[Client] 🎯 Hidden podium cube: ${gltf.src}`)
      }
    }
    if (hiddenPodiumCubes.size >= 4) {
      engine.removeSystem(hidePodiumCubes)
      console.log('[Client] ✅ All 4 podium cubes hidden')
    }
  })
}
