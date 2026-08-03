# The AIX format and the Rokid runtime

*Derived from `main.md` — "AIUI AIX format and Rokid runtime".*

## Package model

Rokid defines AIX as the dedicated distribution format for AIUI agents. The package follows the **Open Agent Format** (OAF) concept, is self-contained, receives a unique `VERSION` UUID during packaging, and can optimize images and JSON data. OAF describes agents as directories and files representing identity, description, capability boundaries, and composable resources.

A typical AIUI project uses one of two source structures:

| Element | Traditional project | Single-file component project |
|---|---|---|
| Global logic | `app.js` | `app.js` |
| Global configuration | `app.json` | `app.json` |
| Global styles | `app.wxss` | Optional/global styling |
| Agent declaration | `AGENTS.md` | `AGENTS.md` |
| Page markup | `page.wxml` | `<page>` block in `page.ink` |
| Page logic | `page.js` | `<script setup>` block |
| Page configuration | `page.json` | `<script def>` block |
| Page styles | `page.wxss` | `<style>` block |
| Static resources | `assets/`, images, SVG, audio | Same |

When both a traditional page and a corresponding `.ink` page exist, **the `.ink` single-file component is preferred**. `AGENTS.md` is the agent-oriented manifest describing identity, capabilities, configuration, and system instructions; `app.json` determines entry points, routes, global window behavior, and page organization.

Conceptual package layout:

```text
example-agent/
├── AGENTS.md
├── app.js
├── app.json
├── app.wxss                 # optional
├── VERSION                  # generated when packaging
├── pages/
│   ├── index/
│   │   └── index.ink
│   └── settings/
│       ├── settings.js
│       ├── settings.json
│       ├── settings.wxml
│       └── settings.wxss
├── components/
├── lib/
└── assets/
    ├── icons/
    ├── images/
    └── audio/
```

The official description lists WXML, WXSS, JavaScript, JSON, images, and audio as package contents — **no native machine code**. The agent payload is largely CPU-neutral; the host runtime and its native libraries remain CPU-, ABI-, and OS-specific. Moving the package across architectures is comparatively easy; reproducing its execution environment is not.

## Runtime requirements

On Rokid Glasses, the logic and view layers run inside **Ink**, a high-performance in-house container built on QuickJS and Skia, optimized for very low power, memory, and CPU budgets. Desktop/web development environments emulate the programming model, but Rokid explicitly warns that hardware-dependent behavior — spatial tracking, gestures, spatial audio, sensors — must be validated on physical devices.

A non-Rokid implementation needs, at minimum:

| Runtime component | Required behavior |
|---|---|
| AIX/OAF loader | Validate the package, locate `VERSION`, `AGENTS.md`, `app.json`, pages, modules, and assets |
| JavaScript engine | Execute AIUI JavaScript and module imports with appropriate memory and execution limits |
| UI parser | Parse WXML/WXSS or `.ink` sections and build a view hierarchy |
| Renderer | Implement layout, text, images, canvas, clipping, transformations, and display-specific constraints |
| Reactive state bridge | Reproduce `setData`-style state transfer and event binding semantics |
| Lifecycle manager | Implement app/page launch, show, hide, load, unload, error, and background behavior |
| Capability bridge | Expose network, storage, camera, microphone, audio, buttons, sensors, AI, and system APIs |
| Security boundary | Isolate packages, enforce permissions, prevent unrestricted filesystem/native access, and constrain networking |
| Update manager | Track package versions, integrity, rollback, and compatibility |
| Diagnostics | JavaScript exceptions, API errors, native logs, package validation, performance counters, and crash reports |

Define the compatibility target explicitly: "can display one known agent" needs a small subset; "can run arbitrary AIUI `.aix` packages" requires a much broader conformance effort (undocumented edge cases, error behavior, timing, font metrics, layout differences, media formats, device-specific modules).

## Official development tools

Scaffolder:

```bash
npm create @yodaos-pkg/aiui-agent my-agent

# Equivalent documented package invocation
npx @yodaos-pkg/create-aiui-agent my-agent

cd my-agent
npm install
npm start
```

The generated template includes `AGENTS.md`, `app.js`, `app.json`, and `pages/index/index.ink`. The repository also contains samples, design specifications, API references, and an AI coding skill.

Official Rust-based AIX CLI:

```bash
# From an AIUI source checkout
cargo install --path packages/aix-cli

# Inspect a package without extracting it
aix list example-agent.aix
aix ls example-agent.aix

# Build a package
aix pack ./example-agent
aix pack ./example-agent -o example-agent.aix

# Optimize images and JSON
aix pack ./example-agent --optimize
aix pack ./example-agent -O --opt-level 3
```

The packer recognizes `.aixignore` (`.gitignore`-like syntax) to exclude development files and secrets.

Community projects use commands such as `aiui-open . -i pages/index/index` and `aiui-aix pack --optimize -o dist/example-agent.aix .` — these appear to be tool wrappers or package-version-specific entry points, not the exact current official `aix` CLI. **A reproducible build should pin the CLI commit or package version** and should not assume `aix`, `aiui-aix`, and older studio tools are interchangeable.

## Publication and updates

The publication service validates the generated `VERSION` file and `AGENTS.md`, performs performance, interaction, and security review, and uses `VERSION` for hot updates. The regional route changed: as of June 24, 2026, former Rizon functions for Chinese users migrated to **AIUI Studio through the Rokid Open Platform**. Confirm international and enterprise workflows with Rokid — public pages are not fully synchronized.

## Licensing of the public materials

The public `jsar-project/AIUI` repository and package metadata are **Apache-2.0** — favorable for using and modifying the published documentation, templates, examples, and tools (subject to notice/attribution obligations). That license should **not** be treated as covering Ink, device firmware, commercial SDK binaries, cloud endpoints, the Agent Store, Rokid trademarks, or redistribution rights. No complete public Ink runtime source package or explicit Ink redistribution license was identified in the reviewed official materials.
