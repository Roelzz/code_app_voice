# Technical guide

This guide explains the sample behind the [integration showcase](../README.md). It describes the code on `main`, not a turnkey deployment or the transport experiments in other branches. Microsoft feature and prerequisite references were reviewed on 11 November 2026; check current documentation before adapting the sample.

## Contents

- [Architecture and answer routing](#architecture-and-answer-routing)
- [Connector and identity boundaries](#connector-and-identity-boundaries)
- [Realtime voice lifecycle](#realtime-voice-lifecycle)
- [Workshop data model](#workshop-data-model)
- [Adapting the sample](#adapting-the-sample)
- [Development and checks](#development-and-checks)
- [Troubleshooting](#troubleshooting)
- [Source map](#source-map)
- [Historical and template references](#historical-and-template-references)

## Architecture and answer routing

The React application holds the workshop model and assembles bounded prompts. TanStack Query owns asynchronous connector requests; generated services route those requests through the Microsoft Copilot Managed Runtime host. The host supplies user identity and applies platform governance.

The chooser selects **one** answer source:

| Choice | Current implementation |
|---|---|
| Microsoft 365 Copilot (default) | Generated Work IQ Copilot connector; optional Microsoft 365 file-search prompting |
| Failure Mode Identifier | Published Copilot Studio specialist, invoked through its MCP channel |
| Failure Risk Prioritizer | Published Copilot Studio specialist, invoked through its MCP channel |
| Corrective Action Advisor | Published Copilot Studio specialist, invoked through its MCP channel |

Typed controls and the realtime `ask_copilot` callback use the same selected-helper session. Selection is manual; there is no automatic routing or fallback. Work IQ and Studio are alternatives, not a required chain.

The voice model is instructed to use the selected helper as the only answer source, then speak a concise version of its response. This is an application constraint, not a claim that Azure Realtime lacks reasoning capabilities.

Changing helpers or starting a new conversation stops realtime/read-aloud, clears output and resets the specialist conversation. Helper selection and conversation IDs remain in session memory. Late replies cannot replace the output of a newer conversation; an upstream timeout does not cancel remote execution.

## Connector and identity boundaries

### Generated bindings

[Microsoft's connector guidance][data] distinguishes the connector definition, authenticated connection, bound data source and generated service. Use App Builder or the supported `ms app add data-source` / `refresh data-source` tooling to generate `generated/` and app bindings. App code calls generated services, not browser-direct Graph/Power Platform HTTP requests. Do not hand-edit generated clients or transplant another app's identity.

Current main uses three connector integrations: the Microsoft 365 answer route, a custom specialist MCP connector and the voice-token broker. Agent Node channel-interception/raw-polling experiments in a separate branch are not this implementation or a supported production contract.

### Microsoft 365 answer route

`src/connectors/workiq-copilot-chat.ts` calls the generated `mcp_m365copilot` operation. It sends a JSON-RPC `tools/call` for `copilot_chat` with a unique ID and a `message`; it does not perform an MCP initialization handshake or maintain a Work IQ conversation ID.

The parser correlates the response ID, reads text content blocks, extracts the reply envelope and rejects prompt echoes. Structured suggestions must match the requested flat schema before they can be offered for addition. Connector, tool, parsing and timeout failures remain distinct safe errors, never empty successful results.

**Legacy integration:** the generated binding is the application-specific Copilot MCP surface, despite its Work IQ label. The [current Copilot MCP reference][legacy] describes these application-specific tools as backward-compatibility-only and advises against using them in new projects or production. [Unified Work IQ][workiq] is the current direction for new development; adopting it would require separate connector, authentication, contract and billing work, not a label change.

Keep licensing statements scoped to the surface being used. The existing Microsoft 365 Copilot route needs an authorized connection, the relevant Copilot entitlement and source-content permissions. Current unified Work IQ API documentation describes usage-based Copilot Credits independently of a Microsoft 365 Copilot license; that is not proof of entitlement to this legacy connector. A Studio-only integration does not universally require a Microsoft 365 Copilot license.

### Copilot Studio specialist MCP

Main calls the generated specialist connector, whose [OpenAPI](../specialist-connector/openapi.json) and [C# transport](../specialist-connector/Script.csx) restrict requests to three fixed agent paths and the `send-message` tool. It completes MCP initialization, discovers the tool once per selected conversation and supports bounded JSON or server-sent-event responses through the connector. The browser does not consume an unbounded remote SSE stream.

App-side parsing accepts only the unique matching JSON-RPC result, validates conversation GUID continuity and combines ordered text once. Plain-language clarification stays text; only complete, schema-validated failure-mode/action suggestions can expose an explicit Add action. An HTTP-200 policy rejection is still a failure.

The agents use the GitHub Copilot harness. Main uses its MCP publishing channel rather than the standard Studio invocation action that rejects that harness. This is not a statement that every harness, connector action or environment supports the same channel.

The [channel documentation][studio] requires:

- An agent published at least once and access for each calling user.
- An **early release cycle environment** where the preview MCP client channel is available. Verify the release cycle and actual channel; naming an environment "Preview" or making it a normal sandbox is not enough.
- An Entra registration in the agent's tenant and an OAuth authorization-code-capable client.
- Only the needed delegated MCP permission, `MCS.InvokeAsMCP`, with consent as required by tenant policy. A2A is a separate permission and is not required by this MCP integration.
- The client's exact redirect URI registered in Entra. Use the channel's actual endpoint and corresponding scope host; do not assume production and preproduction hosts are interchangeable.

The app's custom connector holds OAuth configuration. Secrets belong in an approved secret store/platform configuration, never the source tree. The [API properties template](../specialist-connector/apiProperties.template.json) omits secret material.

### Runtime access, licensing and policies

The [Managed Runtime SDK][runtime] is documented as preview. The [security documentation][security] separately requires deployment to a **Managed Environment**. Users need app access and any applicable environment security-group membership; sharing alone does not bypass environment access.

Current runtime licensing documentation lists **Power Apps Premium** or **Managed Application Copilot Credits** for running apps. Copilot Studio usage and Azure Realtime consumption have their own licensing/capacity considerations. Do not infer that a single license covers every part of this sample.

Review the effective environment policy and any inherited environment-group rules on both the app and agent sides. [ACP][acp] has a default-deny allowlist for covered connectors/actions, and supports MCP server-level blocking, not individual MCP-tool control. Its documented coverage currently includes certified connectors and MCP servers; custom and HTTP connectors still require classic DLP where those policies are evaluated. **Mixed mode** evaluates ACP alongside classic policies and applies the most restrictive effective rules. **ACP-only mode ignores classic policies**, without adding ACP coverage for custom or HTTP connectors; do not assume those connectors remain protected by classic DLP in that mode. The Managed Runtime data guidance also notes that classic DLP Business/Non-Business classification is not supported for apps; do not assume that classification alone governs an app's data flows.

The sample's specialist and broker custom connectors need appropriate governance review even when the underlying target speaks MCP. Do not treat ACP's MCP support as automatic coverage for every custom connector or change shared policies merely to make a demonstration work.

## Realtime voice lifecycle

### Credential and network paths

The [Azure Function](../voice-broker/function_app.py) uses `DefaultAzureCredential` with managed identity in Azure to request a short-lived Realtime client credential. Entra authentication is enforced by the Function App's Easy Auth configuration, not by an embedded browser API key. The function route's anonymous authorization level by itself does not provide that protection; retain and verify the external authentication boundary.

The broker requires `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_DEPLOYMENT`. Give the broker identity only appropriate resource-scoped inference access; the sample uses **Cognitive Services OpenAI User**, whose documented capabilities include Entra-authenticated inference. See [Azure OpenAI RBAC][rbac] and the [broker notes](../voice-broker/README.md).

The generated broker operation returns a credential, expiry, signaling URL and model. The browser validates the response, keeps the credential only transiently in memory and establishes WebRTC **directly with Azure**. The broker does not relay microphone audio or answer workshop questions.

The sample pins an exact calls URL and expected model in `src/connectors/realtime-token.ts`; changing the Azure deployment requires deliberate validation/configuration changes, not merely a new broker variable. Use the deployment name supported by your Azure resource and verify [Realtime availability and quota][realtime].

The Managed Runtime [CSP][csp] must permit the exact Azure OpenAI signaling origin in `connect-src`. Preserve enforcement and other existing rules; do not add wildcards. Browser HTTPS, microphone permission, WebRTC/audio support and permitted network routes are separate requirements. CORS/preflight success does not prove CSP, token authorization or working audio.

### Turns, tool results and cleanup

The user must select Start; merely opening the dialog does not acquire the microphone. Once connected, the session requires tool calls for questions. The application:

1. Receives `ask_copilot` arguments and correlates the call and response IDs.
2. Calls the currently selected helper with workshop context; duplicate/overlapping tool calls are rejected.
3. Waits for the helper result and the associated Realtime response completion.
4. Sends the matching `function_call_output` and creates the speech continuation with `tool_choice: "none"` to avoid repeatedly calling the tool.

Errors are spoken/reported as failures rather than replaced with another helper's answer. Main uses a hard 30-second Work IQ host limit and a 30-second app-side specialist initialization/discovery/answer wait. Automatic query retries are disabled. The app-side wait cannot extend host limits or cancel upstream execution.

Stop works during setup. Dialog dismissal, helper changes and unmount cleanup close the peer/data channel, stop microphone tracks, clear audio/timers and invalidate late work. The activity display follows real session, tool and audio events; it is not a measured audio-level visualizer.

Browser dictation and read-aloud are separate controls built on Web Speech and speech synthesis. They share audio ownership with realtime so starting one stops competing speech features. Reduced-motion and forced-colors treatments are retained.

## Workshop data model

The fictional example is a wearable vital-signs patch. State is initialized from `SAMPLE_DFMEA` and is in-memory; there is no database or collaborative persistence.

| Entity | Relationship and responsibility |
|---|---|
| `DfmeaProject` | Workshop and participants |
| `StructureElement` | System/subsystem/component tree using `parentId` |
| `DesignFunction` | Belongs to an element; includes `requirementRef` |
| `FailureMode` | Links element/function to an effect, severity and optional hazard reference |
| `FailureCause` | Carries occurrence, detection, prevention/detection controls and team-selected priority |
| `ImprovementAction` | Prevention/detection action, owner, due date and workflow status |

Severity belongs to the failure effect; occurrence and detection belong to each cause. Ratings use 1–10 scales. `RPN = severity × occurrence × detection` is shown only when all three exist. Action priority is not calculated from an invented threshold or unlicensed handbook table. Workflow status and urgency are separate.

Suggestions carry `origin: "ai"` and `reviewed: false` until team review. Voice does not automatically mutate the model. ISO 14971 hazard references support workshop reasoning, not automatic compliance. Planning fields, richer structure/function editing and reporting remain incomplete.

## Adapting the sample

Fork or clone the code to explore the interaction pattern, not to inherit the author's deployment. Before any hosted test, design your own environment, identity and data boundaries.

| Boundary | What needs deliberate adaptation |
|---|---|
| Managed application | Create an authorized app identity and use supported tooling for its generated connections/bindings; do not reuse checked-in deployment IDs |
| Studio helpers | Publish and share your own agents, verify the channel rollout and update fixed agent paths/schema references and OAuth configuration |
| Microsoft 365 route | Choose a currently supported surface, confirm entitlement/billing and validate its generated request/response contract |
| Voice broker | Provision your own authenticated Function and Azure deployment, managed identity/RBAC and connector |
| Browser validation | Align the exact endpoint/model checks, generated token response and CSP with your resources |
| Domain and data | Replace the fictional DFMEA model/prompts as needed; design persistence, retention and review controls separately |

The app's Managed Environment and the agents' early-release environment serve different purposes and need not be the same environment. Cross-environment or cross-tenant compatibility is not provisioned or guaranteed by this repository. Rebinding services does not migrate sharing, credentials, policies or business data.

## Development and checks

### Application versus platform tooling

The checked-in application uses React 19, strict TypeScript, Vite 7, Tailwind CSS 4, shadcn/Radix, TanStack Query 5 and `@microsoft/managed-apps` **0.5.11**. Its established application toolchain is **Node.js 22 LTS** (Vite 7 requires Node 20.19+ or 22.12+). Keep the lockfile/SDK pinned unless an upgrade is approved.

That is distinct from the **current Managed Runtime CLI prerequisites**, which [Microsoft lists][runtime] as Node.js LTS **24.11.0+**, Git **2.27.0+** and Git Credential Manager. Use an appropriately isolated tooling runtime; a newer CLI requirement does not silently upgrade this app's SDK or development stack. Python **3.12** and UV are used for the broker only.

With approved existing dependencies, the application's local UI loop is:

```bash
npm run dev
# http://localhost:5173
```

To restore the checked-in application dependencies when needed, use `npm ci`; it is not an instruction to change the manifest or lockfile. A plain Vite localhost server does not supply the Managed Runtime connector host. The current CLI also documents `ms app dev` for hosted-connection development; that has its own runtime, licensing and authentication requirements and is different from `npm run dev`.

Run the existing application checks:

```bash
node --test tests/*.test.mjs
npm run typecheck
npm run lint
npm run build:check
```

`build:check` validates a production build without writing output and uses POSIX environment syntax (Git Bash/WSL on Windows). The two protected-template Fast Refresh lint warnings are known. `npm run check` uses Bun to run checks in parallel; the individual npm commands above do not require Bun.

The Node tests cover helper selection and isolation, MCP parsing, token validation, voice cancellation/cleanup, tool-result sequencing and audio ownership. They mock transport or voice boundaries and are not evidence of live agent/microphone/audio acceptance.

The broker has existing Ruff/Pytest checks. Use an external environment so vendored packages are not scanned by root ESLint:

```bash
cd voice-broker
UV_PROJECT_ENVIRONMENT=/tmp/dfmea-broker-venv uv run ruff check .
UV_PROJECT_ENVIRONMENT=/tmp/dfmea-broker-venv uv run pytest -q
```

The specialist C# transport also has an SDK-only test harness, with no added NuGet packages. With an already-available .NET 10 SDK:

```bash
dotnet restore tests/specialist-connector/Check.csproj --source tests/specialist-connector
dotnet run --project tests/specialist-connector/Check.csproj --no-restore
```

### Source publication is not deployment

This public GitHub repository shares source, not a provisioned deployment binding. Current [Managed Runtime guidance][runtime] supports platform-managed Git and eligible GitHub Enterprise Cloud organization repositories; a public repository under a personal account is not automatically a supported bring-your-own deployment repository.

App Builder and the supported `ms` CLI are release paths. Any actual deployment requires authorized target access, correctly generated bindings, validation and an exact successful platform build before deployment. `pac code push` is not this app's release mechanism. This guide does not authorize a live switch, agent republish or policy change.

## Troubleshooting

| Symptom | Check |
|---|---|
| MCP client channel is missing | Confirm **Early** release cycle and actual channel rollout, not the environment's name or sandbox label |
| Specialist sign-in fails | User access, published agent, delegated MCP permission, endpoint/scope host, exact redirect URI and required consent |
| Connector is denied | Effective app/agent environment policies, inherited rules and classic DLP coverage for custom connectors; do not disable safeguards |
| Microsoft 365 helper cannot retrieve content | Connector-specific entitlement, connection identity, source permissions and legacy-surface availability |
| Broker returns 401 | Entra authentication is required; anonymous access should fail |
| Broker cannot mint a credential | Endpoint/deployment settings, managed identity, resource-scoped inference access, quota and expiry |
| Signaling is blocked | Actual app document CSP and the exact signaling origin, plus network permission; outer-player settings are not app-frame proof |
| Voice session has no audio | HTTPS, microphone/playback permission, browser WebRTC support, audio ownership and session events |
| Stop or helper switch appears ineffective | Inspect microphone-track/peer cleanup and late-result guards, not just token issuance |
| Local connector handshake times out | Plain Vite lacks the host; use an authorized Managed Runtime test surface |

Builds, generated bindings, token issuance and network preflight each prove only their own stage. A real selected-helper answer and actual microphone/playback/Stop behavior need an authorized end-to-end test.

## Source map

| Path | Purpose |
|---|---|
| [`src/data/dfmea.ts`](../src/data/dfmea.ts) | Model, rating helpers, structure traversal and fictional dataset |
| [`src/pages/home.tsx`](../src/pages/home.tsx) | Workshop UI, mutations and broker callback wiring |
| [`src/components/dfmea-ui.tsx`](../src/components/dfmea-ui.tsx) | Ratings, chain editor and semantic status/priority tones |
| [`src/components/ai-facilitator.tsx`](../src/components/ai-facilitator.tsx) | Prompts, query lifecycle, suggestions and review |
| [`src/components/helper-chooser.tsx`](../src/components/helper-chooser.tsx) | Manual four-helper selection |
| [`src/connectors/dfmea-helpers.ts`](../src/connectors/dfmea-helpers.ts) | MCP transport orchestration, conversations and single-flight guard |
| [`src/connectors/workiq-copilot-chat.ts`](../src/connectors/workiq-copilot-chat.ts) | Generated Microsoft 365 call, parsing and safe errors |
| [`src/connectors/realtime-token.ts`](../src/connectors/realtime-token.ts) | Broker response validation |
| [`src/components/voice-console.tsx`](../src/components/voice-console.tsx) | Explicit Start/Stop and activity display |
| [`src/hooks/use-realtime-voice.ts`](../src/hooks/use-realtime-voice.ts) | WebRTC, tool callback and teardown |
| [`src/hooks/use-voice.ts`](../src/hooks/use-voice.ts) | Dictation/read-aloud and shared audio ownership |
| [`generated/`](../generated/) and `ms.config.json` | Tool-owned deployment-specific clients and bindings |
| [`voice-broker/`](../voice-broker/) | Azure Function, connector OpenAPI and Python tests |
| [`specialist-connector/`](../specialist-connector/) | MCP OpenAPI, bounded transport and OAuth template |
| [`tests/`](../tests/) | Existing Node/React and C# checks |

## Historical and template references

The [operational handover](HANDOVER.md) is preserved as **historical, deployment-specific evidence**, not a universal prerequisite list or a statement of current live state. Its environment identities, release/rollback records and acceptance chronology are intentionally not repeated here.

The [App Builder template notes](app-builder-template.md) describe the original scaffold context, not a standalone reproduction guide. Read [AGENTS.md](../AGENTS.md) before changing protected app files. The [broker documentation](../voice-broker/README.md) provides component-specific notes.

[data]: https://learn.microsoft.com/en-us/microsoft-365/copilot-managed-runtime/developer/apps/connect-to-data?view=o365-worldwide
[runtime]: https://learn.microsoft.com/en-us/microsoft-365/copilot-managed-runtime/developer/apps/?view=o365-worldwide
[security]: https://learn.microsoft.com/en-us/microsoft-365/admin/manage/apps/security-compliance?view=o365-worldwide
[studio]: https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/publication-channels-mcp-agent-to-agent
[legacy]: https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-copilot-tools
[workiq]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/
[acp]: https://learn.microsoft.com/en-us/power-platform/admin/advanced-connector-policies
[rbac]: https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/role-based-access-control
[realtime]: https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/realtime-2
[csp]: https://learn.microsoft.com/en-us/microsoft-365/admin/manage/apps/governance?view=o365-worldwide#content-security-policy
