"""빌드된 exe 에 들어가야 할 것이 들어갔는지 대조한다 (P50).

    python tools/check_exe.py [dist/RL3D.exe]

**왜**: 2026-09-24 에 `build.bat` 이 깨진 채 세 커밋·약 7시간을 지나갔다(경로의 `\\b` 가
백스페이스로 커밋됐다). CI 는 테스트만 돌아 초록이었고, 릴리스 빌드를 준비하다 알았다.
빌드가 "성공"해도 **번들이 빠질 수 있다** — `--add-data` 한 줄이 틀리면 exe 는 만들어지고
실행하면 빈 창이다. 그래서 만들어졌는지가 아니라 **무엇이 들어갔는지**를 잰다.

기대 목록은 **소스 트리에서** 만든다(`web/` 아래 전부 + 라이선스 전문). exe 쪽 목록에서
긁어 오면 빠진 파일이 기대에서도 같이 사라져 검사가 공허하게 통과한다.

exe 가 실제로 뜨는지는 재지 않는다 — CI 러너에는 WebView2 가 없다(로컬 exe 스모크의 몫).
"""
import os
import sys

from PyInstaller.archive.readers import CArchiveReader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_EXE = os.path.join(ROOT, "dist", "RL3D.exe")
LICENSE = "THIRD_PARTY_LICENSES.txt"
# 이보다 적으면 기대 목록을 만드는 쪽이 틀린 것이다(현재 web/ 29개) — 목록이 비면 검사도 0건으로 초록이다
MIN_WEB_FILES = 20


def expected_entries(root=ROOT):
    """exe 안에 있어야 할 이름 → 원본 크기. PyInstaller 는 Windows 에서 `\\` 로 적는다."""
    out = {}
    web = os.path.join(root, "web")
    for d, _, files in os.walk(web):
        for f in files:
            full = os.path.join(d, f)
            rel = os.path.relpath(full, root).replace("/", "\\")
            out[rel] = os.path.getsize(full)
    lic = os.path.join(root, LICENSE)
    if os.path.exists(lic):
        out[LICENSE] = os.path.getsize(lic)
    else:
        out[LICENSE] = None   # 소스에 없어도 exe 에는 있어야 한다(build.bat 이 만든다)
    return out


def check(exe_path, root=ROOT):
    """(ok, 줄 목록). 줄은 `[OK]`/`[FAIL]` 로 시작한다."""
    lines = []
    if not os.path.exists(exe_path):
        return False, ["[FAIL] exe 없음: %s" % exe_path]
    arc = CArchiveReader(exe_path)
    have = set(arc.toc.keys())
    want = expected_entries(root)
    web_count = sum(1 for k in want if k.startswith("web\\"))
    ok = True
    if web_count < MIN_WEB_FILES:
        ok = False
        lines.append("[FAIL] 기대 목록이 너무 적다(web %d개) — 검사가 공허해진다" % web_count)
    missing = sorted(k for k in want if k not in have)
    if missing:
        ok = False
        lines.append("[FAIL] exe 에 빠진 파일 %d개: %s" % (len(missing), ", ".join(missing[:8])))
    else:
        lines.append("[OK] 번들 %d개 전부 들어 있다(web %d · 라이선스)" % (len(want), web_count))
    if LICENSE in have:
        size = len(arc.extract(LICENSE))
        if size < 1000:
            ok = False
            lines.append("[FAIL] %s 가 %dB — 비어 있다" % (LICENSE, size))
        else:
            lines.append("[OK] %s %dB" % (LICENSE, size))
    lines.append("[OK] exe %.2fMB · 항목 %d" % (os.path.getsize(exe_path) / 1e6, len(have)) if ok
                 else "[FAIL] exe 번들 검사 실패")
    return ok, lines


def main(argv):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    exe = argv[1] if len(argv) > 1 else DEFAULT_EXE
    ok, lines = check(exe)
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
