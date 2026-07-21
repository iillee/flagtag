import { INTERIOR_CENTER, rotateAroundInteriorCenter } from './interiorGeometry'

export interface CoinLocation { x: number; y: number; z: number }

function rotateInteriorOffset(x: number, y: number, z: number): CoinLocation {
  return rotateAroundInteriorCenter(
    INTERIOR_CENTER.x + x,
    INTERIOR_CENTER.y + y,
    INTERIOR_CENTER.z + z
  )
}

/**
 * Code-built room coins do not exist in the static composite, so both client and
 * authoritative server consume this shared list to derive identical pickup ids.
 */
export const INTERIOR_COIN_LOCATIONS: readonly CoinLocation[] = [
  rotateInteriorOffset(3.5, 0.8, 3.5),
  rotateInteriorOffset(3.5, 0.8, -3.5),
  rotateInteriorOffset(-1, 0.8, 3.5),
  rotateInteriorOffset(-1, 0.8, -3.5),
  rotateInteriorOffset(-3, 0.8, 1.5),
  rotateInteriorOffset(-3, 0.8, -1.5),
]
