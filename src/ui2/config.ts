// ═══════════════════════════════════════════════════════════
// UI2 (DUCK rebuild) — feature flag & platform helpers
// ═══════════════════════════════════════════════════════════
// Flip USE_NEW_UI to true to render the new DUCK-based UI
// instead of the legacy PlayerListUi tree in src/ui.tsx.
// While false, nothing about the old UI changes.

import { isMobile as isMobileNative } from '@dcl/sdk/platform'

export const USE_NEW_UI = true

export function isDesktop(): boolean {
  return !isMobileNative()
}

export function isMobile(): boolean {
  return isMobileNative()
}
