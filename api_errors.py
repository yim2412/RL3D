"""RL3D 예외 → 사람이 읽는 말 (순수 함수만).

`OPENAPI00005` 같은 코드를 그대로 띄우지 않기 위한 자리. 코드별 문구 표를 **한 곳에** 둔다.
`api_client.py` 가 모듈 경유로 부른다: `api_errors._friendly_error(e)`.
"""

import http.client
import ssl
import urllib.error

# ── 에러 메시지(사람이 읽는 말로) ─────────────────────────────────────────────
# HTTP 상태코드 → 사용자 문구. 새 코드를 만나면 여기에만 추가한다.
# 403 은 이 앱이 실제로 겪는 실패다 — Celestrak 은 같은 대형 그룹(Starlink 1.7MB)을
# 짧은 간격으로 거듭 받으면 403 으로 막는다(v1.5.1 위성 상한의 근거).
HTTP_ERROR_MESSAGES = {
    403: "서버가 접근을 거부했습니다(403). 같은 데이터를 짧은 간격으로 여러 번 받으면 "
         "차단될 수 있습니다 — 잠시 후 다시 시도하세요.",
    404: "요청한 데이터를 찾을 수 없습니다(404).",
    429: "요청이 많아 잠시 제한됐습니다(시간당 한도). 잠시 후 다시 시도하세요.",
    500: "서버에 일시적인 문제가 있습니다(500). 잠시 후 다시 시도하세요.",
    502: "서버에 일시적인 문제가 있습니다(502). 잠시 후 다시 시도하세요.",
    503: "서버가 일시적으로 응답할 수 없습니다(503). 잠시 후 다시 시도하세요.",
    504: "서버 응답이 지연됩니다(504). 잠시 후 다시 시도하세요.",
}

TIMEOUT_MESSAGE = "응답이 지연됩니다(타임아웃). 잠시 후 다시 시도하세요."

# **연결이 끊긴 것**과 **받은 것이 깨진 것**은 사용자가 할 일이 다르다 — 전자는 연결 확인,
# 후자는 잠시 후 재시도. 예전에는 둘 다 기본 문구("데이터를 불러오지 못했습니다")였다.
# P29-1 이 `except` 를 넓히면서 이 일곱 종이 **전부 기본 문구로 들어오게 됐다**:
# ConnectionResetError · RemoteDisconnected · IncompleteRead · BadStatusLine · SSLError ·
# SSLEOFError · 일반 OSError.
DISCONNECT_MESSAGE = ("연결이 중간에 끊겼습니다. 인터넷 연결을 확인하고 다시 시도하세요.")
TLS_MESSAGE = ("보안 연결(HTTPS)에 실패했습니다. 회사·학교 네트워크나 백신의 "
               "가로채기 설정이 원인일 수 있습니다.")


def _is_timeout(e):
    """타임아웃 판별.

    urlopen 은 타임아웃을 그대로 던지지 않고 URLError(reason=timeout) 으로 감싼다
    (2026-08-20 실측) — isinstance(e, TimeoutError) 가 그래서 False 다. URLError 를
    먼저 잡으면 서버가 느릴 뿐인데도 "인터넷 연결을 확인하세요" 라고 잘못 안내하게
    되므로 reason 까지 들여다본다.
    """
    if isinstance(e, TimeoutError):
        return True
    reason = getattr(e, "reason", None)
    if isinstance(reason, TimeoutError):
        return True
    return "timed out" in str(reason).lower()


def _friendly_error(e):
    if isinstance(e, urllib.error.HTTPError):
        return HTTP_ERROR_MESSAGES.get(e.code) or f"서버 응답 오류({e.code})."
    if _is_timeout(e):
        return TIMEOUT_MESSAGE
    if isinstance(e, urllib.error.URLError):
        return "네트워크에 연결할 수 없습니다. 인터넷 연결을 확인하세요."
    # TLS 는 연결 끊김보다 **먼저** 본다 — `SSLError` 도 `OSError` 하위라 아래에 두면 가려진다.
    if isinstance(e, ssl.SSLError) or isinstance(getattr(e, "reason", None), ssl.SSLError):
        return TLS_MESSAGE
    # 응답을 **읽는 도중** 끊긴 경우들. 연결 자체가 안 된 것(URLError)과 달리
    # 사용자는 "잠깐 끊겼다"를 겪는다 — 같은 말로 뭉뚱그리면 원인을 엉뚱한 데서 찾는다.
    if isinstance(e, (ConnectionError, http.client.HTTPException)):
        return DISCONNECT_MESSAGE
    if isinstance(e, ValueError):
        return "받은 데이터를 읽지 못했습니다. 잠시 후 다시 시도하세요."
    if isinstance(e, OSError):
        return DISCONNECT_MESSAGE
    return "데이터를 불러오지 못했습니다."
