# Deployment, performance, and debugging

*Derived from `main.md` — "Deployment, performance, and debugging".*

## Deployment checklist

| Area | Required verification |
|---|---|
| Target identity | Exact model, firmware, OS/API level, region, display type, CPU, ABI, RAM, storage, and access restrictions recorded |
| AIUI eligibility | Confirm whether the device firmware contains AIUI/Ink and whether the account has AIUI Studio access |
| Package validation | `aix list` succeeds; `AGENTS.md`, `app.json`, route entries, assets, and generated `VERSION` are present |
| Build reproducibility | Lockfile committed; CLI/toolchain versions pinned; clean CI build produces deterministic manifest and content hashes |
| ABI | Every `.so` has a target ABI variant; no accidental x86-only, ARMv7-only, or incompatible C++ runtime dependency |
| Android signing | APK signed with production key; upgrade path tested using the same signing identity |
| Permissions | Minimum declarations used; runtime denial, permanent denial, and revocation tested |
| Sensors | Camera orientation, format, resolution, IMU axes, timestamps, buttons, and audio routing tested on actual hardware |
| Network | First connection, reconnection, phone sleep, P2P loss, poor Wi-Fi, captive portal, and offline mode tested |
| Privacy | Camera/microphone indication, user consent, retention, deletion, and data-flow documentation complete |
| Security | Package signature/integrity, TLS, authentication, secret storage, dependency scan, and update rollback complete |
| Performance | Startup, steady-state RAM, peak RAM, CPU, thermal behavior, battery, frame timing, audio underruns, and network latency measured |
| Recovery | App restart, device reboot, phone replacement, interrupted update, corrupted cache, and server failure tested |
| Observability | Structured logs, request IDs, crash reports, version metadata, and privacy-safe metrics available |
| Release route | Correct AIUI Studio, enterprise SDK, APK distribution, device management, or firmware OTA channel confirmed |

## Performance model

Measure latency as a pipeline rather than a single average:

```text
T_total =
    T_input_capture
  + T_local_preprocess
  + T_glasses_to_phone
  + T_phone_queue
  + T_phone_or_cloud_compute
  + T_phone_to_glasses
  + T_render_or_audio_start
```

For every stage, collect median, p95, and p99. A low mean can hide reconnect stalls, GC pauses, thermal throttling, or occasional multi-second cloud responses.

Establish SLOs separately for:

| Metric | Measurement points |
|---|---|
| Input-to-feedback | Button/voice event timestamp to first visible or audible acknowledgment |
| Cold startup | Process launch to first usable page |
| Warm resume | Foreground event to interactive UI |
| Camera-to-preview | Sensor timestamp to displayed frame |
| Camera-to-result | Capture timestamp to first useful recognition result |
| Speech endpoint-to-response | End-of-speech detection to first text/audio response |
| Streaming smoothness | Inter-chunk gaps, dropped chunks, and render update frequency |
| Link reliability | Reconnect duration, failed-session rate, and stale-response rate |
| Memory | Initial, steady, peak, post-task, and post-background RAM |
| Energy | Current draw per idle minute and per representative task |
| Thermal stability | Performance after sustained use, not only first-minute benchmarks |

AIUI's official guidance: reduce package size, remove unused resources, split packages for on-demand loading, prefetch core data, batch state updates, minimize data transferred to the view, and reuse list nodes. Network UX should show early loading feedback, define timeout/retry behavior, render core information first, reuse cached data, and test reconnect and resume flows under poor conditions.

Additional implementation practices:

- Downsample camera input before transmission when full sensor resolution is unnecessary.
- Use JPEG/WebP for photographic snapshots; lossless formats only when text or barcodes require them.
- Keep short UI sounds decoded or cached to avoid first-use codec delay.
- Stream speech and model output incrementally.
- Bound the JavaScript heap, image cache, network buffers, decoded audio, and page history.
- Avoid continuous high-rate IMU forwarding unless actually consumed.
- Timestamp sensor data at acquisition, not after transport.
- Cancel stale vision or AI work when the user exits, captures a new frame, or changes context.
- Separate UI feedback from cloud completion so network delay does not appear as a frozen interface.

## Debugging and logging

**AIUI-level.** Real-device results are the final basis for judging interaction, performance, network behavior, storage, audio, and local capability calls. Combine logs and remote debugging; repeatedly test weak networks, Bluetooth links, and sustained operation.

```bash
aiui-open ./example-agent \
  -i pages/index/index \
  --theme yodaos-sprite-greenonly \
  --inspector \
  --show-perf
```

