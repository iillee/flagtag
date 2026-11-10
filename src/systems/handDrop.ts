/**
 * handDrop.ts - local player's left-hand wind-up for banana/bomb drops.
 *
 * On drop press the equipped item's GLB (same model as the trap visual) is
 * shown attached to the local avatar's left hand (AvatarAttach AAPT_LEFT_HAND)
 * and scales 0 -> hand size with an ease-out over HAND_DROP_WINDUP_SEC. When
 * the wind-up ends `onPlaced` runs (drop request + instant local prediction)
 * and the hand model is hidden in the same frame.
 *
 * The attach + both GLBs are created once and shown/hidden by scale (avoids
 * the GltfContainer create/destroy rendering bug noted in trapSystem.ts).
 */
import { AvatarAnchorPointType, AvatarAttach, engine, Entity, GltfContainer, Transform } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import {
  HAND_DROP_WINDUP_SEC, HAND_DROP_BANANA_SCALE, HAND_DROP_BOMB_SCALE,
  HAND_DROP_OFFSET, HAND_DROP_ROTATION_DEG, handScaleAt,
} from '../shared/handDropAnim'

export type HandDropKind = 'banana' | 'bomb'

const MODEL_SRC: Record<HandDropKind, string> = {
  banana: 'assets/models/banana_scaled.glb',
  bomb: 'assets/asset-packs/iron_grenade/Bomb_01/Bomb_01.glb',
}
const FULL_SCALE: Record<HandDropKind, number> = { banana: HAND_DROP_BANANA_SCALE, bomb: HAND_DROP_BOMB_SCALE }

let anchor: Entity | null = null
const models: Partial<Record<HandDropKind, Entity>> = {}
let active: { kind: HandDropKind; elapsed: number; onPlaced: () => void; shouldAbort: () => boolean; onAbort: () => void } | null = null

function ensureRig(): void {
  if (anchor) return
  anchor = engine.addEntity()
  Transform.create(anchor)
  AvatarAttach.create(anchor, { anchorPointId: AvatarAnchorPointType.AAPT_LEFT_HAND })
  for (const kind of ['banana', 'bomb'] as HandDropKind[]) {
    const e = engine.addEntity()
    Transform.create(e, {
      parent: anchor,
      position: Vector3.create(HAND_DROP_OFFSET.x, HAND_DROP_OFFSET.y, HAND_DROP_OFFSET.z),
      rotation: Quaternion.fromEulerDegrees(HAND_DROP_ROTATION_DEG.x, HAND_DROP_ROTATION_DEG.y, HAND_DROP_ROTATION_DEG.z),
      scale: Vector3.Zero(),
    })
    GltfContainer.create(e, { src: MODEL_SRC[kind], visibleMeshesCollisionMask: 0, invisibleMeshesCollisionMask: 0 })
    models[kind] = e
  }
  engine.addSystem(tick)
}

function setScale(kind: HandDropKind, s: number): void {
  const e = models[kind]
  if (e) Transform.getMutable(e).scale = Vector3.create(s, s, s)
}

function tick(dt: number): void {
  if (!active) return
  const a = active
  if (a.shouldAbort()) {
    active = null
    setScale(a.kind, 0)
    a.onAbort()
    return
  }
  a.elapsed += dt
  if (a.elapsed >= HAND_DROP_WINDUP_SEC) {
    active = null
    a.onPlaced()          // drop request + local prediction ...
    setScale(a.kind, 0)   // ... and the hand model disappears this same frame
    return
  }
  setScale(a.kind, FULL_SCALE[a.kind] * handScaleAt(a.elapsed))
}

/** True while a wind-up is running (callers ignore further drop presses). */
export function isHandDropActive(): boolean {
  return active !== null
}

/** Preload the hand rig so the first press doesn't wait on the GLB. */
export function initHandDrop(): void {
  ensureRig()
}

/**
 * Start the wind-up. `shouldAbort` is polled each frame (e.g. spectator /
 * cinematic / drown); on abort the model hides and `onAbort` runs instead.
 */
export function startHandDrop(kind: HandDropKind, onPlaced: () => void, shouldAbort: () => boolean, onAbort: () => void): boolean {
  if (active) return false
  ensureRig()
  active = { kind, elapsed: 0, onPlaced, shouldAbort, onAbort }
  setScale(kind, 0)
  return true
}
