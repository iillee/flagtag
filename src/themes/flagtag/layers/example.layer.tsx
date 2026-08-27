import ReactEcs from '@dcl/sdk/react-ecs'

import { Background, Column, Layer, Text, ZoneType, getTheme } from '@stom66/dcl-ui-component-kit'


// MARK: ExampleLayer
/**
 * Minimal sample layer — edit or delete.
 * Panel chrome is a sibling empty `Background` (do not nest content inside it).
 */
export class ExampleLayer extends Layer {
	constructor() {
		super({
			id         : 'flagtag-example',
			zone       : ZoneType.Default,
			uiTransform: {
				width         : '40vw',
				height        : 'auto',
				alignItems    : 'center',
				justifyContent: 'center',
			},
		})
	}


	// MARK: body
	protected body() {
		const theme = getTheme()

		return [
			<Background key="chrome" backgroundColor={theme.colors.primary} borderRadius={8} />,
			<Column
				key            = "body"
				cols           = {12}
				alignItems     = "center"
				justifyContent = "center"
				padding        = {{ top: 16, right: 16, bottom: 16, left: 16 }}
			>
				<Text value="flagtag" fontSize={theme.typography.size.h3} />
			</Column>,
		]
	}
}

export const exampleLayer = new ExampleLayer()
