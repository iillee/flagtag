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

const BOB_AMOUNT = 0.15    // meters up and down
const BOB_DURATION = 1500  // ms for one direction
const SPIN_SPEED_DEG = 180 // degrees per second

let setup = false
let waitTimer = 0

interface SpinCoin {
  entity: Entity
  baseRotation: Quaternion
  angle: number // accumulated degrees
}
const spinCoins: SpinCoin[] = []

export function coinBobSpinSystem(dt: number) {
  // Spin all registered coins per-frame (avoids quaternion SLERP shortest-path issues on mobile)
  for (const coin of spinCoins) {
    coin.angle = (coin.angle + SPIN_SPEED_DEG * dt) % 360
    if (Transform.has(coin.entity)) {
      Transform.getMutable(coin.entity).rotation = Quaternion.multiply(
        coin.baseRotation,
        Quaternion.fromEulerDegrees(0, 0, coin.angle)
      )
    }
  }

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

    // Register coin for per-frame spin (no tweens — avoids SLERP shortest-path reversal on mobile)
    spinCoins.push({
      entity,
      baseRotation: t.rotation ?? Quaternion.Identity(),
      angle: 0
    })

    count++
  }

  console.log(`[CoinBobSpin] Applied bob & spin to ${count} coin entities`)
}
