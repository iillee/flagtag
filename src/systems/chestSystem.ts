import {
  engine, pointerEventsSystem, InputAction, GltfContainer, ColliderLayer,
  AudioSource, Transform,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { showChestPopup } from '../ui'

const chestSoundEntity = engine.addEntity()
Transform.create(chestSoundEntity, { position: Vector3.Zero() })
AudioSource.create(chestSoundEntity, {
  audioClipUrl: 'assets/sounds/chest.mp3',
  playing: false,
  loop: false,
  volume: 1,
  global: true
})

let chestSetup = false
const attachedEntities = new Set<Entity>()

export function chestSystem() {
  if (chestSetup) return

  for (const [entity] of engine.getEntitiesWith(GltfContainer)) {
    const gltf = GltfContainer.get(entity)
    if (gltf.src.includes('drawer') && !attachedEntities.has(entity)) {
      const mutableGltf = GltfContainer.getMutable(entity)
      mutableGltf.visibleMeshesCollisionMask = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS
      mutableGltf.invisibleMeshesCollisionMask = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS

      pointerEventsSystem.onPointerDown(
        { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Open Chest', maxDistance: 8 } },
        () => {
          const a = AudioSource.getMutable(chestSoundEntity)
          a.currentTime = 0
          a.playing = true
          showChestPopup()
        }
      )

      attachedEntities.add(entity)
      console.log(`[Chest] Click handler attached (${attachedEntities.size} total)`)
    }
  }

  if (attachedEntities.size >= 2) {
    chestSetup = true
  }
}
