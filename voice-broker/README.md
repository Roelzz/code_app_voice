# DFMEA Realtime Voice Token Broker

This Azure Functions app mints short-lived Azure OpenAI Realtime client secrets with its managed identity. The browser uses the secret only to establish one WebRTC voice session. It is never stored, logged or sent to Work IQ.

## Deployed resources

- Subscription: `cape-workshops-fy27`
- Resource group: `rg-dfmea-voice`
- Function App: `dfmea-voice-broker` (Flex Consumption, Python 3.12)
- Azure AI Services resource: `dfmea-voice-fy27`
- Deployment: `gpt-realtime-2.1`
- Route: `POST https://dfmea-voice-broker.azurewebsites.net/api/realtime-token`
- Authentication: Function App Easy Auth with Entra ID; anonymous calls return 401.

The Function's managed identity has `Cognitive Services OpenAI User` on the Azure AI Services resource. The Function requires `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_DEPLOYMENT` app settings. It does not use or return an Azure OpenAI API key.

## Connector setup

Import `openapi.yaml` into App Builder as a custom connector. Configure OAuth with the tenant, API scope, client ID and client secret from the private session files under `files/secrets/`. The secret is not part of this repository. Add the connector to the app and use the generated client operation; never hand-edit `generated/`.

The App Builder app's CSP must allow `https://dfmea-voice-fy27.openai.azure.com` in `connect-src` for WebRTC signaling. Work IQ remains the answer source: the voice client sends the user's question through the `ask_copilot` tool callback and speaks the returned Copilot answer.

## Local checks

```bash
uv run ruff check .
uv run pytest -q
```
