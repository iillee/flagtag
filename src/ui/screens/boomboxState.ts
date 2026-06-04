/**
 * Boombox state — tape definitions and equipped tape tracking.
 */

export interface TapeItem {
  id: string
  name: string
  icon: string
  audioSrc: string
}

export const TAPE_ITEMS: TapeItem[] = [
  { id: 'w', name: 'Sprite Sprint',   icon: 'assets/images/tape.w.png', audioSrc: 'assets/sounds/SpriteSprint_Loop.wav' },
  // { id: 'o', name: 'Medieval',        icon: 'assets/images/tape.o.png', audioSrc: 'assets/sounds/Medieval.mp3' },
  // { id: 'p', name: 'Qualudes',        icon: 'assets/images/tape.p.png', audioSrc: 'assets/sounds/Qualudes 95Bpm - AuthrAudio.mp3' },
]

let equippedTapeId: string | null = 'w'

export function getEquippedTape(): string | null {
  return equippedTapeId
}

export function setEquippedTape(id: string | null): void {
  equippedTapeId = id
}
