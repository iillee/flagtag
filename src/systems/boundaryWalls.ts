import { engine, Entity, Transform, MeshCollider, MeshRenderer, Material, MaterialTransparencyMode, VisibilityComponent, ColliderLayer } from '@dcl/sdk/ecs'
import { registerThrottled } from './systemManager'
import { Vector3, Quaternion, Color3, Color4 } from '@dcl/sdk/math'

/**
 * Creates a cylindrical boundary wall centered on the castle.
 * Faceted planes with gradient fade + stacked invisible collider segments.
 * Registers a proximity-fade system automatically.
 */
export function setupBoundaryWalls(): void {
  const BOUNDARY_CX = 250.75
  const BOUNDARY_CZ = 255.5
  const BOUNDARY_RADIUS = 128
  const BOUNDARY_HEIGHT = 200
  const BOUNDARY_SEGMENTS = 48
  const BOUNDARY_SHOW_DIST = 30
  const angleStep = (Math.PI * 2) / BOUNDARY_SEGMENTS
  const planeWidth = 2 * BOUNDARY_RADIUS * Math.sin(angleStep / 2) + 0.2
  const BOUNDARY_TEX = Material.Texture.Common({ src: 'assets/images/boundary-rgba.png' })

  const boundaryPlanes: { entity: Entity; px: number; pz: number; lastAlpha: number }[] = []

  for (let i = 0; i < BOUNDARY_SEGMENTS; i++) {
    const angle = angleStep * i + angleStep / 2
    const px = BOUNDARY_CX + Math.cos(angle) * BOUNDARY_RADIUS
    const pz = BOUNDARY_CZ + Math.sin(angle) * BOUNDARY_RADIUS
    const rotY = -angle * (180 / Math.PI) + 90
    const py = BOUNDARY_HEIGHT / 2

    // Invisible collider wall — stacked 10m segments for reliable physics
    const WALL_SEGMENT_H = 10
    const WALL_SEGMENTS = Math.ceil(BOUNDARY_HEIGHT / WALL_SEGMENT_H)
    for (let s = 0; s < WALL_SEGMENTS; s++) {
      const wall = engine.addEntity()
      const segY = WALL_SEGMENT_H / 2 + s * WALL_SEGMENT_H
      Transform.create(wall, {
        position: Vector3.create(px, segY, pz),
        scale: Vector3.create(planeWidth, WALL_SEGMENT_H, 4),
        rotation: Quaternion.fromEulerDegrees(0, rotY, 0)
      })
      MeshCollider.setBox(wall, ColliderLayer.CL_PHYSICS)
    }

    // Visual plane — fades in/out based on proximity
    const plane = engine.addEntity()
    Transform.create(plane, {
      position: Vector3.create(px, py, pz),
      scale: Vector3.create(planeWidth, BOUNDARY_HEIGHT, 1),
      rotation: Quaternion.fromEulerDegrees(0, rotY, 0)
    })
    MeshRenderer.setPlane(plane)
    Material.setPbrMaterial(plane, {
      texture: BOUNDARY_TEX,
      albedoColor: Color4.White(),
      emissiveColor: Color3.create(0.6, 0.1, 0.0),
      emissiveIntensity: 1.5,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      castShadows: false
    })
    VisibilityComponent.create(plane, { visible: false })
    boundaryPlanes.push({ entity: plane, px, pz, lastAlpha: 0 })
  }

  // Fade boundary planes based on player proximity (throttled — runs every 0.2s)
  registerThrottled((_dt: number) => {
    const playerPos = Transform.getOrNull(engine.PlayerEntity)
    if (!playerPos) return
    const playerX = playerPos.position.x
    const playerZ = playerPos.position.z

    for (const bp of boundaryPlanes) {
      const dx = playerX - bp.px
      const dz = playerZ - bp.pz
      const dist = Math.sqrt(dx * dx + dz * dz)

      const alpha = dist < BOUNDARY_SHOW_DIST ? 1.0 - (dist / BOUNDARY_SHOW_DIST) : 0

      if (Math.abs(alpha - bp.lastAlpha) < 0.05) continue
      bp.lastAlpha = alpha

      const vis = VisibilityComponent.getMutable(bp.entity)
      if (alpha < 0.01) {
        vis.visible = false
      } else {
        vis.visible = true
        Material.setPbrMaterial(bp.entity, {
          texture: BOUNDARY_TEX,
          albedoColor: Color4.create(1, 1, 1, alpha),
          emissiveColor: Color3.create(0.6, 0.1, 0.0),
          emissiveIntensity: 1.5,
          transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
          castShadows: false
        })
      }
    }
  }, 0.2)
}
