import { engine, Entity, Transform, UiCanvasInformation } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/src/players'
import { signedFetch } from '~system/SignedFetch'
import { openExternalUrl } from '~system/RestrictedActions'
import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { ReactEcsRenderer, UiEntity } from '@dcl/sdk/react-ecs'

/**
 * ForgeScriptModular — Creator Hub–ready Forge client.
 * Copy into your scene (e.g. Scripts/ForgeScriptModular.tsx), set **verseId** in the inspector (change **serverUrl** in source if you use another environment).
 * UI and behavior are driven by the modular JSON from the server; **@action** methods below appear in the Creator Hub action picker.
 */

export class ForgeScriptModular {
  // Canvas dimensions shared by all instances.
  private static dimensions = { width: 0, height: 0, aspect: 0 }
  private static uiTimer = 0

  private static readonly UI_STEP_KINDS: any = [
    'setState',
    'toggleState',
    'call',
    'emit',
    'openUrl',
    'fetchApiData',
    'callApi',
    'beginShopListingSync'
  ]
  // as const

  /**
   * Keys held only on the client after the first config hydrate; remote polls must not overwrite them.
   * Initial values come from config.uiState (preferred) or legacy uiFlags on first apply only.
   */
  private static readonly TRANSIENT_UI_STATE_KEYS: Set<string> = new Set([
    'showForgePanel',
    'showQuestPanel',
    'showInventoryPanel',
    'showStatsPanel',
    'selectedQuest',
    'selectedStep',
    'showShop',
    'shopInventory',
    'shopCreatorWallet',
    'selectedItemId',
    'shopPending',
    'shopPurchaseResult',
    'shopListingSyncPendingItemId',
    'showLeaderboardPanel',
    'leaderboardView',
    'inventoryTooltipText',
    'inventoryTooltipItem'
  ])

  private static readonly MESSAGE_STEP_KINDS: any = [
    'applyUserProfile',
    'updateLocalInventory',
    'updateLocalQuestProgress',
    'setIsPlayerIdle',
    'mergeProfile',
    'notify',
    'dispatchEvent',
    'logError',
    'setState',
    'toggleState',
    'call',
    'fetchApiData',
    'callApi',
    'patchShopInventoryListing',
    'clearShopListingSyncIfBuyer'
  ]
  // as const

  private static updateDimensions(dt: any) {
    if (ForgeScriptModular.uiTimer > 0) {
      ForgeScriptModular.uiTimer -= dt
      return
    }
    ForgeScriptModular.uiTimer = 3
    const canvas = UiCanvasInformation.get(engine.RootEntity)
    ForgeScriptModular.dimensions.width = canvas.width
    ForgeScriptModular.dimensions.height = canvas.height
    ForgeScriptModular.dimensions.aspect = canvas.width / canvas.height
  }

  // Creator Hub smart items read configurable fields from constructor parameter
  // properties only — not from class-body initializers. Options live in `constructor` below.

  // ─── Private runtime state ────────────────────────────────────────────────
  private readonly serverUrl = 'https://theforgecore.xyz/ws'
  private kernel = {
    token: '',
    userId: '',
    forgeConnected: false,
    isForgeConnecting: false,
    isHeartbeatRunning: false,
    errorPings: 0
  }

  private player: any = undefined
  private foundPlayer = false
  private pendingPlayerTimer = 2
  private heartbeatTimer = 2
  private heartbeatInterval = 2

  private behaviorConfig: any = { version: '1.0.0', enabledHandlers: [] }
  private readonly clientScriptVersion = '1.0.0'
  private behaviorPollTimer = 0
  private behaviorPollInterval = 15
  private hasStarted = false
  private isStartBootstrapping = false

  private userProfiles: any = new Map()
  private eventCallbacks: any = new Map()
  private uiOwnerEntity!: Entity
  private uiComponent: any = () => []

