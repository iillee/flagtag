/**
 * Coin Bob & Spin System
 * 
 * Finds all doubloon/coin GLB entities and applies a gentle bob (up/down)
 * plus a continuous spin (Y-axis rotation).
 */
import {
  engine, Transform, Tween, TweenSequence, EasingFunction, TweenLoop, GltfContainer, type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'

/**
 * Original composite position of every coin this system re-parented, keyed by the coin
 * entity. Once the bob tween starts, the live Transform tree only holds the animated
 * position — anything that must hash the coin's PLACED position (coin ids have to match
 * the server registry, which reads never-re-parented entities) reads this instead.
 */
export const coinBasePositions = new Map<Entity, { x: number; y: number; z: number }>()

const BOB_AMOUNT = 0.15    // meters up and down
const BOB_DURATION = 1500  // ms for one direction
const SPIN_DURATION = 2000 // ms for full 360° rotation

let setup = false
let waitTimer = 0

export function coinBobSpinSystem(dt: number) {
  if (setup) return
  waitTimer += dt
  if (waitTimer < 3) return // wait for composite entities to load
  setup = true

  let count = 0
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    const gltf = GltfContainer.get(entity)
    const src = gltf.src.toLowerCase()

    if (!src.includes('coin_01') && !src.includes('doubloon')) continue

    const t = Transform.get(entity)
    const baseY = t.position.y
    const baseRot = t.rotation ?? Quaternion.Identity()

    coinBasePositions.set(entity, { x: t.position.x, y: baseY, z: t.position.z })

    // We need a parent for bobbing and the coin itself for spinning,
    // because an entity can only have one Tween at a time.

    // Create a bob parent at the coin's position
    const bobParent = engine.addEntity()
    Transform.create(bobParent, {
      position: Vector3.create(t.position.x, baseY, t.position.z),
      rotation: Quaternion.Identity(),
      scale: Vector3.One(),
      parent: t.parent
    })

    // Re-parent the coin under the bob parent, reset position to origin
    const mutable = Transform.getMutable(entity)
    mutable.parent = bobParent
    mutable.position = Vector3.create(0, 0, 0)
    // Keep original rotation and scale on the coin

    // Bob the parent up and down
    const upPos = Vector3.create(t.position.x, baseY + BOB_AMOUNT, t.position.z)
    const downPos = Vector3.create(t.position.x, baseY - BOB_AMOUNT, t.position.z)

    Tween.create(bobParent, {
      mode: Tween.Mode.Move({ start: downPos, end: upPos }),
      duration: BOB_DURATION,
      easingFunction: EasingFunction.EF_EASESINE
    })
    TweenSequence.create(bobParent, {
      sequence: [{
        mode: Tween.Mode.Move({ start: upPos, end: downPos }),
        duration: BOB_DURATION,
        easingFunction: EasingFunction.EF_EASESINE
      }],
      loop: TweenLoop.TL_YOYO
    })

    // Spin the coin using Tween in 4 quarter-turns to avoid SLERP shortest-path reversal.
    // Each segment is only 90°, so SLERP always takes the correct direction.
    const quarterDuration = SPIN_DURATION / 4
    const rot0   = baseRot
    const rot90  = Quaternion.multiply(baseRot, Quaternion.fromEulerDegrees(0, 0, 90))
    const rot180 = Quaternion.multiply(baseRot, Quaternion.fromEulerDegrees(0, 0, 180))
    const rot270 = Quaternion.multiply(baseRot, Quaternion.fromEulerDegrees(0, 0, 270))

    Tween.create(entity, {
      mode: Tween.Mode.Rotate({ start: rot0, end: rot90 }),
      duration: quarterDuration,
      easingFunction: EasingFunction.EF_LINEAR
    })
    TweenSequence.create(entity, {
      sequence: [
        { mode: Tween.Mode.Rotate({ start: rot90, end: rot180 }), duration: quarterDuration, easingFunction: EasingFunction.EF_LINEAR },
        { mode: Tween.Mode.Rotate({ start: rot180, end: rot270 }), duration: quarterDuration, easingFunction: EasingFunction.EF_LINEAR },
        { mode: Tween.Mode.Rotate({ start: rot270, end: rot0 }), duration: quarterDuration, easingFunction: EasingFunction.EF_LINEAR },
      ],
      loop: TweenLoop.TL_RESTART
    })

    count++
  }

  console.log(`[CoinBobSpin] Applied bob & spin to ${count} coin entities`)
}
