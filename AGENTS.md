# App scaffold — AGENTS.md

React 19 + TypeScript + Vite 7 app from the Aether App Builder template — offline sandbox. When unsure of an import path, prop, or return type, read `node_modules/` or a neighbor in `src/` rather than reciting from memory (shadcn / Radix / TanStack / Tailwind APIs shift across versions).

## Dependencies

Pre-installed in a read-only `node_modules/` — compose the pre-built shadcn `@/components/ui/*` (merge a primitive onto your own element with `asChild`), don't reimplement. Version-specific facts you won't reliably guess:

- **react-router-dom** 7 — routes live in `src/routes.tsx` (see Structure).
- **zustand** 5 — one store in `src/lib/store.ts` (`useAppStore`, narrow selector).
- **@tanstack/react-query** 5 — every network/IO call; client `src/lib/query-client.ts`. v5 object API (`useQuery({ queryKey, queryFn })`, no `onSuccess`). An initially disabled query with no data has `isPending: true` but `isFetching: false`; use `isFetching` to disable a search/submit button while its query runs, not `isPending`, which can prevent the first request.
- **@tanstack/react-table** 8 — grids via `useReactTable` + `getCoreRowModel`.
- **leaflet** 1.9 + **@types/leaflet** — Spatial maps only through `@/components/spatial-map` (see Capability controls).
- **recharts** 3 — chart **primitives** (`<BarChart>`, `<Bar>`, `<XAxis>`, …) import from `recharts`; the shadcn **wrappers** (`ChartContainer`, tooltip, legend) from `@/components/ui/chart`. 3.x API, not v2. `ChartContainer` is `w-full` by default and Recharts sizes the chart from that box, so a chart sized only by a height or `aspect-*` class fills its container's width. To keep a chart narrower, give it an explicit width: `max-w-[250px] mx-auto` for a centred pie, donut or radial chart, `w-20 shrink-0` for a small gauge beside a label in a row. Never set `w-fit`, or `w-auto` with `mx-auto`: the box shrinks to its content, which is 0px, and the chart renders blank.
- **@dnd-kit/core** + **/sortable** — drag-reorder / kanban (not the HTML5 drag API).
- **react-day-picker** 9 + **date-fns** 4 — calendar via `@/components/ui/calendar`; date math via per-function `date-fns` imports.
- **signature_pad** 5.1 — only through `@/components/pen-input` (see Capability controls).
- **lucide-react** 1.x — icon names shifted at 1.x; grep `node_modules/lucide-react/dist/lucide-react.d.ts` if an import fails.
- **sonner** — toasts (`<Toaster/>` + `toast()`). **cmdk** — command menu. **cn()** (`@/lib/utils`) — merge classes.
- **xlsx** 0.18 / **unpdf** 1.x — client-side Excel/CSV + PDF text (see Conventions → File uploads); PDF page rendering only through `@/components/pdf-viewer` (see Capability controls).
- **html2canvas-pro** 2.4 + **jsPDF** 4.2 — PDF export only through `@/components/pdf-export-button` / `@/lib/pdf-export` (see Capability controls); distinct from `unpdf`, which reads existing PDFs.
- **react-webcam** — only through `@/components/camera-capture` (see Capability controls).
- **@zxing/library** 0.23 — only through `@/components/barcode-scanner` (see Capability controls).
- **three** 0.186.1 (exact pin) — to show a model file only through `@/components/model-viewer` (see Capability controls); never import a `three/*` subpath such as a loader (ESLint blocks it). Core `three` (`import * as THREE from "three"`) is allowed for procedural 3D scenes and games the viewer cannot do; see "3D scenes and games" below.
- **@microsoft/managed-apps** — live M365 connector runtime. `generated/` (app root, sibling of `src/`; read-only — do not edit) holds the typed client and exists only in an app that carries a data-source binding; the runtime's typed `appbuilder-DataSourceAdd` tool is the only thing that adds a binding and generates it, `appbuilder-DataSourceRefresh` regenerates it for a binding the app carries, and `appbuilder-DataSourceRemove` deletes it (a connector's actions, or one table of any tabular connector — SharePoint list, SQL table, Dataverse table; only a SQL stored procedure as a data source is not offered). Spatial requests fail closed when no binding is available; for other sources, an app without one builds on realistic sample data. Never add sample/demo/mock/test-data provenance copy or UI treatment to the app; disclose each affected dataset or entity only in authoring chat. The one exception is `<ModelViewer>`'s built-in "Sample model" badge (see Capability controls), which marks a placeholder model the user replaces with their own file.
- **tailwindcss** 4 — config-less; palette = CSS vars in `src/index.css` (see Theming).

