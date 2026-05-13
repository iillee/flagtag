/**
 * uiSounds.ts — Preloaded UI sound entities and play helpers.
 *
 * Centralizes all UI audio so no other file needs to create sound entities.
 * Import `playClickSound` / `playHoverSound` wherever you need feedback.
 */
import { engine, AudioSource, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

// ── Click sound (buttons, tabs, close) ──
const clickEntity = engine.addEntity()
Transform.create(clickEntity, { position: Vector3.Zero() })
AudioSource.create(clickEntity, {
  audioClipUrl: 'assets/sounds/click.wav',
  playing: true,
  loop: false,
  volume: 0.0,
  global: true,
})

export function playClickSound(): void {
  const a = AudioSource.getMutable(clickEntity)
  a.volume = 0.35
  a.currentTime = 0
  a.playing = true
}

// ── Hover sound (icon buttons) ──
const hoverEntity = engine.addEntity()
Transform.create(hoverEntity, { position: Vector3.Zero() })
AudioSource.create(hoverEntity, {
  audioClipUrl: 'assets/sounds/hover.wav',
  playing: true,
  loop: false,
  volume: 0.0,
  global: true,
})

export function playHoverSound(): void {
  const a = AudioSource.getMutable(hoverEntity)
  a.playing = false
  a.volume = 0.25
  a.currentTime = 0
  a.playing = true
}

// ── Countdown tick sound (last 10 seconds) ──
const tickEntity = engine.addEntity()
Transform.create(tickEntity, { position: Vector3.Zero() })
AudioSource.create(tickEntity, {
  audioClipUrl: 'assets/sounds/click.wav',
  playing: false,
  loop: false,
  volume: 0.0,
  global: true,
})

export function playTickSound(): void {
  const a = AudioSource.getMutable(tickEntity)
  a.volume = 0.25
  a.currentTime = 0
  a.playing = true
}
