"""RL3D — pywebview 창 생성 + JS↔파이썬 브릿지.

파이썬은 네트워크/캐싱을 담당(api_client)하고, JS는 받은 JSON을 지도에 그린다.
리소스 경로는 PyInstaller onefile 대비 _MEIPASS 경유(resource_path).
"""

import os
import sys
import urllib.parse
import webbrowser

import webview

import api_client

__version__ = "1.5.0"   # 배포 단위. 올릴 때 CHANGELOG.md 도 함께 갱신한다.


def resource_path(rel):
    """개발/온파일 exe 양쪽에서 동작하는 리소스 경로."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


def dev_window_pos(width, height):
    """개발 테스트 규칙: 창을 지정 모니터(기본 2번=보조)에 중앙 배치.

    환경변수 RL3D_DEV_MONITOR 가 설정됐을 때만 동작(값 = 1부터 시작하는 모니터 번호,
    미지정 시 첫 비주(非主) 모니터). 배포 exe 는 이 변수가 없어 OS 기본 위치에 뜬다.
    좌표를 못 구하면 (None, None) → pywebview 기본값 사용.
    """
    sel = os.environ.get("RL3D_DEV_MONITOR")
    if sel is None:
        return None, None
    try:
        import clr  # pythonnet (win)
        clr.AddReference("System.Windows.Forms")
        from System.Windows.Forms import Screen

        screens = list(Screen.AllScreens)
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


def main():
    api = Api()
    width, height = 1280, 800

    dev_mode = os.environ.get("RL3D_DEV_MONITOR") is not None
    x, y = dev_window_pos(width, height)

    # 개발 모니터 지정이 없을 때만 저장된 창 상태를 복원(P8-9). dev 위치는 저장 안 함.
    saved_win = {}
    if not dev_mode:
        saved_win = api_client.load_settings().get("window") or {}
        if isinstance(saved_win.get("width"), int) and isinstance(saved_win.get("height"), int):
            width, height = saved_win["width"], saved_win["height"]
        if x is None and isinstance(saved_win.get("x"), int) and isinstance(saved_win.get("y"), int):
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
            except Exception:
                pass  # 창 상태 저장 실패는 종료를 막지 않는다
        window.events.closing += _save_geometry

    webview.start()


if __name__ == "__main__":
    main()
