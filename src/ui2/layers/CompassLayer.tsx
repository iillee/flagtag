import ReactEcs from '@dcl/sdk/react-ecs'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'
import { Compass } from '../../ui/components/Compass'

// MARK: CompassLayer
// Always-visible compass bar at the very top of the screen. Shows N/E/S/W
// markers that slide as the camera rotates, with a gold caret at center
// indicating the current heading.
export class CompassLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-compass',
      zone: ZoneType.TopCenter,
      canBeHidden: false,
      startHidden: false,
    })
  }

  protected body() {
    return [<Compass key="compass" />]
  }
}

export const compassLayer = new CompassLayer()
