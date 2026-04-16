# DCL SDK7 — Responsive 2D UI System Guide

How we built the responsive UI scaling system and modular 2D UI architecture for the Poker DCL project. This guide covers:

1. Getting canvas resolution and detecting device type
2. The `getScaleFactors()` function and per-resolution scaling
3. How to use scale factors inside a UI component
4. The modular UI architecture (UI modules → UIManager → index.ts)
5. How to create a new UI module from scratch

---

## 1. Canvas Resolution — Where It Comes From

DCL SDK7 exposes the player's screen resolution via `UiCanvasInformation`, a built-in ECS component on `engine.RootEntity`.

### Initialization (index.ts)

```typescript
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'

// Global variable every UI module reads
export let globalCanvasInfo: CanvasInfo = { width: 0, height: 0 }

// Inside your main() function:

// 1. Set defaults (1080p) in case canvas isn't ready yet
globalCanvasInfo = { width: 1920, height: 1080, devicePixelRatio: 1 }

// 2. Try to read the real canvas immediately
try {
  let canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
  if (canvas && canvas.width > 0 && canvas.height > 0) {
    globalCanvasInfo = {
      width: canvas.width,
      height: canvas.height,
      devicePixelRatio: canvas.devicePixelRatio || 1,
    }
  }
} catch (error) {
  // Canvas might not be ready — defaults will be used
}

// 3. Keep it updated every frame (handles window resizes, F12, etc.)
engine.addSystem(() => {
  try {
    const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      if (canvas.width !== globalCanvasInfo.width || canvas.height !== globalCanvasInfo.height) {
        globalCanvasInfo = {
          width: canvas.width,
          height: canvas.height,
          devicePixelRatio: canvas.devicePixelRatio || 1,
        }
      }
    }
  } catch (e) {
    // Ignore — canvas might not be ready
  }
})
```

### The CanvasInfo Type

```typescript
export interface CanvasInfo {
  width: number;
  height: number;
  devicePixelRatio?: number;
}
```

This is defined in your types file and exported so all UI modules can import it.

---

## 2. Device Detection + Breakpoints

The system classifies the player's device into 4 categories based on canvas width:

| Device Type | Width Range | Scale Factor | Font Scale | Use Case |
|-------------|-------------|-------------|------------|----------|
| `mobile`    | ≤ 768px     | 1.8x        | 1.4x       | Phones — bigger touch targets |
| `tablet`    | ≤ 1024px    | 1.3x        | 1.2x       | Tablets — slightly bigger UI |
| `desktop`   | ≤ 1920px    | 1.0x        | 1.0x       | Standard monitors (base) |
| `4k`        | > 1920px    | 1.0x        | 1.0x       | High-res — same ratio, more pixels |

```typescript
const BREAKPOINTS = {
  mobile: {
    maxWidth: 768,
    scaleFactor: 1.8,
    fontScale: 1.4,
    minFontSize: 12,
    padding: 1.5,
    touchTargetMin: 44       // iOS Human Interface Guidelines minimum
  },
  tablet: {
    maxWidth: 1024,
    scaleFactor: 1.3,
    fontScale: 1.2,
    minFontSize: 14,
    padding: 1.2,
    touchTargetMin: 44
  },
  desktop: {
    maxWidth: 1920,
    scaleFactor: 1.0,        // This is the BASE — all design is done at 1080p
    fontScale: 1.0,
    minFontSize: 10,
    padding: 1.0,
    touchTargetMin: 32
  },
  highRes: {
    maxWidth: Infinity,
    scaleFactor: 1.0,
    fontScale: 1.0,
    minFontSize: 10,
    padding: 1.0,
    touchTargetMin: 32
  }
}
```

The detection function:

```typescript
export function getDeviceType(): DeviceType {
  const width = globalCanvasInfo.width

  if (width <= 768)  return 'mobile'
  if (width <= 1024) return 'tablet'
  if (width <= 1920) return 'desktop'
  return '4k'
}
```

---

## 3. The `getScaleFactors()` Function

