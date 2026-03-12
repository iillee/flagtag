import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // Client → Server
  registerName: Schemas.Map({ name: Schemas.String }),
  requestPickup: Schemas.Map({ t: Schemas.Int }),
  requestDrop: Schemas.Map({ t: Schemas.Int }),
  requestAttack: Schemas.Map({ t: Schemas.Int }),
  reportGroundY: Schemas.Map({ y: Schemas.Float }),

  // Server → Client
  hitVfx: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),
  missVfx: Schemas.Map({ x: Schemas.Float, y: Schemas.Float, z: Schemas.Float }),
  stagger: Schemas.Map({ victimId: Schemas.String }),
  pickupSound: Schemas.Map({ t: Schemas.Int }),
  dropSound: Schemas.Map({ t: Schemas.Int }),
}

export const room = registerMessages(Messages)