## Structure

```
src/
├── App.tsx              Providers + router (BrowserRouter basename, QueryClientProvider, ErrorBoundary, ConfirmDialogProvider, AppShortcutProvider). LOCKED — don't edit.
├── main.tsx             Entry. LOCKED — don't edit.
├── routes.tsx           SINGLE source of truth for routes (+ nav label/icon). Add a page = ONE entry here.
├── index.css            Tailwind import + design tokens (oklch CSS vars). Theme here on build or restyle (see Theming).
├── components/
│   ├── app-shell.tsx        Minimal shell (owns the only min-h-screen, mounts <Toaster/>). Ships NO nav — add one per the app.
│   ├── barcode-scanner.tsx  <BarcodeScanner onScan={…}/> — live QR/barcode scan + photo-upload fallback (see Capability controls).
│   ├── camera-capture.tsx   <CameraCapture onCapture={…}/> — live viewfinder + file-picker fallback (see Capability controls).
│   ├── model-viewer.tsx     <ModelViewer source={…}/> — glTF/GLB/OBJ/STL 3D viewer (see Capability controls). LOCKED.
│   ├── error-boundary.tsx   App-level boundary (wired in App.tsx). Emits a fixed, detail-free crash signal to the host on render errors — LOCKED.
│   ├── connector-policy-banner.tsx App-wide one-line "blocked by your organization's policy" banner at the bottom of the page; "See more" names the blocked connectors (mounted in main.tsx). LOCKED.
│   ├── confirm-dialog.tsx   <ConfirmDialogProvider> backing useConfirm().
│   ├── states.tsx           <EmptyState> / <ErrorState> / <LoadingState>.
│   ├── page-section.tsx     <PageSection> — heading + description + action + spacing.
│   ├── spatial-map.tsx      Protected Spatial Services map renderer — LOCKED, don't edit.
│   ├── internal/
│   │   └── spatial-tile-layer.ts Protected Spatial tile scheduler — LOCKED, don't edit.
│   ├── pdf-export-button.tsx <PdfExportButton> — bounded PDF download + optional connector-neutral callback. LOCKED.
│   ├── pdf-viewer.tsx       <PdfViewer loadPdf={…}/> — bounded read-only PDF viewer (pages + zoom). LOCKED.
│   ├── pen-input.tsx        <PenInput> — bounded pen/drawing input; app code owns saving. LOCKED — don't edit.
│   ├── shortcut-provider.tsx APP_SHORTCUTS, useAppShortcut, ShortcutScope, ModalShortcutBoundary. LOCKED — don't edit.
│   └── ui/                  shadcn/ui (new-york, Radix). Pre-installed — don't reimplement.
├── hooks/
│   ├── use-confirm.ts       useConfirm() — async confirm(): Promise<boolean>. Use instead of window.confirm.
│   └── use-mobile.ts        useIsMobile().
├── lib/
│   ├── utils.ts             cn().
│   ├── store.ts             zustand store (useAppStore) — first choice for global state.
│   ├── query-client.ts      shared TanStack Query client.
│   ├── pdf-export.ts        createPdfBlob() + PdfExportResult. LOCKED.
│   ├── pdf-bytes.ts         decodePdfBytes() + MAX_PDF_BYTES — bounded PDF byte validation. LOCKED.
│   ├── safe-url.ts          safeUrl() — allowlist URL schemes before rendering links from untrusted/connector data.
│   ├── pen-input-value.ts   PenInputValue validation and PNG-to-Blob conversion. LOCKED — don't edit.
│   ├── barcode-scan.ts      BARCODE_TYPES, detector/decoder loading, scan dedupe, toSafeHttpUrl(). Only file allowed to import @zxing/library.
│   ├── model-load.ts        Model format detection, size/URL checks, three.js loading and stage setup. Only file allowed to import three subpaths (loaders). LOCKED.
│   ├── spatial-tile-bytes.ts Protected binary tile validation and CSP-safe rendering — LOCKED, don't edit.
│   ├── console-capture.ts   Infra — LOCKED, don't edit. Also exports reportPrivateRuntimeError (private diagnostics only).
│   ├── connector-policy-monitor.ts Infra — LOCKED, don't edit. Watches the host's request metrics for a DLP/ACP block (HTTP 442) on any connector, reads the connector name from the request's `/apim/<connector>/` path, and raises the banner.
│   ├── cowork-parent-transport.ts  Infra — LOCKED, don't edit. Fixed, detail-free crash signal to the Cowork host.
│   ├── app-mounted-transport.ts    Infra — LOCKED, don't edit. Fixed-shape first-paint signal to the Cowork host.
│   ├── app-view-transport.ts       Infra — LOCKED, don't edit. Bounded app-view snapshot to the Cowork host.
│   ├── preview-camera-bridge.ts    Infra — LOCKED, don't edit. Dev-preview getUserMedia through the Cowork host's camera.
│   ├── app-view-serializer.ts      Infra — LOCKED, don't edit. Accessible-name tree + route pattern; decides the app-view bound.
│   └── app-view-signal.tsx         Infra — LOCKED, don't edit. When the app-view snapshot is taken (mounted by App.tsx).
├── pages/
    ├── home.tsx             Home ("/") route. Rewrite in place; MUST keep `export function HomePage()` (routes.tsx imports it by name — renaming or `export default` only blanks the preview).
    └── not-found.tsx        404.
└── types/
    └── app-message.ts       Infra — LOCKED. Fixed parent-frame message contract.
```

