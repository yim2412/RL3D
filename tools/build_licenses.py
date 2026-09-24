"""THIRD_PARTY_LICENSES.txt 생성 — exe 에 함께 들어가는 서드파티의 라이선스 전문(전면 감사 F-016).

    .venv\\Scripts\\python.exe tools/build_licenses.py

왜: MapLibre(BSD-3)·pywebview(BSD-3)·pycparser(BSD-3)는 **바이너리 재배포 때** 고지·조건·면책을
"배포물과 함께" 요구한다. 예전에는 번들 JS 헤더의 URL 과 README 의 이름뿐이었다.

어디서: 파이썬 패키지는 **빌드 venv 에 설치된 메타데이터**에서 그대로 읽는다(버전이 exe 와 같다).
JS 두 개와 Natural Earth 는 네트워크 없이 쓰도록 `tools/licenses/` 에 원문을 둔다
(MapLibre v4.7.1 LICENSE.txt · satellite.js 5.0.0 LICENSE.md — 번들 버전과 같은 태그에서 받았다).

어떤 패키지를 넣나: `build/RL3D/PYZ-00.toc` 로 실제 번들을 확인한 목록(2026-09-24). 새 의존성을
더하면 여기에도 더한다 — 빠지면 아래 `--check` 가 FAIL 한다.
"""
import glob
import importlib.metadata as md
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "THIRD_PARTY_LICENSES.txt")
LOCAL = os.path.join(ROOT, "tools", "licenses")

# exe 에 들어가는 파이썬 배포판(PyPI 이름) — 빌드 도구(pyinstaller·pefile 등)는 들어가지 않는다
BUNDLED = ["pywebview", "bottle", "proxy_tools", "pythonnet", "clr_loader", "cffi", "pycparser",
           "typing_extensions"]
JS = [("MapLibre GL JS v4.7.1", "maplibre-gl-js.LICENSE.txt"),
      ("satellite.js v5.0.0", "satellite-js.LICENSE.md")]


def dist_license(name):
    d = md.distribution(name)
    texts = []
    for f in d.files or []:
        base = os.path.basename(str(f)).upper()
        if re.match(r"^(LICEN[CS]E|COPYING|NOTICE)", base):
            p = d.locate_file(f)
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8", errors="replace") as fh:
                    texts.append(fh.read().strip())
    if not texts:
        lic = d.metadata.get("License-Expression") or d.metadata.get("License") or ""
        texts.append(lic.strip() or "(라이선스 파일 없음 — 메타데이터에도 없음)")
    return d.version, "\n\n".join(texts)


def build():
    parts = ["RL3D 에 함께 배포되는 서드파티 소프트웨어의 라이선스 전문.",
             "이 파일은 tools/build_licenses.py 가 생성한다 — 손으로 고치지 않는다.", ""]
    for title, fn in JS:
        with open(os.path.join(LOCAL, fn), "r", encoding="utf-8") as f:
            parts += ["=" * 78, title, "=" * 78, f.read().strip(), ""]
    parts += ["=" * 78, "Natural Earth (web/lib/ne_land.js)", "=" * 78,
              "Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.",
              "Natural Earth 데이터는 퍼블릭 도메인이다.", ""]
    parts += ["=" * 78, "Python %d.%d 런타임" % sys.version_info[:2], "=" * 78,
              "Python Software Foundation License — https://docs.python.org/3/license.html", ""]
    for name in BUNDLED:
        ver, text = dist_license(name)
        parts += ["=" * 78, "%s %s (Python 패키지)" % (name, ver), "=" * 78, text, ""]
    return "\n".join(parts) + "\n"


def check():
    """번들 목록이 실제 빌드와 맞는가 — 빌드 기록이 있을 때만 잰다."""
    toc = os.path.join(ROOT, "build", "RL3D", "PYZ-00.toc")
    if not os.path.exists(toc):
        print("[OK] 빌드 기록이 없어 대조를 건너뛴다")
        return 0
    with open(toc, "r", encoding="utf-8", errors="replace") as f:
        mods = set(m.split(".")[0] for m in re.findall(r"\('([A-Za-z_][\w.]*)'", f.read()))
    top = {"pywebview": "webview", "pythonnet": "pythonnet", "clr_loader": "clr_loader",
           "proxy_tools": "proxy_tools", "typing_extensions": "typing_extensions"}
    known = {top.get(n, n) for n in BUNDLED} | {"clr"}
    third = {m for m in mods if m in {"webview", "bottle", "proxy_tools", "pythonnet", "clr_loader", "cffi",
                                      "pycparser", "typing_extensions", "clr", "PIL", "yaml", "winotify"}}
    missing = sorted(third - known)
    print(("[FAIL] 번들에 있는데 라이선스 목록에 없다: %s" % missing) if missing else "[OK] 번들 목록과 일치")
    return 1 if missing else 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if "--check" in sys.argv:
        sys.exit(check())
    text = build()
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print("[OK] %s (%d줄)" % (os.path.relpath(OUT, ROOT), text.count("\n")))
    sys.exit(check())
