# Flag Steal Mechanic - Debug Investigation

## Added Comprehensive Logging

### Client-Side Logging (flagSystem.ts)

**E Key Press:**
- `[Client] E pressed - I am carrying, sending requestDrop`
- `[Client] E pressed - flag is being carried by <userId>`
- `[Client] E pressed - flag on ground nearby, distance: X.XX`
- `[Client] E pressed - sending requestPickup`
- `[Client] E pressed - sending requestAttack (no flag nearby)`

**Flag State Changes:**
- `[Flag] State/Carrier change detected - prevState: X newState: Y prevCarrier: XXX newCarrier: YYY`
- `[Flag] STATE CHANGED to Carried - new carrier: XXX`
- `[Flag] CARRIER CHANGED (state stayed Carried) - old: XXX new: YYY`
- `[Flag] Created NEW clone for new carrier after steal: XXX`
- `[Flag] STATE CHANGED to Dropped/AtBase - cleaning up clone`

**Periodic Debug:**
- `[Flag Debug] Current state: X Carrier: XXX Clone exists: true/false` (every 3 seconds)

### Server-Side Logging (server.ts)

**Message Receipt:**
- `[Server] 📨 Received requestPickup from XXX`
- `[Server] 📨 Received requestDrop from XXX`
- `[Server] 📨 Received requestAttack from XXX`

**Attack Handler:**
- `[Server] 🎯 handleAttack called by: XXX`
- `[Server]    ⏳ Attack on cooldown for XXX - time since last: X ms`
- `[Server]    📍 Attacker position: X.X Y.Y Z.Z`
- `[Server]       🛡️ Player XXX is IMMUNE (X ms since hit)`
- `[Server]       👤 Player XXX at distance: X.XX m`
- `[Server]    Players checked: X Immune: Y Closest dist: Z.ZZ`
- `[Server]    💥 HIT CONFIRMED! Attacker: XXX Victim: YYY Distance: Z.ZZ`
- `[Server]    🚩 Flag check - State: X Carrier: XXX Victim: YYY`
- `[Server]    ✅ VICTIM HAS FLAG! Initiating steal...`
- `[Server]    ℹ️  Regular hit (victim does not have flag)`
- `[Server]    ❌ ATTACK MISSED - no valid targets in range`

**Steal Execution:**
- `[Server] 🚩 EXECUTING FLAG STEAL: XXX -> YYY`
- `[Server]    Before: state = X , carrier = XXX`
- `[Server]    After:  state = Y , carrier = YYY`
- `[Server] ✅ Flag steal completed successfully - new carrier: XXX`
- `[Server] ❌ Flag steal failed: no flag component`
- `[Server] ❌ Flag steal failed: victim does not have flag. State: X Carrier: XXX Expected victim: YYY`

## What to Look For

### Expected Flow (Successful Steal)

1. **Client A** (attacker) presses E
   - `[Client] E pressed - sending requestAttack (no flag nearby)`

2. **Server** receives and processes
   - `[Server] 📨 Received requestAttack from A`
   - `[Server] 🎯 handleAttack called by: A`
   - `[Server]    💥 HIT CONFIRMED! Attacker: A Victim: B Distance: X.XX`
   - `[Server]    ✅ VICTIM HAS FLAG! Initiating steal...`
   - `[Server] 🚩 EXECUTING FLAG STEAL: B -> A`
   - `[Server]    Before: state = Carried , carrier = B`
   - `[Server]    After:  state = Carried , carrier = A`
   - `[Server] ✅ Flag steal completed successfully - new carrier: A`

3. **All Clients** receive flag state update
   - `[Flag] State/Carrier change detected - prevState: Carried newState: Carried prevCarrier: B newCarrier: A`
   - `[Flag] CARRIER CHANGED (state stayed Carried) - old: B new: A`
   - `[Flag] Created NEW clone for new carrier after steal: A`

### Common Issues to Diagnose

**Issue 1: First hit doesn't steal**
- Check if attack message is even sent: Look for `[Client] E pressed - sending requestAttack`
- Check if server receives it: Look for `[Server] 📨 Received requestAttack`
- Check if hit is detected: Look for `[Server]    💥 HIT CONFIRMED!`
- Check if flag check passes: Look for `[Server]    ✅ VICTIM HAS FLAG!`
- Check if steal executes: Look for `[Server] 🚩 EXECUTING FLAG STEAL`

**Issue 2: Flag doesn't appear on new carrier**
- Check if client detects carrier change: Look for `[Flag] CARRIER CHANGED`
- Check if clone is created: Look for `[Flag] Created NEW clone for new carrier`
- Check periodic debug: `[Flag Debug] Current state: Carried Carrier: XXX Clone exists: true`

**Issue 3: Flag duplication**
- Look for multiple `[Flag] Created animated clone` messages without cleanup
- Check if old clone is cleaned up before new one: Look for cleanup logs before creation

**Issue 4: Second hit drops instead of continuing to hold**
- Check what client sends on second press: Should be `requestDrop` if carrying, `requestAttack` if not
- Check if client thinks it's carrying: Look for `[Client] E pressed - I am carrying`
- Check server flag state: Look for `[Server]    🚩 Flag check - State: Carried Carrier: XXX`

## Testing Instructions

1. Deploy scene with this logging enabled
2. Have two players test stealing
3. Collect console logs from both clients AND server
4. Search for the emoji markers (🎯, 💥, 🚩, etc.) to trace the flow
5. Compare actual flow against "Expected Flow" above
6. Identify where the flow diverges from expected behavior

## Next Steps

Once we identify where the flow breaks:
- **Client sends wrong message** → Fix client-side E key logic
- **Server doesn't detect hit** → Adjust HIT_RADIUS or position sync
- **Server detects hit but doesn't steal** → Fix flag state check
- **Clone not created/cleaned** → Fix client-side clone system
- **State sync delay** → May need to debounce or add state confirmation
