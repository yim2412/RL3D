"""RL3D — pywebview 창 생성 + JS↔파이썬 브릿지.

파이썬은 네트워크/캐싱을 담당(api_client)하고, JS는 받은 JSON을 지도에 그린다.
리소스 경로는 PyInstaller onefile 대비 _MEIPASS 경유(resource_path).
로그 설정·시작 진단은 여기(진입점)에서만 한다 — applog / startup 참조.
"""

import logging
import os
import sys
import urllib.parse
import webbrowser

import webview

import api_client
import applog
import startup

log = logging.getLogger(__name__)

__version__ = "1.7.1"   # 배포 단위. 올릴 때 CHANGELOG.md 도 함께 갱신한다.


def resource_path(rel):
    """개발/온파일 exe 양쪽에서 동작하는 리소스 경로."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


# 복원한 창이 "잡아서 옮길 수 있을" 최소 노출 크기(제목표시줄 정도).
MIN_VISIBLE_W, MIN_VISIBLE_H = 120, 40


def _rect_visible(x, y, width, height, areas):
    """창 사각형이 화면 영역 중 하나와 충분히 겹치는가(순수 함수 — 테스트 대상).

    areas 는 (x, y, w, h) 튜플 목록.
    """
    for ax, ay, aw, ah in areas:
        if (min(x + width, ax + aw) - max(x, ax) >= MIN_VISIBLE_W
                and min(y + height, ay + ah) - max(y, ay) >= MIN_VISIBLE_H):
            return True
    return False


def _monitor_areas():
    """모니터 작업영역 [(x, y, w, h)]. 못 읽으면 None(= 판단 불가)."""
    try:
        import clr  # pythonnet (win)
        clr.AddReference("System.Windows.Forms")
        from System.Windows.Forms import Screen

        return [(s.WorkingArea.X, s.WorkingArea.Y,
                 s.WorkingArea.Width, s.WorkingArea.Height)
                for s in Screen.AllScreens]
    except Exception:
        return None


def order_screens(screens):
    """사용자가 보는 모니터 번호 순서로 정렬 — **주 모니터가 1번**, 나머지가 그 뒤.

    `Screen.AllScreens` 의 순서는 사용자의 "디스플레이 1/2"와 무관하다(2026-09-11 실측:
    이 PC 는 AllScreens[0] 이 보조, [1] 이 주였다). 그대로 인덱싱하면 `=2` 가 **주
    모니터**를 가리켜, "보조에서 테스트한다"는 규칙이 조용히 지켜지지 않는다.
    순수 함수라 테스트 대상 — screens 는 `.Primary` 를 가진 객체 목록이면 된다.
    """
    primary = [s for s in screens if s.Primary]
    others = [s for s in screens if not s.Primary]
    return primary + others


def dev_window_pos(width, height):
    """개발 테스트 규칙: 창을 지정 모니터(기본 2번=보조)에 중앙 배치.

    환경변수 RL3D_DEV_MONITOR 가 설정됐을 때만 동작. 값은 **주 모니터를 1번으로 세는**
    번호이고(order_screens), 숫자가 아니거나 범위를 벗어나면 첫 비주(非主) 모니터.
    배포 exe 는 이 변수가 없어 OS 기본 위치에 뜬다.
    좌표를 못 구하면 (None, None) → pywebview 기본값 사용.
    """
    sel = os.environ.get("RL3D_DEV_MONITOR")
    if sel is None:
        return None, None
    try:
        import clr  # pythonnet (win)
        clr.AddReference("System.Windows.Forms")
        from System.Windows.Forms import Screen

        screens = order_screens(list(Screen.AllScreens))
        target = None
        if sel.isdigit() and int(sel) >= 1:
            idx = int(sel) - 1
            if idx < len(screens):
                target = screens[idx]
        if target is None:  # 번호 미지정/범위밖 → 첫 비주 모니터
            target = next((s for s in screens if not s.Primary), None)
        if target is None:
            return None, None
        b = target.Bounds
        x = b.X + max(0, (b.Width - width) // 2)
        y = b.Y + max(0, (b.Height - height) // 2)
        return x, y
    except Exception:
        return None, None


class Api:
    """window.pywebview.api.* 로 노출되는 브릿지."""

    def get_launches(self, force=False):
        return api_client.get_launches(force=force)

    def get_satellites(self, force=False, groups=None):
        return api_client.get_satellites(force=force, groups=groups)

    def get_satellite_groups(self):
        return api_client.satellite_group_catalog()

    def get_archive(self, year):
        return api_client.get_archive(year)

    def get_settings(self):
        return api_client.load_settings()

    def save_settings(self, patch):
        return api_client.save_settings(patch)

    def open_url(self, url):
        """중계 링크 등을 기본 브라우저에서 연다.

        앱 창(WebView2) 안에서 열면 지도로 돌아올 방법이 없으므로 외부 브라우저로 보낸다.
        API가 준 URL을 그대로 실행하는 셈이라 http/https 만 허용한다(file:// 등 차단).
        """
        try:
            parsed = urllib.parse.urlparse(str(url))
        except ValueError:
            return False
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return False
        webbrowser.open(parsed.geturl())
        return True

    def ping(self):
        return "pong"


def _run():
    """창을 띄우는 본체. 시작 중 예외는 main() 이 잡아 안내한다."""
    api = Api()
    width, height = 1280, 800

    removed = api_client.cleanup_legacy_cache()  # 구조가 바뀌기 전 캐시 파일 청소
    if removed:
        log.info("옛 캐시 정리: %s", ", ".join(removed))

    dev_mode = os.environ.get("RL3D_DEV_MONITOR") is not None
    x, y = dev_window_pos(width, height)

    # 개발 모니터 지정이 없을 때만 저장된 창 상태를 복원(P8-9). dev 위치는 저장 안 함.
    saved_win = {}
    if not dev_mode:
        saved_win = api_client.load_settings().get("window") or {}
        if isinstance(saved_win.get("width"), int) and isinstance(saved_win.get("height"), int):
            width, height = saved_win["width"], saved_win["height"]
        if x is None and isinstance(saved_win.get("x"), int) and isinstance(saved_win.get("y"), int):
            # 보조 모니터에서 창을 옮긴 뒤 그 모니터를 떼면 저장된 좌표가 어느 화면에도
            # 없는 자리가 된다 — 그대로 복원하면 창이 보이지 않는 곳에 떠서 앱이 안 뜬
            # 것처럼 보인다. 못 읽는 환경(areas is None)에선 판단하지 않고 그대로 쓴다.
            areas = _monitor_areas()
            if areas is None or _rect_visible(saved_win["x"], saved_win["y"],
                                              width, height, areas):
                x, y = saved_win["x"], saved_win["y"]

    kwargs = dict(
        url=resource_path(os.path.join("web", "index.html")),
        js_api=api,
        width=width,
        height=height,
        min_size=(900, 600),
        background_color="#0b0f1a",
    )
    if x is not None and y is not None:
        kwargs["x"], kwargs["y"] = x, y
    window = webview.create_window(
        "RL3D v{} — 로켓 발사 & 위성 추적".format(__version__), **kwargs)

    # 종료 시 창 위치·크기 저장(개발 모드 제외 — dev 모니터 위치가 배포에 새지 않게).
    if not dev_mode:
        def _save_geometry(*_):
            try:
                api_client.save_settings({"window": {
                    "x": window.x, "y": window.y,
                    "width": window.width, "height": window.height,
                }})
            except Exception as e:   # noqa: BLE001
                log.warning("창 상태 저장 실패: %s", e)  # 저장 실패가 종료를 막진 않는다
        window.events.closing += _save_geometry

    log.info("창 생성 %dx%d at (%s, %s)", width, height, x, y)
    webview.start()
    log.info("정상 종료")


def main():
    """로그 설정 → 시작 진단 → 창. 시작 실패는 안내 대화상자로 알린다(P12-10)."""
    log_file = applog.setup(api_client.APP_DIR)
    applog.install_excepthook()
    log.info("RL3D v%s 시작", __version__)

    startup.check_webview2()  # 없어도 계속 진행 — 사용자가 상황을 보게 한다(P12-11)

    try:
        _run()
    except Exception as e:   # noqa: BLE001 — 시작 실패를 사용자에게 알리는 마지막 자리
        startup.report_crash(e, log_file)
        raise


if __name__ == "__main__":
    main()
