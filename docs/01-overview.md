# Overview: what `.aix` is and how to support it

*Derived from `main.md` — "Executive summary".*

## What `.aix` is — and is not

Rokid AIUI `.aix` is **not a general-purpose executable format** comparable to an Android APK, Linux ELF binary, WebAssembly module, or OCI container. Rokid defines AIX as "AI eXecutable", a self-contained distribution package for AIUI agents. Its payload contains JavaScript application logic, WXML/WXSS or `.ink` UI definitions, JSON configuration, agent metadata, and static assets. On supported Rokid Glasses these resources are interpreted and rendered by **Ink**, Rokid's wearable runtime built on QuickJS and Skia.

`.aix` compatibility therefore depends far more on the availability of a compatible AIUI/Ink runtime and device API bridge than on the package file itself.

## The central engineering conclusion

> **An `.aix` file cannot normally be converted directly into an APK, ELF binary, RTOS image, or container merely by repackaging it.** Supporting it on another platform requires either the original Ink runtime, a behaviorally compatible host runtime, a source-level port to the target application framework, or a proxy architecture in which Rokid/AIUI-compatible logic runs elsewhere.

## Default recommendations at a glance

- **Unspecified AR glasses** → a **thin glasses client plus companion-phone middleware**, optionally with cloud inference. The glasses own presentation, buttons, camera/microphone consent, and immediate feedback; the phone provides networking, authentication, computation, model access, and protocol adaptation. This mirrors Rokid's own two-device SDK architecture.
- **Android-based glasses with full developer access** → either **port the AIUI application source to a normal APK** (one or a few agents), or build/license an **AIUI compatibility host** (many third-party `.aix` packages unchanged — substantially more expensive, with semantic and licensing risk: public repositories expose AIUI docs, examples, scaffolding, and packaging tools, but not a complete redistributable Ink runtime or a public Ink redistribution license).
- **Rokid Glasses that already support AIUI** → use the native `.aix` workflow, not an APK wrapper. Note the deployment channel changed: as of June 24, 2026, the former Rizon functionality for China migrated to **AIUI Studio on the Rokid Open Platform**. Verify the channel for your region and account rather than trusting older tutorials.

## Assumptions that materially affect the recommendation

| Unknown | Why it matters | Default assumption used in the report |
|---|---|---|
| Exact glasses model | Determines OS, ABI, display, sensors, thermal budget, and SDK availability | Generic ARM-based wearable, with Android as the most likely high-capability target |
| Firmware and OS version | Determines API level, permissions, native library compatibility, and available services | Android 12/API 31-class target where Rokid bare-metal development is considered |
| Access level | Consumer devices may restrict APK sideloading, root access, services, or custom firmware | Standard application-level access; no root or firmware modification |
| Need for binary compatibility | Running arbitrary `.aix` packages is much harder than porting one known agent | Source code for the agent is assumed available |
| Offline requirements | Determines whether phone/cloud proxying is acceptable | Intermittent connectivity must be tolerated; critical interaction remains local |
| Display type | Rokid AIUI guidance currently emphasizes single-green displays for some Glasses generations | UI must remain simple and adaptable to monochrome or low-resolution displays |
| Commercial rights | Public AIUI code licensing does not necessarily cover Ink, cloud services, trademarks, firmware, or stores | Separate commercial and redistribution review is required |
