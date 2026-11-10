# DFMEA Workshop Studio

A guided Design FMEA (DFMEA) workshop app with an AI facilitator powered by Microsoft 365 Copilot. It was built with App Builder in Microsoft 365 Copilot and runs as a Power Platform managed app.

- Live app (older version): https://play.managedapps.cloud.microsoft/apps/053842df-be85-429a-b631-6c2114ab15a1
- Status, backlog, access, ALM and the GitHub Copilot kickoff prompt: [docs/HANDOVER.md](docs/HANDOVER.md)
- Instructions GitHub Copilot reads automatically: [.github/copilot-instructions.md](.github/copilot-instructions.md)
- App Builder template conventions: [AGENTS.md](AGENTS.md); theming: [THEMING.md](THEMING.md); original template notes: [docs/app-builder-template.md](docs/app-builder-template.md)

## Run locally

Requires Node.js 22 LTS.

```bash
npm ci
npm run dev          # http://localhost:5173
```

The AI facilitator needs the managed-app host, so it only works in the published app or in the App Builder preview. Everything else runs locally.

## Checks

```bash
npm run typecheck
npm run lint
npm run build:check  # on Windows, run in Git Bash or WSL
```
