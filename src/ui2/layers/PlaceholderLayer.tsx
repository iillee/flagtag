import ReactEcs from '@dcl/sdk/react-ecs'
import { Background, Column, Layer, Text, ZoneType, getTheme } from '@stom66/dcl-ui-component-kit'

// MARK: PlaceholderLayer
// Phase 0 sanity check — proves SetupUiComponentKit is wired.
// Delete once the first real layer (HudTopLayer) is in place.
export class PlaceholderLayer extends Layer {
  constructor() {
    super({
      id: 'flagtag-ui2-placeholder',
      zone: ZoneType.Top,
      uiTransform: { width: 'auto', height: 'auto', alignItems: 'center', justifyContent: 'center' },
    })
  }

  protected body() {
    const theme = getTheme()
    return [
      <Background key="chrome" backgroundColor={theme.colors.primary} borderRadius={6} />,
      <Column
        key="body"
        cols={12}
        alignItems="center"
        justifyContent="center"
        padding={{ top: 8, right: 16, bottom: 8, left: 16 }}
      >
        <Text value="UI2 Active" fontSize={theme.typography.size.default} />
      </Column>,
    ]
  }
}
