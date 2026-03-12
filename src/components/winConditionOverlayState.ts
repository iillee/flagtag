import { engine, Schemas } from '@dcl/sdk/ecs'

const WinConditionOverlayStateSchema = {
  visible: Schemas.Boolean
}

export const WinConditionOverlayState = engine.defineComponent(
  'ctf-win-condition-overlay',
  WinConditionOverlayStateSchema,
  { visible: false }
)

let overlayEntity: ReturnType<typeof engine.addEntity> | null = null

function setOverlayEntity(entity: ReturnType<typeof engine.addEntity>) {
  overlayEntity = entity
}

function getEntity() {
  if (overlayEntity === null) return null
  if (!WinConditionOverlayState.has(overlayEntity)) return null
  return overlayEntity
}

export function getWinConditionOverlayVisible(): boolean {
  const e = getEntity()
  if (!e) return false
  return WinConditionOverlayState.get(e).visible
}

export function setWinConditionOverlayVisible(visible: boolean) {
  const e = getEntity()
  if (!e) return
  const mutable = WinConditionOverlayState.getMutable(e)
  mutable.visible = visible
}

export function toggleWinConditionOverlay() {
  const e = getEntity()
  if (!e) return
  const mutable = WinConditionOverlayState.getMutable(e)
  mutable.visible = !mutable.visible
}

export function createWinConditionOverlayEntity() {
  const entity = engine.addEntity()
  WinConditionOverlayState.create(entity, { visible: false })
  setOverlayEntity(entity)
  return entity
}
