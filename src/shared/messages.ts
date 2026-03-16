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
  requestShell: Schemas.Map({ dirX: Schemas.Float, dirZ: Schemas.Float }),
  reportShellWallDist: Schemas.Map({ shellId: Schemas.Float, maxDist: Schemas.Float }),
  reportShellGroundY: Schemas.Map({ shellX: Schemas.Float, shellZ: Schemas.Float, groundY: Schemas.Float }),

  // Server → Client
  hitVfx: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),
  missVfx: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),
  stagger: Schemas.Map({ victimId: Schemas.String }),
  pickupSound: Schemas.Map({ t: Schemas.Int }),
  dropSound: Schemas.Map({ t: Schemas.Int }),
  bananaDropped: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),
  bananaTriggered: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, victimId: Schemas.String }),
  shellDropped: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),
  shellTriggered: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float, victimId: Schemas.String }),
}

export const room = registerMessages(Messages)
