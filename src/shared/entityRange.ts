/**
 * entityRange.ts — the renderer-reserved entity range test.
 *
 * Pure module: no engine import, so it can be unit-tested under jest (same reasoning as
 * positionHistory.ts / identitySweep.ts). The side-effecting allocator wrapper that uses
 * it lives in reservedEntityGuard.ts.
 */

/**
 * Entity numbers below this are owned by the renderer at EVERY version: the static
 * entities (root 0, player 1, camera 2) and the range the avatar-communication system
 * allocates remote players from ([32, 256) today).
 */
export const RESERVED_ENTITY_NUMBERS = 512

/**
 * True when `entity`'s NUMBER falls in the renderer-reserved range.
 *
 * Masks to the low 16 bits deliberately — do NOT "simplify" this to
 * `entity < RESERVED_ENTITY_NUMBERS`. A DCL Entity packs the version into the high 16
 * bits, so a raw comparison only catches version 0: entity number 32 at version 1 packs
 * to 65568 and passes it. That is the exact bug in `@dcl/ecs`'s own `removeEntity`
 * (`engine/entity.ts`), and it is what let a scene locally destroy a live remote player's
 * entity. Every reserved-range test in this scene must go through here.
 */
export function isReservedEntity(entity: number): boolean {
  return (entity & 0xffff) < RESERVED_ENTITY_NUMBERS
}

/** `65568` -> `"65568 (#32 v1)"`. For logs, so a reserved id is recognisable at a glance. */
export function describeEntityId(entity: number): string {
  return `${entity} (#${entity & 0xffff} v${(entity >>> 16) & 0xffff})`
}