  /** Session UI state; seeded once from remote config.uiState (and legacy uiFlags transients). */
  private uiState: any = {}
  private uiStateSeededFromRemote = false
  private uiSectionsFromApi: any = []
  private uiActionsFromApi: any = {}
  private messageActionsByType: any = {}
  /** Defaults; overridden by config.scriptRuntime.tokenBalanceDisplay */
  private tokenDisplayDecimals = 18
  private tokenDisplayMaxFractionDigits = 8
  private parseTokenAmountWeiFn = (raw: any): any => this.builtinParseTokenAmountWei(raw)
  private formatWeiBalanceDisplayFn = (wei: any, decimals?: any, maxFractionDigits?: any): any =>
    this.builtinFormatWeiBalanceDisplay(
      wei,
      decimals ?? this.tokenDisplayDecimals,
      maxFractionDigits ?? this.tokenDisplayMaxFractionDigits
    )
  private readonly callMethodAllowList: any = {
    FORGEConnect: () => this.FORGEConnect(),
    FORGEDisconnect: () => this.FORGEDisconnect(),
    FORGEQuestAction: (...args: any) =>
      this.FORGEQuestAction(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8]),
    FORGEGenericAction: (...args: any) =>
      this.FORGEGenericAction(args[0], args[1], args[2], args[3], args[4], args[5], args[6]),
    FORGEOpenShop: (...args: any) => this.FORGEOpenShop(args[0]),
    FORGECloseShop: () => this.FORGECloseShop(),
    FORGEPurchaseItem: () => this.FORGEPurchaseItem(),
    FORGERefreshLeaderboard: () => {
      void this.FORGERefreshLeaderboard()
    },
    FORGEToggleInventorySelect: (...args: any[]) => {
      this.toggleInventoryItemSelect(args[0])
    },
    FORGEApplyInventorySelection: (...args: any[]) => {
      this.applyInventoryItemSelection(args[0])
    }
  }

  constructor(
    /** Asset src path (required by Creator Hub). */
    public src: string,
    /** Entity this script is attached to (required by Creator Hub). */
    public entity: Entity,
    /** Your verse / world ID from The Forge dashboard. Creator Hub: text. */
    public verseId: string = '',
    /** Connect automatically once the local player is detected. Creator Hub: checkbox. */
    public autoConnect: boolean = true,
    /** Show the main Forge UI (panel). Creator Hub: checkbox. */
    public showUI: boolean = true,
    /** Show the Forge icon in the corner. Creator Hub: checkbox. */
    public showIcon: boolean = true,
    /** Show the chat icon in the corner. Creator Hub: checkbox. */
    // public showChatIcon: boolean = false,
    /** Show login splash on start. Creator Hub: checkbox. */
    public showLoginSplashScreen: boolean = false,
    /** Notify when connected to Forge. Creator Hub: checkbox. */
    public ConnectNotifications: boolean = true,
    /** Notify on quest updates. Creator Hub: checkbox. */
    public QuestUpdateNotifications: boolean = true,
    /** Notify on inventory updates. Creator Hub: checkbox. */
    public InventoryUpdateNotifications: boolean = true,
    /** Log user profile payloads to console. Creator Hub: checkbox. */
    public debugUserProfileLogs: boolean = false
  ) {
    this.uiOwnerEntity = engine.addEntity()
    this.uiComponent = () => [this.renderMainUI()]
  }

  start() {
    if (!this.verseId) {
      console.log('ForgeScriptModular: verseId not configured')
      return
    }
    if (this.hasStarted || this.isStartBootstrapping) return
    this.isStartBootstrapping = true
    void this.bootstrapStart()
  }

  private async bootstrapStart() {
    try {
      // Initial config load before rendering any UI.
      await this.fetchBehaviorConfig(false)
    } finally {
      this.isStartBootstrapping = false
      this.completeStart()
    }
  }

  private completeStart() {
    if (this.hasStarted) return
    if (this.showUI) ReactEcsRenderer.addUiRenderer(this.uiOwnerEntity, this.uiComponent)
    this.hasStarted = true
  }

  update(dt: any) {
    ForgeScriptModular.updateDimensions(dt)

    if (!this.foundPlayer) {
      this.pendingPlayerTimer -= dt
      if (this.pendingPlayerTimer <= 0) {
        this.pendingPlayerTimer = 2
        const player = getPlayer()
        if (player) {
          this.player = player
          this.foundPlayer = true
          this.kernel.userId = this.player.userId
          if (this.autoConnect) this.FORGEConnect()
        }
      }
      return
    }

    this.behaviorPollTimer -= dt
    if (this.behaviorPollTimer <= 0) {
      this.behaviorPollTimer = this.behaviorPollInterval
      this.fetchBehaviorConfig(true)
    }

    if (!this.kernel.isHeartbeatRunning) return
    this.heartbeatTimer -= dt
    if (this.heartbeatTimer > 0) return
    this.heartbeatTimer = this.heartbeatInterval

    if (!this.kernel.token) this.sendTokenPing()
    else this.sendHeartbeat()
  }

  // ============================================
  // STABLE KERNEL API (Creator Hub: methods marked @action appear as actions)
  // ============================================

  /**
   * Connect this entity’s Forge script to the backend (auth + heartbeat).
   * Trigger from another entity (e.g. button or trigger), or rely on **Auto connect** in the inspector.
   * @action
   */
  FORGEConnect() {
    if (!this.player) return
    this.foundPlayer = true
    this.kernel.userId = this.player.userId
    this.kernel.isForgeConnecting = true
    this.kernel.isHeartbeatRunning = true
    this.authenticateWithForge()
  }

  /**
   * Disconnect from Forge: stops heartbeat and clears the session token.
   * Trigger from another entity when you want to fully tear down the connection.
   * @action
   */
  FORGEDisconnect() {
    this.kernel.isHeartbeatRunning = false
    this.kernel.forgeConnected = false
    this.kernel.isForgeConnecting = false
    this.kernel.token = ''
  }

  /**
   * Build `{ id, value }[]` for quest/generic actions: flat key/value pairs from Creator Hub, or from code a variables object or array.
   */
  private buildActionVariablesArray(
    first: any,
    value1: any,
    key2: any,
    value2: any,
    key3: any,
    value3: any
  ): any[] {
    if (Array.isArray(first) && value1 === undefined && key2 === undefined) {
      return first
    }
    if (
      first !== undefined &&
      first !== null &&
      typeof first === 'object' &&
      !Array.isArray(first) &&
      value1 === undefined &&
      key2 === undefined
    ) {
      const out: any[] = []
      Object.keys(first).forEach((k) => out.push({ id: k, value: (first as any)[k] }))
      return out
    }
    const map: any = {}
    if (first) map[first] = value1
    if (key2) map[key2] = value2
    if (key3) map[key3] = value3
    return Object.keys(map).map((id) => ({ id, value: map[id] }))
  }

  /**
   * Send a quest action to Forge (e.g. complete a step or task).
   * **Creator Hub:** use optional `variableKey1` / `variableValue1` (and 2–3) for up to three variables.
   * **From code:** pass a single variables object as 4th arg, or an array of `{ id, value }`, or use the flat key/value slots.
   * @action
   * @param questId - Quest ID from The Forge
   * @param stepId - Step ID (empty string if not applicable)
   * @param taskId - Task ID (empty string if not applicable)
   * @param variableKey1 - First variable id, **or** a variables object / `[{id,value},…]` from code
   * @param variableValue1 - Value when `variableKey1` is a string id
   * @param variableKey2 - Second variable id (flat form)
   * @param variableValue2 - Second variable value
   * @param variableKey3 - Third variable id (flat form)
   * @param variableValue3 - Third variable value
   */
  async FORGEQuestAction(
    questId: any,
    stepId: any,
    taskId: any,
    variableKey1?: any,
    variableValue1?: any,
    variableKey2?: any,
    variableValue2?: any,
    variableKey3?: any,
    variableValue3?: any
  ) {
    const variableArray = this.buildActionVariablesArray(
      variableKey1,
      variableValue1,
      variableKey2,
      variableValue2,
      variableKey3,
      variableValue3
    )
    await this.internalSendAction('QUEST_ACTION', { questId, stepId, taskId, variables: variableArray })
  }

  /**
   * Send a generic Forge action by **action ID** (configured in The Forge dashboard).
   * **Creator Hub:** use optional `variableKey1` / `variableValue1` (and 2–3) for up to three variables.
   * **From code:** pass a variables object as 2nd arg, or `[{id,value},…]`, or use flat key/value slots.
   * @action
   * @param actionId - Action ID configured in Forge
   * @param variableKey1 - First variable id, **or** variables object / array from code
   * @param variableValue1 - Value when `variableKey1` is a string id
   * @param variableKey2 - Second variable id (flat form)
   * @param variableValue2 - Second variable value
   * @param variableKey3 - Third variable id (flat form)
   * @param variableValue3 - Third variable value
   */
  async FORGEGenericAction(
    actionId: any,
    variableKey1?: any,
    variableValue1?: any,
    variableKey2?: any,
    variableValue2?: any,
    variableKey3?: any,
    variableValue3?: any
  ) {
    const variableArray = this.buildActionVariablesArray(
      variableKey1,
      variableValue1,
      variableKey2,
      variableValue2,
      variableKey3,
      variableValue3
    )
    await this.internalSendAction('GENERIC_ACTION', { actionId, variables: variableArray })
  }

  // ─── CREATOR HUB: Shop Actions ────────────────────────────────────────────

  /**
   * Open the shop for a specific creator wallet. If a shop is already open it is
   * closed first — only one shop can be open at a time.
   * Seeds wallet + resets shop state, then runs uiActions["open-shop"] from config.
   * @action
   */
  async FORGEOpenShop(creatorWallet: any) {
    if (this.uiState.showShop) await this.FORGECloseShop()
    this.uiState.shopCreatorWallet = creatorWallet
    this.uiState.shopPending = false
    this.uiState.shopPurchaseResult = null
    this.uiState.selectedItemId = null
    this.uiState.shopListingSyncPendingItemId = null
    await this.runUiAction('open-shop')
  }

  /**
   * Close the shop. Steps are defined in the behavior config under uiActions["close-shop"].
   * @action
   */
  async FORGECloseShop() {
    await this.runUiAction('close-shop')
  }

  /**
   * Purchase the currently selected item. Steps (POST purchase, handle result,
   * refresh inventory) are defined in the behavior config under uiActions["purchase-item"].
   * @action
   */
  async FORGEPurchaseItem() {
    await this.runUiAction('purchase-item')
  }

  /**
   * Refetch leaderboard from GET /api/leaderboard/:id (honors uiState.leaderboardSource: cache | subgraph).
   * @action
   */
  async FORGERefreshLeaderboard() {
    await this.runUiAction('refresh-leaderboard')
  }

  // ============================================
  // GENERIC ASYNC STEP PRIMITIVES
  // ============================================

  /**
   * Dispatch a single UI step — async-capable. Called sequentially by runUiAction
   * so steps like fetchApiData → setState → callApi chain correctly.
   */
  private async executeUiStep(kind: any, args: any) {
    if (kind === 'fetchApiData') {
      await this.executeFetchApiData(args)
    } else if (kind === 'callApi') {
      await this.executeCallApi(args)
    } else {
      this.executeUiOperation(kind, args)
    }
  }

  /**
   * GET an API endpoint and store the (optionally filtered) result in uiState.
   *
   * args:
   *   url           — path relative to serverUrl e.g. "api/marketplace/rewards"
   *   queryParams   — optional object appended as query string (values support UI templates)
   *   responseKey   — field to pluck from the JSON response (e.g. "rewards")
   *   responseShape — "leaderboard" maps GET /api/leaderboard/:id → { leaderboard, rankings, fetchError }
   *   stateKey      — uiState key to write the result into (default "apiData")
   *   filterStateKey — uiState key whose string[] value filters the result by item.id
   *   requireNonEmptyStateKey — skip fetch if this snapshot path is empty (e.g. "leaderboardId")
   */
  private async executeFetchApiData(args: any) {
    let url = typeof args.url === 'string' ? args.url.replace(/^\//, '') : ''
    if (!url) return

    const reqPath = typeof args.requireNonEmptyStateKey === 'string' ? args.requireNonEmptyStateKey.trim() : ''
    if (reqPath) {
      const v = this.getValueByPath(this.getUiStateSnapshot(), reqPath)
      if (v == null || String(v).trim() === '') return
    }

    const qp = args.queryParams
    if (qp && typeof qp === 'object' && !Array.isArray(qp)) {
      const parts: string[] = []
      for (const [k, v] of Object.entries(qp)) {
        if (v == null) continue
        const sv = String(v).trim()
        if (sv === '') continue
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(sv)}`)
      }
      if (parts.length > 0) {
        const qs = parts.join('&')
        url += (url.includes('?') ? '&' : '?') + qs
      }
    }

    const stateKey = typeof args.stateKey === 'string' ? args.stateKey : 'apiData'
    const responseKey = typeof args.responseKey === 'string' ? args.responseKey : null
    const responseShape = typeof args.responseShape === 'string' ? args.responseShape : null
    const filterStateKey = typeof args.filterStateKey === 'string' ? args.filterStateKey : null
    try {
      const resp = await fetch(`${this.getRestBaseUrl()}/${url}`, {
        headers: this.kernel.token ? { Authorization: `Bearer ${this.kernel.token}` } : {}
      })
      const data = await resp.json().catch(() => ({}))

      if (responseShape === 'leaderboard') {
        if (data?.success && data.leaderboard) {
          this.uiState[stateKey] = {
            leaderboard: data.leaderboard,
            rankings: Array.isArray(data.rankings) ? data.rankings : [],
            fetchError: null
          }
        } else {
          this.uiState[stateKey] = {
            leaderboard: null,
            rankings: [],
            fetchError: data?.error ?? (!resp.ok ? `HTTP ${resp.status}` : 'Failed to load leaderboard')
          }
        }
        return
      }

      let result: any = responseKey ? (data[responseKey] ?? (Array.isArray(data) ? data : [])) : data
      if (filterStateKey) {
        const ids = this.uiState[filterStateKey]
        if (Array.isArray(ids) && ids.length > 0 && Array.isArray(result)) {
          result = result.filter((r: any) => ids.includes(r.id))
        }
      }
      this.uiState[stateKey] = result
    } catch (_e) {
      if (responseShape === 'leaderboard') {
        this.uiState[stateKey] = {
          leaderboard: null,
          rankings: [],
          fetchError: 'Network error'
        }
      } else {
        this.uiState[stateKey] = Array.isArray(this.uiState[stateKey]) ? [] : null
      }
    }
  }

  /**
   * Make an authenticated HTTP request, then run successSteps or errorSteps sequentially.
   * Body values are template-resolved against current uiState (use $state.* syntax).
   *
   * args:
   *   url              — path relative to serverUrl e.g. "api/marketplace/purchase"
   *   method           — HTTP method (default "POST")
   *   body             — object whose values support $state.* template strings
   *   responseStateKey — optional uiState key to write the full response into
   *   successSteps     — UI action steps to run on success
   *   errorSteps       — UI action steps to run on failure (receive $error in args)
   */
  private async executeCallApi(args: any) {
    const url = typeof args.url === 'string' ? args.url.replace(/^\//, '') : ''
    if (!url) return
    const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'POST'
    const state = this.getUiStateSnapshot()
    const body = args.body ? this.resolveDeepTemplates(args.body, 'API', state) : undefined
    const successSteps: any = Array.isArray(args.successSteps) ? args.successSteps : []
    const errorSteps: any = Array.isArray(args.errorSteps) ? args.errorSteps : []
    const runSteps = async (steps: any, extra: any) => {
      for (const step of steps) {
        if (!step?.kind) continue
        const resolved = this.resolveDeepTemplates({ ...(step.args || {}), ...extra }, 'API', state)
        await this.executeUiStep(step.kind as any, resolved)
      }
    }
    try {
      const resp = await fetch(`${this.getRestBaseUrl()}/${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.kernel.token}` },
        body: body !== undefined ? JSON.stringify(body) : undefined
      })
      const data = await resp.json().catch(() => ({}))
      if (typeof args.responseStateKey === 'string') this.uiState[args.responseStateKey] = data
      if (resp.ok && data.success !== false) {
        await runSteps(successSteps, { $response: data })
      } else {
        await runSteps(errorSteps, { $error: data.error ?? `HTTP ${resp.status}` })
      }
    } catch (err) {
      await runSteps(errorSteps, { $error: (err as any)?.message ?? 'Network error' })
    }
  }

  // ============================================
  // EXPANDABLE RUNTIME (config + handlers)
  // ============================================

  onEvent(eventType: any, callback: any) {
    if (!this.eventCallbacks.has(eventType)) this.eventCallbacks.set(eventType, [])
    this.eventCallbacks.get(eventType)!.push(callback)
  }

  private async fetchBehaviorConfig(requireAuth: any = true) {
    if (!this.verseId) return
    if (requireAuth && !this.kernel.token) return
    try {
      const url = `${this.getRestBaseUrl()}/rest-client/behavior-config/${this.verseId}?clientVersion=${encodeURIComponent(this.clientScriptVersion)}`
      const headers: any =
        requireAuth && this.kernel.token ? { Authorization: `Bearer ${this.kernel.token}` } : undefined
      const response = await fetch(url, { method: 'GET', headers })
      if (!response.ok) return
      const json = await response.json().catch(() => null)
      if (!json?.success || !json?.config) return
      if (!this.validateBehaviorConfig(json.config)) return
      this.applyBehaviorConfig(json.config)
      if (typeof json.verseDisplayName === 'string') {
        this.uiState.verseDisplayName = json.verseDisplayName.trim()
      }
    } catch (_e) {
      // Soft fail: keep current behavior active.
    }
  }

  private validateBehaviorConfig(input: any): any {
    if (!input || typeof input !== 'object') return false
    if (typeof input.version !== 'string') return false
    if (!Array.isArray(input.enabledHandlers)) return false
    if (input.uiSections != null) {
      if (!Array.isArray(input.uiSections)) return false
      for (const section of input.uiSections) {
        if (!section || typeof section !== 'object') return false
        if (typeof section.id !== 'string' || section.id.length === 0) return false
        if (!section.root || typeof section.root !== 'object') return false
        if (!this.validateUiNode(section.root)) return false
        if (section.enabled != null && typeof section.enabled !== 'boolean') return false
      }
    }
    if (input.uiActions != null) {
      if (!Array.isArray(input.uiActions)) return false
      for (const action of input.uiActions) {
        if (!action || typeof action !== 'object') return false
        if (typeof action.id !== 'string' || action.id.length === 0) return false
        if (!Array.isArray(action.steps)) return false
        for (const step of action.steps) {
          if (!step || typeof step !== 'object') return false
          if (typeof step.kind !== 'string' || step.kind.length === 0) return false
          if (!(ForgeScriptModular.UI_STEP_KINDS as any).includes(step.kind)) return false
          if (step.args != null && typeof step.args !== 'object') return false
        }
      }
    }
    if (input.messageActions != null) {
      if (!Array.isArray(input.messageActions)) return false
      for (const action of input.messageActions) {
        if (!action || typeof action !== 'object') return false
        const onTypeValid = typeof action.onType === 'string' || (Array.isArray(action.onType) && action.onType.every((t: any) => typeof t === 'string'))
        if (!onTypeValid) return false
        if (action.when != null && !this.validateCondition(action.when)) return false
        if (!Array.isArray(action.steps)) return false
        for (const step of action.steps) {
          if (!step || typeof step !== 'object') return false
          if (typeof step.kind !== 'string' || step.kind.length === 0) return false
          if (!(ForgeScriptModular.MESSAGE_STEP_KINDS as any).includes(step.kind)) return false
          if (step.args != null && typeof step.args !== 'object') return false
        }
      }
    }
    if (input.uiFlags != null && typeof input.uiFlags !== 'object') return false
    if (input.uiState != null && typeof input.uiState !== 'object') return false
    if (input.notifications != null && typeof input.notifications !== 'object') return false
    if (input.scriptRuntime != null && typeof input.scriptRuntime !== 'object') return false
    return true
  }

  private validateConditionOperand(operand: any): any {
    if (!operand || typeof operand !== 'object') return false
    if (operand.type === 'state') return typeof operand.key === 'string' && operand.key.length > 0
    if (operand.type === 'const') return 'value' in operand
    if (operand.type === 'message') return typeof operand.path === 'string'
    if (operand.type === 'scope') return typeof operand.path === 'string'
    return false
  }

  private validateCondition(condition: any): any {
    if (!condition || typeof condition !== 'object' || typeof condition.op !== 'string') return false
    if (condition.op === 'always') return true
    if (condition.op === 'truthy' || condition.op === 'falsy') {
      return this.validateConditionOperand(condition.value)
    }
    if (condition.op === 'eq' || condition.op === 'neq') {
      return this.validateConditionOperand(condition.left) && this.validateConditionOperand(condition.right)
    }
    if (condition.op === 'and' || condition.op === 'or') {
      return Array.isArray(condition.conditions) && condition.conditions.every((c: any) => this.validateCondition(c))
    }
    if (condition.op === 'not') return this.validateCondition(condition.condition)
    return false
  }

  private validateUiNode(node: any): any {
    if (!node || typeof node !== 'object') return false
    if (node.uiTransformWhen != null) {
      if (!Array.isArray(node.uiTransformWhen)) return false
      for (const p of node.uiTransformWhen) {
        if (!p || typeof p !== 'object') return false
        if (!this.validateCondition(p.when)) return false
        if (p.merge == null || typeof p.merge !== 'object') return false
      }
    }
    if (node.visibleWhen != null && !this.validateCondition(node.visibleWhen)) return false
    if (node.children != null) {
      if (!Array.isArray(node.children)) return false
      if (!node.children.every((child: any) => this.validateUiNode(child))) return false
    }
    return true
  }

  /** Deep-clone JSON-serializable config values into uiState (arrays/objects get new references). */
  private cloneBehaviorConfigValue(value: any): any {
    if (value === null || typeof value !== 'object') return value
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return value
    }
  }

  private applyBehaviorConfig(config: any) {
    this.behaviorConfig = config
    this.uiSectionsFromApi = Array.isArray(config.uiSections) ? config.uiSections : []
    this.uiActionsFromApi = {}
    if (Array.isArray(config.uiActions)) {
      config.uiActions.forEach((action:any) => {
        this.uiActionsFromApi[action.id] = action.steps
      })
    }
    this.messageActionsByType = {}
    if (Array.isArray(config.messageActions)) {
      config.messageActions.forEach((action:any) => {
        const types = Array.isArray(action.onType) ? action.onType : [action.onType]
        types.forEach((type:any) => {
          if (!this.messageActionsByType[type]) this.messageActionsByType[type] = []
          this.messageActionsByType[type].push(action)
        })
      })
    }
    const isFirstUiSeed = !this.uiStateSeededFromRemote
    const remoteUiState = config.uiState != null && typeof config.uiState === 'object' ? config.uiState : null

    if (isFirstUiSeed && remoteUiState) {
      for (const [k, v] of Object.entries(remoteUiState)) {
        this.uiState[k] = this.cloneBehaviorConfigValue(v)
      }
    }

    if (config.uiFlags) {
      Object.keys(config.uiFlags).forEach((key) => {
        const value = config.uiFlags?.[key]
        if (key === 'showIcon' && typeof value === 'boolean') {
          this.showIcon = value
          return
        }
        if (key === 'showUI' && typeof value === 'boolean') {
          this.showUI = value
          return
        }
        // if (key === 'showChatIcon' && typeof value === 'boolean') {
        //   this.showChatIcon = value
        //   return
        // }
        if (key === 'showLoginSplashScreen' && typeof value === 'boolean') {
          this.showLoginSplashScreen = value
          return
        }
        if (ForgeScriptModular.TRANSIENT_UI_STATE_KEYS.has(key)) {
          if (isFirstUiSeed) {
            const fromDedicated = remoteUiState && Object.prototype.hasOwnProperty.call(remoteUiState, key)
            if (!fromDedicated) this.uiState[key] = this.cloneBehaviorConfigValue(value)
          }
          return
        }
        this.uiState[key] = value
      })
    }

    if (isFirstUiSeed) this.uiStateSeededFromRemote = true
    if (config.notifications) {
      if (typeof config.notifications.onConnect === 'boolean') this.ConnectNotifications = config.notifications.onConnect
      if (typeof config.notifications.onQuestUpdate === 'boolean') this.QuestUpdateNotifications = config.notifications.onQuestUpdate
      if (typeof config.notifications.onInventoryUpdate === 'boolean') this.InventoryUpdateNotifications = config.notifications.onInventoryUpdate
    }
    this.applyScriptRuntimeFromConfig(config)
  }

  /**
   * Reset token helpers to builtins, then apply config.scriptRuntime (display + optional embeddedHelpers strings).
   */
  private applyScriptRuntimeFromConfig(config: any) {
    this.tokenDisplayDecimals = 18
    this.tokenDisplayMaxFractionDigits = 8
    this.parseTokenAmountWeiFn = (raw) => this.builtinParseTokenAmountWei(raw)
    this.formatWeiBalanceDisplayFn = (wei, d, m) =>
      this.builtinFormatWeiBalanceDisplay(
        wei,
        d ?? this.tokenDisplayDecimals,
        m ?? this.tokenDisplayMaxFractionDigits
      )

    const rt = config.scriptRuntime
    if (!rt || typeof rt !== 'object') return

    const tbd = rt.tokenBalanceDisplay
    if (tbd && typeof tbd === 'object') {
      const d = Number(tbd.decimals)
      const m = Number(tbd.maxFractionDigits)
      if (Number.isFinite(d) && d >= 0) this.tokenDisplayDecimals = Math.min(36, Math.floor(d))
      if (Number.isFinite(m) && m >= 0) this.tokenDisplayMaxFractionDigits = Math.min(36, Math.floor(m))
    }

    const emb = rt.embeddedHelpers
    if (!emb || typeof emb !== 'object') return

    const installExpr = (source: any, label: any, onOk: any) => {
      if (typeof source !== 'string' || !source.trim()) return
      try {
        const fn = new Function(`return (${source.trim()})`)() as any
        if (typeof fn === 'function') onOk(fn)
        else console.log(`[ForgeScriptModular] scriptRuntime.embeddedHelpers.${label} is not a function`)
      } catch (e) {
        console.log(`[ForgeScriptModular] scriptRuntime.embeddedHelpers.${label} invalid`, e)
      }
    }

    installExpr(emb.parseTokenAmountWei, 'parseTokenAmountWei', (fn:any) => {
      this.parseTokenAmountWeiFn = (raw) => fn(raw)
    })
    installExpr(emb.formatWeiBalanceDisplay, 'formatWeiBalanceDisplay', (fn: any) => {
      this.formatWeiBalanceDisplayFn = (wei, d, m) =>
        fn(wei, d ?? this.tokenDisplayDecimals, m ?? this.tokenDisplayMaxFractionDigits)
    })
  }

  private builtinParseTokenAmountWei(raw: any): any {
    if (raw == null) return 0n
    if (typeof raw === 'bigint') return raw >= 0n ? raw : 0n
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw) || raw < 0) return 0n
      if (Math.abs(raw) > Number.MAX_SAFE_INTEGER) return 0n
      return BigInt(Math.trunc(raw))
    }
    let s = String(raw).trim()
    if (!s) return 0n
    s = s.replace(/^0+/, '') || '0'
    if (s === '0') return 0n
    if (!/^\d+$/.test(s)) return 0n
    try {
      return BigInt(s)
    } catch {
      return 0n
    }
  }

  private builtinFormatWeiBalanceDisplay(wei: any, decimals: any = 18, maxFractionDigits: any = 8): any {
    if (wei === 0n) return '0'
    const neg = wei < 0n
    let v = neg ? -wei : wei
    const base = 10n ** BigInt(decimals)
    const whole = v / base
    let frac = v % base
    if (frac === 0n) return `${neg ? '-' : ''}${whole.toString()}`
    let fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
    if (fracStr.length > maxFractionDigits) {
      fracStr = fracStr.slice(0, maxFractionDigits).replace(/0+$/, '')
    }
    return `${neg ? '-' : ''}${whole.toString()}.${fracStr}`
  }

  private forgeIdsMatch(a: any, b: any): any {
    if (a == null || b == null || a === '' || b === '') return false
    return String(a).toLowerCase() === String(b).toLowerCase()
  }

  /** Heartbeat MARKETPLACE_PURCHASE / MARKETPLACE_ITEM_SOLD — merge quantity + listed into shop rows. */
  private patchShopInventoryListingFromMessage(message: any, inventoryKey = 'shopInventory') {
    const itemId = message?.itemId
    if (!itemId || typeof itemId !== 'string') return
    const inv = this.uiState[inventoryKey]
    if (!Array.isArray(inv)) return
    this.uiState[inventoryKey] = inv.map((row: any) => {
      if (row?.id !== itemId) return row
      const next = { ...row }
      const listing = { ...(next.listing || {}) }
      if (message.quantity !== undefined) {
        listing.quantity = message.quantity
        next.quantity = message.quantity
      }
      if (message.listed !== undefined) {
        listing.listed = message.listed
        next.listed = message.listed
      }
      next.listing = listing
      return next
    })
  }

  /** After a local purchase, clear `shopListingSyncPendingItemId` when our buyer MARKETPLACE_PURCHASE arrives. */
  private clearShopListingSyncIfBuyer(message: any) {
    const pending = this.uiState.shopListingSyncPendingItemId
    const itemId = message?.itemId
    if (!pending || !itemId || pending !== itemId) return
    const buyer = message?.userId
    const profile = this.getCurrentUserProfile()
    const me = (profile?.userAddress ?? profile?.ethAddress ?? this.player?.userId ?? this.kernel.userId) as
      | string
      | undefined
    if (this.forgeIdsMatch(buyer, me)) this.uiState.shopListingSyncPendingItemId = null
  }

  private isShopItemInteractionLocked(itemId: any, itemRow?: any): any {
    if (this.uiState.shopListingSyncPendingItemId === itemId) return true
    const row =
      itemRow ||
      (Array.isArray(this.uiState.shopInventory) ? this.uiState.shopInventory.find((r: any) => r?.id === itemId) : null)
    if (!row) return false
    const l = row.listing
    if (l && l.listed === false) return true
    const q = l?.quantity
    if (q !== undefined && q !== null && Number(q) <= 0) return true
    return false
  }

  private routeMessage(type: any, message: any) {
    const enabled = this.behaviorConfig.enabledHandlers
    const isEnabled = enabled.length === 0 || enabled.includes(type)
    if (!isEnabled) return
    this.runMessageActions(type, message)
  }

  // ============================================
  // INTERNAL KERNEL TRANSPORT
  // ============================================

  private dispatchEvent(type: any, data: any) {
    const callbacks = this.eventCallbacks.get(type) || []
    callbacks.forEach((cb:any) => {
      try {
        cb(data)
      } catch (error) {
        console.error(`ForgeEvent error ${type}:`, error)
      }
    })
  }

  private getRestBaseUrl(): any {
    return (this.serverUrl || '').replace(/\/$/, '')
  }

  /**
   * Absolute https URL for UiBackground.texture.src. Handles bare UUIDs, /api/images/…, metadata, and PROFILE → /api/metadata/:id/image.
   * Raw USER_PROFILE artifacts may only have image / imageId until server normalization lands.
   */
  private resolveArtifactTextureAbsoluteUrl(item: any): string {
    if (!item || typeof item !== 'object') return ''
    const base = this.getRestBaseUrl()
    const meta =
      typeof item.metadata === 'string'
        ? (() => {
            try {
              return JSON.parse(item.metadata || '{}')
            } catch {
              return {}
            }
          })()
        : item.metadata || {}

    const isProfile =
      item.type === 'PROFILE' ||
      item.kind === 'PROFILE' ||
      item.artifactType === 'profile_definition' ||
      meta.artifactType === 'profile_definition' ||
      meta.kind === 'PROFILE'

    const tokenId = item.tokenId ?? item.blockchain?.tokenId
    const tidStr = tokenId != null ? String(tokenId).trim() : ''
    if (isProfile && /^\d+$/.test(tidStr)) {
      return `${base}/api/metadata/${tidStr}/image`
    }

    const absolutize = (u: string) => {
      const s = (u || '').trim()
      if (!s) return ''
      if (s.startsWith('https://') || s.startsWith('http://')) return s.split('?')[0]
      if (s.startsWith('/api/')) return `${base}${s.split('?')[0]}`
      if (s.startsWith('data:')) return s
      return ''
    }

    const urlCandidates = [item.imageUrl, item.media?.imageUrl, meta.imageUrl, meta.media?.imageUrl]
    for (const cand of urlCandidates) {
      if (typeof cand !== 'string' || !cand.trim()) continue
      const a = absolutize(cand)
      if (a) return a
    }

    const unwrapBareSegment = (raw: string): string => {
      let s = raw.trim()
      if (!s) return ''
      while (s.includes('/api/images/http')) {
        const idx = s.indexOf('/api/images/http')
        s = s.slice(idx + '/api/images/'.length)
      }
      // No global URL in DCL scene runtime — parse pathname manually.
      if (s.startsWith('http://') || s.startsWith('https://')) {
        const t = s.split('?')[0].split('#')[0]
        const m = /^https?:\/\/[^/?#]+(\/.*)?$/i.exec(t)
        const pathname = m && m[1] && m[1].length > 0 ? m[1] : '/'
        const parts = pathname.split('/').filter(Boolean)
        s = parts.length > 0 ? parts[parts.length - 1] || s : s
      }
      if (s.includes('/api/images/')) {
        s = s.split('/api/images/').pop() || s
      }
      return s.replace(/^\//, '').split('?')[0]
    }

    const bareFields = [
      item.imageId,
      meta.imageId,
      item.media?.image,
      meta.media?.image,
      item.image,
      meta.image
    ]
    for (const raw of bareFields) {
      if (raw == null || typeof raw !== 'string') continue
      const s = unwrapBareSegment(raw)
      if (!s || /^https?:\/\//i.test(s)) continue
      if (/^\d{20,}$/.test(s)) continue
      return `${base}/api/images/${encodeURIComponent(s)}`
    }

    if (!isProfile && /^\d+$/.test(tidStr)) {
      return `${base}/api/images/${tidStr}`
    }
    const idStr = item.id != null ? String(item.id).trim() : ''
    if (!isProfile && /^\d+$/.test(idStr)) {
      return `${base}/api/images/${idStr}`
    }
    return ''
  }

  private getErrorMessage(error: any): any {
    if (!error) return 'Unknown error'
    if (typeof error === 'string') return error
    if (typeof error.message === 'string' && error.message.length > 0) return error.message
    try {
      return JSON.stringify(error)
    } catch (_e) {
      return String(error)
    }
  }

  private async parseJsonSafely(response: any): Promise<any> {
    try {
      const text = await response.text()
      if (!text) return null
      return JSON.parse(text)
    } catch (_e) {
      return null
    }
  }

  private async authenticateWithForge() {
    try {
      const isGuest = (this.player as any)?.isGuest === true || (this.player as any)?.data?.isGuest === true
      const response = await signedFetch({
        url: `${this.getRestBaseUrl()}/rest-client/connect`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: this.kernel.userId,
            verseId: this.verseId,
            isGuest
          })
        }
      })
      if (!response || response.body == null) throw new Error('Invalid auth response')
      const authJson = JSON.parse(response.body)
      if (!authJson.success) throw new Error(authJson.error || 'Auth failed')
    } catch (error) {
      this.kernel.isForgeConnecting = false
      this.kernel.errorPings++
      this.dispatchEvent('CONNECTION_ERROR', { error })
    }
  }

  private async sendTokenPing() {
    if (this.kernel.errorPings > 9) {
      this.kernel.isHeartbeatRunning = false
      this.dispatchEvent('CONNECTION_ERROR', { error: 'Max retries exceeded' })
      return
    }
    try {
      let url = `${this.getRestBaseUrl()}/rest-client/client-token/${this.kernel.userId}/${this.verseId}`
      const isGuest = (this.player as any)?.isGuest === true || (this.player as any)?.data?.isGuest === true
      if (isGuest) url += '?isGuest=true'
      const response = await fetch(url)
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) {
        this.kernel.errorPings++
        return
      }
      this.kernel.token = data.token
      this.kernel.errorPings = 0
    } catch (_e) {
      this.kernel.errorPings++
    }
  }

  private async sendHeartbeat() {
    const position = Transform.get(engine.PlayerEntity).position
    try {
      const response = await fetch(`${this.getRestBaseUrl()}/rest-client/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.kernel.token}` },
        body: JSON.stringify({ position })
      })
      const data = await this.parseJsonSafely(response)
      if (!response.ok) {
        this.kernel.errorPings++
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          this.kernel.forgeConnected = false
          this.kernel.token = ''
          this.kernel.isForgeConnecting = true
        }
        const errorMessage = data?.error || `HTTP ${response.status}`
        console.error(`Heartbeat request failed: ${errorMessage}`)
        return
      }
      if (!data?.success || !Array.isArray(data.messages) || data.messages.length === 0) return
      // Fallback: ensure connection/profile state is updated even if messageActions are missing.
      const profileMsg = data.messages.find((m: any) => m?.type === 'USER_PROFILE')
      if (profileMsg?.message) {
        this.applyUserProfileFromMessage(profileMsg.message)
      }
      data.messages.forEach((msg: any) => {
        this.dispatchEvent(msg.type, msg.message)
        this.routeMessage(msg.type, msg.message)
      })
    } catch (error) {
      this.kernel.errorPings++
      console.error(`Heartbeat transport error: ${this.getErrorMessage(error)}`)
    }
  }

  private async internalSendAction(type: any, body: any) {
    if (!this.kernel.forgeConnected) return
    let actionBody: any
    if (type === 'QUEST_ACTION') {
      const vars: any = {}
      body.variables?.forEach((v: any) => {
        vars[v.id] = v.value
      })
      actionBody = {
        action: 'QUEST_ACTION',
        questId: body.questId,
        stepId: body.stepId,
        taskId: body.taskId,
        verseId: this.verseId,
        variables: vars
      }
    } else if (type === 'GENERIC_ACTION') {
      const vars: any = {}
      body.variables?.forEach((v: any) => {
        vars[v.id] = v.value
      })
      actionBody = { action: 'EXECUTE_ACTION', actionId: body.actionId, verseId: this.verseId, variables: vars }
    } else {
      return
    }

    try {
      const response = await fetch(`${this.getRestBaseUrl()}/rest-client/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.kernel.token}` },
        body: JSON.stringify(actionBody)
      })
      const data = await response.json()
      if (data.messages?.length) {
        data.messages.forEach((msg: any) => {
          this.dispatchEvent(msg.type, msg.message)
          this.routeMessage(msg.type, msg.message)
        })
      }
    } catch (error) {
      console.error('Action error:', error)
    }
  }

  // ============================================
  // FEATURE DATA HELPERS (expandable)
  // ============================================

  /** INVENTORY_UPDATE payload merge (planet-angzaar parity): bulk arrays + TOKEN / ARTIFACT updatedItem */
  private updateLocalInventory(data: any) {
    const profileKey = (data?.userId ?? this.player?.userId) as any
    const fallbackUserId = this.player?.userId
    const key = profileKey || fallbackUserId
    if (!key) return

    const hasFullUserTokens = Array.isArray(data.userTokens) && data.userTokens.length > 0
    const hasFullTokens = Array.isArray(data.tokens) && data.tokens.length > 0
    const hasTokenBalances = Array.isArray(data.tokenBalances) && data.tokenBalances.length > 0
    const hasFullArtifacts = Array.isArray(data.artifacts) && data.artifacts.length > 0

    if (hasFullUserTokens || hasFullTokens || hasTokenBalances || hasFullArtifacts) {
      const existing = this.userProfiles.get(key) ?? {}
      const userProfile = { ...existing }
      if (hasFullUserTokens) userProfile.userTokens = [...data.userTokens]
      else if (hasFullTokens) userProfile.userTokens = [...data.tokens]
      else if (hasTokenBalances) userProfile.userTokens = [...data.tokenBalances]
      if (hasFullArtifacts) userProfile.artifacts = [...data.artifacts]
      this.userProfiles.set(key, userProfile)
    }

    const updatedItem = data?.updatedItem
    if (!updatedItem) return
    if (updatedItem.type !== 'ARTIFACT' && updatedItem.type !== 'TOKEN') return

    const userProfile = this.userProfiles.get(key)
    if (!userProfile) return

    if (updatedItem.type === 'ARTIFACT') {
      if (!userProfile.artifacts) userProfile.artifacts = []
      const existingIndex = userProfile.artifacts.findIndex(
        (a: any) =>
          a.id === updatedItem.id || a.artifactId === updatedItem.id || a._id === updatedItem.id
      )
      if (existingIndex >= 0) {
        userProfile.artifacts[existingIndex] = {
          ...userProfile.artifacts[existingIndex],
          ...updatedItem,
        }
      } else {
        userProfile.artifacts.push(updatedItem)
      }
    } else {
      if (!userProfile.userTokens) userProfile.userTokens = []
      const existingIndex = userProfile.userTokens.findIndex(
        (t: any) =>
          t.id === updatedItem.id ||
          t.tokenId === updatedItem.id ||
          (t.token && (t.token.id === updatedItem.id || t.token.symbol === updatedItem.symbol))
      )
      const bal = updatedItem.quantity ?? updatedItem.balance ?? 0
      if (existingIndex >= 0) {
        userProfile.userTokens[existingIndex] = {
          ...userProfile.userTokens[existingIndex],
          balance: bal,
        }
      } else {
        userProfile.userTokens.push({
          id: updatedItem.id,
          balance: bal,
          token: updatedItem.token ?? { symbol: updatedItem.symbol, name: updatedItem.name },
        })
      }
    }

    this.userProfiles.set(key, { ...userProfile })
  }

  /** Use in messageActions notify as message: "$inventoryNotifyMessage" */
  private buildInventoryNotifyLine(data: any): any {
    const updatedItem = data?.updatedItem
    if (!updatedItem) return null
    if (updatedItem.type === 'ARTIFACT') {
      return updatedItem.name != null ? String(updatedItem.name) : null
    }
    if (updatedItem.type === 'TOKEN') {
      const bal = this.parseTokenAmountWeiFn(updatedItem.quantity ?? updatedItem.balance ?? 0)
      const amountStr = this.formatWeiBalanceDisplayFn(bal)
      const sym = updatedItem.symbol != null ? String(updatedItem.symbol) : ''
      return sym ? `${amountStr} ${sym}` : amountStr
    }
    return null
  }

  private updateLocalQuestProgress(data: any) {
    if (!this.player?.userId || !data?.questId) return
    const profile = this.userProfiles.get(this.player.userId)
    if (!profile) return
    if (!profile.userStats) profile.userStats = {}
    const base = profile.userQuests?.questsProgress || profile.userStats?.questsProgress || []
    const merged = base.some((q: any) => q.questId === data.questId)
      ? base.map((q: any) => (q.questId === data.questId && data.userQuestInfo ? data.userQuestInfo : q))
      : [...base, data.userQuestInfo].filter(Boolean)
    profile.userStats.questsProgress = merged
    this.userProfiles.set(this.player.userId, { ...profile })
  }

  // ============================================
  // LIGHTWEIGHT UI (example)
  // ============================================

  private renderUiSections() {
    return this.uiSectionsFromApi
      .filter((section:any) => section.enabled !== false)
      .map((section:any) => this.renderUiNode(section.root, `api-section-${section.id}`))
  }

  private renderMainUI() {
    if (!this.showUI) return null
    return (
      <UiEntity
        key="dcl::forge::modular::ui"
        uiTransform={{
          width: '100%',
          height: '100%',
          positionType: 'absolute',
          display: this.showUI ? 'flex' : 'none'
        }}
      >
        {this.renderUiSections()}
      </UiEntity>
    )
  }

  private resolveColor(input: any): any {
    if (!input) return undefined
    if (Array.isArray(input) && input.length === 4) {
      const [r, g, b, a] = input
      return Color4.create(r, g, b, a)
    }
    if (typeof input === 'string' && input.startsWith('#')) {
      const hex = input.slice(1)
      if (hex.length === 6 || hex.length === 8) {
        const r = parseInt(hex.slice(0, 2), 16) / 255
        const g = parseInt(hex.slice(2, 4), 16) / 255
        const b = parseInt(hex.slice(4, 6), 16) / 255
        const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
        return Color4.create(r, g, b, a)
      }
    }
    return undefined
  }

  /** UiTransform.borderColor from JSON arrays often must be Color4 for the renderer. */
  private normalizeUiTransformForSdk(transform: any): any {
    if (!transform || typeof transform !== 'object') return transform
    const out: any = { ...transform }
    if (out.borderColor != null) {
      const c = this.resolveColor(out.borderColor)
      if (c) out.borderColor = c
    }
    return out
  }

  private getUiStateSnapshot(): any {
    return {
      ...this.uiState,
      forgeConnected: this.kernel.forgeConnected,
      isForgeConnecting: this.kernel.isForgeConnecting,
      userId: this.kernel.userId,
      showIcon: this.showIcon,
      showUI: this.showUI,
      // showChatIcon: this.showChatIcon,
      showLoginSplashScreen: this.showLoginSplashScreen
    }
  }

  private getValueByPath(source: any, path: any): any {
    if (!path) return undefined
    const parts = path.split('.')
    let current: any = source
    for (const part of parts) {
      if (current == null) return undefined
      current = current[part]
    }
    return current
  }

  private interpolateTemplateString(template: any, type: any, message: any, state: any, scope?: any): any {
    const localScope = scope || {}
    return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match: any, exprRaw: any) => {
      const expr = String(exprRaw || '').trim()
      const value = this.resolveTemplateExpression(expr, type, message, state, localScope)
      if (value == null) return ''
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
      return JSON.stringify(value)
    })
  }

  private resolveTemplateExpression(expr: any, type: any, message: any, state: any, localScope: any): any {
    const alternatives = expr.split('||').map((p:any) => p.trim()).filter(Boolean)
    for (const token of alternatives) {
      let value: any = ''
      if (token === 'type') value = type
      else if (token === 'message') value = message
      else if (token.startsWith('message.')) value = this.getValueByPath(message, token.slice('message.'.length))
      else if (token === 'state') value = state
      else if (token.startsWith('state.')) value = this.getValueByPath(state, token.slice('state.'.length))
      else if (token === 'scope') value = localScope
      else if (token.startsWith('scope.')) value = this.getValueByPath(localScope, token.slice('scope.'.length))
      else if (token === 'item') value = localScope.item
      else if (token.startsWith('item.')) value = this.getValueByPath(localScope.item, token.slice('item.'.length))
      else if (token === 'index') value = localScope.index
      else value = token

      if (value !== undefined && value !== null && value !== '') return value
      if (alternatives.length === 1) return value
    }
    return ''
  }

  private resolveTemplateValue(input: any, type: any, message: any, scope?: any): any {
    if (typeof input !== 'string') return input
    const state = this.getUiStateSnapshot()
    const localScope = scope || {}
    if (input === '$inventoryNotifyMessage') {
      if (type === 'INVENTORY_UPDATE') return this.buildInventoryNotifyLine(message) ?? 'Inventory updated'
      return 'Inventory updated'
    }
    if (input === '$itemImageUrl') {
      return this.resolveArtifactTextureAbsoluteUrl(localScope.item)
    }
    if (input === '$type') return type
    if (input === '$message') return message
    if (input.startsWith('$message.')) return this.getValueByPath(message, input.slice('$message.'.length))
    if (input === '$state') return state
    if (input.startsWith('$state.')) return this.getValueByPath(state, input.slice('$state.'.length))
    if (input === '$scope') return localScope
    if (input.startsWith('$scope.')) return this.getValueByPath(localScope, input.slice('$scope.'.length))
    if (input === '$item') return localScope.item
    if (input.startsWith('$item.')) return this.getValueByPath(localScope.item, input.slice('$item.'.length))
    if (input === '$index') return localScope.index
    if (input.includes('{{')) return this.interpolateTemplateString(input, type, message, state, localScope)
    return input
  }

  private resolveDeepTemplates(input: any, type: any, message: any, scope?: any): any {
    if (input == null) return input
    if (typeof input === 'string') return this.resolveTemplateValue(input, type, message, scope)
    if (Array.isArray(input)) return input.map((v) => this.resolveDeepTemplates(v, type, message, scope))
    if (typeof input === 'object') {
      const out: any = {}
      Object.keys(input).forEach((key) => {
        out[key] = this.resolveDeepTemplates((input as any)[key], type, message, scope)
      })
      return out
    }
    return input
  }

  private resolveConditionOperand(operand: any, state: any, message?: any, scope?: any): any {
    if (operand.type === 'state') {
      const k = operand.key
      return k.includes('.') ? this.getValueByPath(state, k) : state[k]
    }
    if (operand.type === 'message') return this.getValueByPath(message, operand.path)
    if (operand.type === 'scope') return this.getValueByPath(scope, operand.path)
    return operand.value
  }

  /** Match UI conditions after resolving operands; coerces string/number/bigint ids so "42" and 42 match. */
  private conditionPrimitivesEqual(a: any, b: any): boolean {
    if (a === b) return true
    const isPrim = (x: any) =>
      x != null &&
      (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' || typeof x === 'bigint')
    if (isPrim(a) && isPrim(b)) return String(a) === String(b)
    return false
  }

  private evaluateCondition(condition: any, state: any, message?: any, scope?: any): any {
    if (!condition) return true
    if (condition.op === 'always') return true
    if (condition.op === 'truthy') return !!this.resolveConditionOperand(condition.value, state, message, scope)
    if (condition.op === 'falsy') return !this.resolveConditionOperand(condition.value, state, message, scope)
    if (condition.op === 'eq') {
      const L = this.resolveConditionOperand(condition.left, state, message, scope)
      const R = this.resolveConditionOperand(condition.right, state, message, scope)
      return this.conditionPrimitivesEqual(L, R)
    }
    if (condition.op === 'neq') {
      const L = this.resolveConditionOperand(condition.left, state, message, scope)
      const R = this.resolveConditionOperand(condition.right, state, message, scope)
      return !this.conditionPrimitivesEqual(L, R)
    }
    if (condition.op === 'and') return condition.conditions.every((c:any) => this.evaluateCondition(c, state, message, scope))
    if (condition.op === 'or') return condition.conditions.some((c:any) => this.evaluateCondition(c, state, message, scope))
    if (condition.op === 'not') return !this.evaluateCondition(condition.condition, state, message, scope)
    return true
  }

  private applyUserProfileFromMessage(message: any) {
    const wasConnected = this.kernel.forgeConnected
    if (!this.kernel.forgeConnected) {
      this.kernel.forgeConnected = true
      this.kernel.isForgeConnecting = false
    }
    const userProfile = { ...message }
    if (!userProfile.artifacts && userProfile.rewards) {
      userProfile.artifacts = userProfile.rewards
      delete userProfile.rewards
    }
    if (this.player?.userId) this.userProfiles.set(this.player.userId, userProfile)
    if (this.debugUserProfileLogs) {
      const qUserStats = userProfile?.userStats?.questsProgress
      const qUserQuests = userProfile?.userQuests?.questsProgress
      const qRoot = userProfile?.questsProgress
      const selected = this.getAllQuests()
      console.log('[ForgeScriptModular] USER_PROFILE received')
      const questPathStats = {
        userStatsQuestsCount: Array.isArray(qUserStats) ? qUserStats.length : -1,
        userQuestsQuestsCount: Array.isArray(qUserQuests) ? qUserQuests.length : -1,
        rootQuestsCount: Array.isArray(qRoot) ? qRoot.length : -1,
        selectedQuestsCount: Array.isArray(selected) ? selected.length : -1
      }
      console.log(`[ForgeScriptModular] quest paths ${JSON.stringify(questPathStats)}`)
      try {
        const raw = JSON.stringify(userProfile)
        const maxLen = 3000
        const preview = raw.length > maxLen ? `${raw.slice(0, maxLen)}... [truncated ${raw.length - maxLen} chars]` : raw
        console.log('[ForgeScriptModular] USER_PROFILE snapshot', preview)
      } catch (_e) {
        console.log('[ForgeScriptModular] USER_PROFILE snapshot could not be serialized')
      }
    }
    if (!wasConnected) {
      this.dispatchEvent('USER_CONNECTED', userProfile)
      this.dispatchEvent('USER_PROFILE', userProfile)
      if (this.ConnectNotifications) this.dispatchEvent('NOTIFICATION', { message: 'Connected to Forge', type: 'Connected' })
    }
  }

  private executeMessageOperation(kind: any, args: any, type: any, message: any) {
    switch (kind) {
      case 'applyUserProfile':
        this.applyUserProfileFromMessage(message)
        break
      case 'updateLocalInventory':
        this.updateLocalInventory(message)
        break
      case 'updateLocalQuestProgress':
        this.updateLocalQuestProgress(message)
        break
      case 'setIsPlayerIdle': {
        const path = typeof args.path === 'string' ? args.path : 'isIdle'
        this.dispatchEvent('IDLE_STATUS', message)
        this.uiState.isPlayerIdle = !!this.getValueByPath(message, path)
        break
      }
      case 'mergeProfile':
        if (this.player?.userId) {
          const current = this.userProfiles.get(this.player.userId) || {}
          this.userProfiles.set(this.player.userId, { ...current, ...message })
        }
        break
      case 'notify': {
        const text = this.resolveTemplateValue(args.message ?? '', type, message)
        const nType = this.resolveTemplateValue(args.type ?? '', type, message)
        this.dispatchEvent('NOTIFICATION', { message: String(text ?? ''), type: String(nType ?? '') })
        break
      }
      case 'dispatchEvent': {
        const eventType = this.resolveTemplateValue(args.type ?? '', type, message)
        const payload = this.resolveTemplateValue(args.payload ?? '$message', type, message)
        if (typeof eventType === 'string' && eventType.length > 0) this.dispatchEvent(eventType, payload)
        break
      }
      case 'logError': {
        const text = this.resolveTemplateValue(args.message ?? '$message.message', type, message)
        console.error('Forge message error:', text)
        break
      }
      case 'setState':
      case 'toggleState':
      case 'call':
        this.executeUiOperation(kind, args)
        break
      case 'fetchApiData':
        void this.executeFetchApiData(
          this.resolveDeepTemplates(args, type, message, undefined) as any
        )
        break
      case 'callApi':
        void this.executeCallApi(args)
        break
      case 'patchShopInventoryListing':
        this.patchShopInventoryListingFromMessage(message, typeof args.inventoryKey === 'string' ? args.inventoryKey : 'shopInventory')
        break
      case 'clearShopListingSyncIfBuyer':
        this.clearShopListingSyncIfBuyer(message)
        break
      default:
        console.log('Unsupported message operation kind:', kind)
        break
    }
  }

  private runMessageActions(type: any, message: any): any {
    const actions = this.messageActionsByType[type] || []
    if (actions.length === 0) return false
    const state = this.getUiStateSnapshot()
    let stopDefault = false
    actions.forEach((action:any) => {
      if (!this.evaluateCondition(action.when, state, message)) return
      action.steps.forEach((step:any) => {
        const args = (step.args && typeof step.args === 'object') ? step.args : {}
        this.executeMessageOperation(step.kind, args, type, message)
      })
      if (action.stopDefault === true) stopDefault = true
    })
    return stopDefault
  }

  private getCurrentUserProfile(): any {
    if (!this.player?.userId) return null
    return this.userProfiles.get(this.player.userId) || null
  }

  private getAllQuests(): any {
    const profile = this.getCurrentUserProfile()
    const candidates = [
      profile?.userQuests?.questsProgress,
      profile?.userStats?.questsProgress,
      profile?.questsProgress
    ]
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate
    }
    return []
  }

  private getAllArtifacts(): any {
    const profile = this.getCurrentUserProfile()
    return profile?.artifacts || []
  }

  /**
   * Quest progress / instance rows (subgraph + profile shapes) — hidden from `$artifacts` inventory grid.
   * Does not remove REWARD items that only have sourceType quest.
   */
  private isQuestRelatedInventoryArtifact(a: any): boolean {
    if (!a || typeof a !== 'object') return false
    const s = (v: any) => String(v ?? '').trim()
    const low = (v: any) => s(v).toLowerCase()

    const meta = a.metadata && typeof a.metadata === 'object' ? a.metadata : null
    const qInst = a.questInstanceId ?? meta?.questInstanceId
    if (s(qInst) !== '') return true

    const at = low(a.artifactType ?? a.artifact_type ?? (meta ? meta.artifactType ?? meta.artifact_type : ''))
    if (
      ['quest_instance', 'quest_instances', 'quest_attempt', 'quest_attempts', 'quest_definition', 'quest_definitions'].includes(
        at
      )
    )
      return true

    const kind = low(a.kind ?? (meta ? meta.kind : ''))
    if (kind === 'quest' || kind === 'quest_definition') return true

    const typ = low(a.type ?? (meta ? meta.type : ''))
    if (typ === 'quest') return true

    const desc = low(a.description ?? (meta ? meta.description : ''))
    if (desc.includes('quest instance')) return true

    return false
  }

  private getArtifactsForInventoryGrid(): any[] {
    const raw = this.getAllArtifacts()
    if (!Array.isArray(raw)) return []
    return raw.filter((a) => !this.isQuestRelatedInventoryArtifact(a))
  }

  private getAllTokens(): any {
    const profile = this.getCurrentUserProfile()
    return profile?.userTokens || profile?.tokens || []
  }

  private shortenStatLabel(text: any, max = 26): string {
    const t = String(text ?? '').trim()
    if (t.length <= max) return t
    return `${t.slice(0, Math.max(0, max - 1))}…`
  }

  private formatStatValueForUi(v: any): string {
    if (v == null) return '—'
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '—'
    if (typeof v === 'string') return v.length > 24 ? `${v.slice(0, 23)}…` : v
    try {
      const s = JSON.stringify(v)
      return s.length > 28 ? `${s.slice(0, 27)}…` : s
    } catch {
      return String(v)
    }
  }

  /** REST USER_PROFILE `userStats`: map of variableId → { name, description, type, value, … } */
  private getUserStatsEntries(): any[] {
    const profile = this.getCurrentUserProfile()
    const raw = profile?.userStats
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const rows = Object.keys(raw).map((id) => {
      const row = (raw as any)[id]
      const merged =
        row != null && typeof row === 'object' && !Array.isArray(row)
          ? { id, ...row }
          : { id, name: id, description: '', type: 'unknown', category: '', value: row }
      const label = String(merged.name ?? merged.id ?? id)
      return {
        ...merged,
        displayName: this.shortenStatLabel(label, 26),
        displayValue: this.formatStatValueForUi(merged.value)
      }
    })
    rows.sort((a: any, b: any) => String(a.name || a.id).localeCompare(String(b.name || b.id)))
    return rows
  }

  private resolveRepeatSource(source: any): any {
    if (!source || typeof source !== 'string') return []
    const state = this.getUiStateSnapshot()
    const alternatives = source.split('||').map((s) => s.trim()).filter(Boolean)
    for (const part of alternatives) {
      if (part === '$quests') {
        const v = this.getAllQuests()
        if (Array.isArray(v) && v.length > 0) return v
      } else if (part === '$artifacts') {
        const v = this.getArtifactsForInventoryGrid()
        if (Array.isArray(v) && v.length > 0) return v
      } else if (part === '$tokens') {
        const v = this.getAllTokens()
        if (Array.isArray(v) && v.length > 0) return v
      } else if (part === '$shopInventory') {
        const v = Array.isArray(state.shopInventory) ? state.shopInventory : []
        if (v.length > 0) return v
      } else if (part === '$userStats') {
        return this.getUserStatsEntries()
      } else if (part.startsWith('$state.')) {
        const value = this.getValueByPath(state, part.slice('$state.'.length))
        if (Array.isArray(value)) return value
      }
    }
    return []
  }

  private isSafeHttpUrl(url: any): any {
    return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url)
  }

  /** Same identity rules as inventory selection highlight (id / artifactId / token ids). */
  private inventoryArtifactsMatch(sel: any, item: any): boolean {
    if (!sel || !item) return false
    const keys = ['id', 'artifactId', 'instanceTokenId', 'tokenId'] as const
    for (const k of keys) {
      const a = sel[k]
      const b = item[k]
      if (b != null && b !== '' && a != null && a !== '' && String(a) === String(b)) return true
    }
    return false
  }

  private collectInventoryItemDescription(item: any): string {
    if (!item || typeof item !== 'object') return ''
    const raw =
      item.description ??
      item.details ??
      item.summary ??
      item.shortDescription ??
      item.longDescription ??
      ''
    return String(raw).replace(/\s+/g, ' ').trim()
  }

  /** Single-line tooltip copy; keeps the dark bar compact so it stays inside the panel. */
  private truncateInventoryDescriptionLine(text: any, maxChars = 110): string {
    const s = String(text ?? '').trim()
    if (s.length <= maxChars) return s
    return `${s.slice(0, Math.max(0, maxChars - 1))}…`
  }

  private applyInventoryItemSelection(item: any) {
    if (!item) return
    this.uiState.inventoryTooltipItem = item
    this.uiState.inventoryTooltipText = this.truncateInventoryDescriptionLine(
      this.collectInventoryItemDescription(item),
      110
    )
  }

  private toggleInventoryItemSelect(item: any) {
    if (this.inventoryArtifactsMatch(this.uiState.inventoryTooltipItem, item)) {
      this.uiState.inventoryTooltipText = ''
      this.uiState.inventoryTooltipItem = null
    } else {
      void this.runUiAction('inventory-item-select', { item })
    }
  }

  private async runUiAction(actionId: any, clickArgs: any = {}) {
    if (!actionId) return
    if (actionId === 'select-shop-item') {
      const item = clickArgs.item
      const id = item?.id
      if (id && this.isShopItemInteractionLocked(id, item)) return
    }
    if (actionId === 'purchase-item') {
      const sid = this.uiState.selectedItemId
      if (sid && this.isShopItemInteractionLocked(sid)) return
    }
    const steps = this.uiActionsFromApi[actionId]
    if (!steps || steps.length === 0) {
      console.log('UI action not found in API config:', actionId)
      return
    }
    for (const step of steps) {
      const mergedArgs = this.resolveDeepTemplates(
        { ...(step.args || {}), ...(clickArgs || {}) },
        'UI',
        {},
        clickArgs || {}
      )
      await this.executeUiStep(step.kind, mergedArgs)
    }
  }

  private executeUiOperation(kind: any, args: any = {}) {
    switch (kind) {
      case 'setState': {
        const values = (args.values && typeof args.values === 'object') ? args.values : {}
        Object.keys(values).forEach((key) => {
          if (key === 'showIcon' && typeof values[key] === 'boolean') this.showIcon = values[key]
          else if (key === 'showUI' && typeof values[key] === 'boolean') this.showUI = values[key]
          // else if (key === 'showChatIcon' && typeof values[key] === 'boolean') this.showChatIcon = values[key]
          else if (key === 'showLoginSplashScreen' && typeof values[key] === 'boolean') this.showLoginSplashScreen = values[key]
          else this.uiState[key] = values[key]
        })
        break
      }
      case 'toggleState': {
        const keys = Array.isArray(args.keys) ? args.keys : []
        keys.forEach((key:any) => {
          if (key === 'showIcon') this.showIcon = !this.showIcon
          else if (key === 'showUI') this.showUI = !this.showUI
          // else if (key === 'showChatIcon') this.showChatIcon = !this.showChatIcon
          else if (key === 'showLoginSplashScreen') this.showLoginSplashScreen = !this.showLoginSplashScreen
          else {
            const current = this.uiState[key]
            this.uiState[key] = typeof current === 'boolean' ? !current : true
          }
        })
        break
      }
      case 'call': {
        const method = typeof args.method === 'string' ? args.method : ''
        const methodArgs = Array.isArray(args.args) ? args.args : []
        const call = this.callMethodAllowList[method]
        if (!call) {
          console.log('Unsupported call method:', method)
          break
        }
        Promise.resolve(call(...methodArgs)).catch((error) => {
          console.error('UI call operation failed:', method, error)
        })
        break
      }
      case 'emit':
        if (typeof args.type === 'string' && args.type.length > 0) this.dispatchEvent(args.type, args.payload)
        break
      case 'openUrl': {
        const url = typeof args.url === 'string' ? args.url : ''
        const target = typeof args.target === 'string' ? args.target : '_blank'
        if (!this.isSafeHttpUrl(url)) {
          console.log('OPEN_URL ignored: invalid or unsafe URL', url)
          break
        }
        this.dispatchEvent('OPEN_URL_REQUEST', { url, target })
        void openExternalUrl({ url }).catch(() => {
          const maybeOpen = (globalThis as any)?.open
          if (typeof maybeOpen === 'function') {
            try {
              maybeOpen(url, target)
            } catch (_e) {
              // Ignore host/runtime open restrictions; event fallback is already emitted.
            }
          }
        })
        break
      }
      case 'beginShopListingSync': {
        const path = typeof args.itemIdPath === 'string' ? args.itemIdPath : '$state.selectedItemId'
        let itemId = this.resolveTemplateValue(path, 'UI', {}, undefined) as any
        if (typeof itemId !== 'string' || !itemId) itemId = this.uiState.selectedItemId
        if (!itemId || typeof itemId !== 'string') break
        this.uiState.selectedItemId = null
        this.uiState.shopListingSyncPendingItemId = itemId
        const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 25000
        setTimeout(() => {
          if (this.uiState.shopListingSyncPendingItemId === itemId) {
            this.uiState.shopListingSyncPendingItemId = null
            console.log('[ForgeScriptModular] shop listing sync timeout — unlocked', itemId)
          }
        }, timeoutMs)
        break
      }
      default:
        console.log('Unsupported UI operation kind:', kind)
        break
    }
  }

  private renderUiNode(node: any, key: any, scope?: any): any {
    if (node.repeat && typeof node.repeat.source === 'string') {
      const allItems = this.resolveRepeatSource(node.repeat.source)
      const limitedItems = typeof node.repeat.limit === 'number' && node.repeat.limit >= 0
        ? allItems.slice(0, node.repeat.limit)
        : allItems
      const repeatedNode: any = { ...node }
      delete repeatedNode.repeat
      const itemAlias = node.repeat.itemAlias || 'item'
      const indexAlias = node.repeat.indexAlias || 'index'
      return limitedItems.map((item: any, index: any) =>
        this.renderUiNode(
          repeatedNode,
          `${key}-r${index}`,
          { ...(scope || {}), [itemAlias]: item, [indexAlias]: index, item, index }
        )
      )
    }

    const state = this.getUiStateSnapshot()
    if (!this.evaluateCondition(node.visibleWhen, state, undefined, scope)) return null

    const resolvedBackgroundInput = node.uiBackground
      ? this.resolveDeepTemplates(node.uiBackground, 'UI', {}, scope)
      : undefined
    const bgColor = this.resolveColor(resolvedBackgroundInput?.color)
    const textColor = this.resolveColor(node.uiText?.color)
    const textureSrc = typeof resolvedBackgroundInput?.texture?.src === 'string'
      ? resolvedBackgroundInput.texture.src.trim()
      : ''

    // DCL multiplies uiBackground.color with the texture; a dark hex makes icons look crushed. Use white whenever a texture is shown.
    const hasTexture = textureSrc.length > 0
    const uiBackground = resolvedBackgroundInput
      ? {
          ...(hasTexture
            ? { color: Color4.create(1, 1, 1, 1) }
            : bgColor
              ? { color: bgColor }
              : {}),
          ...(hasTexture ? { texture: { src: textureSrc } } : {}),
          ...(hasTexture && resolvedBackgroundInput.textureMode
            ? { textureMode: resolvedBackgroundInput.textureMode }
            : {})
        }
      : undefined

    const hasTextValue = typeof node.uiText?.value === 'string'
    const uiText = hasTextValue
      ? {
          value: String(this.resolveTemplateValue(node.uiText!.value as any, 'UI', {}, scope)),
          ...(node.uiText?.textAlign ? { textAlign: node.uiText.textAlign } : {}),
          ...(textColor ? { color: textColor } : {}),
          ...(typeof node.uiText?.fontSize === 'number' ? { fontSize: node.uiText.fontSize } : {}),
          ...(node.uiText?.textWrap === 'wrap' || node.uiText?.textWrap === 'nowrap'
            ? { textWrap: node.uiText.textWrap }
            : {})
        }
      : undefined

    let uiTransform: any = node.uiTransform ? { ...node.uiTransform } : {}
    const tfWhen = node.uiTransformWhen
    if (Array.isArray(tfWhen)) {
      for (const entry of tfWhen) {
        if (!entry?.when || entry.merge == null || typeof entry.merge !== 'object') continue
        if (!this.evaluateCondition(entry.when, state, undefined, scope)) continue
        const patch = this.resolveDeepTemplates(entry.merge, 'UI', {}, scope)
        uiTransform = { ...uiTransform, ...patch }
      }
    }

    uiTransform = this.normalizeUiTransformForSdk(uiTransform)

    return (
      <UiEntity
        key={key}
        uiTransform={uiTransform}
        uiBackground={uiBackground}
        uiText={uiText}
        onMouseDown={
          node.onMouseDownAction
            ? () => { void this.runUiAction(node.onMouseDownAction, this.resolveDeepTemplates(node.onMouseDownArgs || {}, 'UI', {}, scope)) }
            : undefined
        }
        onMouseEnter={
          node.onMouseEnterAction
            ? () => { void this.runUiAction(node.onMouseEnterAction, scope || {}) }
            : undefined
        }
        onMouseLeave={
          node.onMouseLeaveAction
            ? () => { void this.runUiAction(node.onMouseLeaveAction, scope || {}) }
            : undefined
        }
      >
        {node.children?.map((child:any, index:number) =>
          this.renderUiNode(child, `${key}-${child.key || index}`, scope)
        )}
      </UiEntity>
    )
  }
}

