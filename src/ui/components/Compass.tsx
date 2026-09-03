/**
 * Compass.tsx — Top-of-screen compass HUD.
 *
 * Renders a horizontal bar with N / E / S / W markers that slide based on the
 * camera's yaw. The marker aligned with the center caret is whatever direction
 * the player is currently facing.
 */
import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4, Vector3 } from '@dcl/sdk/math'
import { engine, Transform } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { getPlayer } from '@dcl/sdk/players'
import { PANEL_BG, GOLD, S } from '../uiConstants'
import { getFlagAuthoritativeWorldPos } from '../../systems/flagSystem'
import { getCurrentFlagCarrierUserId } from '../../gameState/flagHoldTime'

const CARDINALS: { label: string; deg: number; color: Color4 }[] = [
  { label: 'N', deg: 0,   color: Color4.White() },
  { label: 'E', deg: 90,  color: Color4.White() },
  { label: 'S', deg: 180, color: Color4.White() },
  { label: 'W', deg: 270, color: Color4.White() },
]

/** Get camera yaw in degrees (0 = north / +Z, clockwise). */
function getCameraYawDeg(): number {
  const t = Transform.getOrNull(engine.CameraEntity)
  if (!t) return 0
  // Rotate forward vector (0,0,1) by camera rotation, read heading from x/z.
  const f = Vector3.rotate(Vector3.Forward(), t.rotation)
  let yaw = Math.atan2(f.x, f.z) * (180 / Math.PI)
  if (yaw < 0) yaw += 360
  return yaw
}

export function Compass() {
  const mobile = isMobile()
  // Desktop scales with the UI scale toggle (press 1). Mobile keeps a fixed size.
  const width = mobile ? 640 : S(520)
  const height = mobile ? 28 : S(26)
  const yaw = getCameraYawDeg()

  // Show markers within +/- 90 degrees of the current heading.
  const halfSpan = 90
  const pxPerDeg = (width / 2) / halfSpan

  const markers: any[] = []

  // Flag bearing marker (gold dot).
  const playerT = Transform.getOrNull(engine.PlayerEntity)
  // Flag position: dropped/base → authoritative world pos. Carried → carrier's avatar pos.
  let flagPos: Vector3 | null = getFlagAuthoritativeWorldPos()
  if (!flagPos) {
    const carrierId = getCurrentFlagCarrierUserId()
    if (carrierId) {
      const carrier = getPlayer({ userId: carrierId })
      if (carrier?.position) flagPos = Vector3.create(carrier.position.x, carrier.position.y, carrier.position.z)
    }
  }
  if (playerT && flagPos) {
    const dx = flagPos.x - playerT.position.x
    const dz = flagPos.z - playerT.position.z
    if (dx * dx + dz * dz > 0.01) {
      let bearing = Math.atan2(dx, dz) * (180 / Math.PI)
      if (bearing < 0) bearing += 360
      let delta = bearing - yaw
      while (delta > 180) delta -= 360
      while (delta < -180) delta += 360
      // Clamp to edges so the flag dot is always visible (even behind the player).
      const clamped = Math.max(-halfSpan, Math.min(halfSpan, delta))
      const dotSize = mobile ? 14 : S(10)
      const centerX = width / 2 + clamped * pxPerDeg
      markers.push(
        <UiEntity
          key="flag-dot"
          uiTransform={{
            positionType: 'absolute',
            position: { top: (height - dotSize) / 2, left: centerX - dotSize / 2 },
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
          }}
          uiBackground={{ color: GOLD }}
        />
      )
    }
  }

  for (const c of CARDINALS) {
    // Signed angular delta in range (-180, 180].
    let delta = c.deg - yaw
    while (delta > 180) delta -= 360
    while (delta < -180) delta += 360
    if (Math.abs(delta) > halfSpan) continue

    const centerX = width / 2 + delta * pxPerDeg
    const labelWidth = mobile ? 40 : S(30)
    markers.push(
      <Label
        key={c.label}
        value={c.label}
        fontSize={mobile ? 18 : S(16)}
        color={c.color}
        font="sans-serif"
        textAlign="middle-center"
        uiTransform={{
          positionType: 'absolute',
          position: { top: 0, left: centerX - labelWidth / 2 },
          width: labelWidth,
          height,
        }}
      />
    )
  }

  return (
    <UiEntity
      uiTransform={{
        width,
        height,
        positionType: 'relative',
        borderRadius: mobile ? 8 : S(8),
        margin: { bottom: 2 },
      }}
      uiBackground={{ color: PANEL_BG }}
    >
      <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'relative', pointerFilter: 'none' }}>
        {markers}
        {/* Center caret */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: mobile ? -4 : S(-4), left: width / 2 - 1 },
            width: 2,
            height: height + (mobile ? 8 : S(8)),
          }}
          uiBackground={{ color: Color4.White() }}
        />
      </UiEntity>
    </UiEntity>
  )
}
