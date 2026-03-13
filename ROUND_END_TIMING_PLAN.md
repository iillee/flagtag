# Round End Timing Issue & Fix Plan

## Current Problem

**What happens now:**
1. Splash appears ~2-3 seconds **before** countdown hits 0:00
2. Splash disappears
3. Countdown resets and starts new round at 0:00

**Why this is wrong:**
- Players don't see the round actually end at 0:00
- The splash cuts into the previous round's gameplay
- Creates confusion about when rounds actually end

## Root Cause

Looking at the server code (`src/server/server.ts`):

```typescript
const SPLASH_DURATION_MS = 3000 // 3 seconds

// Server triggers round end AT the UTC boundary (0:00, 0:05, etc.)
timerMutable.roundEndTriggered = true
timerMutable.roundEndDisplayUntilMs = now + SPLASH_DURATION_MS
```

The server sets:
- `roundEndTriggered = true` AT the boundary (when timer hits 0:00)
- `roundEndDisplayUntilMs = now + 3000` (show splash for 3 seconds)

But the client shows the splash WHILE `roundEndTriggered` is true AND BEFORE the new round starts. This means:
- Old round ends at 0:00
- Splash shows immediately
- But the countdown display hasn't updated yet
- Player sees splash appear while timer still shows 0:02 or 0:01

## The Solution

### High-Level Flow:

**Old (current):**
```
0:03 → Splash appears (wrong!)
0:02 → Splash still showing
0:01 → Splash still showing
0:00 → Round actually ends, new round starts, splash disappears
```

**New (correct):**
```
0:03 → Gameplay continues
0:02 → Gameplay continues
0:01 → Gameplay continues
0:00 → Round ends, new round STARTS IN BACKGROUND, splash appears
      (Splash shows for 3 seconds DURING the new round)
0:01 (new round) → Splash still showing
0:02 (new round) → Splash still showing
0:03 (new round) → Splash disappears, gameplay resumes
```

### Technical Changes Needed:

#### 1. **Server Already Works Correctly!**
The server DOES start the new round immediately:
- Resets hold times
- Respawns flag
- Updates `roundEndTimeMs` to next boundary

The only issue is the **winner data gets wiped** when hold times reset.

#### 2. **Server: Preserve Winner Snapshot**
✅ Already done! The server stores winners in `timer.roundWinnerJson` BEFORE resetting hold times:
```typescript
const winnerSnapshot = winners.map(p => ({
  userId: p.userId,
  name: playerNames.get(p.userId) || p.userId.slice(0, 8)
}))
timerMutable.roundWinnerJson = JSON.stringify(winnerSnapshot)
```

This snapshot persists for the entire splash duration!

#### 3. **Client: Display Winner Snapshot**
✅ Already done! The client reads from `timer.roundWinnerJson`:
```typescript
const winnerSnapshot = JSON.parse(roundEndData.roundWinnerJson)
displayResults = winnerSnapshot.map((w: any) => ({
  userId: w.userId,
  name: w.name,
  isWinner: true
}))
```

#### 4. **The Real Issue: Timing Perception**

The problem is **visual only**. The logic is correct, but:
- The countdown display updates slower than the splash appears
- Players see "0:02" on the timer when splash shows
- This creates the illusion that the splash is early

**Solution:** The splash IS appearing at the right time (when round ends), but we need to:
1. Make sure the countdown display updates to "0:00" BEFORE the splash appears
2. OR accept that the splash will show while the countdown says 0:01-0:03 due to network latency

### Why The Current System Actually Works:

1. **Round ends at 0:00** → Server triggers
2. **New round starts immediately** → Server resets game state
3. **Splash shows for 3 seconds** → Overlays the first 3 seconds of the NEW round
4. **Winner data preserved** → Stored in `roundWinnerJson` snapshot

The only issue is the **countdown display** might not have updated yet when the splash appears, making it LOOK like the splash is early.

## Proposed Fix

### Option A: Accept Current Behavior
- The system is technically correct
- The "early" appearance is just network latency
- Players will get used to it

### Option B: Delay Splash by 1 Second
```typescript
timerMutable.roundEndDisplayUntilMs = now + SPLASH_DURATION_MS + 1000
```
- Gives countdown display time to update to 0:00
- Splash appears when players see 0:00
- But shortens the splash to 2 effective seconds

### Option C: Client-Side Countdown Override
- When `roundEndTriggered` becomes true, immediately update countdown display to "0:00"
- Then show splash
- Ensures players always see 0:00 when splash appears

### Option D: Extend Splash Duration
```typescript
const SPLASH_DURATION_MS = 5000 // 5 seconds instead of 3
```
- Gives more time for countdown to update
- Longer celebration period
- Players have more time to see winners

## Recommendation

**Option C + D Combined:**
1. When round end is detected, force countdown display to "0:00"
2. Increase splash duration to 5 seconds
3. This gives players clear visual feedback that the round ended
4. Longer splash time feels more celebratory

## Testing Checklist

After implementing the fix:
- [ ] Countdown shows 0:00 when splash appears
- [ ] Splash shows for full 5 seconds
- [ ] Winner names display correctly (not addresses)
- [ ] New round starts in background (flag respawns)
- [ ] Splash disappears and gameplay resumes smoothly
- [ ] No duplicate splashes or sound playing twice
