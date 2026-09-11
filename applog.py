"""RL3D 로그 파일 설정 (P12-9).

exe 는 `pythonw` 로 도는 셈이라 **stderr 가 어디에도 남지 않는다** — 사용자가 겪은
실패의 신호가 0 이었다. `%APPDATA%\\RL3D\\logs\\rl3d.log` 에 회전 로그로 남긴다.

이 모듈은 **아무것도 import 하지 않는다**(표준 라이브러리만). api_client 를 import 하면
api_client 안에서 로깅을 못 쓰게 되므로(순환 import), 경로는 호출자가 인자로 넘긴다.
다른 모듈은 `logging.getLogger(__name__)` 만 쓰고, 핸들러 설정은 진입점에서 1회만 한다.

터미널 확인: `python applog.py` → 로그 경로와 방금 쓴 줄을 출력한다.
"""

import logging
import logging.handlers
import os
import sys

LOG_FILENAME = "rl3d.log"
MAX_BYTES = 512 * 1024   # 한 파일 512KB
BACKUP_COUNT = 3         # rl3d.log + .1~.3 → 최대 2MB
LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"

# setup() 이 재대입한다 → 이름 import 금지(전역 규칙). log_path() 로만 읽는다.
_log_path = None


def log_path():
    """설정된 로그 파일 경로. setup() 전이거나 실패했으면 None."""
    return _log_path


def log_dir(app_dir):
    """로그 디렉터리 경로(설정 없이도 계산 가능 — 크래시 안내용)."""
    return os.path.join(app_dir, "logs")


def setup(app_dir, level=logging.INFO):
    """루트 로거에 회전 파일 핸들러를 붙이고 로그 경로를 반환. 실패하면 None.

    로그를 못 쓰는 것이 앱 실행을 막아선 안 된다(디스크 권한 등) → 예외를 삼킨다.
    """
    global _log_path
    directory = log_dir(app_dir)
    path = os.path.join(directory, LOG_FILENAME)
    try:
        os.makedirs(directory, exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            path, maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT,
            encoding="utf-8",   # 전역 규칙: 인코딩은 항상 명시
        )
    except OSError:
        return None

    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    root = logging.getLogger()
    root.setLevel(level)
    root.addHandler(handler)
    _log_path = path
    return path


def install_excepthook():
    """잡히지 않은 예외를 로그에 남긴다(GUI 에선 traceback 이 아무 데도 안 남는다)."""
    previous = sys.excepthook

    def _hook(exc_type, exc, tb):
        logging.getLogger("rl3d").critical(
            "처리되지 않은 예외", exc_info=(exc_type, exc, tb))
        previous(exc_type, exc, tb)

    sys.excepthook = _hook


if __name__ == "__main__":
    app_dir = os.path.join(
        os.environ.get("APPDATA", os.path.expanduser("~")), "RL3D")
    p = setup(app_dir)
    if p is None:
        print("[FAIL] applog - 로그 파일을 만들지 못했습니다")
        raise SystemExit(1)
    logging.getLogger("rl3d.smoke").info("스모크 실행")
    print(f"[OK] applog - {p}")
    with open(p, encoding="utf-8") as f:
        print("        마지막 줄: " + (f.read().splitlines() or [""])[-1])
