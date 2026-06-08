import {
  engine, Transform, pointerEventsSystem, InputAction, AudioSource, GltfContainer, ColliderLayer
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { openExternalUrl } from '~system/RestrictedActions'

const TERMINAL_SRC = 'assets/asset-packs/terminal/Terminal_01/Terminal_01.glb'
const POSTHOG_DASHBOARD_URL = 'https://us.posthog.com/shared/wPXQXDz0K0G24z-o_w-9zlvGcK2Cyg'

const setupEntities = new Set<number>()

export function terminalSystem() {
  // Find terminal entities by GltfContainer src
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    if (setupEntities.has(entity as number)) continue
    const gltf = GltfContainer.get(entity)
    if (gltf.src !== TERMINAL_SRC) continue

    const pos = Transform.get(entity).position

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
      { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'View Scene Analytics', maxDistance: 5 } },
      () => {
        AudioSource.createOrReplace(sound, { audioClipUrl: 'assets/sounds/terminal.mp3', playing: true, loop: false, volume: 1, global: false })
        openExternalUrl({ url: POSTHOG_DASHBOARD_URL })
      }
    )

    setupEntities.add(entity as number)
    console.log(`[Terminal] Click handler attached at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`)
  }
}
