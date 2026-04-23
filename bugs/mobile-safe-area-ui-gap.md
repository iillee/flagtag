# Bug Report: UI Fullscreen Overlays Don't Cover Safe Area on Mobile

**Date:** April 23, 2026  
**Reporter:** Flag Tag scene developers  
**Platform:** Decentraland Mobile App (v0.58.0-1c2b5f1-prod)  
**Device:** Phone with notch/dynamic island (landscape orientation)  

## Summary

Full-screen UI overlays rendered via React-ECS (`width: '100%', height: '100%'`) do not extend to the physical screen edges on mobile devices. A strip of the 3D scene remains visible behind the overlay, breaking the intended effect of black screens, death screens, fade transitions, and modal backgrounds.

## Screenshot

![Mobile screenshot showing gap](../assets/images/mobile%20screenshot1.png)

Note the left edge of the screen — the 3D world is visible behind what should be a fully opaque black overlay.

## Steps to Reproduce

1. Open any Decentraland scene on mobile that uses a full-screen UI overlay (e.g. black fade, death screen, title splash)
2. Hold device in landscape orientation
3. Observe that the overlay does not cover the safe area inset region — a thin strip of the 3D scene is visible on one or both edges

## Expected Behavior

Full-screen UI elements with `width: '100%', height: '100%'` and `positionType: 'absolute', position: { top: 0, left: 0 }` should cover the entire physical screen, including the area behind the notch/safe area insets.

## Actual Behavior

The UI canvas is inset from the screen edges to respect the device safe area. Scene code has no mechanism to draw outside this canvas, so full-screen overlays (black screens, fade transitions, modal backdrops) leave a visible gap where the 3D scene shows through.

## Impact

This affects **any scene** that uses:
- Black fade transitions (cinematic sequences)
- Death/respawn overlays
- Title splash screens
- Modal popup backdrops
- Any full-screen semi-transparent or opaque UI layer

## Suggested Fix

The mobile app renderer should either:

1. **Extend the UI canvas to the full physical screen** — let `width: '100%'` truly mean 100% of the display, and let scene developers handle safe area padding themselves
2. **Fill the safe area inset region with the nearest UI background color** — similar to iOS `edgesIgnoringSafeArea(.all)` or Android `WindowCompat.setDecorFitsSystemWindows(window, false)`
3. **Provide a scene-accessible API** (e.g. a component or canvas property) that lets developers opt in to drawing behind the safe area for specific UI elements

Option 1 or 2 would fix this transparently for all existing scenes without requiring scene code changes.

## Environment

- Decentraland Mobile App: v0.58.0-1c2b5f1-prod - Opt
- SDK: @dcl/sdk ^7.22.5
- Scene: Flag Tag (flagtag.dcl.eth) — 1024-parcel world