Community tooling also documents optional Bluetooth, message-file, query, and inspector flags; availability varies by tool release.

**Android.**

```bash
# Filter application and native logs
adb logcat \
  -v threadtime \
  AIUIHost:D \
  DeviceBridge:D \
  AndroidRuntime:E \
  libc:F \
  '*:S'

# Record a full log for later correlation
adb logcat -b all -v epoch > glass-session.log

# Memory and process state
adb shell dumpsys meminfo com.example.aiuihost
adb shell dumpsys activity processes
adb shell dumpsys media.audio_flinger
adb shell dumpsys sensorservice
adb shell dumpsys camera

# Inspect package permissions
adb shell dumpsys package com.example.aiuihost

# Verify packaged native libraries
unzip -l app-release.apk | grep 'lib/.*\.so$'
```

Rokid Glass3 requires a data/debug cable (not the charge-only cable) to appear as an Android Studio device; screen-mirroring tools help verify rendering and interaction.

**Native crashes.**

```bash
adb shell run-as com.example.aiuihost ls files
adb shell ls /data/tombstones

$ANDROID_NDK_HOME/ndk-stack \
  -sym app/build/intermediates/cmake/release/obj/arm64-v8a \
  -dump native-crash.txt
```

Keep unstripped symbols in a protected artifact store and ship stripped binaries. Associate every native crash with application version, package `VERSION`, firmware version, ABI, and device model.

**Structured event logging.** Machine-readable, not prose:

```json
{
  "event": "bridge.request.completed",
  "requestId": "req-4d2a",
  "operation": "vision.describe",
  "agentVersion": "aix-version-uuid",
  "appVersion": "2.4.1",
  "deviceModel": "redacted-model-code",
  "firmware": "redacted-firmware-version",
  "transport": "wifi-p2p",
  "durationMs": 428,
  "uploadBytes": 86421,
  "downloadBytes": 912,
  "status": "ok"
}
```

Do not log raw audio, images, transcripts, access tokens, authorization headers, API keys, precise location, or complete user prompts by default.

## Common pitfalls

| Pitfall | Root cause | Prevention |
|---|---|---|
| Renaming `.aix` to `.apk` | Formats have unrelated loaders and execution models | Treat `.aix` as agent resources, not an Android executable |
| Assuming QuickJS alone is enough | AIUI also depends on layout, rendering, lifecycle, and native APIs | Define the complete compatibility surface |
| Embedding secrets in `.aix` | Client packages can be inspected or extracted | Keep secrets in phone/server secure storage; use short-lived tokens |
| Assuming a simulator proves compatibility | Sensors and performance differ on real devices | Maintain a real-device test matrix |
| Shipping one native ABI | Glasses may use a different ABI or require secondary libraries | Query ABI and inspect every transitive AAR |
| Mixing C++ runtimes | Multiple or incompatible `libc++_shared.so` copies | Standardize NDK and C++ runtime versions |
| Ignoring microphone ownership | Wake-word or system assistant may hold capture resources | Coordinate audio focus/session ownership and test interruptions |
| Assuming direct internet access | Some glasses route through the phone | Abstract transport and support relay behavior |
| Treating P2P connection as app readiness | Device session or custom scene may not yet be initialized | Model connection, authentication, scene readiness, and operation readiness separately |
| Unbounded images or lists | Decoded media and view nodes consume scarce RAM | Resize, page, recycle, and cap caches |
| Excessive `setData` equivalents | Too many cross-layer updates and renders | Batch state changes |
| No cancellation | Old AI result overwrites a newer user action | Add request IDs, generation counters, and cancellation |
| Depending on undocumented APIs | Firmware updates may remove behavior | Gate by capability and firmware profile |
| Assuming Rizon instructions are current everywhere | China workflow migrated in June 2026 | Confirm region-specific AIUI Studio route |
| Treating containerization as hardware abstraction | Containers share the host kernel and drivers | Keep vendor hardware adapters host-native |
| Trying full AIUI on a small RTOS | Runtime, renderer, filesystem, and memory requirements are too large | Use a thin RTOS client and external execution |

Community field testing on Rokid Glasses has reported reliable results for custom UI, camera capture, network requests, images, barcode detection, and some button mappings, while TTS, ASR, IMU, web video, MP3 playback, and complete exit behavior were less stable or not fully verified in that environment. These are useful test leads, not official capability guarantees, and may change by firmware and tool version.
