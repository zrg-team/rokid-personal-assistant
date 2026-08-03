# Security, licensing, recommendations, and next steps

*Derived from `main.md` — "Security, licensing, recommendations, and next steps".*

## Security and privacy implications

**Package isolation.** An `.aix` package contains active JavaScript and should be treated as executable content. A compatibility host must not provide unrestricted filesystem, process, native library, shell, or network access. Each native API should validate arguments, enforce size and rate limits, check an explicit capability grant, and return controlled errors.

**Package integrity.** Maintain two independent identities:

```text
Package content identity:
    cryptographic hash of immutable package bytes

Release identity:
    signed metadata containing agent ID, version, hash,
    minimum runtime version, permissions, and expiry/revocation state
```

The generated `VERSION` UUID is useful for update tracking but should not replace cryptographic integrity or publisher authentication. Rokid's store uses `VERSION` for validation and hot-update decisions; a custom deployment system should also verify signatures and hashes.

**Camera and microphone privacy.** Access should be initiated by an unambiguous user action or an explicitly disclosed feature. Show a visible or audible capture state, stop capture promptly, and provide a hardware-independent cancellation path. Android identifies camera, microphone, and location as sensitive resources and expects applications to request access only when required.

**Data minimization.** Crop images to the relevant region, reduce resolution where sufficient, perform wake-word detection or simple filtering locally, and avoid retaining raw media after deriving the required result. Cloud processing should document what leaves the device, the processing region, model/provider, retention period, access controls, and deletion process.

**Authentication.** Do not embed long-lived API keys, client secrets, or signing keys in JavaScript, assets, APK resources, or `.aix` packages. Use a phone or backend to exchange device/user authentication for short-lived scoped tokens. Rokid community guidance likewise warns against publishing `.env` files, API keys, historic `.aix` packages, extracted APK contents, or system logs.

**Transport security.** Use TLS for phone/cloud communication and an authenticated, encrypted pairing protocol between phone and glasses. Bind each session to the paired device, reject replayed sequence numbers, rotate keys, and require explicit reauthorization after device ownership changes.

**Supply-chain security.** Pin AIUI CLI, Node, Rust, NDK, Gradle, Maven, native engine, and SDK versions. Preserve dependency manifests and license information, scan native and JavaScript dependencies, store checksums for external SDKs, and produce an SBOM for the APK, container, or firmware release.

**Updates.** Use signed updates, rollback protection, atomic installation, and a known-good fallback. RTOS products should use a verified bootloader/update chain; Android products should preserve the signing key and test migration across application and data-schema versions.

## Licensing implications

| Component | Publicly observed status | Required action |
|---|---|---|
| AIUI public repository, docs, templates, and tools | Apache-2.0 | Preserve license and notices; review modified distributions |
| `.aix` agent code and assets | Determined by agent owner and included dependencies | Obtain rights for code, fonts, images, audio, models, and data |
| Ink runtime | Described as Rokid's in-house runtime; no complete public redistribution grant identified | Request written SDK/runtime and redistribution terms from Rokid |
| Rokid Android SDK artifacts | Distributed through Rokid channels, with public and commercial tiers | Review SDK agreement, device restrictions, and distribution rights |
| CXR-M | Commercial access | Obtain commercial agreement before architecture commitment |
| Rokid cloud/AI services | Service-specific | Review acceptable-use, privacy, data-processing, region, quota, and pricing terms |
| QuickJS/Skia or substitute engines | Depends on selected versions and modifications | Perform component-specific license and notice audit |
| Models and datasets | Provider-specific | Verify inference, redistribution, fine-tuning, output, and telemetry rights |
| App-store/device distribution | Platform-specific | Confirm signing, review, security, export, and regional requirements |

The Apache-2.0 status of the public repository does **not** by itself authorize use of the Rokid name, duplication of proprietary runtime behavior through confidential materials, redistribution of firmware components, or access to commercial services.

## Recommended architectures

**For unspecified glasses** — a three-layer architecture:

```text
Glasses shell
    display, buttons, capture, consent, local feedback
             ⇅
Companion phone middleware
    connection, authentication, protocol adaptation,
    caching, media preprocessing, offline fallback
             ⇅
Edge/cloud services
    LLM, vision, ASR/TTS where needed,
    business systems, synchronization
```

