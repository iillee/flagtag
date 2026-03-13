# Round End Splash - Debug Logging

## Issue #1: Splash Detection

Testing whether the round end splash triggers reliably.

### Added Logging

**Periodic Status (every 10 seconds):**
- `[UI.DEBUG]` Timer status - roundEndTriggered: X timeToRoundEnd: Y s

**Round End Detection:**
- `[UI.1]` Round end triggered! Time remaining: X ms
- `[UI.2]` Round end ACTIVE - showing splash
- `[UI.3]` NEW round end detected! ID: X Playing trumpet...
- `[UI.4]` Trumpet sound created, winners: [...]
- `[UI.5]` Already processed this round end ID: X
- `[UI.6]` Round end triggered but expired - now: X displayUntil: Y
- `[UI.7]` Cleaning up trumpet sound
- `[UI.8]` No countdown timer found!

### What to Test

1. **Deploy the scene** with this logging
2. **Wait for a round to end** (every 5 minutes at :00, :05, :10, etc.)
3. **Watch the console** (F12 or `) for the UI.x logs

### Expected Flow (Success)

```
[UI.DEBUG] Timer status - roundEndTriggered: false timeToRoundEnd: 45 s
... (10 seconds pass)
[UI.DEBUG] Timer status - roundEndTriggered: false timeToRoundEnd: 35 s
... (round ends)
[UI.1] Round end triggered! Time remaining: 3000 ms
[UI.2] Round end ACTIVE - showing splash
[UI.3] NEW round end detected! ID: 1234567890 Playing trumpet...
[UI.4] Trumpet sound created, winners: [...]
(Splash screen appears)
... (3 seconds pass)
[UI.6] Round end triggered but expired - now: X displayUntil: Y
[UI.7] Cleaning up trumpet sound
(Splash disappears)
```

### Diagnosis

**If no splash appears:**

**Check 1: Is timer found?**
- Look for `[UI.8]` - if you see this, the timer entity isn't syncing from server

**Check 2: Is round end triggered?**
- Look for `[UI.DEBUG]` - does `roundEndTriggered` ever become `true`?
- If NO: Server isn't triggering round end (check server logs for `[S.` messages)
- If YES: Continue to Check 3

**Check 3: Does detection activate?**
- Look for `[UI.1]` - if missing, the condition `now < timer.roundEndDisplayUntilMs` is failing
- Check the time remaining - should be ~3000ms
- If time remaining is negative or 0, the display window already expired

**Check 4: Does splash render?**
- Look for `[UI.2]` - if missing, `isRoundOver` isn't being set
- Check if `roundEndData` is null

**Check 5: Is it a duplicate?**
- Look for `[UI.5]` - means we already processed this round
- Could indicate the roundEndTimeMs isn't changing between rounds

### What to Report

Copy console logs and note:
1. What time the round ended (check UTC time)
2. All `[UI.x]` messages around that time
3. Whether splash appeared or not
4. Whether trumpet played or not
5. Any errors in console

This will help us pinpoint exactly where the detection is failing!
