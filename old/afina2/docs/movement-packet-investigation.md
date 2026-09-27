# Outgoing movement packet investigation

Current strategy: physical movement and its bounded packet trace are **prevention only**. Confirmed AFK uses hub/realm recovery, described in [runtime reliability](runtime-reliability.md). The sender audit below remains applicable to prevention; references to the reported AFK failure describe historical evidence.

## Findings before any behavioral fix

The current source has one outgoing movement filter: `ConfigurationEvents.#registerWriteGuard` in `src/minecraftBot/handlers/botEvents/configurationEvents.js`. It returns without delegating for `position`, `position_look` and `flying` **only when `protocol.state === "configuration"`**. It does not inspect role or AFK status. The state check is evaluated on every write; it is not a persistent suppression flag. `look` is not in the existing set. This audit preserves that behavior, including the omission. No historical explanation is available beyond the handler's configuration-safety purpose.

Source and installed sender-path inspection found no additional movement blacklist/whitelist or global write suppression. There is no project `patches/` directory and no patch-package install hook in package.json. The installed minecraft-protocol client is locally formatted/customized; this investigation inspects the installed implementation, not an assumed upstream copy. No original baseline is available to attribute every local modification historically. Its `Client.write()` skips a non-writable serializer and otherwise calls `serializer.write({name, params})`; there is no movement-name condition there. Bot creation passes the server version to Mineflayer and does not supply custom packet definitions. The explicit listener removal in Bot initialization concerns `world_particles`, not movement. Root `protodef-read-generated.js` is a generated reader, not an outbound sender hook.

The runtime version comes from server configuration. The installed minecraft-data **1.21.11 / protocol 774** serverbound mapping is:

| Purpose | write name | ID | Fields |
|---|---|---|---|
| Position | `position` | 0x1d | x/y/z f64, flags |
| Position and rotation | `position_look` | 0x1e | x/y/z f64, yaw/pitch f32, flags |
| Rotation | `look` | 0x1f | yaw/pitch f32, flags |
| Status only | `flying` | 0x20 | flags |

`flags` is `MovementFlags`, including `onGround` and `hasHorizontalCollision`. Mineflayer supplies this modern flags object alongside legacy onGround fields. Tests round-trip the actual installed serializer/parser; these movement names and fields are compatible. This does not prove correctness of every unrelated protocol feature or server acceptance.

## Actual sending path

In `node_modules/mineflayer/lib/plugins/physics.js`, `setControlState()` stores input. On the nominal 50 ms physics timestep, `tickPhysics()` simulates/applies player state and emits `physicsTick`, then calls `updatePosition(now)`. `updatePosition()` selects `sendPacketPosition`, `sendPacketPositionAndLook`, `sendPacketLook`, or the status-only `flying` write. Position changes trigger updates; unchanged position still receives a roughly one-second refresh. Rotation-only and onGround-only changes use their corresponding packets. One write for every physics tick is not guaranteed.

Unready/nonfinite entity coordinates, unloaded terrain, private `shouldUsePhysics` suspension, and the post-death tick limit can prevent sending. Public `physicsEnabled` gates simulation, while `shouldUsePhysics` also gates `updatePosition`. Project configuration/disconnect handlers disable public physics; AFK status itself does not. Existing movement eligibility remains unchanged.

Then: project configuration write guard -> installed `Client.write` -> serializer -> optional compressor -> length framer -> optional cipher -> socket. The installed protocol client pipes these streams; no movement-specific condition was found downstream. Encryption/compression prevent reliable packet-name attribution from a raw socket chunk alone.

Clientbound `position` contains teleportId, coordinates, delta velocity, rotation and relative flags. Mineflayer's existing handler applies the correction, sends `teleport_confirm`, and sends a position/look response. It has a special delayed response after respawn. No teleport handling was changed. Counting incoming corrections alone does not establish why the server sent them.

## Diagnostic changes only

`MovementPacketTrace` is attached after the existing guard, outside AntiAfkManager. It observes one prevention attempt per client registration. Every attempt ends with movement completion/failure/cancellation, disconnect, protocol-state transition or a 12-second diagnostic cap (the movement timeout remains 10 seconds). It restores wrapped methods and removes listeners/timers afterward. No physical recovery attempt is generated or traced.

Events use the existing `bot.antiAfk.diagnostic` bridge:

- `PACKET_TRACE_START`: version, mode, work status and exact observation boundaries.
- `PACKET_TRACE_SAMPLE`: batches every 750 ms, not one log event per packet.
- `PACKET_TRACE_END`: final counters, reason and remaining records.

Records identify `MOVEMENT_WRITE_ATTEMPT` before the guard, `MOVEMENT_WRITE_PASSED` at serializer.write entry, `MOVEMENT_SERIALIZED` at serializer byte output, incoming `CLIENTBOUND_POSITION_CORRECTION`, and teleport confirmation attempt/pass. Coordinates, rotation, modern flags and teleport IDs are selected explicitly; chat/authentication payloads are never recorded. At most 512 records per attempt are retained across batches. Counters continue after the record cap; `truncated` reports omitted records. No console packet spam is added.

Compare `physicsTicks`, `movementWriteAttempts`, `movementWritesPassed`, `movementSerialized`, `serializationErrors`, `clientboundPositionCorrections`, and teleport confirmation counters. Socket writability/destruction and `socketBytesWrittenDelta` are supplementary: the byte delta includes **all** socket traffic, not just movement. Serializer entry is not proof of successful encoding; serialized output is not proof of socket delivery or server receipt. A positive return from write is deliberately not used as evidence.

No preexisting live log supplies movement write/pass counts. The reported ~200 ticks and temporary movement do not establish these numbers, nor do position resets alone prove incoming position packets. The new trace is necessary to distinguish those cases. No suppression fix is applied without that evidence: **old guard condition = new guard condition**.

## Normal realm control test

The first naturally scheduled prevention movement supplies the realm comparison using the exact same normal walking path. For an explicit local diagnostic in a running worker debugger, with `bot` referring to that worker's Afina Bot instance, call `await bot.movementPacketTrace.requestNormalMovement()` before AFK. This requests one existing forward/return cycle by making it due; it does not write protocol packets. It refuses non-realm, ineligible, blocked or already moving bots and an exhausted prevention trace budget. All manager eligibility/ownership checks still apply. It is not a website chat command. Restart the worker for a fresh trace budget.

We did not connect to FunTime or run this live control test from the development workspace. Capture prevention trace-end counters and correction records before concluding global suppression or server rejection. The earlier request to compare physical recovery has been superseded by hub/realm recovery.

## Verification

Deterministic tests exercise the actual installed 1.21.11 protocol serializer/parser and framer for all four movement packets in realm/AFK, unchanged configuration filtering, correction and teleport-confirm observation, zero-generation distinction, cleanup on protocol transition/disconnect, trace budgets, the normal movement request safety checks and absence of direct packet writes in AntiAfkManager. These are offline protocol-path tests, not a FunTime reproduction. After replacing obsolete physical-recovery tests with hub-recovery coverage, the full `npm test` suite passes 158 tests with 0 failures.

Changed files: the configuration handler (diagnostic registration only), new `runtime/movementPacketTrace.js`, `tests/movementPacketTrace.test.js`, and this document. AntiAfkManager, AFK lifecycle, timeout, auction behavior and Core are unchanged.
