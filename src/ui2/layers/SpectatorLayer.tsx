import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { S, GOLD, LIGHT_GREY } from '../../ui/uiConstants'
import { hover } from '../../ui/uiState'
import { playClickSound } from '../../ui/uiSounds'
import { spectatorState, type SpectatorMode } from '../../shared/clientState'
import { exitSpectatorMode, setSpectatorMode, selectFollowPlayer } from '../../systems/spectatorSystem'
import { getPlayersWithHoldTimes, getCurrentFlagCarrierUserId } from '../../gameState/flagHoldTime'

// MARK: SpectatorLayer
// Bottom-of-screen spectator HUD: mode tabs (Follow Flag / Follow Player) +
// optional player picker + close button + controls hint. Desktop only.

const SPEC_MODES: { key: SpectatorMode; label: string }[] = [
  { key: 'flag', label: 'Follow Flag' },
  { key: 'player', label: 'Follow Player' },
]

const TAB_BG = Color4.create(0.2, 0.2, 0.25, 0.9)
const TAB_ACTIVE = Color4.create(0.9, 0.75, 0.2, 1)
const PANEL = Color4.create(0.08, 0.08, 0.1, 0.94)
const CONTROLS_HINT = 'W/S = Zoom  |  A/D = Orbit  |  E/F = Up/Down'

export class SpectatorLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-spectator',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    if (!spectatorState.active) return null

    const mode = spectatorState.mode
    const players = getPlayersWithHoldTimes()
    const carrierUserId = getCurrentFlagCarrierUserId()
    const pickerOpen = mode === 'player' && spectatorState.playerPickerOpen && players.length > 0

    return [
      <UiEntity
        key="wrap"
        uiTransform={{
          positionType: 'absolute',
          position: { bottom: S(16), left: 0 },
          width: '100%',
          flexDirection: 'column', alignItems: 'center',
          pointerFilter: 'none',
        }}
      >
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {/* Player picker (above bar) */}
          {pickerOpen && (
            <UiEntity
              uiTransform={{ flexDirection: 'column', maxHeight: S(240), borderRadius: S(10), padding: { top: S(4), bottom: S(4) }, margin: { bottom: S(4) } }}
              uiBackground={{ color: PANEL }}
            >
              {players.map((p, i) => {
                const isCarrier = carrierUserId !== null && p.userId.toLowerCase() === carrierUserId.toLowerCase()
                const isSelected = spectatorState.followPlayerId?.toLowerCase() === p.userId.toLowerCase()
                return (
                  <UiEntity key={`sp-${i}`}
                    uiTransform={{ height: S(32), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: { left: S(10), right: S(10) }, borderRadius: S(6), margin: { left: S(4), right: S(4), top: S(1), bottom: S(1) } }}
                    uiBackground={{ color: isSelected ? Color4.create(0.9, 0.75, 0.2, 0.25) : Color4.create(0, 0, 0, 0) }}
                    onMouseDown={() => { selectFollowPlayer(p.userId, p.name) }}
                  >
                    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                      {isCarrier && <UiEntity uiTransform={{ width: S(14), height: S(14), margin: { right: S(4) } }} uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/images/flag-icon-white.png' }, color: GOLD }} />}
                      <Label value={p.name} fontSize={S(15)} color={isSelected ? TAB_ACTIVE : LIGHT_GREY} font="sans-serif" />
                    </UiEntity>
                  </UiEntity>
                )
              })}
            </UiEntity>
          )}

          {/* Main bar */}
          <UiEntity
            uiTransform={{ flexDirection: 'column', alignItems: 'center', borderRadius: S(14), padding: { top: S(10), bottom: S(10), left: S(10), right: S(10) } }}
            uiBackground={{ color: PANEL }}
          >
            {/* Mode tabs + close button */}
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: S(6) } }}>
              {SPEC_MODES.map((m, i) => {
                const isActive = mode === m.key
                return (
                  <UiEntity key={`tab-${i}`}
                    uiTransform={{ height: S(34), padding: { left: S(16), right: S(16) }, margin: { left: i > 0 ? S(4) : 0 }, borderRadius: S(10), justifyContent: 'center', alignItems: 'center' }}
                    uiBackground={{ color: isActive ? TAB_ACTIVE : TAB_BG }}
                    onMouseDown={() => {
                      if (m.key === 'player') {
                        if (mode !== 'player') setSpectatorMode(m.key)
                        else spectatorState.playerPickerOpen = !spectatorState.playerPickerOpen
                      } else {
                        setSpectatorMode(m.key)
                      }
                    }}
                  >
                    <Label value={m.label} fontSize={S(14)} color={isActive ? Color4.Black() : Color4.White()} font="sans-serif" />
                  </UiEntity>
                )
              })}
              <UiEntity
                uiTransform={{ height: S(34), width: S(34), margin: { left: S(4) }, borderRadius: S(10), justifyContent: 'center', alignItems: 'center' }}
                uiBackground={{ color: hover.closeSpectator ? Color4.create(0.35, 0.3, 0.3, 0.95) : TAB_BG }}
                onMouseEnter={() => { hover.closeSpectator = true }}
                onMouseLeave={() => { hover.closeSpectator = false }}
                onMouseDown={() => { playClickSound(); exitSpectatorMode(); hover.closeSpectator = false }}
              >
                <Label value="×" fontSize={S(28)} color={hover.closeSpectator ? Color4.create(1, 0.4, 0.4, 1) : Color4.create(0.9, 0.15, 0.15, 1)} font="sans-serif" textAlign="middle-center"
                  uiTransform={{ width: '100%', height: '100%', margin: { top: S(-4), left: S(2) } }} />
              </UiEntity>
            </UiEntity>

            <Label value={CONTROLS_HINT} fontSize={S(12)} color={Color4.create(1, 1, 1, 0.6)} font="sans-serif" />
          </UiEntity>
        </UiEntity>
      </UiEntity>,
    ]
  }
}

export const spectatorLayer = new SpectatorLayer()

export function updateSpectatorLayerVisibility() {
  if (spectatorState.active) spectatorLayer.show(0)
  else spectatorLayer.hide(0)
}
