import {
  engine, Transform, pointerEventsSystem, InputAction, AudioSource, GltfContainer, ColliderLayer
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { openMetricsPanel, isMetricsPanelOpen, closeMetricsPanel } from '../ui'

const TERMINAL_SRC = 'assets/asset-packs/terminal/Terminal_01/Terminal_01.glb'
const TERMINAL_CLOSE_DISTANCE = 6

const setupEntities = new Set<number>()
const terminalPositions: Vector3[] = []

export function terminalSystem() {
  // Close metrics panel if player walks away from all terminals
  if (isMetricsPanelOpen() && Transform.has(engine.PlayerEntity) && terminalPositions.length > 0) {
    const playerPos = Transform.get(engine.PlayerEntity).position
    const nearAny = terminalPositions.some(pos => Vector3.distance(playerPos, pos) <= TERMINAL_CLOSE_DISTANCE)
    if (!nearAny) {
      closeMetricsPanel()
    }
  }

  // Find terminal entities by GltfContainer src
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    if (setupEntities.has(entity as number)) continue
    const gltf = GltfContainer.get(entity)
    if (gltf.src !== TERMINAL_SRC) continue

    const pos = Transform.get(entity).position
    terminalPositions.push(Vector3.create(pos.x, pos.y, pos.z))

    // Fix collision mask so pointer events work
    GltfContainer.createOrReplace(entity, {
      src: TERMINAL_SRC,
      visibleMeshesCollisionMask: ColliderLayer.CL_POINTER,
      invisibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
    })

    // Sound effect entity
    const sound = engine.addEntity()
    Transform.create(sound, { position: pos })
    AudioSource.create(sound, {
      audioClipUrl: 'assets/sounds/terminal.mp3',
      playing: false,
      loop: false,
      volume: 1,
      global: false
    })

    pointerEventsSystem.onPointerDown(
      { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Boot Up Computer', maxDistance: 5 } },
      () => {
        const a = AudioSource.getMutable(sound)
        a.currentTime = 0
        a.playing = true
        openMetricsPanel()
      }
    )

    setupEntities.add(entity as number)
    console.log(`[Terminal] Click handler attached at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`)
  }
}