This is the core of the system. Every UI module calls this to get scale multipliers for the current resolution.

```typescript
export function getScaleFactors() {
  const canvas = globalCanvasInfo
  const baseResolution = { width: 1920, height: 1080 } // Design target

  // How big is this screen vs our 1080p base?
  const rawScaleWidth = canvas.width / baseResolution.width     // e.g., 0.5 for 960px
  const rawScaleHeight = canvas.height / baseResolution.height   // e.g., 0.5 for 540px
  const uniformScale = Math.min(rawScaleWidth, rawScaleHeight)   // Use the smaller one

  // Get device-specific multiplier
  const deviceType = getDeviceType()
  const deviceConfig = BREAKPOINTS[deviceType === '4k' ? 'highRes' : deviceType]

  // Final scale = resolution ratio × device multiplier
  const adjustedScale = uniformScale * deviceConfig.scaleFactor

  return {
    scaleWidth: adjustedScale,        // Multiply widths/heights by this
    scaleHeight: adjustedScale,       // Same value (uniform scaling)
    deviceType,
    isMobile: deviceType === 'mobile',
    isTablet: deviceType === 'tablet',
    isTouch: deviceType === 'mobile' || deviceType === 'tablet',
    fontScale: deviceConfig.fontScale,
    minFontSize: deviceConfig.minFontSize,
    touchTargetMin: deviceConfig.touchTargetMin * adjustedScale,
    paddingScale: deviceConfig.padding,
    positionOffset: 0,
    positionOffsetTop: deviceType === 'mobile' ? 20 * adjustedScale : 0,
  }
}
```

### What the numbers mean at different resolutions

| Resolution | rawScale | Device | deviceFactor | Final `adjustedScale` |
|------------|----------|--------|-------------|----------------------|
| 1920×1080  | 1.0      | desktop | 1.0        | **1.0** (base)       |
| 1280×720   | 0.667    | desktop | 1.0        | **0.667**            |
| 960×540    | 0.5      | mobile  | 1.8        | **0.9**              |
| 768×1024   | 0.4      | mobile  | 1.8        | **0.72**             |
| 2560×1440  | 1.333    | 4k     | 1.0        | **1.333**            |
| 3840×2160  | 2.0      | 4k     | 1.0        | **2.0**              |

---

## 4. Using Scale Factors in a UI Component

The pattern is always the same: call `getScaleFactors()` at the top of your render function, then multiply every pixel value by the scale.

### Example — A Simple Pot Display

```tsx
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { getScaleFactors, roundedBg } from './uiUtils'
import { globalCanvasInfo } from '../../index'

export function PotDisplayUI() {
  // 1. Get scale factors for current resolution
  const { scaleWidth, scaleHeight } = getScaleFactors()

  // 2. Define sizes at 1080p base, then multiply
  const panelWidth = 240 * scaleWidth       // 240px at 1080p, 160px at 720p, 480px at 4K
  const panelHeight = 36 * scaleHeight
  const fontSize = 22 * scaleHeight          // Font scales with resolution too
  const padding = 4 * scaleHeight

  // 3. Center horizontally using canvas width
  const leftPosition = (globalCanvasInfo.width - panelWidth) / 2

  // 4. Position from top (also scaled)
  const topPosition = 120 * scaleHeight

  return (
    <UiEntity
      uiTransform={{
        width: panelWidth,
        height: panelHeight,
        positionType: 'absolute',
        position: { top: topPosition, left: leftPosition },
        padding: { top: padding, bottom: padding }
      }}
      uiBackground={roundedBg('#1A1A1ABB')}
    >
      <Label
        value="Pot: 500"
        fontSize={fontSize}
        color={Color4.fromHexString('#FFD700')}
        textAlign="middle-center"
      />
    </UiEntity>
  )
}
```

### Key rules:
- **Always multiply pixel values** — widths, heights, font sizes, margins, padding
- **Use `globalCanvasInfo.width`** for centering calculations
- **Use `positionType: 'absolute'`** + `position: { top, left }` for placing panels on screen
- **Design at 1080p first**, then let `getScaleFactors()` handle the rest

