import { Layer } from '@stom66/dcl-ui-component-kit'
import { mobileLayoutLayer } from './MobileLayoutLayer'
import { compassLayer } from './CompassLayer'

// Mobile layer stack. Currently a single wrapper around the legacy
// MobileLayout React tree — mirrors what desktop had before its per-layer
// DUCK rebuild. Individual mobile layers can be split out later.
export const mobileLayers: Layer[] = [
  mobileLayoutLayer,
  compassLayer,
]
