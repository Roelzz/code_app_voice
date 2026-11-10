import json
import os
import urllib.error
import urllib.request
from typing import Any

import azure.functions as func
from azure.identity import DefaultAzureCredential
from loguru import logger

logger.remove()
logger.add(
    sink=lambda msg: print(msg, end=""),
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="{time:DD-MM-YYYY at HH:mm:ss} | {level: <8} | {message}",
)

COGNITIVE_SCOPE = "https://cognitiveservices.azure.com/.default"
ALLOWED_VOICES = {"marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"}

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)
_credential: DefaultAzureCredential | None = None


class BrokerError(Exception):
    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


def get_credential() -> DefaultAzureCredential:
    global _credential
    if _credential is None:
        _credential = DefaultAzureCredential()
    return _credential


def settings() -> tuple[str, str]:
    endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").rstrip("/")
    deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "")
    if not endpoint or not deployment:
        raise BrokerError("Broker is missing AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_DEPLOYMENT.", 500)
    return endpoint, deployment


def mint_client_secret(voice: str) -> dict[str, Any]:
    endpoint, deployment = settings()
    token = get_credential().get_token(COGNITIVE_SCOPE).token
    body = json.dumps({"session": {"type": "realtime", "model": deployment, "audio": {"output": {"voice": voice}}}})
    request = urllib.request.Request(
        f"{endpoint}/openai/v1/realtime/client_secrets",
        data=body.encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:500]
        logger.error(f"Azure OpenAI rejected client secret request: {error.code} {detail}")
        raise BrokerError("Azure OpenAI refused to issue a realtime token.", 502) from error
    except (urllib.error.URLError, TimeoutError) as error:
        logger.error(f"Azure OpenAI unreachable: {error}")
        raise BrokerError("Azure OpenAI is unreachable.", 504) from error

    value = payload.get("value")
    if not isinstance(value, str) or not value:
        logger.error("Azure OpenAI response had no client secret value")
        raise BrokerError("Azure OpenAI returned no realtime token.", 502)
    return {
        "value": value,
        "expiresAt": payload.get("expires_at"),
        "callsUrl": f"{endpoint}/openai/v1/realtime/calls",
        "model": deployment,
    }


@app.route(route="realtime-token", methods=["POST"])
def realtime_token(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json() if req.get_body() else {}
    except ValueError:
        return func.HttpResponse(json.dumps({"error": "Request body must be valid JSON."}), status_code=400, mimetype="application/json")
    voice = body.get("voice", "marin") if isinstance(body, dict) else "marin"
    if not isinstance(voice, str) or voice not in ALLOWED_VOICES:
        return func.HttpResponse(json.dumps({"error": f"Unsupported voice '{voice}'."}), status_code=400, mimetype="application/json")

    try:
        result = mint_client_secret(voice)
    except BrokerError as error:
        return func.HttpResponse(json.dumps({"error": str(error)}), status_code=error.status, mimetype="application/json")
    except Exception as error:  # noqa: BLE001 - last-resort boundary, logged with traceback
        logger.exception(f"Unexpected broker failure: {error}")
        return func.HttpResponse(json.dumps({"error": "Unexpected broker failure."}), status_code=500, mimetype="application/json")

    logger.info(f"Issued realtime token (voice {voice})")
    return func.HttpResponse(json.dumps(result), status_code=200, mimetype="application/json", headers={"Cache-Control": "no-store"})
