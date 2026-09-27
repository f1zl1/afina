# Preventive Anti-AFK movement diagnostics

Physical movement is now **prevention only**. Confirmed AFK uses /hub and the existing realm-entry lifecycle; see [runtime reliability](runtime-reliability.md). The former physical-recovery strategy and auction readiness probe are removed.

The earlier FunTime report showed repeated 10-second timeouts with identical starting coordinates. Later evidence showed physics ticks, forward input, local velocity and temporary displacement. Neither report established packet delivery or the exact reason for server-position returns; no speculative movement workaround was added.

Inspection confirmed independent numeric start snapshots, horizontal hypot(dx,dz) distance, and physicsTick listeners installed before input. Reseller cleanup does not clear controls or disable physics. The runner's ROLE_CLEANUP blocker protects movement ownership until asynchronous role cleanup finishes. On AFK, the new runtime recovery also waits for that completion before requesting hub.

Bounded bot.antiAfk.diagnostic traces retain actual control readback, positions, velocity, physics ticks, orientation, terrain/vehicle state and blockers. Detailed movement logging covers one prevention attempt per manager, with at most 14 samples spaced 750 ms apart. External control clears include limited caller traces; owned releases are excluded. Wrappers/listeners/timers are restored afterward.

Failure summaries distinguish CONTROL_NOT_APPLIED, CONTROL_CLEARED, NO_PHYSICS_TICKS, NO_HORIZONTAL_MOTION, VELOCITY_WITHOUT_DISPLACEMENT and MOVEMENT_INCOMPLETE. These are observations, not proven server-side causes. Timeout captures state before control cleanup. The movement timeout and prevention retry settings are unchanged. Preventive failure does not trigger /hub.

Tests cover control readback, mutable coordinate objects and Y exclusion, missing/stationary physics ticks, external clears, timeout/retry, bounded diagnostics and event normalization. See [packet investigation](movement-packet-investigation.md) for the separate bounded sender trace.
