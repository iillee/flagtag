# Flag Steal Mechanic - Debug Investigation

## Numerical Logging System

All logs use a numerical prefix for easy searching and filtering:

### Client-Side (C.x)

**E Key Press (C.1-C.5):**
- `[C.1]` E pressed - I am carrying, sending requestDrop
- `[C.2]` E pressed - flag is being carried by <userId>
- `[C.3]` E pressed - flag on ground nearby, distance: X.XX
- `[C.4]` E pressed - sending requestPickup
- `[C.5]` E pressed - sending requestAttack (no flag nearby)

**Flag State Changes (C.10-C.15):**
- `[C.10]` State/Carrier change - prevState: X newState: Y prevCarrier: XXX newCarrier: YYY
- `[C.11]` STATE CHANGED to Carried - new carrier: XXX
- `[C.12]` Created clone for carrier: XXX
- `[C.13]` CARRIER CHANGED (state stayed Carried) - old: XXX new: YYY
- `[C.14]` Created NEW clone for new carrier after steal: XXX
- `[C.15]` STATE CHANGED to Dropped/AtBase - cleaning up clone

**Periodic Debug (C.20):**
- `[C.20]` Current state: X Carrier: XXX Clone exists: true/false (every 3 seconds)

### Server-Side (S.x)

**Message Receipt (S.1-S.3):**
- `[S.1]` Received requestPickup from XXX
- `[S.2]` Received requestDrop from XXX
- `[S.3]` Received requestAttack from XXX

**Attack Handler (S.10-S.25):**
- `[S.10]` handleAttack called by: XXX
- `[S.11]` Attack on cooldown for XXX - time since last: X ms
- `[S.12]` Attack failed: attacker position not found for XXX
- `[S.13]` Attacker position: X.X Y.Y Z.Z
- `[S.14]` Player XXX is IMMUNE - X ms since hit
- `[S.15]` Player XXX at distance: X.XX m
- `[S.16]` Players checked: X Immune: Y Closest dist: Z.ZZ
- `[S.20]` HIT CONFIRMED! Attacker: XXX Victim: YYY Distance: Z.ZZ
- `[S.21]` Flag check - State: X Carrier: XXX Victim: YYY
- `[S.22]` VICTIM HAS FLAG! Initiating steal...
- `[S.23]` Victim XXX now has X ms immunity
- `[S.24]` Regular hit (victim does not have flag)
- `[S.25]` ATTACK MISSED - no valid targets in range

**Steal Execution (S.30-S.35):**
- `[S.30]` Flag steal FAILED: no flag component
- `[S.31]` Flag steal FAILED: victim does not have flag. State: X Carrier: XXX Expected victim: YYY
- `[S.32]` EXECUTING FLAG STEAL: XXX -> YYY
- `[S.33]` Before: state = X , carrier = XXX
- `[S.34]` After:  state = Y , carrier = YYY
- `[S.35]` Flag steal completed successfully - new carrier: XXX

## What to Look For

### Expected Flow (Successful Steal)

1. **Client A** (attacker) presses E
   - `[C.5]` E pressed - sending requestAttack (no flag nearby)

2. **Server** receives and processes
   - `[S.3]` Received requestAttack from A
   - `[S.10]` handleAttack called by: A
   - `[S.13]` Attacker position: X.X Y.Y Z.Z
   - `[S.15]` Player B at distance: X.XX m
   - `[S.16]` Players checked: X Immune: Y Closest dist: Z.ZZ
   - `[S.20]` HIT CONFIRMED! Attacker: A Victim: B Distance: X.XX
   - `[S.21]` Flag check - State: Carried Carrier: B Victim: B
   - `[S.22]` VICTIM HAS FLAG! Initiating steal...
   - `[S.32]` EXECUTING FLAG STEAL: B -> A
   - `[S.33]` Before: state = Carried , carrier = B
   - `[S.34]` After:  state = Carried , carrier = A
   - `[S.35]` Flag steal completed successfully - new carrier: A

3. **All Clients** receive flag state update
   - `[C.10]` State/Carrier change - prevState: Carried newState: Carried prevCarrier: B newCarrier: A
   - `[C.13]` CARRIER CHANGED (state stayed Carried) - old: B new: A
   - `[C.14]` Created NEW clone for new carrier after steal: A

### Common Issues to Diagnose

**Issue 1: First hit doesn't steal**
- Check if attack message is sent: Look for `[C.5]`
- Check if server receives it: Look for `[S.3]`
- Check if hit is detected: Look for `[S.20]`
- Check if flag check passes: Look for `[S.22]`
- Check if steal executes: Look for `[S.32]`

**Issue 2: Flag doesn't appear on new carrier**
- Check if client detects carrier change: Look for `[C.13]`
- Check if clone is created: Look for `[C.14]`
- Check periodic debug: Look for `[C.20]` - should show Clone exists: true

**Issue 3: Flag duplication**
- Look for multiple `[C.12]` or `[C.14]` without cleanup
- Check if old clone is cleaned up before new one

**Issue 4: Second hit drops instead of continuing to hold**
- Check what client sends on second press: Should be `[C.1]` if carrying, `[C.5]` if not
- Check if client thinks it's carrying: Look for `[C.1]`
- Check server flag state: Look for `[S.21]`

## Quick Log Filtering

Search console for these patterns to trace a steal attempt:

- **Client attack attempt:** Search for `[C.5]`
- **Server hit confirmation:** Search for `[S.20]`
- **Steal execution:** Search for `[S.32]` through `[S.35]`
- **Client clone creation:** Search for `[C.14]`
- **Periodic state:** Search for `[C.20]`

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
