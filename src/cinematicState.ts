// Shared cinematic state — when true, combat inputs (click/shell/banana) are disabled
let _cinematicActive = false

export function setCinematicActive(v: boolean) { _cinematicActive = v }
export function isCinematicActive() { return _cinematicActive }
