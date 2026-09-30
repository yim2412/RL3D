"""빌드한 exe 를 실제로 띄웠다가 **정상 종료**로 끈다 (P57).

    python tools/smoke_exe.py [dist/RL3D.exe] [--kill]

**왜**: 감사 F-017 실측에서 `%TEMP%` 에 onefile 이 못 지운 `_MEI*` 가 42개 · 981.7MB 있었고,
전부 **exe 스모크를 강제 종료한 날짜**였다. 2026-09-27 P53 스모크도 `Stop-Process -Force` 로
하나를 더 남겼다. 창에 WM_CLOSE 를 보내면 pywebview 가 정상 종료하고 부트로더가 임시 폴더를
지운다(같은 날 실측: 1.5초 · rc 0 · 새 `_MEI` 0). 손으로 하던 순서를 여기 묶는다.

재는 것: 창이 뜨는가 · 제목의 버전이 `main.py` 와 같은가(옛 exe 를 띄운 것 아닌가) ·
2번 모니터(주 모니터가 아닌 곳)에 떴는가 · 이번 실행의 로그에 WARNING 이상이 없는가 ·
정상 종료되는가 · 프로세스와 새 `_MEI` 가 남지 않는가.

`RL3D_DEV_MONITOR=2` 로 띄운다 — 프로젝트 규칙(GUI 는 보조 모니터)이고, 개발 모드에서는
창 위치를 **저장하지 않아** 스모크가 사용자의 창 위치를 덮지 않는다(`main.py` `dev_mode`).

`--kill` 은 이 검사가 **정말 재는지** 보는 대조군이다: 강제 종료하면 `_MEI` 가 남아 FAIL 해야
한다(남은 것은 지운다). CI 에서는 안 돈다 — 러너에 WebView2 가 없다.
"""
import ctypes
import ctypes.wintypes as W
import glob
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_EXE = os.path.join(ROOT, "dist", "RL3D.exe")
LOG = os.path.join(os.environ.get("APPDATA", ""), "RL3D", "logs", "rl3d.log")
TITLE_PREFIX = "RL3D v"
WINDOW_TIMEOUT_S = 30     # 실측 1.6초(데운 상태). 콜드 스타트 여유
sys.path.insert(0, ROOT)
import api_client  # noqa: E402 — 앱의 HTTP 한도를 한 곳에서 읽는다(숫자를 여기 따로 적으면 어긋난다)

DATA_EXPECT_S = 30        # 창 → 첫 발사 데이터 로그. 실측 0.8~17.5초(P58 뒤 20회 · WebGL 대기가 대부분)
# 네트워크가 느려도 앱은 **폴백으로 반드시 한 줄** 남긴다 — 그 최악까지는 기다린다(P99). 발사는 예정·지난 두 요청을
# 차례로 하고, 요청마다 최악은 전체 마감 + 마지막 한 번 읽기다. 예전엔 30초로 끊어, LL2 가 느렸던 날(P96) "앱이 데이터
# 단계까지 못 갔다" 는 FAIL 을 냈다 — 네트워크가 느린 것과 앱이 멈춘 것을 구분하지 못했다
DATA_TIMEOUT_S = 2 * (api_client.HTTP_TOTAL_TIMEOUT + api_client.HTTP_TIMEOUT) + 10
SETTLE_S = 1              # 데이터 로그 뒤 한숨 — 같은 틱의 다른 로그(위성 등)까지 받는다
# 발사 데이터는 부트마다 한 번 반드시 온다 — 캐시·네트워크·한도 대기 중 어느 경로든 한 줄 남긴다(P72).
# 예전엔 창 뒤 **5초 고정**으로 닫아, WebGL 대기가 길면 데이터 경로를 안 거친 채 통과했다(2026-09-27).
DATA_LINE = re.compile(r"api_client: 발사 \d+건")
CLOSE_TIMEOUT_S = 30      # 실측 1.5초
WM_CLOSE = 0x0010
MONITOR_DEFAULTTONEAREST = 2
MONITORINFOF_PRIMARY = 1

user32 = ctypes.windll.user32


def source_version():
    with open(os.path.join(ROOT, "main.py"), encoding="utf-8") as f:
        m = re.search(r'^__version__ = "([^"]+)"', f.read(), re.M)
    return m.group(1) if m else None


def mei_dirs():
    """이 앱의 onefile 임시 폴더만(다른 PyInstaller 앱 것은 건드리지 않는다)."""
    tmp = os.environ.get("TEMP", "")
    return {p for p in glob.glob(os.path.join(tmp, "_MEI*"))
            if os.path.exists(os.path.join(p, "web", "js", "boot.js"))}


def app_windows():
    found = []

    @ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    def cb(h, _):
        n = user32.GetWindowTextLengthW(h)
        if n and user32.IsWindowVisible(h):
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(h, buf, n + 1)
            if buf.value.startswith(TITLE_PREFIX):
                found.append((h, buf.value))
        return True

    user32.EnumWindows(cb, 0)
    return found


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", W.DWORD), ("rcMonitor", W.RECT), ("rcWork", W.RECT), ("dwFlags", W.DWORD)]