---

## 5. Nine-Slice Rounded Backgrounds

Instead of using flat `Color4` backgrounds, we use a nine-slice white PNG tinted to any color:

```typescript
const ROUNDED_RECT_SRC = 'images/UI/rounded-rect-white.png'
const NINE_SLICE = { top: 0.2, bottom: 0.2, left: 0.2, right: 0.2 }

export function roundedBg(hexColor: string) {
  return {
    textureMode: 'nine-slices' as const,
    texture: { src: ROUNDED_RECT_SRC },
    textureSlices: NINE_SLICE,
    color: Color4.fromHexString(hexColor)
  }
}
```

Usage: `uiBackground={roundedBg('#0D0D1AE8')}` (the last 2 hex chars are alpha, e.g., `E8` = ~91% opacity, `BB` = ~73%).

You need a small white rounded-rectangle PNG (e.g., 64x64px with rounded corners). The nine-slice system stretches the center while keeping corners intact.

---

## 6. The Modular UI Architecture

### The Pattern

Each UI feature is a self-contained module with:
1. **Module-level state** (plain object, not React state)
2. **Setter functions** to update that state (exported, called from game logic)
3. **A render function** that reads the state and returns JSX (or `null` if hidden)

```
Game Logic (index.ts / colyseusManager.ts)
    │
    │ calls setter functions
    ▼
UI Module State (module-level let)
    │
    │ read by render function
    ▼
UIManager.tsx (calls all render functions in ReactEcsRenderer)
    │
    ▼
Screen
```

### File Structure

```
src/ui/
├── index.ts                     ← Barrel exports (re-exports from UIManager + modules)
├── UIManager.tsx                ← Central renderer (calls all module render functions)
├── casual/                      ← Floor-specific modules
│   ├── JoinModalUI.tsx
│   └── PlayerListUI.tsx
├── competitive/
│   ├── CompetitiveJoinModalUI.tsx
│   ├── CompetitivePlayerListUI.tsx
│   └── CompetitiveWaitingUI.tsx
└── shared/                      ← Shared modules (used on all floors)
    ├── uiUtils.ts               ← getScaleFactors(), roundedBg(), helpers
    ├── BettingUI.tsx
    ├── PotDisplayUI.tsx
    ├── HandResultUI.tsx
    ├── HoleCardsUI.tsx
    ├── CommunityCardsUI.tsx
    └── ... (20+ modules)
```

---

## 7. Creating a New UI Module (Step by Step)

### Step 1: Create the module file

Create `src/ui/shared/MyNewUI.tsx`:

```tsx
// src/ui/shared/MyNewUI.tsx
// Description of what this UI does

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { getScaleFactors, roundedBg } from './uiUtils'
import { globalCanvasInfo } from '../../index'

// ==================
// Module-level state
// ==================
let myState = {
  isVisible: false,
  message: '',
  count: 0,
}

// ==================
// Setter functions (exported — called from game logic)
// ==================

/** Show the UI with a message */
export function showMyUI(message: string, count: number) {
  myState.isVisible = true
  myState.message = message
  myState.count = count
}

/** Hide the UI */
export function hideMyUI() {
  myState.isVisible = false
  myState.message = ''
  myState.count = 0
}

// ==================
// Render function (exported — called by UIManager)
// ==================

export function MyNewUI() {
  // Return null when hidden — renders nothing
  if (!myState.isVisible) return null

  // Get responsive scale factors
  const { scaleWidth, scaleHeight } = getScaleFactors()

  // Design at 1080p, scale everything
  const panelWidth = 300 * scaleWidth
  const panelHeight = 100 * scaleHeight
  const titleFontSize = 24 * scaleHeight
  const bodyFontSize = 16 * scaleHeight

  // Center horizontally
  const leftPosition = (globalCanvasInfo.width - panelWidth) / 2
  // Position from top
  const topPosition = 200 * scaleHeight

  return (
    <UiEntity
      key="my-new-ui"
      uiTransform={{
        width: panelWidth,
        height: panelHeight,
        positionType: 'absolute',
        position: { top: topPosition, left: leftPosition },
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      uiBackground={roundedBg('#1A1A2AE8')}
    >
      <Label
        value={myState.message}
        fontSize={titleFontSize}
        color={Color4.fromHexString('#FFD700')}
        uiTransform={{ width: '100%', height: 32 * scaleHeight }}
        textAlign="middle-center"
      />
      <Label
        value={`Count: ${myState.count}`}
        fontSize={bodyFontSize}
        color={Color4.White()}
        uiTransform={{ width: '100%', height: 24 * scaleHeight }}
        textAlign="middle-center"
      />
    </UiEntity>
  )
}
```

