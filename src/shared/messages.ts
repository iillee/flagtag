import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // Client → Server
  registerName: Schemas.Map({ name: Schemas.String }),
  requestPickup: Schemas.Map({ t: Schemas.Int }),
  requestDrop: Schemas.Map({ t: Schemas.Int }),
  requestAttack: Schemas.Map({ t: Schemas.Int }),
  reportGroundY: Schemas.Map({ y: Schemas.Float }),
  requestBanana: Schemas.Map({ t: Schemas.Int }),
  reportBananaGroundY: Schemas.Map({ bananaX: Schemas.Float, bananaZ: Schemas.Float, groundY: Schemas.Float }),
  requestShell: Schemas.Map({ dirX: Schemas.Float, dirZ: Schemas.Float, color: Schemas.String, chargeSpeed: Schemas.Float, chargeRange: Schemas.Float, chargeScale: Schemas.Float }),
  reportShellWallDist: Schemas.Map({ shellId: Schemas.Float, maxDist: Schemas.Float }),
  reportShellGroundY: Schemas.Map({ shellX: Schemas.Float, shellZ: Schemas.Float, groundY: Schemas.Float }),

  // Server → Client
  hitVfx: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),
  missVfx: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),
  stagger: Schemas.Map({ victimId: Schemas.String }),
  pickupConfirmed: Schemas.Map({ playerId: Schemas.String }),
  pickupSound: Schemas.Map({ t: Schemas.Int }),
  dropSound: Schemas.Map({ t: Schemas.Int }),
  bananaDropped: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, ownerId: Schemas.String }),
  bananaTriggered: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, victimId: Schemas.String }),
  shellDropped: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, dirX: Schemas.Float, dirZ: Schemas.Float, color: Schemas.String, firedBy: Schemas.String, chargeSpeed: Schemas.Float, chargeRange: Schemas.Float, chargeScale: Schemas.Float }),
  shellTriggered: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, victimId: Schemas.String, peak: Schemas.Optional(Schemas.Boolean) }),


  // Updraft messages
  requestUpdraftLocation: Schemas.Map({ t: Schemas.Int }),
  updraftLocation: Schemas.Map({ index: Schemas.Int }),

  // Mushroom messages
  requestMushroomPositions: Schemas.Map({ t: Schemas.Int }),
  pickupMushroom: Schemas.Map({ id: Schemas.Int }),
  mushroomPositions: Schemas.Map({ mushroomsJson: Schemas.String, fullReset: Schemas.Optional(Schemas.Boolean) }),   // JSON array of {id, candidates: [{x,z}]}
  mushroomPickedUp: Schemas.Map({ id: Schemas.Int, playerId: Schemas.String }),
  mushroomShield: Schemas.Map({ durationMs: Schemas.Int, playerId: Schemas.String }),
  shieldConsumed: Schemas.Map({ playerId: Schemas.String }),
  flagImmunity: Schemas.Map({ playerId: Schemas.String, durationMs: Schemas.Int }),
  playerShieldActive: Schemas.Map({ playerId: Schemas.String, active: Schemas.Int }),

  // Boomerang color sync
  colorChanged: Schemas.Map({ color: Schemas.String }),
  playerColorChanged: Schemas.Map({ playerId: Schemas.String, color: Schemas.String }),

  // Green orbit mechanic
  requestOrbit: Schemas.Map({ t: Schemas.Int }),
  orbitHitWall: Schemas.Map({ t: Schemas.Int }),
  orbitStarted: Schemas.Map({ playerId: Schemas.String, durationMs: Schemas.Int }),
  orbitHit: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, victimId: Schemas.String, attackerId: Schemas.String }),
  orbitEnded: Schemas.Map({ playerId: Schemas.String }),

  // Boomerang charge sync (lightweight: start/stop only)
  chargeStart: Schemas.Map({ t: Schemas.Int }),
  chargeStop: Schemas.Map({ t: Schemas.Int }),
  playerChargeStart: Schemas.Map({ playerId: Schemas.String, t: Schemas.Int }),
  playerChargeStop: Schemas.Map({ playerId: Schemas.String, t: Schemas.Int }),

  // Lightning (carrier client → all clients)
  lightningWarning: Schemas.Map({ t: Schemas.Int }),
  lightningStrike: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, victimId: Schemas.String }),

  // Round end respawn
  requestReloadRespawn: Schemas.Map({ t: Schemas.Int }),
  respawnPlayers: Schemas.Map({ t: Schemas.Int, winnersJson: Schemas.String }),

  // Admin: trigger Discord report manually
  testDiscord: Schemas.Map({ t: Schemas.Int }),


}

export const room = registerMessages(Messages)
