import { ROUND_MS, DAY_MUSIC_TAPE_ID, NIGHT_MUSIC_TAPE_ID, defaultMusicTapeIdAt } from '../src/shared/dayNight'

describe('day/night default music', () => {
  // ids from MUSIC_STORE (shared/upgrades.ts): 'w' = Sprite Sprint, 'b' = Blips Piano
  it('uses w for day and b for night', () => {
    expect(DAY_MUSIC_TAPE_ID).toBe('w')
    expect(NIGHT_MUSIC_TAPE_ID).toBe('b')
  })

  const day = 1_000 * ROUND_MS

  it('switches exactly on round boundaries', () => {
    expect(defaultMusicTapeIdAt(day)).toBe('w')
    expect(defaultMusicTapeIdAt(day + ROUND_MS - 1)).toBe('w')
    expect(defaultMusicTapeIdAt(day + ROUND_MS)).toBe('b')
    expect(defaultMusicTapeIdAt(day + 2 * ROUND_MS - 1)).toBe('b')
    expect(defaultMusicTapeIdAt(day + 2 * ROUND_MS)).toBe('w')
  })
})