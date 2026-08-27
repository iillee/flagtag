import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { DeathOverlay } from '../../ui/components/DeathOverlay'
import { getRespawnCountdown, getDrownFadeOpacity, isDrownTextVisible } from '../../systems/waterSystem'
import { isLightningRespawning, getLightningFadeOpacity, getLightningRespawnCountdown, isLightningTextVisible } from '../../systems/lightningSystem'
import { isGhostDeathRespawning, getGhostDeathFadeOpacity, getGhostDeathRespawnCountdown, isGhostDeathTextVisible } from '../../systems/ghostSystem'

// MARK: DeathOverlayLayer
// Full-screen death message + respawn countdown. Three flavours (drown,
// lightning, ghost-scare) render as siblings; each self-hides via its own
// `visible` prop when its cause is inactive.
export class DeathOverlayLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-death-overlay',
      zone: ZoneType.FullScreen,
      canBeHidden: true,
      startHidden: true,
      uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
    })
  }

  protected body() {
    const wrap = {
      positionType: 'absolute' as const,
      position: { top: 0, right: 0, bottom: 0, left: 0 },
      width: '100%' as const, height: '100%' as const,
      pointerFilter: 'none' as const,
    }
    return [
      <UiEntity key="drown" uiTransform={wrap}>
        <DeathOverlay
          visible={getRespawnCountdown() > 0}
          message="You Drowned!"
          fadeOpacity={getDrownFadeOpacity()}
          showText={isDrownTextVisible()}
          respawnCountdown={getRespawnCountdown()}
        />
      </UiEntity>,
      <UiEntity key="lightning" uiTransform={wrap}>
        <DeathOverlay
          visible={isLightningRespawning()}
          message="You were struck by lightning!"
          fadeOpacity={getLightningFadeOpacity()}
          showText={isLightningTextVisible()}
          respawnCountdown={getLightningRespawnCountdown()}
        />
      </UiEntity>,
      <UiEntity key="ghost" uiTransform={wrap}>
        <DeathOverlay
          visible={isGhostDeathRespawning()}
          message="You were scared to death!"
          fadeOpacity={getGhostDeathFadeOpacity()}
          showText={isGhostDeathTextVisible()}
          respawnCountdown={getGhostDeathRespawnCountdown()}
        />
      </UiEntity>,
    ]
  }
}

export const deathOverlayLayer = new DeathOverlayLayer()

export function updateDeathOverlayLayerVisibility() {
  const anyActive =
    getRespawnCountdown() > 0 ||
    isLightningRespawning() ||
    isGhostDeathRespawning()
  if (anyActive) deathOverlayLayer.show(0)
  else deathOverlayLayer.hide(0)
}
