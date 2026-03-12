# Bug Fixes Log

This document tracks all bugs discovered and their resolutions. Each entry helps prevent similar issues in the future and provides context for unusual code patterns that might be bug fixes rather than poor design.

## Format
```
## [Date] Bug Title
**Severity:** Critical/High/Medium/Low
**Description:** What the bug was and how it manifested
**Root Cause:** Technical explanation of why the bug occurred
**Reproduction Steps:** How to reproduce the bug (if applicable)
**Solution:** How the bug was fixed
**Files Modified:** Which files were changed
**Prevention:** What was added to prevent similar bugs
**Testing:** How the fix was verified
```

---

## Template for New Entries
```
## [YYYY-MM-DD] Bug Title
**Severity:** [Critical/High/Medium/Low]
**Description:** 
**Root Cause:** 
**Reproduction Steps:**
1. Step one
2. Step two
3. Expected vs actual result

**Solution:** 
**Files Modified:**
- `file1.ts` - what was changed
- `file2.ts` - what was changed

**Prevention:** 
**Testing:** 
**Related Issues:** Links to similar bugs or follow-up issues
```

---

## [2026-03-12 00:15] Flag Animation Not Working When Attached
**Severity:** Medium
**Description:** When flag was attached to player's head using AvatarAttach, the spinning and bobbing animations stopped working. Flag appeared static above player's head instead of the expected animated behavior.

**Root Cause:** The AvatarAttach component was overriding Transform changes made by the animation system. Since AvatarAttach controls the entity's position and rotation to keep it attached to the avatar, manual Transform.getMutable() changes were being ignored or overwritten.

**Reproduction Steps:**
1. Player picks up flag with E key
2. Flag attaches above head using AvatarAttach
3. Animation system attempts to modify Transform for spin/bob
4. Expected: Flag spins and bobs while attached
5. Actual: Flag remains static

**Solution:** Implemented parent-child entity system:
1. Create invisible parent entity that attaches to avatar via AvatarAttach  
2. Make flag a child of the parent entity using Parent component
3. Animate flag's Transform relative to parent (child entities can animate freely)
4. Particle system calculates world position from carrier position + animation offsets

**Files Modified:**
- `src/systems/flagSystem.ts` - Added `attachmentParents` Map, parent-child logic
- `src/systems/localTestFlag.ts` - Added `attachmentParent` tracking, matching logic
- Both files updated particle position calculations for attached flags

**Prevention:** 
- Document that AvatarAttach entities cannot be directly animated via Transform  
- Use parent-child pattern for any future animated attachments
- Test animations immediately after implementing attachment systems

**Testing:** 
- Verified flag spins at 45°/second when carried
- Verified flag bobs with 0.25m amplitude at 3Hz frequency  
- Verified particle effects spawn at correct world positions
- Verified cleanup properly removes parent entities on drop
- Tested in both online and local preview modes

**Related Issues:** Also removed colliders from flags per user request as part of same change.

---

## [2026-03-12 00:55] Flag Duplication During Clone System
**Severity:** High
**Description:** Sometimes when picking up the flag, two versions would appear - one on the ground (server-synced original) and one attached to the avatar (visual clone). This created confusing UX where players saw two flags simultaneously.

**Root Cause:** Race condition in the clone system's visibility management:
1. Clone creation happened before server flag was hidden
2. Existing clone entities weren't always cleaned up before creating new ones
3. No defensive programming to verify visibility state consistency
4. State transitions could be interrupted by network sync, leaving both entities visible

**Reproduction Steps:**
1. Pick up flag (E key)
2. Occasionally both server flag and clone would remain visible
3. Two flags would move independently (server flag idle, clone following player)
4. Issue more common during network latency or rapid pickup/drop cycles

**Solution:** Implemented robust clone system state management:
1. **Mandatory Cleanup**: Always call `cleanupClone()` before creating new clone
2. **Immediate Visibility**: Hide server flag BEFORE creating clone (not after)
3. **Defensive Programming**: Every frame verify visibility matches expected state
4. **Debug Logging**: Track clone creation/destruction for troubleshooting

**Files Modified:**
- `src/systems/flagSystem.ts` - Added `cleanupClone()` function, improved state transitions
- `src/systems/localTestFlag.ts` - Applied identical fixes for consistency

**Prevention:** 
- Always cleanup before creating new entities in similar systems
- Use `createOrReplace` instead of `create` for components that manage visibility
- Add defensive programming for critical state consistency
- Test state transitions under network latency conditions

**Testing:** 
- Verified no duplication during rapid pickup/drop cycles
- Tested with simulated network delays
- Confirmed cleanup happens properly on state transitions  
- Debug logs confirm proper visibility state management

**Related Issues:** Clone system architecture from v1 project - ensured proper adaptation to current codebase.