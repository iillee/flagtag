import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import {
  S, WHITE, LIGHT_GREY, PANEL_BG_SEMI, _ABILITY_BTN_SIZE, _ABILITY_ICON_SIZE, _BORDER_RADIUS,
} from '../../ui/uiConstants'
import { cinematicState } from '../../ui/uiState'
import { spectatorState } from '../../shared/clientState'
import { isSpectatorTransitioning } from '../../systems/spectatorSystem'
import { isServerConnected } from '../../systems/clientUtils'
import { getBoomerangColor } from '../../gameState/boomerangColor'
import { getLocalUpgrades } from '../../gameState/playerUpgradeState'
import { isTrapOnCooldown, getTrapCooldownRemaining } from '../../systems/trapSystem'
import {
  isProjectileOnCooldown, getProjectileCooldownRemaining,
  getChargeFraction, getIsCharging, getBurnoutFlash,
} from '../../systems/projectile'

// MARK: HudBottomLayer
// Ability bar: E (boomerang) + F (trap) buttons centered along the bottom.
// Shows charge fill, burnout flash, and per-ability cooldown countdowns.
// Hidden during cinematic or while spectating.
export class HudBottomLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-hud-bottom',
      zone: ZoneType.BottomCenter,
      canBeHidden: true,
      startHidden: true,
      uiTransform: {
        width: 'auto',
        height: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
      },
    })
  }

  protected body() {
    const btn = S(_ABILITY_BTN_SIZE)
    const trapIconSrc = getLocalUpgrades().equippedTrap === 'bomb' ? 'assets/images/bomb.png' : 'assets/images/banana.png'
    const charging = getIsCharging()
    const burnout = getBurnoutFlash()
    const projCd = isProjectileOnCooldown()
    const projCdRemaining = getProjectileCooldownRemaining()
    const trapCd = isTrapOnCooldown()

    return [
      <UiEntity key="row" uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
        {/* Projectile (E) */}
        <UiEntity
          uiTransform={{
            width: btn, height: btn, flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', borderRadius: S(_BORDER_RADIUS), margin: { right: S(8) },
          }}
          uiBackground={{ color: PANEL_BG_SEMI }}
        >
          <Label
            value="E" fontSize={S(16)} color={LIGHT_GREY} font="sans-serif"
            uiTransform={{ positionType: 'absolute', position: { top: S(2), left: S(8) } }}
          />
          {(charging || burnout) && (() => {
            const cf = burnout ? 1 : getChargeFraction()
            const inset = S(6)
            return (
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { bottom: inset, left: inset, right: inset },
                  height: `${Math.round(cf * 100)}%`,
                  maxHeight: btn - inset * 2,
                  borderRadius: S(_BORDER_RADIUS),
                }}
                uiBackground={{
                  color: burnout
                    ? Color4.create(1, 0.15, 0.1, 0.9)
                    : cf >= 1.25 / 1.5
                      ? Color4.create(1, 0.84, 0, 0.85)
                      : Color4.create(1, 1, 1, 0.5),
                }}
              />
            )
          })()}
          {isServerConnected() && (
            <UiEntity
              uiTransform={{
                width: (S(_ABILITY_ICON_SIZE) - 6) * 1.4175,
                height: (S(_ABILITY_ICON_SIZE) - 6) * 1.4175,
                margin: { top: S(-2) },
                positionType: 'absolute',
              }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: `assets/images/boomerang.${getBoomerangColor()}.png` },
                color: projCd ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White(),
              }}
            />
          )}
          {isServerConnected() && projCd && projCdRemaining > 0 && (
            <Label
              value={`${projCdRemaining}`} fontSize={S(26)} color={WHITE} font="sans-serif"
              uiTransform={{ positionType: 'absolute' }}
            />
          )}
        </UiEntity>

        {/* Trap (F) */}
        <UiEntity
          uiTransform={{
            width: btn, height: btn, flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', borderRadius: S(_BORDER_RADIUS), margin: { left: S(8) },
          }}
          uiBackground={{ color: PANEL_BG_SEMI }}
        >
          <Label
            value="F" fontSize={S(16)} color={LIGHT_GREY} font="sans-serif"
            uiTransform={{ positionType: 'absolute', position: { top: S(2), left: S(8) } }}
          />
          {isServerConnected() && (
            <UiEntity
              uiTransform={{
                width: S(_ABILITY_ICON_SIZE) * 1.3 * 0.675 * 1.1,
                height: S(_ABILITY_ICON_SIZE) * 1.3 * 0.675 * 1.1,
                margin: { top: S(2) },
              }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: trapIconSrc },
                color: trapCd ? Color4.create(0.4, 0.4, 0.4, 0.3) : Color4.White(),
              }}
            />
          )}
          {isServerConnected() && trapCd && (
            <Label
              value={`${getTrapCooldownRemaining()}`} fontSize={S(26)} color={WHITE} font="sans-serif"
              uiTransform={{ positionType: 'absolute' }}
            />
          )}
        </UiEntity>
      </UiEntity>,
    ]
  }
}

export const hudBottomLayer = new HudBottomLayer()

export function updateHudBottomLayerVisibility() {
  const shouldShow = !cinematicState.showing && !spectatorState.active && !isSpectatorTransitioning()
  if (shouldShow) hudBottomLayer.show(0)
  else hudBottomLayer.hide(0)
}
