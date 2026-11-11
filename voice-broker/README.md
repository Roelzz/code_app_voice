# DFMEA Realtime Voice Token Broker

This Azure Functions app mints short-lived Azure OpenAI Realtime client secrets with its managed identity. The browser uses the secret only to establish one WebRTC voice session. It is never stored, logged or sent to Work IQ.

For the integration story, start with the [showcase](../README.md); see the [technical guide](../docs/technical-guide.md#realtime-voice-lifecycle) for identity, lifecycle and adaptation boundaries. The resource names below are historical example-deployment details, not resources supplied by cloning this repository or a statement of current live state.

## Example deployment resources

- Subscription: `cape-workshops-fy27`
- Resource group: `rg-dfmea-voice`
- Function App: `dfmea-voice-broker` (Flex Consumption, Python 3.12)
- Azure AI Services resource: `dfmea-voice-fy27`
- Deployment: `gpt-realtime-2.1`
- Route: `POST https://dfmea-voice-broker.azurewebsites.net/api/realtime-token`
- Authentication: Function App Easy Auth with Entra ID; anonymous calls return 401.

The Function's managed identity has `Cognitive Services OpenAI User` on the Azure AI Services resource. The Function requires `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_DEPLOYMENT` app settings. It does not use or return an Azure OpenAI API key.

## Connector setup

Use `openapi.yaml` as a custom-connector starting point with your own broker endpoint. Configure OAuth for your own tenant, API scope, registration and exact redirect URI; keep credentials in approved platform configuration or a secret store, never in the repository. Add the connector through supported tooling and use the generated client operation; never hand-edit `generated/`.

The app's CSP must allow its exact Azure OpenAI origin in `connect-src` for WebRTC signaling; the example uses `https://dfmea-voice-fy27.openai.azure.com`. The selected Work IQ or Copilot Studio helper remains the answer source: the voice client sends the user's question through `ask_copilot` and speaks the returned helper answer.

## Local checks

```bash
uv run ruff check .
uv run pytest -q
```
