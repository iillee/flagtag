// Shared lightning respawn state — avoids circular imports between flagSystem and lightningSystem
let _lightningRespawning = false

export function setLightningRespawning(value: boolean) {
  _lightningRespawning = value
}

export function isLightningRespawning(): boolean {
  return _lightningRespawning
}
