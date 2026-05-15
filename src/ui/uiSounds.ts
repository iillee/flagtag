/**
 * uiSounds.ts — Preloaded UI sound entities and play helpers.
 *
 * Uses a per-frame system to toggle playing off→on across two frames,
 * which retriggers sounds without the overhead of component recreation.
 */
import { engine, AudioSource, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

// ── Click sound (buttons, tabs, close) ──
const clickEntity = engine.addEntity()
Transform.create(clickEntity, { position: Vector3.Zero() })
AudioSource.create(clickEntity, {
  audioClipUrl: 'assets/sounds/click.wav',
  playing: false,
  loop: false,
  volume: 0.35,
  global: true,
})

// ── Hover sound (icon buttons) ──
const hoverEntity = engine.addEntity()
Transform.create(hoverEntity, { position: Vector3.Zero() })
AudioSource.create(hoverEntity, {
  audioClipUrl: 'assets/sounds/hover.wav',
  playing: false,
  loop: false,
  volume: 0.25,
  global: true,
})

// ── Countdown tick sound (last 10 seconds) ──
const tickEntity = engine.addEntity()
Transform.create(tickEntity, { position: Vector3.Zero() })
AudioSource.create(tickEntity, {
  audioClipUrl: 'assets/sounds/click.wav',
  playing: false,
  loop: false,
  volume: 0.25,
  global: true,
})

// ── Pending sound queue ──
// Frame 0: set playing=false  |  Frame 1: set playing=true
const pending = new Map<number, number>() // entity → frames remaining (1 = reset done, fire next frame)

export function playClickSound(): void {
  pending.set(clickEntity, 0)
}

export function playHoverSound(): void {
  pending.set(hoverEntity, 0)
}

export function playTickSound(): void {
  pending.set(tickEntity, 0)
}

// System that processes pending sounds across two frames
engine.addSystem(() => {
  for (const [entity, frame] of pending) {
    if (frame === 0) {
      // Frame 0: ensure playing is false
      AudioSource.getMutable(entity).playing = false
      pending.set(entity, 1)
    } else {
      // Frame 1: set playing to true → triggers playback
      AudioSource.getMutable(entity).playing = true
      pending.delete(entity)
    }
  }
})
