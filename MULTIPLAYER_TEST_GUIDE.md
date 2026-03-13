# Multiplayer Flag Steal Testing Guide

## Setup

**Both players need:**
1. Foundation client or browser
2. Console access (press ` or F12)
3. Visit: `flagtag.dcl.eth`

## Testing Procedure

### Test 1: Basic Steal

**Player A (Flag Holder):**
1. Pick up the red flag (press E near it)
2. Watch console for:
   - `[C.4]` or `[C.11]` - Pickup success
   - `[C.12]` - Clone created
   - `[C.20]` - Status shows "Clone exists: true"
3. Stand still and wait for Player B

**Player B (Attacker):**
1. Run up close to Player A (within 2.5 meters)
2. Press E to attack
3. Watch console for:
   - `[C.5]` - Attack sent
   - `[C.13]` - Carrier changed (if steal worked!)
   - `[C.14]` - New clone created (if steal worked!)

**What Should Happen:**
- Flag should instantly appear above Player B's head
- Player B should start earning points
- Flag should NOT drop to ground

**What Currently Happens (Bug):**
- First hit doesn't steal?
- Flag drops instead of transferring?
- Flag doesn't appear visually?

### Test 2: Second Hit

After the first steal attempt:

**Player B (now has flag if steal worked):**
- Press E again
- Should see `[C.1]` - "I am carrying, sending requestDrop"
- Flag should drop to ground

**What to Check:**
- Does Player B think they're carrying? (look for `[C.1]` vs `[C.5]`)
- Does `[C.20]` periodic log show correct state?

### Test 3: Repeated Steals

Try stealing back and forth multiple times:
- Does it work the first time?
- Does it work every time?
- Are there delays or duplications?

## Console Log Collection

**Both players should:**
1. Copy ALL console output (right-click → Save As or Select All → Copy)
2. Save to a text file with your name (e.g., `player-a-logs.txt`)
3. Send both log files for analysis

**Key logs to search for:**

Player who pressed E to steal:
- Search for `[C.5]` - Did attack get sent?
- Search for `[C.13]` - Did carrier change?
- Search for `[C.14]` - Did clone get created?

Player who had the flag:
- Search for `[C.13]` - Did they detect losing it?
- Search for `[C.15]` - Did their clone get cleaned up?

## Quick Diagnosis

**If first hit doesn't steal:**
- Check if `[C.5]` appears (attack sent?)
- Check if distance was close enough
- Check if victim was immune from previous hit

**If flag doesn't appear on new carrier:**
- Check if `[C.14]` appears (clone created?)
- Check `[C.20]` status - does it show "Clone exists: true"?

**If flag drops instead of stealing:**
- Check what Player B sent: `[C.1]` (drop) or `[C.5]` (attack)?
- If `[C.1]`, client thinks it's already carrying

## Server Logs (If Accessible)

If you can access server console, look for:
- `[S.3]` - Attack received
- `[S.20]` - Hit confirmed
- `[S.22]` - Victim has flag
- `[S.32]` - Executing steal
- `[S.35]` - Steal completed

## Report Format

Please provide:
1. What happened (in plain English)
2. What you expected to happen
3. Console logs from both players
4. Any visual bugs (flag in wrong place, duplicated, etc.)

Example:
```
Player A picked up flag - flag appeared above head ✓
Player B pressed E near Player A
Expected: Flag transfers to Player B
Actual: Nothing happened on first press, second press dropped the flag
See attached logs: player-a.txt, player-b.txt
```
