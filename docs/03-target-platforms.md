# Target platform landscape

*Derived from `main.md` — "Target platform landscape".*

"AR glasses" covers very different deployment environments. A strategy that works on an Android-based standalone headset may be impossible on lightweight glasses using an RTOS and a companion phone.

| Platform class | Typical application format | Native dependency format | Likely `.aix` support | Practical route |
|---|---|---|---|---|
| Rokid Glasses with AIUI | `.aix` through AIUI Studio/device runtime | Ink and system capability services supplied by firmware | Native, when the model/region supports AIUI | Use official AIUI workflow |
| Rokid bare-metal development | Signed Android APK | AAR/JAR and ABI-specific `.so` libraries | Not automatically | Native Android port or custom compatibility host |
| Rokid Glass3 two-device SDK | Glasses APK plus phone APK | Rokid AARs and ARM shared libraries | Not automatically | Phone/glasses adapter, native rewrite, or service bridge |
| Generic Android AR glasses | APK installed on device; AAB used for publishing | `arm64-v8a`, sometimes `armeabi-v7a`, x86 variants | No standard support | APK rewrite or embedded runtime |
| General embedded Linux glasses | ELF executable, shared libraries, distro package, application bundle, or OCI image | AArch64/ARMv7 ELF `.so` | No standard support | Native Linux port, service container, or proxy |
| Custom Linux without desktop stack | ELF binary and firmware-integrated services | Cross-compiled native libraries | Very unlikely | Minimal native client plus phone/cloud |
| RTOS glasses | Firmware image or statically linked application | Board-specific objects and libraries | Effectively none | Protocol proxy; do not host full AIUI unless vendor supplies it |
| Display-only tethered glasses | Application runs on phone, puck, or compute unit | Host-dependent | Only on host | Run AIUI-compatible layer on companion |

## Rokid Glasses and YodaOS-Sprite

Rokid identifies **YodaOS-Sprite** as the operating system for Rokid Glasses and related AI glasses. Public platform documentation distinguishes three main development routes: CXR-L on Android/iOS phones through the Rokid AI App, commercially distributed CXR-M on Android, and public "bare-metal" Android development on the glasses (Android Go/AOSP API 31; exposes keys, IMU, and camera to standard Android applications).

| Rokid route | Execution location | Requires Rokid AI App | Public availability | Main capabilities |
|---|---|---:|---:|---|
| AIUI `.aix` | Ink runtime on glasses | Platform-dependent | AIUI Studio access | Agent UI, AIUI APIs, device-integrated experiences |
| CXR-L `1.0.3` | Phone, with glasses sessions | Yes | Public | Image, audio, display/custom views, commands |
| CXR-M `1.1.0` | Android phone, optionally with glasses-side component | No | Commercial | Stable connection, AV streaming, P2P, TTS, notifications, commands, scene customization |
| Bare-metal `1.0.0` | On glasses | No | Public | Standard Android app, camera, IMU, buttons, custom device logic |

**CXR-M cannot run alongside the Rokid AI App on the same phone.** Applications that depend on the consumer AI App and AIUI ecosystem should generally remain in that control plane; enterprise applications that need full connection ownership may need CXR-M or a separate glasses-side APK.

## Rokid Glass3

Glass3's official SDK supports standalone glasses Android applications and paired phone applications. Documented environment: Android Studio 2022+, JDK 17+, Android 8.0+. Rokid publishes separate glasses and phone SDK dependencies and documents native `libr2aud.so` variants for `arm64-v8a` and `armeabi-v7a` — ABI-specific native audio code is involved.

```groovy
dependencies {
    implementation('com.rokid.security:glass3.open.sdk:2.2.0-E') {
        exclude group: "org.slf4j"
    }
}

android {
    packagingOptions {
        pickFirst 'lib/arm64-v8a/libr2aud.so'
        pickFirst 'lib/armeabi-v7a/libr2aud.so'
    }
}
```

The architecture delegates discovery, connection, P2P establishment, network forwarding, and orchestration to the **phone**, while the glasses-side application controls device hardware and returns results. The SDK supports messaging, files, photos, video, preview, ASR, TTS, AI chat, offline voice commands, and recognition. After P2P setup, the documented internet path is normally **glasses → phone → public network → service**.

## Generic Android

Android installs APKs; an `.aab` App Bundle is a publishing artifact processed by a distributor into device-specific APKs, not directly installable. APKs with native libraries must package the correct ABI-specific machine code (`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`).

An Android `.aix` host would itself be an APK containing:

```text
aiui-host.apk
├── classes.dex                    # Kotlin/Java host and bridges
├── lib/arm64-v8a/
│   ├── libjsruntime.so
│   ├── librenderer.so
│   └── libdevicebridge.so
├── assets/
│   └── built-in-agent.aix         # optional
├── res/
└── AndroidManifest.xml
```

The `.aix` remains a data/resource package inside or beside the APK; the APK supplies the executable runtime.

## Embedded Linux

A conventional Linux product executes ELF binaries and shared objects compiled for its CPU and C library. An OCI image can package filesystem layers and configuration but still requires a compatible kernel, container runtime, storage, namespaces/cgroups, and device access. Containerization can package an AI or networking service, but it does not automatically supply display drivers, camera access, microphone routing, GPU support, Bluetooth permissions, or an Ink-equivalent UI runtime — those must be mapped from the host, often with privileged device access that reduces isolation.

## RTOS

In an RTOS environment such as Zephyr, the application, RTOS configuration, drivers, and linked libraries are commonly built into **one firmware binary**, with signed MCUboot-compatible images for secure updates. A full QuickJS-plus-Skia-compatible wearable runtime may exceed the RAM, flash, graphics, filesystem, and memory-management capabilities of many RTOS glasses. Unless the vendor already supplies a JavaScript/UI runtime, the preferred RTOS design is a small native protocol client connected to a phone or edge service.