def on_primary(hwnd):
    mon = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    mi = MONITORINFO(cbSize=ctypes.sizeof(MONITORINFO))
    user32.GetMonitorInfoW(mon, ctypes.byref(mi))
    return bool(mi.dwFlags & MONITORINFOF_PRIMARY), user32.GetSystemMetrics(80)  # SM_CMONITORS


def rl3d_count():
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq RL3D.exe", "/FO", "CSV", "/NH"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return (r.stdout or "").count('"RL3D.exe"')


def log_problems(since):
    """since(epoch 초) 이후에 찍힌 WARNING 이상 줄. 로그 시각은 로컬 시각이다."""
    if not os.path.exists(LOG):
        return None
    cutoff = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(since))
    out = []
    with open(LOG, encoding="utf-8", errors="replace") as f:
        for line in f:
            stamp = line[:19]
            if re.match(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", stamp) and stamp >= cutoff \
                    and re.match(r"\S+ \S+ (WARNING|ERROR|CRITICAL)", line):
                out.append(line.rstrip())
    return out


def data_seen(since):
    """since 이후 발사 데이터 로그가 찍혔나."""
    if not os.path.exists(LOG):
        return False
    cutoff = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(since))
    with open(LOG, encoding="utf-8", errors="replace") as f:
        return any(line[:19] >= cutoff and DATA_LINE.search(line) for line in f)


def run(exe, kill=False):
    """(ok, 줄 목록). 줄은 [OK]/[FAIL] 로 시작한다."""
    lines, ok = [], True

    def say(good, msg):
        nonlocal ok
        ok = ok and good
        lines.append(("[OK] " if good else "[FAIL] ") + msg)

    if not os.path.exists(exe):
        return False, ["[FAIL] exe 없음: %s" % exe]
    if rl3d_count():
        return False, ["[FAIL] 이미 RL3D 가 %d개 떠 있다 — 먼저 끄고 다시 돈다" % rl3d_count()]

    before = mei_dirs()
    env = dict(os.environ, RL3D_DEV_MONITOR="2")
    t0 = time.time()
    proc = subprocess.Popen([exe], env=env)
    wins = []
    while time.time() - t0 < WINDOW_TIMEOUT_S and not wins:
        time.sleep(0.5)
        wins = app_windows()
    say(bool(wins), "창이 떴다 %.1f초" % (time.time() - t0) if wins
        else "창이 %d초 안에 안 떴다" % WINDOW_TIMEOUT_S)
    if wins:
        ver = source_version()
        title = wins[0][1]
        say(title.startswith(TITLE_PREFIX + (ver or "?") + " "), "제목 %r ↔ 소스 v%s" % (title, ver))
        primary, monitors = on_primary(wins[0][0])
        if monitors >= 2:
            say(not primary, "보조 모니터에 떴다" if not primary else "주 모니터에 떴다(RL3D_DEV_MONITOR 가 안 들었다)")
        else:
            lines.append("[OK] 모니터가 %d개라 위치는 재지 않았다" % monitors)
        got = False
        while time.time() - t0 < DATA_TIMEOUT_S and not got:
            time.sleep(0.5)
            got = data_seen(t0)
        took = time.time() - t0
        say(got, ("발사 데이터가 들어왔다 %.1f초" % took
                  + (" (느림 — 보통 %d초 안. 네트워크를 본다)" % DATA_EXPECT_S if took > DATA_EXPECT_S else ""))
            if got else "%d초(앱의 네트워크 최악 + 10초) 안에 발사 데이터 로그가 없다 — 폴백도 안 탔다: "
                        "앱이 데이터 단계에서 멈췄다" % DATA_TIMEOUT_S)
        time.sleep(SETTLE_S)

    t1 = time.time()
    if kill:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    else:
        for h, _ in wins:
            user32.PostMessageW(h, WM_CLOSE, 0, 0)
    try:
        rc = proc.wait(CLOSE_TIMEOUT_S)
        say(kill or rc == 0, "%s 종료 rc %s %.1f초" % ("강제" if kill else "정상", rc, time.time() - t1))
    except subprocess.TimeoutExpired:
        say(False, "%d초 안에 안 끝났다 — 강제 종료한다" % CLOSE_TIMEOUT_S)
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    time.sleep(1)   # 부트로더가 임시 폴더를 지우는 시간

    left = rl3d_count()
    say(left == 0, "남은 RL3D 프로세스 %d" % left)
    new = sorted(mei_dirs() - before)
    say(not new, "남은 새 _MEI %d개" % len(new) + ("" if not new else " — 지운다: " + ", ".join(os.path.basename(p) for p in new)))
    for p in new:
        subprocess.run(["cmd", "/c", "rmdir", "/s", "/q", p], capture_output=True)

    probs = log_problems(t0)
    if probs is None:
        say(False, "로그 파일이 없다: %s" % LOG)
    else:
        say(not probs, "이번 실행 로그의 WARNING 이상 %d줄" % len(probs) + "".join("\n       " + p[:160] for p in probs[:5]))
    return ok, lines


def main(argv):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = [a for a in argv[1:] if not a.startswith("--")]
    ok, lines = run(args[0] if args else DEFAULT_EXE, kill="--kill" in argv)
    print("\n".join(lines))
    print("[OK] exe 스모크 통과" if ok else "[FAIL] exe 스모크 실패")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
