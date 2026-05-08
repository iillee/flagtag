/**
 * Water Bob System
 * 
 * Makes water planes, lilypads, and flowers on the water bob up and down gently.
 * Finds entities by matching known positions from the composite, then applies
 * looping move tweens.
 */
import {
  engine, Transform, Tween, TweenSequence, EasingFunction, TweenLoop, GltfContainer
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

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
}
