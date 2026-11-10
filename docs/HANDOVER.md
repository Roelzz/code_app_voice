# DFMEA Workshop Studio — handover for GitHub Copilot

Prepared on 10 November 2026 from the App Builder source of the app. GitHub Copilot reads `.github/copilot-instructions.md` automatically; this document holds the status, backlog, access and ALM details, and the kickoff prompt.

## 1. Status

| Item | State |
|---|---|
| Original MSIT app (untouched) | https://play.managedapps.cloud.microsoft/apps/053842df-be85-429a-b631-6c2114ab15a1 — original version, not the CAPE deployment |
| New CAPE app | [Live DFMEA Workshop Studio](https://play.managedapps.cloud.microsoft/apps/088be080-35da-497a-a83e-0b870c975893), app `088be080-35da-497a-a83e-0b870c975893` |
| Deployed release | `6b8ebc262fea43dd98389e67e109a2f3b6eade2a`; platform build succeeded and deployment identity was rechecked with `ms app info` |
| CAPE environment | User-selected `Managed_App_Deploy` (`28207d24-1fb8-e2ed-ba6e-180550d63611`), US Sandbox / westus, tenant `efb073bb-283b-4757-a252-22af963721bc`, Dataverse `https://org0630cb09.crm.dynamics.com/` |
| Previous attempted target | RRS Preview app `2bdf6ca4-4eda-419d-8df8-ea34f164028e` remains undeployed; no app or environment deleted |
| This repository | Complete migrated source and tool-generated target bindings in the separate platform-managed repository; source metadata must never replace target identities |
| Data | Fictional sample DFMEA ("Wearable vital-signs patch W2"), in memory only; it resets on every reload |
| Checks passed on this source | Type check, lint and production build |

**Built**
- 7-step AIAG-VDA process bar with a progress fact for each step.
- Structure tree (system → subsystems → components) with failure-chain counts.
- Failure network per element: effect → failure mode → causes, with filters for all chains, chains that need rating, and high-priority chains.
- Risk analysis per chain: severity, occurrence and detection on 1–10 scales, RPN, action priority, prevention and detection controls.
- Actions per cause: type, owner, due date and status.
- Add a failure mode (with function link and hazard reference); delete a failure chain.
- AI facilitator: facilitation questions, failure-mode suggestions, rating challenges, action suggestions, workshop summary and free questions; optional Microsoft 365 file search. AI content is marked "AI suggestion" until the team confirms it.
- Voice: dictation into the facilitator question box, the failure-mode fields and new actions; read-aloud of facilitator answers.
- Realtime voice client: native WebRTC voice session with `ask_copilot` routed back through Work IQ; no new browser package.
- Work IQ calls: single-flight requests, a typed 30-second host timeout and a bounded workshop-summary prompt.

**Deployed migration changes**
- AI facilitator: shorter prompts, Microsoft 365 file-search hint, typed error messages with codes, tolerant parsing of suggestion lists, conversational answers shown as text, and timeout messaging.
- Realtime voice broker infrastructure: `dfmea-voice-broker` (Flex Consumption) and `dfmea-voice-fy27` (`gpt-realtime-2.1`) are deployed in `cape-workshops-fy27` / `rg-dfmea-voice`. Managed identity has the `Cognitive Services OpenAI User` role. Easy Auth requires an Entra token; anonymous requests return 401 and an authenticated token mint returned 200.
- Realtime voice now has cancellation guards, bounded setup and Work IQ waits, complete resource cleanup, Stop during connecting, shared audio ownership with dictation/read-aloud, and explicit speech-only continuation after a Work IQ result.
- Fourteen voice-hook tests cover tool flow, response-completion ordering, cleanup, setup cancellation/restart/unmount, timeouts, safe errors and microphone ownership. Three broker-adapter tests validate the generated operation result and reject invalid/expired tokens and unexpected endpoints/models. These are not live voice E2E proof.
- The new target has fresh generated Work IQ and `DFMEA Realtime Voice Broker` SSO bindings. Its broker is wired in `HomePage` through a no-retry TanStack mutation; the ephemeral result is reset immediately, with cache garbage-collection time zero.
- The user confirmed typed Copilot returns an answer while signed into CAPE. The live voice attempt reached Azure SDP signaling after microphone acquisition and generated broker-token validation; it was blocked by the host's enforced `connect-src 'self'`.
- After the user approved a dedicated CSP-only group, the exact Azure origin was assigned through that group. A subsequent live voice retry still failed with the generic connection/network-policy error. Effective host CSP and a successful audio session remain unverified; saved policy configuration alone is not proof of enforcement.

**Not yet verified**
- Work IQ failure/timeout scenarios in the published app. A successful typed question is user-verified, but the host's hard 30-second limit still applies.
- Realtime voice end to end: the last confirmed browser blocker was CSP; the latest generic error does not establish whether the same blocker persists. Signaling preflight returned HTTP 200 with POST and the required request headers allowed, but that is not an authenticated SDP exchange or evidence of live CSP.
- A spoken question invoking Work IQ exactly once, actual returned audio, and Stop releasing the microphone in the live host. Automated lifecycle tests do not replace these checks.
- Read-aloud.

## 2. Backlog

Requested but not built yet:
1. **Planning step** — edit scope, team and roles, and rating scales.
2. **Structure and functions** — add, rename, move and delete elements; add and edit functions with requirement references.
3. **Documentation step** — export a DFMEA report for the design history file (PDF through the template's `PdfExportButton`, optionally Excel).
4. **Persistence and collaboration** — store the data model so it survives reloads and is shared by the team (Dataverse tables or SharePoint lists). The data binding is created in App Builder.

Optional ideas: action-priority suggestions from the team's licensed AIAG-VDA table, hazard import from the ISO 14971 risk file, change history and audit trail, review and sign-off, and a DFMEA portfolio view across products.

## 3. Access you need

| Access | Needed for |
|---|---|
| Edit access to the platform-managed app repository | Supported native Git/build deployment; a new GitHub repository is not required for migration |
| A GitHub Copilot licence; agent mode in VS Code, and the Copilot coding agent enabled for the repository if you want to assign issues to Copilot | Building with Copilot |
| GitHub Actions enabled for the repository | CI checks on pull requests |
| Microsoft 365 Copilot entitlement and Managed Runtime app edit access | Live AI and publishing through App Builder or supported CLI |
| Edit access to the managed app in its Power Platform environment (owner: the app's creator) | Publishing updates |
| For each user: Microsoft 365 Copilot access and their own sign-in to the Work IQ Copilot connection | Using the AI facilitator |
| A connector data policy that allows the Work IQ Copilot MCP connector (preview) in the environment | Using the AI facilitator |
| Allowed custom broker connector in `Managed_App_Deploy` | Both connectors are allowed in the new target; do not weaken RRS/group/tenant policy |
| Power Platform admin access for the exact target Managed Runtime CSP exception | Allowing `https://dfmea-voice-fy27.openai.azure.com` in `connect-src`, without weakening enforcement or other environments |

## 4. ALM — how GitHub and the live app fit together

**Develop in GitHub.** Protect `main`, work in feature branches, and require a passing CI run (type check, lint, build) and a review on every pull request. Tag each release and keep `CHANGELOG.md` up to date.

**Supported CLI release.** Managed Runtime supports native Git/build deployment; the earlier manual-App-Builder-only guidance was incorrect. Use isolated pinned CLI tooling, not an application dependency or SDK upgrade. Inspect CLI authentication flags first, use device-code sign-in, and give the user links/codes without opening their browser.

1. Reuse the CLI's protected cached login. Only if authentication is actually required, authenticate to the CAPE account with `ms auth login --device-code`, without launching a browser. Verify the tenant, environment and target app using `ms app info --json` from the target repository, not the original source checkout.
2. Work in the separate native target repository created by `ms app create`. Transfer complete source while retaining its CLI-generated target `ms.config.json` and `generated/`; never transplant source identities, connections, credentials or sharing.
3. Generate approved bindings with `ms app add data-source` / `ms app refresh data-source`. For Work IQ, the generated SSO binding uses `shared_a365copilotchatmcp`. A locally generated binding does not prove a licensed user can make a hosted call.
4. Run source checks and voice/broker tests. Commit and push to the target native Git remote without force-pushing or modifying the original repository's remotes.
5. Inspect `ms app build --help` and build the exact pushed commit. Inspect its result before `ms app deploy`. Do not switch to external-artifact upload.
6. Retrieve the actual platform URL with `ms app play --no-browser` or `ms app info`. Verify live identity and repeat CAPE Work IQ plus microphone/audio/Stop checks in the user's chosen browser. Do not claim completion from token issuance or build success.

The target repository uses a repository-local Git Credential Manager helper with `credential.credentialStore=keychain`. CLI login and native Git use distinct authentication clients. CLI authentication still works, but a noninteractive native Git lookup found no reusable credential. No further sign-in was initiated. Protected Git credential reuse is configured, not proven; do not claim a token was persisted or create a long-lived credential. Never put tokens in repository files or logs. Ignore the CLI's `.ms/` schema cache: generated signed icon URLs in that cache triggered the native secret scanner. The clean release history excludes the cache; never bypass the scanner or reuse the rejected local commit history.

**Verify realtime voice.** The selected target already has both generated SSO bindings and broker wiring. Do not create duplicates. OAuth secrets stay in private deployment artifacts, never source, browser storage or logs. Preserve enforced Managed Runtime CSP. The approved exact signaling origin is already saved in the dedicated group policy below; investigate its effective runtime application before adding or changing any rule. Code Apps CSP keys are not interchangeable with Managed Runtime. If available diagnostics cannot isolate the remaining failure, report voice as limited rather than claiming completion.

**Migration identities and task-owned governance changes (10 November 2026).**

| Item | Recorded value / delta |
|---|---|
| Selected target platform repository | `d1d3cd61-ab84-4863-b6e2-720b38eee6eb` in `Managed_App_Deploy` |
| Selected target broker connector | Dataverse ID `84cbbbe5-02dd-f111-84ea-70a8a5afa0bc`; catalog name `shared_new-5fdfmea-20realtime-20voice-20broker-5fcb638419537c7c20` |
| Selected target baseline | Initially Basic protection, outside environment groups, no assigned ACP policy; all six existing classic DLP policies scoped only to other environments |
| Approved Managed Environment delta | Protection changed from `Basic` to `Standard` solely to support the approved dedicated CSP-only environment group |
| Dedicated group | `Managed_App_Deploy_CSP`, `a4af58d4-d70a-411f-a8e1-43af08ab72fd`; only `Managed_App_Deploy` was added; no ACP/DLP rules added |
| CSP-only policy | `0ea9b73c-d80e-4ecf-a8a0-0a74450be1ab`, assigned only to that group; one `MicrosoftAppsContentSecurityPolicy` rule, version `1.0`, enforcement enabled |
| Exact CSP addition | `MicrosoftAppsContentSecurityPolicyConfiguration` = `{"Connect-Src":{"sources":[{"source":"https://dfmea-voice-fy27.openai.azure.com"}]}}`; reporting endpoint remains null; no other directives changed |
| CSP verification limit | Policy GET, group assignment and environment membership confirmed. Direct environment assignments return an empty list; the direct assignment write route returns `RouteNotFound`. Live voice retry still fails. Effective host policy is not verified |
| Earlier RRS repository / connector (retained) | Repository `0bc830cc-420e-4116-8fb9-5675329ba576`; connector `9e62ae16-00dd-f111-84e7-000d3a5a4f90` / `shared_new-5fdfmea-20realtime-20voice-20broker-5f327b36021f5f52f3` |
| OAuth client | `9b6207c4-ca6f-46c5-a75c-04b5387c2822` |
| OAuth redirects added | `https://global.consent.azure-apim.net/redirect/new-5fdfmea-20realtime-20voice-20broker-5f327b36021f5f52f3` (RRS) and `https://global.consent.azure-apim.net/redirect/new-5fdfmea-20realtime-20voice-20broker-5fcb638419537c7c20` (selected target); original `https://global.consent.azure-apim.net/redirect` preserved |
| RRS-only policy | `64fef678-1412-4aa2-acd9-59b3cfa67019`, assigned only to RRS |
| Policy delta | Added the broker catalog API to `ConnectorManagement` with `SomeAllowed` actions: `RequestRealtimeToken`; all other entries preserved |
| Observed effective result | Policy GET includes 1,763 connectors, but authenticated environment runtime still includes only 1,762 and excludes the broker |
| Inherited CAPE policy | `097451f3-f3bd-48d3-b37f-c4268cdc1550`, group `2d473c99-5925-4845-93f4-80a586cf2fa3`: **not changed** |
| Existing group/tenant policies, sharing, original MSIT app/remotes | **Not changed**, apart from the separately recorded earlier RRS-only broker entry |
| Deployed target rollback reference | `6b8ebc262fea43dd98389e67e109a2f3b6eade2a`: successful platform build and user-confirmed typed Copilot; **not** a voice-verified release |

RRS enforces `AdvancedConnectorPoliciesOnly`. [Current ACP documentation](https://learn.microsoft.com/en-us/power-platform/admin/advanced-connector-policies) says custom connectors are not yet supported; an accepted allowlist PATCH was not evidence of runtime permission. A documented policy-assignment POST also returned `RouteNotFound`. The user then explicitly requested creation and deployment in the separate `Managed_App_Deploy` environment. Provisioning succeeded without changing existing governance, and connector discovery plus generation confirms both target connectors are allowed. Never assume a new environment is exempt from future tenant policies.

Pre-change environment, RRS policy, parent policy, group inventory and assignment snapshots are held privately in the migration session's `files/` artifacts, along with the exact CSP request and saved responses. Code rollback redeploys the recorded exact target commit through the platform's native build/deploy flow; it does not repair the unresolved voice limitation. Governance rollback requires re-reading live state and removing only this task's CSP assignment/membership and exact RRS broker entry, preserving concurrent changes. Reverting Managed Environment protection requires an authorized administrator's supported procedure and must not remove unrelated controls. Restore only task-owned OAuth redirect additions if required. Do not replace entire policies, delete apps/data/resources or undo unrelated administrator work.

References: [CLI commands](https://learn.microsoft.com/en-us/microsoft-365/copilot-managed-runtime/developer/apps/ms-cli-command-reference?view=o365-worldwide), [generated data sources](https://learn.microsoft.com/en-us/microsoft-365/copilot-managed-runtime/developer/apps/connect-to-data?view=o365-worldwide), [Managed Runtime governance](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/apps/governance?view=o365-worldwide), [Managed Runtime CSP](https://learn.microsoft.com/en-us/microsoft-365/copilot-managed-runtime/developer/apps/content-security-policy?view=o365-worldwide).

**Separate test and production before real use.** `Managed_App_Deploy` is the user-approved migration target, not a medical-device production validation. Any persistence or additional environment/data migration requires its own approved scope.

## 5. Medical-device quality notes

If real DFMEA records will feed a design history file, treat the app as quality-system software:
- Validate it before production use (ISO 13485 clause 4.1.6), with traceability from requirements to tests.
- Add an audit trail, access control and electronic record and signature controls where 21 CFR Part 11 applies.
- Plan backup, retention and export of records.
- Keep AI suggestions marked and human-reviewed (already modeled with `origin` and `reviewed`), and keep prompts within your organization's Copilot data policies.
- Voice input uses the browser's online speech service (Microsoft for Edge, Google for Chrome); confirm this is acceptable for confidential design data.

## 6. Kickoff prompt

Paste this into GitHub Copilot Chat in agent mode, or use it as the task for the Copilot coding agent. Replace `@your-github-handle` first.

```text
You are continuing development of DFMEA Workshop Studio, a React 19 + TypeScript + Vite 7 web app that runs Design FMEA workshops (AIAG-VDA method, ISO 14971 hazard links) with an AI facilitator powered by Microsoft 365 Copilot. It runs as a Managed Runtime app; supported publishing includes App Builder and the ms CLI native Git/build workflow. Read the migration status before assuming CAPE deployment or voice verification is complete.

Before changing anything, read .github/copilot-instructions.md, docs/HANDOVER.md and AGENTS.md. Then reply with a five-bullet summary of the architecture, the data model and the rules you must follow.

Then work through these steps, one pull request per step. Every pull request must pass npm run typecheck, npm run lint and npm run build:check.

1. ALM baseline
   - Add .github/workflows/ci.yml that runs on pull requests and on pushes to main: Node 22, npm cache, npm ci, npm run typecheck, npm run lint, npm run build:check.
   - Add .github/pull_request_template.md with a checklist: checks pass; accessibility preserved; no edits to generated/, ms.config.json, build configuration or LOCKED files; AI content marked and reviewed; docs/HANDOVER.md updated.
   - Add .github/CODEOWNERS with @your-github-handle as owner of everything.
   - Add CHANGELOG.md with an "Unreleased" section listing the unpublished changes from docs/HANDOVER.md section 1.
2. Backlog
   - Create one GitHub issue per backlog item in docs/HANDOVER.md section 2, each with a user story, acceptance criteria and test notes. If you cannot create issues, write them to docs/BACKLOG.md instead.
3. Plan the next feature
   - Propose an implementation plan for backlog item 2 (structure and function editing) on the existing data model in src/data/dfmea.ts: components to change, state mutations, keyboard and screen-reader behaviour, and edge cases such as deleting an element that still has failure modes or child elements. Wait for my approval before writing code.

Constraints: don't edit generated/, ms.config.json, build configuration or LOCKED files; don't add or upgrade dependencies without asking; don't invent DFMEA rating thresholds or tables; keep AI suggestions marked until the team reviews them; never show raw connector error text in the UI.
```
