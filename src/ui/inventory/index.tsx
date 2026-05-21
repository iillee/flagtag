/** Inventory system — root component. Mounts hotbar + conditional grid. */
import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { InventoryHotbar } from './Hotbar'
import { InventoryGrid } from './InventoryGrid'
import { showInventory } from './state'

export { toggleInventory, setShowInventory, showInventory } from './state'
export { hotbar } from './state'
export type { GameItem } from './items'

export const Inventory = () => {
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
      {showInventory && <InventoryGrid />}
      <InventoryHotbar />
    </UiEntity>
  )
}
