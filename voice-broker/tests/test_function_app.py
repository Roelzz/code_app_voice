import io
import json
import urllib.error
from typing import Any, Self

import azure.functions as func
import pytest

import function_app


class FakeToken:
    token = "entra-token"


class FakeCredential:
    def get_token(self, scope: str) -> FakeToken:
        assert scope == function_app.COGNITIVE_SCOPE
        return FakeToken()


class FakeResponse(io.BytesIO):
    def __enter__(self) -> Self:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://voice.openai.azure.com/")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", "gpt-realtime-2.1")
    monkeypatch.setattr(function_app, "_credential", FakeCredential())


def make_request(body: Any = None) -> func.HttpRequest:
    return func.HttpRequest(
        method="POST",
        url="/api/realtime-token",
        body=json.dumps(body).encode() if body is not None else b"",
        headers={"x-ms-client-principal-name": "user@contoso.com"},
    )


def call(request: func.HttpRequest) -> func.HttpResponse:
    return function_app.realtime_token.build().get_user_function()(request)


def test_issues_token(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    def fake_urlopen(request: Any, timeout: int) -> FakeResponse:
        seen["url"] = request.full_url
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = json.loads(request.data)
        return FakeResponse(json.dumps({"value": "ek_123", "expires_at": 99}).encode())

    monkeypatch.setattr(function_app.urllib.request, "urlopen", fake_urlopen)
    response = call(make_request({"voice": "cedar"}))

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert json.loads(response.get_body()) == {
        "value": "ek_123",
        "expiresAt": 99,
        "callsUrl": "https://voice.openai.azure.com/openai/v1/realtime/calls",
        "model": "gpt-realtime-2.1",
    }
    assert seen["url"] == "https://voice.openai.azure.com/openai/v1/realtime/client_secrets"
    assert seen["auth"] == "Bearer entra-token"
    assert seen["body"]["session"]["model"] == "gpt-realtime-2.1"
    assert seen["body"]["session"]["audio"]["output"]["voice"] == "cedar"


def test_defaults_voice_without_body(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_urlopen(request: Any, timeout: int) -> FakeResponse:
        captured.update(json.loads(request.data))
        return FakeResponse(b'{"value": "ek_1"}')

    monkeypatch.setattr(function_app.urllib.request, "urlopen", fake_urlopen)
    assert call(make_request()).status_code == 200
    assert captured["session"]["audio"]["output"]["voice"] == "marin"


def test_rejects_unknown_voice() -> None:
    response = call(make_request({"voice": "darth"}))
    assert response.status_code == 400


def test_rejects_non_string_voice() -> None:
    response = call(make_request({"voice": []}))
    assert response.status_code == 400


def test_rejects_invalid_json() -> None:
    request = func.HttpRequest(method="POST", url="/api/realtime-token", body=b"{", headers={})
    assert call(request).status_code == 400


def test_upstream_error_maps_to_502(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_urlopen(request: Any, timeout: int) -> FakeResponse:
        raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, io.BytesIO(b"no role"))  # type: ignore[arg-type]

    monkeypatch.setattr(function_app.urllib.request, "urlopen", fake_urlopen)
    response = call(make_request())
    assert response.status_code == 502
    assert "realtime token" in json.loads(response.get_body())["error"]


def test_missing_value_maps_to_502(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(function_app.urllib.request, "urlopen", lambda request, timeout: FakeResponse(b"{}"))
    assert call(make_request()).status_code == 502


def test_missing_settings_maps_to_500(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AZURE_OPENAI_DEPLOYMENT")
    assert call(make_request()).status_code == 500
