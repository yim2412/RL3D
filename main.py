"""RL3D — pywebview 창 생성 + JS↔파이썬 브릿지.

파이썬은 네트워크/캐싱을 담당(api_client)하고, JS는 받은 JSON을 지도에 그린다.
리소스 경로는 PyInstaller onefile 대비 _MEIPASS 경유(resource_path).
"""

import os
import sys

import webview

import api_client


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

    def get_satellites(self, force=False):
        return api_client.get_satellites(force=force)

    def ping(self):
        return "pong"


def main():
    api = Api()
    width, height = 1280, 800
    x, y = dev_window_pos(width, height)
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
    webview.create_window("RL3D — 로켓 발사 & 위성 추적", **kwargs)
    webview.start()


if __name__ == "__main__":
    main()