### Step 2: Register in UIManager.tsx

Open `src/ui/UIManager.tsx` and add two things:

**a) Import at the top:**
```typescript
import { MyNewUI } from './shared/MyNewUI'
```

**b) Add to the renderer array:**
```typescript
ReactEcsRenderer.setUiRenderer(() => [
  JoinModalUI(),
  PlayerListUI(),
  // ... existing modules ...
  MyNewUI(),               // ← Add your new module here
  BuildVersionUI()
])
```

That's it for rendering. The UIManager just calls every module's render function every frame. If `myState.isVisible` is false, it returns `null` and renders nothing.

### Step 3: Export setter functions through UIManager (optional)

If other files need to call your setter functions, re-export them from UIManager:

```typescript
// In UIManager.tsx — add at the bottom
export { showMyUI, hideMyUI } from './shared/MyNewUI'
```

### Step 4: Call setters from game logic (index.ts or colyseusManager.ts)

```typescript
// In index.ts or wherever your game logic lives
import { showMyUI, hideMyUI } from './ui/UIManager'

// When something happens in the game:
showMyUI("You won!", 500)

// When it should disappear:
hideMyUI()
```

---

## 8. Helper Functions Available in uiUtils.ts

| Function | What it does |
|----------|-------------|
| `getScaleFactors()` | Returns all scale multipliers for current resolution |
| `roundedBg(hexColor)` | Nine-slice rounded rect background tinted to any color |
| `getDeviceType()` | Returns `'mobile'`, `'tablet'`, `'desktop'`, or `'4k'` |
| `isTouchDevice()` | `true` if mobile or tablet |
| `getResponsiveFontSize(base)` | Scales font with minimum threshold |
| `getMinTouchSize()` | Minimum button size for touch devices |
| `getSafeAreaInsets()` | Safe area for notches/home indicators |
| `useCompactLayout()` | `true` if screen is very small |
| `getOptimalGridColumns(itemWidth)` | How many columns fit in a grid |
| `setPlayerHasPosition(pos)` | Track if player is seated (for hiding UI when queued) |
| `playerHasRealPosition()` | Check if player is seated |

---

## 9. Key Patterns / Gotchas

### Module-level state, NOT React state
DCL's React ECS doesn't support `useState` or `useEffect`. All state is plain module-level `let` variables. The render function reads them directly.

### Visibility via `return null`
Every render function starts with `if (!state.isVisible) return null`. This is how you show/hide UI — it costs nothing when hidden.

### Always use a unique `key` prop
Every top-level `<UiEntity>` needs a `key` prop: `key="my-module-name"`. This prevents DCL's UI renderer from getting confused between modules.

### Absolute positioning for overlays
Use `positionType: 'absolute'` with `position: { top, left }` for screen-space UI. Use `globalCanvasInfo.width` to calculate centered positions.

### Hex colors with alpha
`Color4.fromHexString()` supports 8-character hex: `'#1A1A2AE8'` where `E8` is the alpha (0-FF). Common values: `FF`=100%, `E8`=91%, `CC`=80%, `BB`=73%, `80`=50%.

### No console.log on client
`console.log` in DCL client code is invisible — there's no client console. Only server logs show up. Don't add logging to UI modules.
