import { engine, AudioSource } from '@dcl/sdk/ecs'

/**
 * Background music entity. Exported so other systems (e.g. boomboxSystem)
 * can toggle mute.
 *
 * We attach the AudioSource DIRECTLY to engine.PlayerEntity (rather than a
 * child entity parented to the player). Reasoning:
 *   - `global: true` alone is not fully attenuation-free in the current SDK
 *     build — sound falls off with distance from the transform position, so
 *     a stationary entity at 0,0,0 goes inaudible across the 800m scene.
 *   - Attaching a child of PlayerEntity exhibited a bug where
 *     `audio.playing = false` did not stop playback (boombox click no longer
 *     muted). Direct attachment on engine.PlayerEntity is the SDK7-recommended
 *     pattern for background music and behaves correctly with mutations.
 */
export const musicEntity = engine.PlayerEntity

export function setupMusic() {
  AudioSource.createOrReplace(musicEntity, {
    audioClipUrl: 'assets/sounds/SpriteSprint_Loop.mp3',
    playing: true,
    loop: true,
    volume: 0.6,
    global: true
  })
}
