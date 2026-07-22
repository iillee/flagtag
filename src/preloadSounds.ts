/**
 * preloadSounds.ts — Silently plays every game sound at volume 0 on scene load
 * so the engine fetches and caches the audio clips. This eliminates the delay
 * on first playback of any sound effect.
 */
import { engine, AudioSource, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

const ALL_SOUNDS = [
  'assets/sounds/boomerang2.mp3',
  'assets/sounds/buzz.mp3',
  'assets/sounds/charge.mp3',
  'assets/sounds/charge2.mp3',
  'assets/sounds/chest.mp3',
  'assets/sounds/coin.mp3',
  'assets/sounds/death.mp3',
  'assets/sounds/drop.mp3',
  'assets/sounds/error.mp3',
  'assets/sounds/ghost.mp3',
  'assets/sounds/hit.mp3',
  'assets/sounds/lighting.mp3',
  'assets/sounds/mailbox.mp3',
  'assets/sounds/miss2.mp3',
  'assets/sounds/pickup2.mp3',
  'assets/sounds/pickup2.wav',
  'assets/sounds/portals/doorAmb.mp3',
  'assets/sounds/powerup.mp3',
  'assets/sounds/purchase.mp3',
  'assets/sounds/release.mp3',
  'assets/sounds/swoosh.mp3',
  'assets/sounds/teleport.mp3',
  'assets/sounds/terminal.mp3',
  'assets/sounds/trap2.mp3',
  'assets/sounds/trumpets.mp3',
  'assets/sounds/water.mp3',
  'assets/sounds/binoculars.mp3',
  'assets/sounds/fuse.mp3',
  'assets/sounds/explode.mp3',
]

export function preloadAllSounds(): void {
  for (const url of ALL_SOUNDS) {
    const e = engine.addEntity()
    Transform.create(e, { position: Vector3.Zero() })
    AudioSource.create(e, {
      audioClipUrl: url,
      playing: true,
      loop: false,
      volume: 0.0001, // non-zero so the engine actually decodes/caches the clip (0.0 can short-circuit)
      global: true,
    })
  }
}