This minimizes assumptions about the glasses OS and resources, isolates vendor SDK differences, and supports Android, embedded Linux, RTOS, and display-only glasses. Expensive AI workloads can move between phone, edge, and cloud without redesigning the glasses interface.

When the target is a capable Android product and offline operation matters, port the specific AIUI application to a normal APK — preserve schemas, prompts, business JavaScript, and the transport contract, but use the target's native UI and sensor APIs.

Build a general AIX host **only** when all of the following are true:

- Running many existing `.aix` packages unchanged is a product requirement.
- A long-term conformance and security-test program is funded.
- The necessary runtime or licensing relationship with Rokid is available, or the organization accepts the cost of an independent compatible implementation.
- The target hardware has sufficient RAM, CPU/GPU, flash, and update capability.
- A stable device capability contract can be maintained across multiple vendors.

**For Rokid Glasses with supported AIUI.** Use the official `.aix` runtime and AIUI Studio deployment path. Build with the official scaffolder and `aix` CLI, validate on physical hardware, and avoid wrapping `.aix` inside an APK unless Rokid explicitly documents such a host integration. Confirm the regional release route (AIUI Studio, international equivalent, or enterprise channel).

**For Rokid bare-metal Android.** Use a signed native APK when direct camera, IMU, buttons, or standalone control are needed. Treat AIUI source as migration input, not as an executable container. Where phone interaction is needed, integrate CXR-L/CXR-S or the appropriate current SDK and preserve the phone-relay network model.

**For Rokid Glass3.** Build paired Android applications using the official phone and glasses SDKs. Keep the glasses application focused on hardware, low-latency interaction, and presentation; keep authentication, internet access, service integration, and heavier AI on the phone. Confirm the exact SDK generation — Glass3 enterprise documentation and consumer CXR documentation are related but distinct product channels.

**For Linux glasses.** Use a native display/sensor daemon and optionally containerize headless business or inference services. Do not put the only camera/audio/display integration inside an OCI container unless the container security and device-access model is intentionally designed for it.

**For RTOS glasses.** Use a minimal native client and companion-phone/cloud execution. Full `.aix` runtime compatibility is not the recommended baseline.

## Actionable next steps

| Priority | Action | Deliverable |
|---|---|---|
| Immediate | Identify exact glasses model, firmware, OS/API level, CPU ABI, RAM, storage, display, and developer access | Target capability sheet |
| Immediate | Obtain one representative `.aix` file and its source tree | Reproducible test fixture |
| Immediate | Run `aix list` and inventory pages, modules, assets, APIs, and permissions | AIX dependency manifest |
| Immediate | Confirm whether exact binary compatibility or source-level feature equivalence is required | Written compatibility objective |
| Immediate | Contact Rokid regarding Ink/runtime availability, enterprise SDK terms, AIUI Studio region support, and redistribution | Licensing and platform decision record |
| Near term | Build a capability probe for camera, microphone, audio output, buttons, IMU, networking, storage, and lifecycle | Device test APK or AIUI agent |
| Near term | Implement the versioned `GlassCapabilities` interface and a mock backend | Portable adapter layer |
| Near term | Prototype the phone-proxy path with one photo request and one streaming text response | End-to-end vertical slice |
| Near term | Measure cold start, input feedback, P2P transfer, inference, render latency, memory, and battery | Baseline performance report |
| Near term | Port one representative AIUI page to the target native UI | Complexity and fidelity benchmark |
| Decision gate | Compare native rewrite versus compatibility host using actual API coverage and performance data | Architecture selection |
| Production | Add signatures, SBOM, permission policy, privacy indicators, structured logs, crash symbols, rollback, and CI conformance tests | Release-ready platform |

The first proof of concept should be deliberately narrow:

```text
User presses glasses button
    → glasses displays "Capturing…"
    → one image is captured
    → phone receives image and metadata
    → phone performs local or cloud recognition
    → partial text is streamed to glasses
    → user can cancel
    → all stages emit correlated timing metrics
```

That vertical slice exercises the most consequential compatibility boundaries — buttons, UI, camera, binary transport, phone relay, authentication, AI processing, streaming, lifecycle, cancellation, privacy, and latency — without prematurely committing to a complete AIX runtime implementation.
