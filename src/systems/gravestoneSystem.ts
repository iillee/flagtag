import {
  engine, Transform, pointerEventsSystem, InputAction
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { showGravestonePopup, hideGravestonePopup, popupState } from '../ui'

const GRAVESTONE_POS = Vector3.create(221.93, 2, 286.54)
const MATCH_DIST = 2
const CLOSE_DISTANCE = 5

let gravestoneSetup = false

export function gravestoneSystem() {
  // Close popup if player walks away
  if (popupState.gravestone && Transform.has(engine.PlayerEntity)) {
    const playerPos = Transform.get(engine.PlayerEntity).position
    if (Vector3.distance(playerPos, GRAVESTONE_POS) > CLOSE_DISTANCE) {
      hideGravestonePopup()
    }
  }

  if (gravestoneSetup) return

  for (const [entity] of engine.getEntitiesWith(Transform)) {
    const t = Transform.get(entity)
    if (Vector3.distance(t.position, GRAVESTONE_POS) < MATCH_DIST) {
      if (entity === engine.PlayerEntity || entity === engine.CameraEntity) continue

      pointerEventsSystem.onPointerDown(
        { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Read', maxDistance: 5 } },
        () => {
          showGravestonePopup()
        }
      )

      gravestoneSetup = true
      console.log('[Gravestone] Click handler attached')
      return
    }
  }
}
