export interface InteriorPoint { x: number; y: number; z: number }

export const INTERIOR_CENTER: Readonly<InteriorPoint> = { x: 378, y: 0, z: 422 }
export const INTERIOR_ROTATION_DEG = 20

const rotationRad = (INTERIOR_ROTATION_DEG * Math.PI) / 180
const cosRotation = Math.cos(-rotationRad)
const sinRotation = Math.sin(-rotationRad)

/** Rotate an absolute world point around the shared room center. */
export function rotateAroundInteriorCenter(x: number, y: number, z: number): InteriorPoint {
  const dx = x - INTERIOR_CENTER.x
  const dz = z - INTERIOR_CENTER.z
  return {
    x: INTERIOR_CENTER.x + dx * cosRotation - dz * sinRotation,
    y,
    z: INTERIOR_CENTER.z + dx * sinRotation + dz * cosRotation,
  }
}
