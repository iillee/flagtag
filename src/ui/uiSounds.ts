/**
 * uiSounds.ts — Preloaded UI sound entities and play helpers.
 *
 * Uses AudioSource.createOrReplace for reliable retriggering without
 * per-frame systems that cause UI lag via ECS change detection.
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

export function playClickSound(): void {
  AudioSource.createOrReplace(clickEntity, {
    audioClipUrl: 'assets/sounds/click.wav',
    playing: true,
    loop: false,
    volume: 0.35,
    global: true,
  })
}

export function playHoverSound(): void {
  AudioSource.createOrReplace(hoverEntity, {
    audioClipUrl: 'assets/sounds/hover.wav',
    playing: true,
    loop: false,
    volume: 0.25,
    global: true,
  })
}

export function playTickSound(): void {
  AudioSource.createOrReplace(tickEntity, {
    audioClipUrl: 'assets/sounds/click.wav',
    playing: true,
    loop: false,
    volume: 0.25,
    global: true,
  })
}
