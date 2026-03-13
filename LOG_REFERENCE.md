# Flag Steal Debug - Quick Reference Card

## Numerical Log Codes

### CLIENT LOGS (C.x)

**E Key Actions:**
```
[C.1] = Dropping flag (I'm carrying)
[C.2] = Someone else has flag
[C.3] = Flag on ground nearby
[C.4] = Picking up flag
[C.5] = Attacking (no flag nearby)
```

**Flag State Updates:**
```
[C.10] = State/Carrier change detected
[C.11] = State changed to Carried
[C.12] = Created clone for carrier
[C.13] = Carrier changed (steal detected!)
[C.14] = Created NEW clone after steal
[C.15] = State changed to Dropped/AtBase
```

**Status:**
```
[C.20] = Periodic status (every 3s)
```

### SERVER LOGS (S.x)

**Message Receipt:**
```
[S.1] = Received requestPickup
[S.2] = Received requestDrop
[S.3] = Received requestAttack
```

**Attack Processing:**
```
[S.10] = Attack handler started
[S.11] = Attack on cooldown
[S.12] = Attacker position not found
[S.13] = Attacker position found
[S.14] = Player is immune
[S.15] = Checking player distance
[S.16] = Summary of player check
```

**Hit Detection:**
```
[S.20] = HIT CONFIRMED
[S.21] = Flag state check
[S.22] = Victim has flag, stealing!
[S.23] = Victim now immune
[S.24] = Regular hit (no flag)
[S.25] = Attack missed
```

**Steal Execution:**
```
[S.30] = Steal failed (no flag)
[S.31] = Steal failed (wrong carrier)
[S.32] = EXECUTING STEAL
[S.33] = Before state
[S.34] = After state
[S.35] = Steal completed
```

## Success Pattern (What to Look For)

**Successful Steal Sequence:**
1. `[C.5]` - Client sends attack
2. `[S.3]` - Server receives attack
3. `[S.10]` - Attack processing starts
4. `[S.20]` - Hit confirmed
5. `[S.22]` - Victim has flag
6. `[S.32]` - Executing steal
7. `[S.35]` - Steal completed
8. `[C.13]` - Client detects carrier change
9. `[C.14]` - Client creates new clone

## Quick Diagnosis

**If first hit doesn't steal:**
- Missing `[C.5]`? → Client not sending attack
- Missing `[S.3]`? → Server not receiving message
- Missing `[S.20]`? → Hit not detected (distance too far?)
- Missing `[S.22]`? → Flag check failed
- Missing `[S.32]`? → Steal not executing

**If flag doesn't appear:**
- Missing `[C.13]`? → Client not detecting carrier change
- Missing `[C.14]`? → Clone not created
- Check `[C.20]` → Should show "Clone exists: true"

**If second press drops flag:**
- Should see `[C.1]` not `[C.5]`
- If seeing `[C.5]`, client thinks it's not carrying

## Testing Procedure

1. **Deploy scene** with debug logging
2. **Test with 2 players:**
   - Player A picks up flag
   - Player B hits Player A
3. **Collect logs:**
   - Open browser console (F12)
   - Copy all logs
   - Search for `[C.` and `[S.` patterns
4. **Compare to success pattern above**
5. **Report which step is missing**
