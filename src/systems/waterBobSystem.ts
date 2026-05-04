/**
 * Water Bob System
 * 
 * Makes water planes, lilypads, and flowers on the water bob up and down gently.
 * Finds entities by matching known positions from the composite, then applies
 * looping move tweens.
 */
import {
  engine, Transform, Tween, TweenSequence, EasingFunction, TweenLoop, GltfContainer,
  MeshRenderer, Material, MaterialTransparencyMode, VisibilityComponent, TextureWrapMode
} from '@dcl/sdk/ecs'
import { Vector3, Color4, Color3, Quaternion } from '@dcl/sdk/math'

const BOB_AMOUNT = 0.06   // meters up and down
const BOB_DURATION = 3000  // ms for one direction

// All entities at y ≈ 0.58 that should bob (water planes, lilypads, balsam flower)
const BOB_ENTITY_NAMES = [
  'waterpatch',  // Caribbean Water models
  'lilypad',     // Lilypad models
  'balsam',      // Balsam Flower
]

let setup = false
let waitTimer = 0

export function waterBobSystem(dt: number) {
  if (setup) return
  waitTimer += dt
  if (waitTimer < 3) return  // wait for composite entities to load
  setup = true

  let count = 0
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    const gltf = GltfContainer.get(entity)
    const src = gltf.src.toLowerCase()

    const shouldBob = BOB_ENTITY_NAMES.some(name => src.includes(name))
    if (!shouldBob) continue

    const t = Transform.get(entity)
    // Only bob entities near water level (y < 2)
    if (t.position.y > 3) continue

    const baseY = t.position.y
    const upPos = Vector3.create(t.position.x, baseY + BOB_AMOUNT, t.position.z)
    const downPos = Vector3.create(t.position.x, baseY - BOB_AMOUNT, t.position.z)

    // Start: move from down to up
    Tween.create(entity, {
      mode: Tween.Mode.Move({
        start: downPos,
        end: upPos
      }),
      duration: BOB_DURATION,
      easingFunction: EasingFunction.EF_EASESINE
    })

    // Sequence: move back down — TL_YOYO reverses the whole sequence each loop
    TweenSequence.create(entity, {
      sequence: [
        {
          mode: Tween.Mode.Move({
            start: upPos,
            end: downPos
          }),
          duration: BOB_DURATION,
          easingFunction: EasingFunction.EF_EASESINE
        },
      ],
      loop: TweenLoop.TL_YOYO
    })

    count++
  }

  console.log(`[WaterBob] Applied bobbing to ${count} entities`)

  // ── Custom water material overlay ──
  // Overlay a plane with water.png on top of the existing Caribbean Water GLB
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    const gltf = GltfContainer.get(entity)
    if (!gltf.src.toLowerCase().includes('waterpatch')) continue
    const t = Transform.get(entity)
    if (t.position.y > 3) continue

    // Move original water down slightly
    const originalY = t.position.y
    Transform.getMutable(entity).position.y = originalY - 0.05

    // Create overlay plane at the original water height, centered on scene
    const waterPlane = engine.addEntity()
    Transform.create(waterPlane, {
      position: Vector3.create(256, originalY + 0.05, 256),
      scale: Vector3.create(320, 320, 1),
      rotation: Quaternion.fromEulerDegrees(90, 0, 0),
    })
    MeshRenderer.setPlane(waterPlane)
    Material.setPbrMaterial(waterPlane, {
      texture: Material.Texture.Common({
        src: 'assets/materials/water.png',
        wrapMode: TextureWrapMode.TWM_REPEAT
      }),
      albedoColor: Color4.create(0.7, 0.9, 1.0, 0.85),
      emissiveColor: Color3.create(0.1, 0.3, 0.5),
      emissiveIntensity: 0.5,
      metallic: 0.3,
      roughness: 0.2,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      castShadows: false,
    })

    // Apply bobbing tween to the overlay
    const upPos = Vector3.create(256, originalY + BOB_AMOUNT, 256)
    const downPos = Vector3.create(256, originalY - BOB_AMOUNT, 256)
    Tween.create(waterPlane, {
      mode: Tween.Mode.Move({ start: downPos, end: upPos }),
      duration: BOB_DURATION,
      easingFunction: EasingFunction.EF_EASESINE
    })
    TweenSequence.create(waterPlane, {
      sequence: [{
        mode: Tween.Mode.Move({ start: upPos, end: downPos }),
        duration: BOB_DURATION,
        easingFunction: EasingFunction.EF_EASESINE
      }],
      loop: TweenLoop.TL_YOYO
    })

    console.log(`[WaterBob] Created water overlay at scene center (256, ${originalY.toFixed(2)}, 256), scale 320x320. Original moved to y=${(originalY - 0.01).toFixed(2)}`)
  }
}
