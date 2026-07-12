/**
 * terrainSetup.ts — Static world terrain mesh + invisible ground collider.
 * Loads assets/models/terrain.glb and adds an 800×800 collider plane at y=0
 * so players never fall through the world.
 */
import { engine, Transform, GltfContainer, MeshCollider, VisibilityComponent, ColliderLayer } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

export function setupTerrain(): void {
  const terrain = engine.addEntity()
  Transform.create(terrain, {
    position: Vector3.create(0, 37, 0),
  })
  GltfContainer.create(terrain, {
    src: 'assets/models/terrain.glb',
    visibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS,
    invisibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS,
  })
  console.log('[Terrain] 🗺️  Loaded terrain.glb')

  // Invisible ground collider covering the entire 800×800 scene at y=0
  const groundCollider = engine.addEntity()
  Transform.create(groundCollider, {
    position: Vector3.create(400, 48, 400),
    scale: Vector3.create(800, 0.1, 800),
  })
  MeshCollider.setBox(groundCollider, ColliderLayer.CL_PHYSICS)
  VisibilityComponent.create(groundCollider, { visible: false })
  console.log('[Terrain] 🗿 Added 800×800 invisible ground collider at y=0')
}