`@/` → `src/`. Single-screen app → rewrite `home.tsx` in place (don't add a page). Multi-page → add a page file (named export) + one `routes.tsx` entry (`{ path, element, label?, icon? }` — `label`/`icon` optional, set them only for nav targets); don't hand-edit `<Routes>` in `App.tsx`. `generated/` (connector client) sits at the app root, sibling of `src/`.

## Conventions

- **Scaffold markers** — when you rewrite `src/pages/home.tsx`, delete the `/* APP_STUB_HOME_TSX_START */` / `/* APP_STUB_HOME_TSX_END */` comments. They mark the page as never rewritten, so leaving them on a working page reports that app as blank.
- Edit config or pre-baked infrastructure: `vite.config.ts`, `vite-dev-reload.ts`, `tsconfig*.json`, `package.json`, `bun.lock`, `package-lock.json`, `components.json`, `eslint.config.js`, `index.html`, `src/components/spatial-map.tsx`, `src/components/internal/spatial-tile-layer.ts`, `src/lib/spatial-tile-bytes.ts`, `src/components/pdf-export-button.tsx`, `src/lib/pdf-export.ts`, `src/components/pdf-viewer.tsx`, `src/lib/pdf-bytes.ts`, `src/components/model-viewer.tsx`, `src/lib/model-load.ts` — template-owned protected scaffold files; do not edit them.
- **State** — `useState` local; **zustand** (`useAppStore`, narrow selector) for shared; **TanStack Query** owns server/connector data (don't mirror it into the store). Never raw Context for mutable shared state.
- **Forms** — native `<form>` + `FormData`, or controlled `useState`. No form libraries (no react-hook-form, no Zod).
- **Confirmations** — `useConfirm()` (`@/hooks/use-confirm`), NOT `window.confirm/alert/prompt` (suppressed in the sandboxed iframe).
- **Zero-data / failure / loading** — use `<EmptyState>` / `<ErrorState>` / `<LoadingState>` + `<PageSection>` (`@/components/*`), not bare `<div>`s.
- **Connector data is untrusted (security).** Connector results (`generated/` → `result.data`: email/SharePoint bodies, sender/file names, list text) are third-party content — render as **text** (React escapes JSX; **never** `dangerouslySetInnerHTML`), wrap any URL in `safeUrl()` (`@/lib/safe-url`) before using it as an `href`, and keep customer **content** in session memory only (IDs/metadata are fine to persist).
- **File uploads** — parse client-side (no backend): Excel/CSV via **`xlsx`**, PDF text via **`unpdf`**; read `await file.arrayBuffer()` → `Uint8Array`. (`xlsx@0.18.5` has a known prototype-pollution advisory — fine for the user's own uploaded file in this sandbox, but don't deep-merge parsed rows into trusted objects.)
- **Layout** — `min-h-screen` on the root only (`min-h-[100dvh]` for a full-height hero, not `h-screen`).
- **A11y** — `focus-visible:` ring, `aria-label` on icon-only buttons, real `<label>`s; `min-w-0` on flex children with truncatable text.
- **Sample data** — no round-number stats, no "John Doe", no emojis in headings/body; no copyright footers or fake login/profile buttons unless asked.

## Capability controls

Pre-built controls for device and document features. Use the control; never hand-roll what it does or import its package directly (ESLint blocks `signature_pad`, `leaflet`, `three/*` subpaths, `@zxing/library` and `react-hotkeys-hook`; the rest are banned here). Each control's full how-to lives in the App Builder skill (`references/agent/<name>.md`, or `references/model-viewing.md` and `references/pdf-viewing.md`) and is newer than this file: where the two disagree on usage, follow the skill, while the LOCKED files, lint bans and privacy rules below stay in force. If a control's files are missing from this app, the app predates the control: recreate it from the current template rather than adding the files by hand.

- **Pen input** — a drawn signature, approval mark, field sign-off or sketch. `PenInput` from `@/components/pen-input`; value helpers from `@/lib/pen-input-value`. LOCKED: `src/components/pen-input.tsx`, `src/lib/pen-input-value.ts`. Never import `signature_pad`, add pointer, mouse or touch drawing handlers on a canvas, or register global pointer, mouse or touch listeners; any other canvas must carry `data-aether-canvas-purpose="non-drawing"` on a JSX `<canvas>` or a recognized React `createElement("canvas", …)` call (`bun run check` enforces this). App code owns saving; keep the drawing in session memory, never in `localStorage`, logs, URLs, analytics or parent-frame messages. When a drawing is required, block submission unless the value is non-null and `onValidityChange` reported true; validate again at the app-owned save boundary. Skill: `pen-input.md`.
- **Camera capture** — inspections, receipts, ID or asset photos. `<CameraCapture onCapture={…} />` from `@/components/camera-capture`. Never import `react-webcam` or hand-roll `getUserMedia`, `<video>` or `<canvas>` capture. The live camera works in a published app and in design-time preview once the user allows the Cowork host's camera prompt; otherwise it shows the file-picker fallback. Never word app copy as if publishing is required for the camera. Skill: `camera-capture.md`.
- **Barcode scanning** — QR codes and barcodes: asset tags, inventory, tickets, check-in, product lookup. `<BarcodeScanner barcodeTypes={[…]} onScan={…} />` from `@/components/barcode-scanner`, with `barcodeTypes` narrowed to the codes needed; only `src/lib/barcode-scan.ts` may import `@zxing/library`. Scanned values are untrusted text: validate them before a lookup, pass a URL through `toSafeHttpUrl()`, never auto-open one. Live scanning works in preview and published apps when the camera is available; otherwise it offers photo upload. Skill: `barcode-scanning.md`.
- **3D models** — glTF/GLB/OBJ/STL product, part, CAD or scan previews. `<ModelViewer source={…} />` from `@/components/model-viewer`; `decodeModelBytes` from `@/lib/model-load` for connector bytes. LOCKED: `src/components/model-viewer.tsx`, `src/lib/model-load.ts` (the only file allowed to import `three/*` subpaths). Never commit user-attached model files into app source or `src/assets`; keep attached model bytes in browser memory and pass them directly to the viewer. Its built-in "Sample model" badge is the one allowed sample marker. Skill: `model-viewing.md`.
- **Spatial maps** — geographic maps, address search, location finders, geocoded markers, geographic pan/zoom (not charts, diagrams, image pan/zoom or timelines). `SpatialMap`, its DTOs and `SpatialTileLoader` from `@/components/spatial-map`, with a usable Spatial Services binding; fail closed without one. LOCKED: `src/components/spatial-map.tsx`, `src/components/internal/spatial-tile-layer.ts`, `src/lib/spatial-tile-bytes.ts`. Never import `leaflet` directly, embed a provider key or supply a `subscription-key`, and never send connector-derived addresses, coordinates or tile bytes to public geocoders, public tile providers, logs, analytics, `console.*`, `localStorage`, URLs or parent-frame messages. Never persist tile bytes or create Blob URLs for them. A custom map control the user explicitly asked for is a new component under the same bans. Skill: `spatial-map.md`.
- **PDF export** — download a report, form, certificate or other visible result. `PdfExportButton` from `@/components/pdf-export-button` (or `createPdfBlob` from `@/lib/pdf-export`) on a ref to the app-owned screen; no second PDF-only component tree. LOCKED: `src/components/pdf-export-button.tsx`, `src/lib/pdf-export.ts`. Use only app-local, data, blob, or same-origin image and font resources; remote cross-origin resources are rejected even when they advertise CORS. Keep `iframe`, `object`, `embed`, `video`, `audio`, `link`, image-input elements, custom elements, shadow roots and inline event-handler attributes out of included capture content; the helper rejects unsupported or executable content. Never claim the PDF was saved until the connector call succeeds, and never log raw connector errors or bytes. Skill: `pdf-export.md`.
- **PDF viewing** — show an existing PDF. `<PdfViewer loadPdf={…} title="…" />` from `@/components/pdf-viewer`. LOCKED: `src/components/pdf-viewer.tsx`, `src/lib/pdf-bytes.ts` (the 25 MB cap). Load bytes through the owning connector or local upload, never a URL in an `iframe`, `object`, `embed`, link or `window.open`; never import `unpdf` or `pdfjs-dist` to render pages; keep the bytes in session memory and never log raw connector errors or bytes. Skill: `pdf-viewing.md`.
- **Keyboard shortcuts** — command palette, search, list navigation, new item, save. `useAppShortcut(binding, handler, options)` with `APP_SHORTCUTS` from `@/components/shortcut-provider` (LOCKED). A plain key needs a `useShortcutScope` scope; never bind a combo the browser or OS keeps; never add raw `keydown`/`keyup` listeners or `onkeydown` assignments on `document`/`window`, JSX `onKeyDown` or `react-hotkeys-hook`. Skill: `keyboard-shortcuts.md`.

## 3D scenes and games

When the user asks for something the viewer cannot do, such as a 3D game, a
procedural scene or an interactive simulation, use real three.js instead of
faking depth with CSS transforms or SVG. To show a model file, still use
`<ModelViewer>` (above).

- Import core `three` only (`import * as THREE from "three"`). `three/*`
  subpaths (loaders, `examples/jsm`, `addons`) are blocked by ESLint, so build
  geometry from three's built-in primitives.
- Render into a JSX `<canvas data-aether-canvas-purpose="non-drawing">`
  through a ref: `new THREE.WebGLRenderer({ canvas: ref.current })`. Never
  let the renderer create its own canvas. Never put pointer, mouse or touch
  handlers on the canvas; put them on a wrapping `<div>`.
- Keys go through `useAppShortcut` with `{ scope, allowRepeat: true }`, using
  the `scope` from `useShortcutScope`. Spread `scope.bindings` on the wrapper
  and give it `tabIndex={0}`.
- Run one `requestAnimationFrame` loop in an effect. On unmount, cancel it
  and dispose the renderer, geometries and materials. Resize with a
  `ResizeObserver` on the wrapper.

## Theming

Grayscale by default — **every build adds color.** Single theme unless the user asks for dark mode. Turn-1 builds select one validated hue preset directly from the stable app UUID from `/opt/appbuilder/templates/v1/THEMING.md`. Paste the hue into all three `index.css` token blocks (surfaces stay neutral), set `--radius` to suit the app, then accent inline with Tailwind utilities. **Turn-1 builds AND restyle / recolor iterates → prefer the current paste-able presets in `/opt/appbuilder/templates/v1/THEMING.md`; use the app-local `THEMING.md` only as a legacy fallback because template snapshots are not refreshed after creation** (retheme the `src/index.css` token blocks; don't derive OKLCH by hand).

**Tailwind v4 (config-less).** No `tailwind.config.js` — everything is in `src/index.css` (`@import "tailwindcss";`, tokens in `:root`/`.dark`, `@theme inline { --color-*: var(--*) }` maps vars → utilities). **Adding a token needs BOTH the `:root`/`.dark` var AND its `@theme` `--color-*` mapping** (a var with no mapping renders nothing). v3 habits that silently break: `bg-opacity-50`→`bg-black/50`, `shadow`→`shadow-sm`, `outline-none`→`outline-hidden`.


## Parent-frame message contract (LOCKED)

The preview runs inside an embedding **Cowork host** iframe. Hand-written template source has five parent-frame channels, all owned by infra files you must not edit:

- **Console forwarding** (`console-capture.ts`, unchanged legacy behavior): mirrors `console.log/warn/error` to the host preview panel. This is the existing, general channel. It resolves its target origin at runtime (env override → `ancestorOrigins` → same-origin fallback) — that resolution is grandfathered legacy behavior and must not be copied into new channels.
- **Runtime-error signal** (`cowork-parent-transport.ts`): a **fixed, detail-free** crash signal, sent by the ErrorBoundary for caught render crashes or by React's root `onUncaughtError` hook for uncaught root crashes.
- **App-mounted signal** (`app-mounted-transport.ts`): a **fixed-shape, detail-free** first-paint signal (`{ type: "app-mounted", timestamp }`), sent once from `main.tsx` after the first `requestAnimationFrame` following the initial render commit, so the host can measure real load latency instead of inferring it from the iframe's `load` event.
- **App-view snapshot** (`app-view-transport.ts`, fed by `app-view-serializer.ts` and scheduled by `app-view-signal.tsx`): a **bounded** report of what the user can see (`{ type: "app-view", v: 1, timestamp, route, tree, truncated }`), so the agent can ground on the screen the user is asking about. This is the ONE channel that carries app content by design. Its bound is the serialiser: `route` is the matched route PATTERN from `routes.tsx` (never the pathname, never params); `tree` is an accessible-name tree — roles, accessible names and visible text, one node per line, two spaces of indent per depth, `role: name` for elements and `"text"` (quoted) for text leaves so a parser can tell the two apart — with no attributes, no form-control values (a value-bearing control — `input`, `textarea`, `select`, `option`, `output`, `progress`, `meter` — never contributes to a computed name, so a wrapping `<label>` names it without its value, and a `contenteditable` region is a `textbox` control whose body never crosses), no link targets, no image sources, no ids/classes/`data-*`, no hidden subtrees (a hidden `<label>` or `aria-labelledby` target names nothing; CSS `display:none`/`visibility:hidden` count as hidden), cut at whole lines to 24,000 characters and capped in depth (transparent containers count toward the depth bound too) and node count. The serialiser reads DOM properties through exactly two casts (`.checked`, `.labels`), pinned by the guard; every other read is an allow-listed attribute. Emitted on the preview mount only (the orchestrator-baked `/v1/…` base; a deployed app never observes or posts), after a route change or a settled DOM mutation anywhere in `document.body` (so an open dialog, sheet or menu is in the tree), rate-floored, never on a timer alone; the host keeps only the latest and forwards it under the user's consent. Never emitted top-level.
- **Preview camera bridge** (`preview-camera-bridge.ts`, installed from `main.tsx` in dev only): replaces `navigator.mediaDevices.getUserMedia` for video-only calls so the camera components work in the preview. The app posts a **detail-free** request (`{ type: "cowork-camera/request", version: 1, requestId }`, a random id and nothing else); the host shows its own consent, and on Allow transfers a `MessagePort` over which it streams camera frames (the app acks each and sends `stop` when its last track stops). Replies are accepted only from `window.parent` at a `COWORK_PARENT_ORIGINS` origin. Nothing about the app crosses to the host. With no host answer within one second, every later call uses the browser's own `getUserMedia`; audio always does. Never installed top-level or in a published build.

**The runtime-error signal is immutable.** Both emitters call `postAppRuntimeErrorToCoworkParent()` with **no arguments**, and the template emits exactly:

    { type: "preview-error", code: "APP_RUNTIME_ERROR" }

Cowork receiver support for `APP_RUNTIME_ERROR` lands separately; until then,
the host safely ignores this code and its generic crash UI remains inactive.

**The app-mounted signal carries exactly one dynamic field.** `postAppMountedToCoworkParent()` takes **no arguments** and emits exactly:

    { type: "app-mounted", timestamp: <Date.now() at call time> }

`timestamp` is a clock reading, never customer content, route, URL, token, or `appId`.

Cowork's host-side listener for `{ type: "app-mounted" }` merged in `bic/cowork` PR #8401 (app-studio#2979 client-preview telemetry).

Hard rules (a security review depends on these; the Aether repo enforces them with `aether_runtime/tests/unit/app_builder/test_template_runtime_error_security.py`):

- **No dynamic data crosses to the parent** from the runtime-error or app-mounted paths beyond the single `timestamp` field above — no error `name`/`message`/`stack`, no React component stack, no route, URL, token, `appId`, or customer content. The app-view path is the only exception, and only within the serialiser's allow-list: a route PATTERN and the accessible-name tree. Nothing else — never `location.href`, never a form value, never an `appId`, never a token — may be added to that envelope; widening it is a security review, not an edit. `reportPrivateRuntimeError` writes to the pre-capture console implementation and makes a best-effort POST to `./__dev/console`; the runtime preview proxy forwards that POST to the dev server (#24067), but the channel stays best-effort — the log is absent until the first report lands and a restarting dev server drops reports — so repair logic must not assume `.browser-errors.log` exists.
- **No wildcard target origin.** `cowork-parent-transport.ts`, `app-mounted-transport.ts`, `app-view-transport.ts` and `preview-camera-bridge.ts` post their messages to the SAME **explicit allow-list** of Cowork host origins (`COWORK_PARENT_ORIGINS`, exported from `cowork-parent-transport.ts`) and rely on Cowork pinning `event.source` to this iframe. Adding a supported host requires updating both that list and `EXPECTED_PARENT_ORIGINS` in the security guard — never add `"*"`, a suffix match, or a runtime-derived origin (`ancestorOrigins`, `document.referrer`, `location.origin`).
- **Top-level is a no-op.** When not embedded (`window.parent === window`), each sender does nothing.
- **Do not add another hand-written post-to-parent path.** In `src/`, `window.parent` / `window.top` / `postMessage` may appear only in the five transport infra files (`console-capture.ts`, `cowork-parent-transport.ts`, `app-mounted-transport.ts`, `app-view-transport.ts`, `preview-camera-bridge.ts`). `app-view-serializer.ts` and `app-view-signal.tsx` never touch the parent; they only prepare and schedule the snapshot. New app code must never message the parent, and must never read the DOM to build a payload for the host — the serialiser is the one reader.
- **Bundled dependencies are outside this source contract.** In particular, `@microsoft/managed-apps` may transfer its connector `MessagePort` to the embedding host with a wildcard target origin on the no-bridge authoring path. The Aether source guard does not inspect dependency bundles and must not be treated as proving that only these five channels exist in the complete runtime.
- The in-frame fallback UI may still show the real local error message — that stays inside the iframe and never crosses to the host.
