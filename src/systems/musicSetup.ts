import { engine, Transform, AudioSource } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

/**
 * Background music entity. Exported so other systems (e.g. boomboxSystem)
 * can toggle mute.
 */
export let musicEntity: ReturnType<typeof engine.addEntity>

export function setupMusic() {
  musicEntity = engine.addEntity()
  Transform.create(musicEntity, { position: Vector3.create(0, 0, 0) })
  AudioSource.create(musicEntity, {
    audioClipUrl: 'assets/sounds/SpriteSprint_Loop.mp3',
    playing: true,
    loop: true,
    volume: 0.1,
    global: true
  })
}
