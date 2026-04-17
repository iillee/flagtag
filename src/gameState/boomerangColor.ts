export type BoomerangColor = 'r' | 'y' | 'b' | 'g'

const COLOR_LABELS: Record<BoomerangColor, string> = {
  r: 'Red',
  y: 'Yellow',
  b: 'Blue',
  g: 'Green'
}

let selectedColor: BoomerangColor = 'r'
const changeListeners: Array<(color: BoomerangColor) => void> = []

export function getBoomerangColor(): BoomerangColor {
  return selectedColor
}

export function getBoomerangModelSrc(): string {
  return `assets/models/boomerang.${selectedColor}.glb`
}

export function getBoomerangColorLabel(): string {
  return COLOR_LABELS[selectedColor]
}

export function setBoomerangColor(color: BoomerangColor): void {
  if (color === selectedColor) return
  selectedColor = color
  console.log(`[Boomerang] Color changed to ${COLOR_LABELS[color]}`)
  for (const listener of changeListeners) {
    listener(color)
  }
}

export function onBoomerangColorChange(listener: (color: BoomerangColor) => void): void {
  changeListeners.push(listener)
}
