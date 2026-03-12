# Architectural Decisions Log

This document records major architectural choices and design patterns in the Flag Tag project. Understanding these decisions is crucial for maintaining consistency and avoiding conflicts with the existing system design.

## Current Architecture Overview

### Authoritative Multiplayer Design
**Decision:** Use server-authoritative architecture with client prediction
**Justification:** 
- Prevents cheating in competitive multiplayer environment
- Server validates all game-changing actions (pickup, drop, attack)
- Client prediction provides responsive feel for visual effects
- `@dcl/sdk@auth-server` with `hammurabi-server` provides robust foundation

**Implementation:**
- Server: `src/server/server.ts` - All game logic and state validation
- Client: Systems provide visual feedback and input handling only
- Components: `validateBeforeChange()` ensures server-only modification
- Sync: Deterministic entity IDs for consistent client-server mapping

### Component-Based Entity Architecture
**Decision:** Separate components for different game aspects with strict ownership
**Justification:**
- Clean separation of concerns
- Server-only vs client-only responsibilities clearly defined
- Easy to sync specific data without conflicts

**Key Components:**
- `Flag`: Server-authoritative flag state (position, carrier, state)
- `PlayerFlagHoldTime`: Individual player accumulated time
- `CountdownTimer`: Round timing and winner snapshots
- `LeaderboardState`: Persistent all-time leaderboard

### Physics and Movement System
**Decision:** Hybrid client-server physics with client-assisted ground detection
**Justification:**
- Server lacks direct access to 3D scene colliders
- Client raycast provides accurate ground detection
- Server maintains authoritative gravity simulation
- Prevents flag floating or clipping through terrain

**Implementation:**
- Server tracks carrier Y position history to estimate ground level
- Client fires raycast on flag drop and reports ground Y to server
- Server applies gravity with realistic acceleration (15 m/s²)
- Smooth client-side interpolation for visual following

### Event-Driven Communication
**Decision:** Message-based client-server communication with typed schemas
**Justification:**
- Clear API contract between client and server
- Type safety prevents runtime errors
- Decoupled architecture - systems don't need direct references

**Message Categories:**
- Client→Server: `requestPickup`, `requestDrop`, `requestAttack`, `reportGroundY`
- Server→Client: `hitVfx`, `missVfx`, `stagger`, `pickupSound`, `dropSound`
- Player Management: `registerName` for display name resolution

### Performance Optimization Strategy
**Decision:** Object pooling for frequently created/destroyed entities
**Justification:**
- VFX system creates many short-lived entities
- Entity creation/destruction is expensive in ECS
- Pooling eliminates garbage collection spikes
- Maintains consistent 30fps in large multiplayer scene

**Pooled Systems:**
- Trail particles (15 entities) - flag movement effects
- Beacon particles (12 entities) - idle flag effects  
- Hit VFX spikes (18 entities) - combat hit effects
- Miss VFX clouds (6 entities) - combat miss effects
- Hit sound effects (5 entities) - audio overlap prevention

### State Management Pattern
**Decision:** Centralized game state with distributed UI state
**Justification:**
- Single source of truth for game mechanics
- UI can derive all display data from core game state
- Local UI state (overlay visibility) doesn't affect gameplay

**Structure:**
- Core State: Server-synchronized components (Flag, PlayerFlagHoldTime, etc.)
- Derived State: Client functions compute UI data from core state
- Local State: UI overlay visibility, client-only preferences

### Round and Persistence System
**Decision:** UTC-aligned rounds with server-side persistence
**Justification:**
- Predictable round timing regardless of server restarts
- Fair competition - all players know exact end time
- Persistent leaderboard survives deployments
- Storage API ensures data reliability

**Implementation:**
- 10-minute rounds aligned to UTC boundaries (00:00, 00:10, 00:20, etc.)
- Server persists flag state and leaderboard JSON to storage
- Round winner snapshots preserved during hold time reset
- Graceful handling of server restarts mid-round

### Combat System Design
**Decision:** Unified interaction key with context-sensitive actions
**Justification:**
- Simple control scheme - single E key for all interactions
- Context determines action: pickup vs drop vs attack
- Reduces control complexity in already complex multiplayer game

**Action Priority:**
1. Drop flag (if carrying)
2. Pickup flag (if nearby and available)  
3. Attack players (default action when not carrying flag)

### VFX and Feedback Architecture
**Decision:** Client-side VFX triggered by server events
**Justification:**
- Server determines hit/miss outcome to prevent cheating
- Client renders appropriate VFX at precise positions
- Consistent visual feedback across all clients
- Separates game logic from presentation

**VFX Categories:**
- Combat: Hit spikes, miss clouds, stagger effects
- Flag: Trail particles, beacon bubbles, state change sounds
- UI: Smooth animations, hover effects, overlay transitions

## Future Considerations

### Scalability
- Current 150-parcel scene approaches entity limits
- VFX pooling can be expanded if more effects needed
- Server message rate should be monitored under high player load

### Anti-Cheat
- All game state changes validated server-side
- Client input is requests only, never commands
- Ground detection is collaborative but server has final authority

### Performance
- Object pools prevent garbage collection issues
- Frame time clamping prevents lag-induced exploits  
- Entity cleanup ensures memory doesn't leak over long sessions

This architecture has proven stable for 24/7 operation and can handle the competitive multiplayer requirements of Flag Tag.