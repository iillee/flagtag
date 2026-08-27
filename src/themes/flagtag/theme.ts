import { Color4 } from '@dcl/sdk/math'
import type { ThemeCustomize } from '@stom66/dcl-ui-component-kit'

// MARK: theme
/**
 * Flag Tag theme — matches the game's legacy uiConstants palette so that
 * DUCK primitives (Background, Text, ButtonImage, …) inherit the right look
 * out of the box.
 *
 * Source of truth for these values is src/ui/uiConstants.ts; keep in sync.
 */
export const theme: ThemeCustomize = {
  colors: {
    body     : Color4.create(0.1, 0.1, 0.1, 0.92),   // PANEL_BG
    dark     : Color4.create(0.06, 0.06, 0.08, 1),
    light    : Color4.create(1, 1, 1, 1),            // WHITE
    primary  : Color4.create(1, 0.84, 0, 1),         // GOLD (accent)
    secondary: Color4.create(0.72, 0.72, 0.75, 1),   // LIGHT_GREY
    tertiary : Color4.create(0.82, 0.82, 0.85, 1),   // MUTED
    danger   : Color4.create(0.9, 0.15, 0.15, 1),
    info     : Color4.create(0.2, 0.6, 1, 1),
    success  : Color4.create(0.3, 0.85, 0.4, 1),
    warning  : Color4.create(1, 0.9, 0.3, 1),
  },
  border: {
    radiusDefault: 18,
    radiusSmall  : 6,
    radiusLarge  : 20,
    width        : 0,
  },
}
