# Docs index

These documents cover **Supporting Rokid AIUI `.aix` Applications on AR Glasses**, split into focused, self-contained topics. (They were originally derived from a single `main.md` research report, since removed; the per-file "Derived from" notes name the section each came from.)

| Doc | Covers |
| --- | --- |
| [01-overview.md](01-overview.md) | Executive summary, the central portability conclusion, and the assumptions that shape every recommendation |
| [02-aix-format-and-runtime.md](02-aix-format-and-runtime.md) | What an `.aix` package is, the project/package layout, what a host runtime must implement, official tooling, publication, and licensing of the public repos |
| [03-target-platforms.md](03-target-platforms.md) | The platform landscape: Rokid Glasses/YodaOS-Sprite routes, Glass3 two-device SDK, generic Android, embedded Linux, RTOS |
| [04-compatibility.md](04-compatibility.md) | The portability boundary, the fourteen compatibility dimensions, architecture comparison, and the decision flowchart |
| [05-integration-playbooks.md](05-integration-playbooks.md) | Step-by-step playbooks: native port, compatible AIX host, Android host, companion-phone middleware, cloud/edge, Linux, RTOS |
| [06-deployment-performance-debugging.md](06-deployment-performance-debugging.md) | Deployment checklist, latency/SLO model, debugging commands, and the common-pitfalls table |
| [07-security-and-licensing.md](07-security-and-licensing.md) | Package isolation and integrity, camera/mic privacy, secrets, licensing table, recommended architectures, and next steps |
| [08-project-verification.md](08-project-verification.md) | Verification of **this repository** against the guidance above — what complies, what diverges, ranked by severity |
| [09-aiui-agent-flow.md](09-aiui-agent-flow.md) | How to **build** an AIUI `.aix` agent end to end (page-as-tool model, lifecycle, dev/validate/package/publish loop), with this repo as the worked example |
| [10-aiui-on-glasses-flow.md](10-aiui-on-glasses-flow.md) | How an agent **runs on the glasses** at runtime — install/dispatch/lifecycle/turn/updates — the usage counterpart to doc 09 (picture-first) |
| [11-aiui-on-glasses-login-flow.md](11-aiui-on-glasses-login-flow.md) | The **sign-in flow** on the glasses — code on the HUD → phone browser → confirm word → token, no app to install (picture-first) |
| [12-deploy-and-test-on-glasses.md](12-deploy-and-test-on-glasses.md) | **Deploying and testing on a real device** — the two deploys (agent + Supabase), how the agent is invoked (by name / touchpad gesture), sign-in trigger words, and current beta gotchas (from the Rokid forum) |
| [13-google-calendar-auth.md](13-google-calendar-auth.md) | _Superseded by 14._ An earlier plan to connect calendar via **direct Google OAuth** through the backend; kept for history. The shipped design authorizes calendar through Composio (see 14), so no Google Cloud client is needed |
| [14-connections-architecture.md](14-connections-architecture.md) | **The agent's shape** — built-in default functions (face/text memory) plus **connections**: external services (Google Calendar first) the wearer authorizes once through Composio, added as a registry entry rather than new auth code. The current, shipped design |
| [15-submission-review.md](15-submission-review.md) | **Ready for build & store?** — the readiness check against the three criteria (no personal information, login works for every user, all commands), what's deployed, and the pre-flight state (clean, no warnings) |
| [16-connections-hub-plan.md](16-connections-hub-plan.md) | **Connections hub plan** — evolving Kavi into a `Kavi <thing> <action>` multi-connection assistant: status/sync commands, a phone page that lists authorizations, recommended connections (Contacts×faces synergy), and the phased build. Plan only, not built |

## How this project maps onto the report

This repository is the report's recommended case: **Rokid Glasses with supported AIUI**, so it uses the native `.aix` workflow (see 02 and 07) with a **thin glasses client plus cloud services** split (see 04 and 05) — the `.aix` owns capture, consent, and rendering, while face recognition runs in Supabase Edge Functions and calendar access goes through Composio.
