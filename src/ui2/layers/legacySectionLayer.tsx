import ReactEcs from '@dcl/sdk/react-ecs'
import { Layer, ZoneType } from '@stom66/dcl-ui-component-kit'

import { PlayerListUi, type PlayerListUiSection } from '../../ui'

// MARK: makeLegacySectionLayer
// Factory that produces a DUCK Layer wrapping a single legacy PlayerListUi
// section. Each layer renders PlayerListUi with only that section enabled, so
// the legacy JSX stays a single source of truth while the outer container
// becomes a proper DUCK layer. Future work: rewrite each section's body using
// DUCK components (Background, Column, ProgressBar, ButtonImage, ...).
export function makeLegacySectionLayer(id: string, section: PlayerListUiSection): Layer {
  const sectionSingleton = [section]
  class LegacySectionLayer extends Layer {
    constructor() {
      super({
        id,
        zone: ZoneType.FullScreen,
        uiTransform: { width: '100%', height: '100%', pointerFilter: 'none' },
      })
    }
    protected body() {
      return <PlayerListUi sections={sectionSingleton} />
    }
  }
  return new LegacySectionLayer()
}
