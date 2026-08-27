import type { Layer } from '@stom66/dcl-ui-component-kit'
import { toastHostLayer } from '@stom66/dcl-ui-component-kit'

import { exampleLayer } from './example.layer'


/**
 * flagtag layer list.
 * Add layer instances here. Keep `toastHostLayer` if you use toasts.
 */
export const layers: Layer[] = [
	exampleLayer,
	toastHostLayer,
]
