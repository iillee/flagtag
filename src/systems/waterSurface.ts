/**
 * Scene water: a circular moat-sized disk at the historic footprint and
 * height, with pixelwars-style glossy water and tiny morph-target ripples.
 *
 * The root entity is what the lever cycle tweens. Drowning still reads the
 * root's Y (the mean surface), not the wave crests.
 */
import {
  engine, Entity, Transform, MeshRenderer, Material, MaterialTransparencyMode,
  Animator, Tween, GltfContainer, GltfNodeModifiers, VisibilityComponent,
  TextureFilterMode, TextureWrapMode,
} from '@dcl/sdk/ecs'
import { Color3, Color4, Vector2, Vector3 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { WATER_SURFACE, waterSurfaceDiameterM } from '../shared/waterLook'

const W = WATER_SURFACE

function repeatTex(src: string, tiling = 1) {
  return Material.Texture.Common({
    src,
    wrapMode: TextureWrapMode.TWM_REPEAT,
    filterMode: TextureFilterMode.TFM_TRILINEAR,
    tiling: Vector2.create(tiling, tiling),
  })
}

function swellShade() {
  const c = W.color
  const clear = W.clear
  const gloss = W.gloss
  const hi = W.glossReflectivity
  const shade = {
    albedoColor: Color4.create(c.r, c.g, c.b, clear ? W.clearAlpha : c.a),
    metallic: W.metallic,
    roughness: gloss ? W.glossRoughness : W.roughness,
    specularIntensity: gloss ? W.glossSpecular : W.specular,
    reflectivityColor: gloss ? Color3.create(hi.r, hi.g, hi.b) : Color3.create(c.r, c.g, c.b),
    transparencyMode: clear ? MaterialTransparencyMode.MTM_ALPHA_BLEND : MaterialTransparencyMode.MTM_OPAQUE,
    castShadows: false as const,
  }
  if (!W.softNormal) return shade
  return {
    ...shade,
    texture: repeatTex(W.albedoSrc),
    bumpTexture: Material.Texture.Common({
      src: W.softNormalSrc,
      wrapMode: TextureWrapMode.TWM_REPEAT,
      filterMode: TextureFilterMode.TFM_TRILINEAR,
    }),
  }
}

function scrollTexture(ent: Entity, x: number, z: number, speed: number): void {
  const len = Math.hypot(x, z) || 1
  Tween.setTextureMoveContinuous(ent, Vector2.create(x / len, z / len), speed)
}

function hideCompositeWater(): void {
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    const gltf = GltfContainer.get(entity)
    if (gltf.src.includes('WaterPatchFull')) {
      VisibilityComponent.createOrReplace(entity, { visible: false })
      console.log('[Interior] Hid composite water entity')
      break
    }
  }
}

function addFloor(root: Entity): void {
  const floor = engine.addEntity()
  Transform.create(floor, {
    parent: root,
    position: Vector3.create(0, -W.floorBelowM, 0),
    scale: Vector3.create(W.diameterM, 0.02, W.diameterM),
  })
  MeshRenderer.setCylinder(floor, 0.5, 0.5)
  const c = W.floorColor
  Material.setPbrMaterial(floor, {
    albedoColor: Color4.create(c.r, c.g, c.b, 1),
    roughness: 1,
    metallic: 0,
    specularIntensity: 0,
    transparencyMode: MaterialTransparencyMode.MTM_OPAQUE,
    castShadows: false,
  })
}

function addFlatCylinder(root: Entity): Entity {
  const surface = engine.addEntity()
  const diameter = waterSurfaceDiameterM()
  Transform.create(surface, {
    parent: root,
    position: Vector3.Zero(),
    scale: Vector3.create(diameter, 0.02, diameter),
  })
  MeshRenderer.setCylinder(surface, 0.5, 0.5)
  const c = W.color
  Material.setPbrMaterial(surface, {
    albedoColor: Color4.create(c.r, c.g, c.b, W.clear ? W.clearAlpha : c.a),
    metallic: W.metallic,
    roughness: W.gloss ? W.glossRoughness : W.roughness,
    specularIntensity: W.gloss ? W.glossSpecular : W.specular,
    reflectivityColor: W.gloss
      ? Color3.create(W.glossReflectivity.r, W.glossReflectivity.g, W.glossReflectivity.b)
      : Color3.create(c.r, c.g, c.b),
    transparencyMode: W.clear ? MaterialTransparencyMode.MTM_ALPHA_BLEND : MaterialTransparencyMode.MTM_OPAQUE,
    texture: W.softNormal ? repeatTex(W.albedoSrc) : undefined,
    bumpTexture: W.softNormal
      ? Material.Texture.Common({
        src: W.softNormalSrc,
        wrapMode: TextureWrapMode.TWM_REPEAT,
        filterMode: TextureFilterMode.TFM_TRILINEAR,
      })
      : undefined,
    castShadows: false,
  })
  if (W.softNormal) scrollTexture(surface, W.softNormalDirX, W.softNormalDirZ, W.softNormalSpeed)
  return surface
}

function addWaveMesh(root: Entity, src: string, playClip: boolean): Entity {
  const wave = engine.addEntity()
  Transform.create(wave, {
    parent: root,
    position: Vector3.Zero(),
    scale: Vector3.create(1, W.heightScale, 1),
  })
  GltfContainer.create(wave, {
    src,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0,
  })
  if (playClip) {
    Animator.create(wave, {
      states: [{
        clip: 'wave',
        playing: true,
        loop: true,
        speed: W.clipS / Math.max(0.01, W.periodS),
        weight: 1,
      }],
    })
  }
  GltfNodeModifiers.create(wave, {
    modifiers: [{
      path: '',
      castShadows: false,
      material: {
        material: {
          $case: 'pbr',
          pbr: swellShade(),
        },
      },
    }],
  })
  if (W.softNormal) scrollTexture(wave, W.softNormalDirX, W.softNormalDirZ, W.softNormalSpeed)
  return wave
}

function watchMobile(root: Entity, desktop: Entity): void {
  let age = 0
  let swapped = false
  function tick(dt: number): void {
    age += dt
    if (!isMobile()) {
      if (age > 5) engine.removeSystem(tick)
      return
    }
    if (!swapped) {
      swapped = true
      engine.removeEntity(desktop)
      if (W.mobileWaves) addWaveMesh(root, W.meshLiteSrc, true)
      else addFlatCylinder(root)
    }
    engine.removeSystem(tick)
  }
  engine.addSystem(tick)
}

/**
 * Hide the composite water GLB and spawn the runtime surface + floor.
 * Returns the root entity (mean surface Y) for the rise/lower tween.
 */
export function buildCircularWater(): Entity {
  hideCompositeWater()

  const root = engine.addEntity()
  Transform.create(root, {
    position: Vector3.create(W.centerX, W.baseY, W.centerZ),
  })
  addFloor(root)

  if (!W.waves) {
    addFlatCylinder(root)
    console.log('[Interior] Created flat water surface, diameter:', waterSurfaceDiameterM(), 'm')
    return root
  }

  const mobile = isMobile()
  if (mobile) {
    if (W.mobileWaves) addWaveMesh(root, W.meshLiteSrc, true)
    else addFlatCylinder(root)
    console.log('[Interior] Created lite water surface, diameter:', waterSurfaceDiameterM(), 'm waves:', W.mobileWaves)
    return root
  }

  const desktop = addWaveMesh(root, W.meshSrc, true)
  watchMobile(root, desktop)
  console.log('[Interior] Created circular water waves, diameter:', waterSurfaceDiameterM(), 'm amp:', W.amplitudeM)
  return root
}

export { WATER_SURFACE }
