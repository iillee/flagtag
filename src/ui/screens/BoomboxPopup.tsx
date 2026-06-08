/**
 * BoomboxPopup — Tape/music selector UI.
 * Click boombox to open, swap tapes to change music.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { AudioSource } from '@dcl/sdk/ecs'
import { S, GOLD, GREY, LIGHT_GREY, PANEL_BG, BRIGHT_WHITE } from '../uiConstants'
import { playClickSound } from '../uiSounds'
import { CloseButton } from '../components/CloseButton'
import { hideBoomboxPopup } from '../uiState'
import { musicEntity } from '../../systems/musicSetup'
import { TAPE_ITEMS, type TapeItem, getEquippedTape, setEquippedTape } from './boomboxState'

const SLOT_SIZE = 104
const SLOT_GAP = 12
const SLOT_RADIUS = 18

const SLOT_BG = Color4.create(0.08, 0.08, 0.1, 0.87)
const SLOT_BG_ACTIVE = Color4.create(0.45, 0.36, 0.05, 0.95)
const SLOT_BG_HOVER = Color4.create(0.35, 0.35, 0.4, 0.92)

let hoveredTapeId: string | null = null

function selectTape(tape: TapeItem) {
  setEquippedTape(tape.id)
  // Change the music track
  try {
    const audio = AudioSource.getMutable(musicEntity)
    audio.audioClipUrl = tape.audioSrc
    audio.playing = true
    audio.loop = true
    audio.volume = 0.0984375
  } catch (e) {
    console.error('[Boombox] Failed to switch track:', e)
  }
}

function ejectTape() {
  setEquippedTape(null)
  try {
    const audio = AudioSource.getMutable(musicEntity)
    audio.playing = false
    audio.volume = 0
  } catch (e) {
    console.error('[Boombox] Failed to stop music:', e)
  }
}

export function BoomboxPopup() {
  const equippedId = getEquippedTape()
  const equippedTape = equippedId ? TAPE_ITEMS.find(t => t.id === equippedId) || null : null
  const hoveredTape = hoveredTapeId ? TAPE_ITEMS.find(t => t.id === hoveredTapeId) : null

  return (
    <UiEntity uiTransform={{
      positionType: 'absolute',
      position: { top: 0, left: 0 },
      width: '100%', height: '100%',
      justifyContent: 'center', alignItems: 'center',
      pointerFilter: 'none',
    }}>
      <UiEntity uiTransform={{
        width: S(480),
        flexDirection: 'column',
        alignItems: 'center',
        padding: { top: S(28), bottom: S(28), left: S(28), right: S(28) },
        borderRadius: S(20),
      }}
      uiBackground={{ color: PANEL_BG }}
      >
        <CloseButton hoverKey="closeBoombox" onClose={() => { hideBoomboxPopup(); hoveredTapeId = null }} />

        {/* Title */}
        <Label value="Boombox" fontSize={S(32)} color={GOLD} font="sans-serif"
          uiTransform={{ margin: { bottom: S(6) } }} />

        {/* Now Playing */}
        <UiEntity uiTransform={{
          flexDirection: 'column', alignItems: 'center',
          margin: { top: S(8), bottom: S(16) },
        }}>
          <Label value="Now Playing" fontSize={S(16)} color={GREY} font="sans-serif"
            uiTransform={{ margin: { bottom: S(8) } }} />

          {/* Current tape slot */}
          <UiEntity uiTransform={{
            width: S(SLOT_SIZE + 16), height: S(SLOT_SIZE + 16),
            borderRadius: S(SLOT_RADIUS + 4),
            justifyContent: 'center', alignItems: 'center',
            borderWidth: S(2),
            borderColor: equippedTape ? GOLD : Color4.create(0.3, 0.3, 0.3, 0.5),
          }}
          uiBackground={{ color: equippedTape ? SLOT_BG_ACTIVE : Color4.create(0.06, 0.06, 0.08, 0.5) }}
          onMouseDown={() => { if (equippedTape) { playClickSound(); ejectTape() } }}
          >
            {equippedTape && (
              <UiEntity
                uiTransform={{ width: S(SLOT_SIZE - 8), height: S(SLOT_SIZE - 8), pointerFilter: 'none' }}
                uiBackground={{ textureMode: 'stretch', texture: { src: equippedTape.icon }, color: Color4.White() }}
              />
            )}
          </UiEntity>

          <Label value={equippedTape ? equippedTape.name : 'Empty'} fontSize={S(18)}
            color={equippedTape ? BRIGHT_WHITE : GREY} font="sans-serif"
            uiTransform={{ margin: { top: S(8) } }} />
          {equippedTape && (
            <Label value={equippedTape.author} fontSize={S(16)}
              color={GREY} font="sans-serif"
              uiTransform={{ margin: { top: S(3) } }} />
          )}
        </UiEntity>

        {/* Divider */}
        <UiEntity uiTransform={{ width: '90%', height: S(1), margin: { bottom: S(12) } }}
          uiBackground={{ color: Color4.create(0.3, 0.3, 0.3, 0.5) }} />

        {/* Tape grid — always 3 slots */}
        <UiEntity uiTransform={{
          flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
        }}>
          {Array.from({ length: 3 }).map((_, i) => {
            const tape = TAPE_ITEMS[i] || null
            const EMPTY_BG = Color4.create(0.06, 0.06, 0.08, 0.5)

            if (!tape) {
              // Empty locked slot
              return (
                <UiEntity
                  key={`tape-empty-${i}`}
                  uiTransform={{
                    width: S(SLOT_SIZE), height: S(SLOT_SIZE),
                    margin: { left: i === 0 ? 0 : S(SLOT_GAP) },
                    borderRadius: S(SLOT_RADIUS),
                    justifyContent: 'center', alignItems: 'center',
                  }}
                  uiBackground={{ color: EMPTY_BG }}
                >
                  <Label value="?" fontSize={S(36)} color={GREY} font="sans-serif"
                    uiTransform={{ pointerFilter: 'none' }} />
                </UiEntity>
              )
            }

            const isEquipped = tape.id === equippedId
            const isHovered = tape.id === hoveredTapeId
            const bg = isEquipped ? EMPTY_BG : isHovered ? SLOT_BG_HOVER : SLOT_BG

            return (
              <UiEntity
                key={`tape-${tape.id}`}
                uiTransform={{
                  width: S(SLOT_SIZE), height: S(SLOT_SIZE),
                  margin: { left: i === 0 ? 0 : S(SLOT_GAP) },
                  borderRadius: S(SLOT_RADIUS),
                  justifyContent: 'center', alignItems: 'center',
                }}
                uiBackground={{ color: bg }}
                onMouseEnter={() => { if (!isEquipped) hoveredTapeId = tape.id }}
                onMouseLeave={() => { if (hoveredTapeId === tape.id) hoveredTapeId = null }}
                onMouseDown={() => { if (!isEquipped) { playClickSound(); selectTape(tape) } }}
              >
                {!isEquipped && (
                  <UiEntity
                    uiTransform={{ width: S(SLOT_SIZE - 16), height: S(SLOT_SIZE - 16), pointerFilter: 'none' }}
                    uiBackground={{
                      textureMode: 'stretch',
                      texture: { src: tape.icon },
                      color: Color4.White(),
                    }}
                  />
                )}
              </UiEntity>
            )
          })}
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
