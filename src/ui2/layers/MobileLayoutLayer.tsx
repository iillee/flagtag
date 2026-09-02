import ReactEcs from '@dcl/sdk/react-ecs'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'
import { MobileLayout } from '../../ui/layouts/MobileLayout'

// MARK: MobileLayoutLayer
// Wraps the existing (legacy) MobileLayout component in a single DUCK layer
// so that mobile players get a full HUD while the per-layer mobile rebuild
// is still pending. This restores mobile UI parity with production without
// re-implementing every screen from scratch.
export class MobileLayoutLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-mobile-layout',
      zone: ZoneType.FullScreen,
      canBeHidden: false,
      startHidden: false,
      uiTransform: {
        width: '100%',
        height: '100%',
      },
    })
  }

  protected body() {
    return [<MobileLayout key="mobile-layout" />]
  }
}

export const mobileLayoutLayer = new MobileLayoutLayer()
