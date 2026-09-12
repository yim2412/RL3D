"""RL3D 예외 → 사람이 읽는 말 (순수 함수만).

`OPENAPI00005` 같은 코드를 그대로 띄우지 않기 위한 자리. 코드별 문구 표를 **한 곳에** 둔다.
`api_client.py` 가 모듈 경유로 부른다: `api_errors._friendly_error(e)`.
"""

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
    return "데이터를 불러오지 못했습니다."
