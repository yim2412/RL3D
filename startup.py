"""시작 단계 진단·안내 (P12-10 크래시 안내 / P12-11 WebView2 부재 안내).

둘 다 **창이 뜨기 전/못 뜰 때** 동작해야 하므로 표준 라이브러리만 쓴다.
- WebView2 가 없으면 pywebview 창은 뜨지만 **내용이 흰 화면**이라 고장처럼 보인다.
- 시작 중 예외가 나면 창이 아예 안 뜬다 — 로그 경로를 알려주는 것이 최소한의 신호다.

레지스트리 읽기·대화상자는 **주입 가능하게** 떼어 놨다(GUI·마우스 없이 테스트하기 위해).

터미널 확인: `python startup.py` → 이 PC 의 WebView2 버전을 출력한다(대화상자 없음).
"""

import logging
import sys

log = logging.getLogger(__name__)

# WebView2 런타임이 스스로 등록하는 EdgeUpdate 클라이언트 GUID. 버전은 `pv` 값.
# Evergreen 런타임은 시스템(HKLM, 32비트 뷰)에, 사용자 설치본은 HKCU 에 적는다.
WEBVIEW2_CLIENT_GUID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
WEBVIEW2_KEYS = (
    ("HKLM", r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\%s" % WEBVIEW2_CLIENT_GUID),
    ("HKLM", r"SOFTWARE\Microsoft\EdgeUpdate\Clients\%s" % WEBVIEW2_CLIENT_GUID),
    ("HKCU", r"SOFTWARE\Microsoft\EdgeUpdate\Clients\%s" % WEBVIEW2_CLIENT_GUID),
)

WEBVIEW2_MISSING_TITLE = "RL3D — WebView2 런타임이 필요합니다"
WEBVIEW2_MISSING_MESSAGE = (
    "이 앱은 화면을 그리는 데 Microsoft Edge WebView2 런타임을 사용합니다.\n"
    "설치돼 있지 않아 지도가 빈 화면으로 뜹니다.\n\n"
    "아래 주소에서 'Evergreen Standalone Installer' 를 받아 설치한 뒤 다시 실행하세요.\n"
    "https://developer.microsoft.com/microsoft-edge/webview2/\n\n"
    "계속 진행하면 창은 뜨지만 내용이 보이지 않을 수 있습니다."
)

CRASH_TITLE = "RL3D — 시작하지 못했습니다"


def _read_registry_value(root, path, name):
    """레지스트리 문자열 값. 없으면 None. (win 전용 — 다른 OS 면 None)"""
    try:
        import winreg
    except ImportError:
        return None
    hive = winreg.HKEY_LOCAL_MACHINE if root == "HKLM" else winreg.HKEY_CURRENT_USER
    try:
        with winreg.OpenKey(hive, path) as key:
            value, _ = winreg.QueryValueEx(key, name)
    except OSError:
        return None
    return value


def webview2_version(read_value=_read_registry_value):
    """설치된 WebView2 런타임 버전 문자열. 없으면 None.

    read_value(root, path, name) 를 주입하면 레지스트리 없이 판정을 테스트할 수 있다.
    """
    for root, path in WEBVIEW2_KEYS:
        value = read_value(root, path, "pv")
        if not isinstance(value, str):
            continue
        value = value.strip()
        # "0.0.0.0" 은 EdgeUpdate 가 남겨두는 '설치 안 됨' 표시이고, 빈 값도 마찬가지다
        # — 버전으로 치면 안내가 아예 안 뜬다. 판정은 여기 한 곳에서만 한다
        # (리더 쪽에 두면 주입한 리더가 그 규칙을 비껴간다 — 실제로 테스트가 잡았다).
        if value and value != "0.0.0.0":
            return value
    return None


def _message_box(title, text):
    """네이티브 대화상자. 띄우지 못해도 예외를 내지 않는다(마지막 안내 수단일 뿐)."""
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, text, title, 0x00000010)  # MB_ICONERROR
        return True
    except Exception:
        return False


def check_webview2(version=None, notify=_message_box):
    """WebView2 가 없으면 안내하고 False 를 반환(있으면 True).

    version 을 넘기면 감지를 건너뛴다(테스트용). 반환값은 '계속 진행 가능' 이 아니라
    '런타임이 있는가' 다 — 없어도 앱은 계속 뜬다(사용자가 상황을 보게).
    """
    found = version if version is not None else webview2_version()
    if found:
        log.info("WebView2 런타임 %s", found)
        return True
    log.warning("WebView2 런타임을 찾지 못했습니다 — 흰 화면으로 뜰 수 있습니다")
    notify(WEBVIEW2_MISSING_TITLE, WEBVIEW2_MISSING_MESSAGE)
    return False


def crash_message(exc, log_file=None):
    """크래시 안내 문구(순수 함수 — 테스트 대상)."""
    lines = [
        "앱을 시작하는 중 문제가 발생했습니다.",
        "",
        "{}: {}".format(type(exc).__name__, exc),
    ]
    if log_file:
        lines += ["", "자세한 내용은 로그 파일에 있습니다:", log_file]
    else:
        lines += ["", "로그 파일을 만들지 못해 자세한 기록이 남지 않았습니다."]
    return "\n".join(lines)


def report_crash(exc, log_file=None, notify=_message_box):
    """시작 실패를 로그에 남기고 사용자에게 안내한다."""
    log.critical("시작 실패", exc_info=exc)
    notify(CRASH_TITLE, crash_message(exc, log_file))


if __name__ == "__main__":
    # 콘솔 인코딩은 실행 PC 를 따른다 — 이 PC 는 UTF-8(65001), 한국어 PC 는 cp949 라
    # 한글이 넘어가지만 영문 로캘(cp1252)에서는 UnicodeEncodeError 로 죽는다.
    # 2026-09-11 CI 첫 실행이 실제로 여기서 깨졌다(GitHub 러너 = cp1252).
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    v = webview2_version()
    if v:
        print(f"[OK] webview2 - {v}")
    else:
        print("[FAIL] webview2 - 런타임을 찾지 못했습니다")
        sys.exit(1)
