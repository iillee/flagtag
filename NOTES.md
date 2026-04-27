# Flag Tag - Session Notes (April 27, 2026)

## What happened today

### The bugs reported
1. **First load, pick up flag → no points on scoreboard**
2. **Points revert to previous value when dropping the flag**
3. **Flag clone stuck to avatar permanently** — can't drop, persists across leave/return

### Root cause analysis

**The bugs were caused by an AFK player's stale client**, not by code changes. When we redeployed the scene, the AFK player's client retained old CRDT state and was out of sync with the fresh server. This caused the server to think the flag was in a state that prevented new pickups.

**Evidence:**
- Deploying to `baskervill.dcl.eth` (no AFK player) → everything worked fine
- Once all players left `flagtag.dcl.eth` → everything worked fine again
- The optimistic pickup rollback (clone appears then disappears after 1.5s) confirmed the server was rejecting pickups — likely because the flag state was `Carried` with the stale player as carrier

### What was committed today
- `f6adc7b` — Fix flag falling through ground: only accept `reportGroundY` from the player who dropped the flag (the `lastDropperId` fix). This change is solid and unrelated to the pickup bugs.

### Uncommitted changes (SHOULD BE REVERTED)
- **Diagnostic logging in `src/server/server.ts`** — added `console.log` and `room.send('debugReject', ...)` to `handlePickup`, `handleDrop`, `requestPickup`, `requestDrop`, and `requestReloadRespawn` handlers. These were for debugging and should be stripped out.
- **`debugReject` message in `src/shared/messages.ts`** — added for client-visible server rejection reasons. Should be removed.
- **`debugReject` listener in `src/index.ts`** — `room.onMessage('debugReject', ...)` handler. Should be removed.
- **`scene.json` world name** — changed from `flagtag.dcl.eth` to `baskervill.dcl.eth` for testing. **MUST be changed back to `flagtag.dcl.eth`**.

### Recommended next steps (in priority order)

1. **Revert all uncommitted changes** and redeploy cleanly to `flagtag.dcl.eth`.

2. **Remove the optimistic pickup system** — This is the top suspect for recurring client-side bugs (stuck clones, rollback confusion). The optimistic prediction in `src/systems/flagSystem.ts` adds significant complexity:
   - `optimisticCarrierId`, `optimisticTimestamp`, `OPTIMISTIC_ROLLBACK_MS`
   - `skipShieldClear` logic
   - Rollback paths that interact with CRDT state updates mid-prediction
   
   The actual pickup latency without it is ~150-300ms (WebSocket round-trip + CRDT sync), which should feel fine. Remove the optimistic code and let the client wait for CRDT confirmation before showing the clone. If the delay feels bad, re-add it later.

3. **Case-sensitivity bug in reload-respawn** (`src/index.ts` ~line 380):
   ```ts
   if (flag.carrierPlayerId === local.userId)
   ```
   `flag.carrierPlayerId` is always lowercased by the server, but `local.userId` from `getPlayer()` may be mixed-case. Should be:
   ```ts
   if (flag.carrierPlayerId === local.userId.toLowerCase())
   ```

4. **Banana log spam** — `[Trap] Skipping own banana prediction` fires every frame for ~2 seconds after dropping a banana. Not a bug, just noisy. Could gate behind a `once` flag or remove the log.

### Logging situation
- **Local preview**: Server code doesn't run (`isServer()` returns false), so server-side logs are invisible. Only client logs appear in the preview console.
- **Desktop client**: Scene console logs require launching with `scene-console=true` parameter. Regular `Player.log` at `C:\Users\luke\AppData\LocalLow\Decentraland\Explorer\` only has Unity engine logs.
- **Browser**: `play.decentraland.org/?realm=flagtag.dcl.eth` with F12 → Console shows client-side scene logs. Server logs are not visible to clients.
