"""정적 스캔 — 이 앱에서 **실제로 반복된 실수**를 검사 함수로 굳힌 것(전면 감사 1단계, 2026-09-24).

    python tools/audit_scan.py              # 스캔 → [OK]/[FAIL], 위반이 있으면 종료코드 1
    python tools/audit_scan.py --selftest   # 검사마다 위반 한 건을 임시 사본에 주입해 FAIL 이 나는지

왜 selftest 가 도구 안에 있나 — 이 프로젝트에서 측정 도구가 **스물한 번** 틀렸고, 전부
관대해지는 방향이었다(대상 목록이 비어 0건 → 초록 등). 사람이 기억해서 변이를 돌리는 것에
맡기지 않는다. 대상 개수 하한(`MIN_TARGETS`)도 같은 이유다.

허용 목록(`tools/audit_allow.json`)은 항목마다 `사유` 가 필수다 — 없으면 FAIL.
허용 목록은 검사가 관대해지는 통로라, 크기를 매번 출력에 찍어 늘면 diff 에 보이게 한다.
"""
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOW_PATH = os.path.join("tools", "audit_allow.json")

# 스캔 대상 개수 하한 — 목록이 비어 "문제 0건"으로 통과하는 것을 막는다.
# 검사 이름 → 하한. 2026-09-24 실측: encoding 11 · endpoint 30 · 변이흔적 38 · innerHTML 34 · bom 38.
MIN_TARGETS = {"audit-privacy": 5, "encoding": 8, "reassigned-import": 8, "endpoint-location": 25,
               "mutation-residue": 30, "innerHTML": 25, "bom": 30}

# 테스트가 재대입해서 격리하는 전역 — 이름 import 하면 재대입이 안 보인다(전역 8번).
# `global X` 로 재대입되는 것은 AST 로 자동으로 찾고, 여기는 **모듈 밖에서** 재대입되는 것.
REASSIGNED_FROM_OUTSIDE = {"api_client": {"CACHE_DIR", "_http_get", "SETTINGS_PATH"}}

# 인코딩을 받는 호출 — 키워드 encoding= 이 없고 바이너리 모드가 아니면 위반.
# 이름 호출(`open(...)`)과 속성 호출(`p.read_text(...)`)을 나눈다 — `webbrowser.open` 을
# 파일 open 으로 잡은 오탐이 첫 실행에서 나왔다.
ENCODING_NAMES = {"open"}
ENCODING_ATTRS = {"read_text", "write_text", "FileHandler", "RotatingFileHandler",
                  "read_csv", "to_csv"}

# 변이 도구가 남기는 흔적 — 커밋에 들어가면 안 된다(P48, 2026-09-24 실제로 들어갔다).
MUTATION_RESIDUE = [re.compile(r"!\(!"), re.compile(r"__noMutate"), re.compile(r"if not \(not ")]

# innerHTML 보간에서 안전으로 보는 형태 — 이스케이프 함수 호출.
SAFE_INTERP = re.compile(r"^\s*escapeHtml\(")


def tracked_files():
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True,
                         encoding="utf-8", errors="replace").stdout
    return [p for p in out.splitlines() if p]


def read(root, rel):
    with open(os.path.join(root, rel), "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def load_allow(root):
    path = os.path.join(root, ALLOW_PATH)
    if not os.path.exists(path):
        return [], []
    with open(path, "r", encoding="utf-8") as f:
        entries = json.load(f)
    bad = [e for e in entries if not str(e.get("사유", "")).strip()]
    return entries, bad


def allowed(allow, check, where):
    return any(e.get("check") == check and e.get("where") == where for e in allow)


# ── 검사들 — 각자 (대상 수, 위반 목록[(where, 설명)]) 을 돌려준다 ─────────────────

def check_encoding(root, files):
    """인코딩 미지정 파일 IO (전역 인코딩 절 1번)."""
    hits, n = [], 0
    for rel in files:
        if not rel.endswith(".py"):
            continue
        n += 1
        try:
            tree = ast.parse(read(root, rel))
        except SyntaxError as e:
            hits.append((rel, f"구문 오류로 못 읽음: {e}"))
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", None)
            kws = {k.arg for k in node.keywords}
            is_io = (isinstance(f, ast.Name) and name in ENCODING_NAMES) or                     (isinstance(f, ast.Attribute) and (name in ENCODING_ATTRS or
                     (name == "open" and getattr(f.value, "id", None) in {"io", "codecs"})))
            if is_io and "encoding" not in kws:
                mode = node.args[1] if len(node.args) > 1 else next(
                    (k.value for k in node.keywords if k.arg == "mode"), None)
                if isinstance(mode, ast.Constant) and "b" in str(mode.value):
                    continue
                # 테스트가 open 을 감싸 넘기는 래퍼(real_open(path, *a, **kw))는 인자를 그대로 넘긴다
                if any(isinstance(a, ast.Starred) for a in node.args) or None in kws:
                    continue
                hits.append((f"{rel}:{node.lineno}", f"{name}() 에 encoding= 없음"))
            if name in {"run", "Popen", "check_output"} and ("text" in kws or "universal_newlines" in kws) \
                    and "encoding" not in kws:
                hits.append((f"{rel}:{node.lineno}", f"subprocess.{name}(text=True) 에 encoding= 없음"))
    return n, hits


def check_reassigned_import(root, files):
    """재대입되는 전역의 이름 import (전역 8번 — 두 번 당했다)."""
    reassigned = {k: set(v) for k, v in REASSIGNED_FROM_OUTSIDE.items()}
    trees = {}
    for rel in files:
        if rel.endswith(".py"):
            try:
                trees[rel] = ast.parse(read(root, rel))
            except SyntaxError:
                continue
    for rel, tree in trees.items():
        mod = os.path.splitext(os.path.basename(rel))[0]
        for node in ast.walk(tree):
            if isinstance(node, ast.Global):
                reassigned.setdefault(mod, set()).update(node.names)
    hits = []
    for rel, tree in trees.items():
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module in reassigned:
                for a in node.names:
                    if a.name in reassigned[node.module]:
                        hits.append((f"{rel}:{node.lineno}", f"from {node.module} import {a.name} — 재대입이 안 보인다"))
    return len(trees), hits


def check_endpoint_location(root, files):
    """엔드포인트 URL 은 api_client.py 상단에만 (전역 6번의 이 앱 적용 지점)."""
    hits, n = [], 0
    url = re.compile(r"""["'](https?://[^"'\s]+)""")
    for rel in files:
        # 감사 도구 자신(가짜 URL·selftest 주입 문자열)은 앱 코드가 아니다 — 2026-09-24 에
        # docs/audit 가 추적되자마자 사본에서 FAIL 했다(로컬은 미추적이라 초록이었다)
        if not (rel.endswith(".py") or rel.endswith(".js")) or rel.startswith(("tests/", "docs/audit/")) \
                or rel.startswith("web/lib/") or rel in ("api_client.py", "tools/audit_scan.py"):
            continue
        n += 1
        for i, line in enumerate(read(root, rel).splitlines(), 1):
            s = line.strip()
            if s.startswith(("#", "//", "*")):
                continue
            for m in url.finditer(line):
                # 줄 번호가 아니라 URL 로 식별한다 — 허용 목록이 줄 이동에 깨지지 않게
                hits.append((f"{rel}|{m.group(1).split('{')[0]}", f"줄 {i}"))
    return n, hits


def check_mutation_residue(root, files):
    """변이 흔적 (P48)."""
    hits, n = [], 0
    for rel in files:
        if not (rel.endswith(".py") or rel.endswith(".js")) or rel.startswith("web/lib/") \
                or rel == "tools/audit_scan.py":
            continue
        n += 1
        for i, line in enumerate(read(root, rel).splitlines(), 1):
            for p in MUTATION_RESIDUE:
                if p.search(line):
                    hits.append((f"{rel}:{i}", f"변이 흔적 {p.pattern}"))
    return n, hits


def check_ui_top(root, files):
    """오버레이 top 은 var(--ui-top, 92px) — 92px 직접 쓰면 한 줄 툴바일 때만 맞다(P34)."""
    rel = "web/style.css"
    if rel not in files:
        return 0, [("web/style.css", "파일이 없다")]
    hits = []
    for i, line in enumerate(read(root, rel).splitlines(), 1):
        if re.search(r"\btop\s*:\s*92px", line):
            hits.append((f"{rel}:{i}", "top: 92px 직접 사용"))
    return 1, hits


def _statement_after(src, start):
    """start 부터 문장 끝까지 — 문맥 스택(템플릿·${}·따옴표·괄호)을 따라가 ; 에서 끊는다."""
    i, stack = start, []
    while i < len(src):
        c = src[i]
        top = stack[-1] if stack else None
        if top in ("`", '"', "'"):
            if c == "\\":
                i += 2
                continue
            if c == top:
                stack.pop()
            elif top == "`" and src.startswith("${", i):
                stack.append("${")
                i += 2
                continue
        elif c in "`\"'":
            stack.append(c)
        elif c in "([{":
            stack.append(c)
        elif c in ")]}":
            if stack:
                stack.pop()
            else:
                return src[start:i]
        elif c == ";" and not stack:
            return src[start:i]
        i += 1
    return src[start:]


def _interpolations(stmt):
    """템플릿 리터럴의 ${...} 식들."""
    out, i = [], 0
    while True:
        i = stmt.find("${", i)
        if i < 0:
            return out
        j, d = i + 2, 1
        while j < len(stmt) and d:
            d += {"{": 1, "}": -1}.get(stmt[j], 0)
            j += 1
        out.append(stmt[i + 2:j - 1])
        i = j


def check_innerhtml(root, files):
    """innerHTML 에 이스케이프 없이 들어가는 보간 (CLAUDE.md 프론트 2번 — XSS).

    판정은 '보간식이 escapeHtml( 로 시작하는가' 하나뿐이다. 숫자·내부 상수·이미 이스케이프된
    조각을 담은 변수는 **허용 목록에 사유를 적어** 통과시킨다 — 도구가 스스로 관대해지지 않게.
    """
    hits, n = [], 0
    for rel in files:
        if not rel.startswith("web/js/"):
            continue
        src = read(root, rel)
        for m in re.finditer(r"\.innerHTML\s*\+?=", src):
            n += 1
            line = src.count("\n", 0, m.start()) + 1
            for expr in _interpolations(_statement_after(src, m.end())):
                if not SAFE_INTERP.match(expr):
                    hits.append((rel, f"줄 {line}: {' '.join(expr.split())[:50]}"))
    return n, hits


def check_bat_ascii(root, files):
    """build.bat 은 ASCII · BOM 없음 (cmd 가 BOM 을 명령으로 읽는다)."""
    hits = []
    for rel in files:
        if rel.lower().endswith((".bat", ".cmd")):
            with open(os.path.join(root, rel), "rb") as f:
                b = f.read()
            if b.startswith(b"\xef\xbb\xbf"):
                hits.append((rel, "BOM"))
            elif any(x > 127 for x in b):
                hits.append((rel, "비 ASCII 바이트"))
    return 1, hits


def check_py_bom(root, files):
    """.py 에 BOM — 정규식 도구가 첫 줄에서 조용히 빗나간다."""
    hits, n = [], 0
    for rel in files:
        if rel.endswith((".py", ".js")) and not rel.startswith("web/lib/"):
            n += 1
            with open(os.path.join(root, rel), "rb") as f:
                if f.read(3) == b"\xef\xbb\xbf":
                    hits.append((rel, "BOM"))
    return n, hits


def check_audit_privacy(root, files):
    """감사 산출물에 개인정보(사용자명 경로·관측지 좌표)가 섞이지 않았나.

    관측지 좌표는 로컬 설정에서 **실행 시에만** 읽는다 — 값을 이 파일에 적으면 그 자체가 유출이다.
    """
    hits, n = [], 0
    pats = [re.compile(r"C:[\\/]+Users[\\/]+(?!<)[^\\/\s]+[\\/]", re.I)]
    coords = []
    settings = os.path.join(os.environ.get("APPDATA", ""), "RL3D", "settings.json")
    try:
        with open(settings, "r", encoding="utf-8") as f:
            obs = (json.load(f) or {}).get("observer") or {}
        for k in ("lat", "lon"):
            v = obs.get(k)
            if isinstance(v, (int, float)):
                coords.append(f"{v:.2f}")
    except (OSError, ValueError, AttributeError):
        pass
    # 추적 목록이 아니라 **디스크**를 훑는다 — 감사 산출물은 커밋 전에 쓰이고, 그때가 유출을
    # 막아야 할 때다(2026-09-24: 추적 목록만 보다가 대상 0건으로 초록이었다).
    on_disk = []
    base = os.path.join(root, "docs", "audit")
    for dp, _, fns in os.walk(base):
        if "__pycache__" in dp:
            continue
        on_disk += [os.path.relpath(os.path.join(dp, f), root).replace(os.sep, "/") for f in fns]
    for rel in sorted(set(on_disk) | {f for f in files if f.startswith("docs/audit/")}):
        if not os.path.exists(os.path.join(root, rel)):
            continue
        n += 1
        text = read(root, rel)
        for p in pats:
            if p.search(text):
                hits.append((rel, "사용자명이 든 경로"))
        for c in coords:
            if c in text:
                hits.append((rel, "관측지 좌표로 보이는 값"))
    return n, hits


CHECKS = [
    ("encoding", check_encoding, None),
    ("reassigned-import", check_reassigned_import, None),
    ("endpoint-location", check_endpoint_location, None),
    ("mutation-residue", check_mutation_residue, None),
    ("ui-top", check_ui_top, None),
    ("innerHTML", check_innerhtml, None),
    ("bat-ascii", check_bat_ascii, None),
    ("bom", check_py_bom, None),
    ("audit-privacy", check_audit_privacy, None),
]


# 파일별 상한으로 재는 검사 — 한 건씩 허용하면 목록이 곧 관대해지는 통로가 된다.
# 허용 항목 {"check", "where": 파일, "max": N, "사유"} — 늘면 FAIL, 줄면 "상한을 내려라" FAIL.
RATCHET = {"innerHTML"}


def ratchet(allow, name, hits, used):
    by_file = {}
    for where, why in hits:
        by_file.setdefault(where, []).append(why)
    real = []
    caps = {e.get("where"): e.get("max", 0) for e in allow if e.get("check") == name}
    for rel in sorted(set(by_file) | set(caps)):
        got, cap = len(by_file.get(rel, [])), caps.get(rel, 0)
        if rel in caps:
            used.add((name, rel))
        if got > cap:
            real.append((rel, f"{got}건 > 상한 {cap}: " + " / ".join(by_file[rel][:3])))
        elif got < cap:
            real.append((rel, f"{got}건 < 상한 {cap} — 줄었으면 상한을 내린다(래칫)"))
    return real


def scan(root, files, quiet=False):
    allow, bad_allow = load_allow(root)
    failed = []
    say = (lambda *a: None) if quiet else print
    say(f"허용 목록 {len(allow)}건 ({ALLOW_PATH})")
    if bad_allow:
        failed.append("allow")
        say(f"  [FAIL] 사유 없는 허용 {len(bad_allow)}건: {[e.get('where') for e in bad_allow]}")
    used = set()
    for name, fn, floor_key in CHECKS:
        n, hits = fn(root, files)
        real = []
        if name in RATCHET:
            real = ratchet(allow, name, hits, used)
        for where, why in ([] if name in RATCHET else hits):
            if allowed(allow, name, where):
                used.add((name, where))
            else:
                real.append((where, why))
        floor = MIN_TARGETS.get(name)
        if floor and n < floor:
            failed.append(f"{name}:floor")
            say(f"  [FAIL] {name}: 대상 {n}개 < 하한 {floor} — 스캔이 비었다")
        elif real:
            failed.append(name)
            say(f"  [FAIL] {name}: 대상 {n} · 위반 {len(real)}")
            for where, why in real:
                say(f"         {where}  {why}")
        else:
            say(f"  [OK]   {name}: 대상 {n} · 위반 0 (허용 {len(hits)})")
    stale = [e for e in allow if (e.get("check"), e.get("where")) not in used]
    if stale:
        failed.append("stale-allow")
        say(f"  [FAIL] 쓰이지 않는 허용 {len(stale)}건 — 지워야 한다: {[e.get('where') for e in stale]}")
    return failed


# ── selftest — 검사마다 위반을 주입해 FAIL 이 나는지 ───────────────────────────
INJECT = {
    "encoding": ("api_errors.py", "\ndef _x():\n    return open('a.txt').read()\n"),
    "reassigned-import": ("api_errors.py", "\nfrom api_client import CACHE_DIR\n"),
    "endpoint-location": ("main.py", "\n_X = 'https://example.com/api'\n"),
    "mutation-residue": ("web/js/utils.js", "\nif (!(!true)) {}\n"),
    "ui-top": ("web/style.css", "\n.x { top: 92px; }\n"),
    "innerHTML": ("web/js/utils.js", "\nfunction __t(el, v) { el.innerHTML = `<b>${v}</b>`; }\n"),
    "bat-ascii": ("build.bat", "\nrem \ud55c\uae00\n"),
    "bom": ("api_errors.py", None),
    "audit-privacy": ("docs/audit/_selftest.md", "C:\\Users\\someone\\AppData\n"),
}


def selftest():
    files = tracked_files()
    base = scan(ROOT, files, quiet=True)
    if base:
        print(f"[FAIL] selftest: 주입 전 기준이 이미 FAIL ({base}) — 먼저 초록으로 만든다")
        return 1
    ok = True
    for name, _, _ in CHECKS:
        rel, payload = INJECT[name]
        tmp = tempfile.mkdtemp(prefix="audit_scan_")
        try:
            audit_on_disk = [os.path.relpath(os.path.join(dp, f), ROOT).replace(os.sep, "/")
                             for dp, _, fns in os.walk(os.path.join(ROOT, "docs", "audit"))
                             if "__pycache__" not in dp for f in fns]
            for f in files + [ALLOW_PATH] + audit_on_disk:
                src = os.path.join(ROOT, f)
                if os.path.exists(src):
                    dst = os.path.join(tmp, f)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copyfile(src, dst)
            target = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if payload is None:
                with open(target, "rb") as f:
                    b = f.read()
                with open(target, "wb") as f:
                    f.write(b"\xef\xbb\xbf" + b)
            else:
                with open(target, "a", encoding="utf-8") as f:
                    f.write(payload)
            fl = files + ([rel] if rel not in files else [])
            got = scan(tmp, fl, quiet=True)
            hit = name in got
            ok &= hit
            print(f"  [{'OK' if hit else 'FAIL'}]   {name}: 주입 → {'FAIL 로 잡힘' if hit else '못 잡음 (검사가 존재하지 않는다)'}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    # 하한 — 대상이 비면 FAIL 이어야 한다
    got = scan(ROOT, [f for f in files if not f.startswith("web/js/")], quiet=True)
    hit = "innerHTML:floor" in got
    ok &= hit
    print(f"  [{'OK' if hit else 'FAIL'}]   하한: js 를 뺀 목록 → {'FAIL 로 잡힘' if hit else '못 잡음'}")
    print("[OK] selftest" if ok else "[FAIL] selftest")
    return 0 if ok else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    failed = scan(ROOT, tracked_files())
    print("[OK] audit_scan" if not failed else f"[FAIL] audit_scan: {failed}")
    sys.exit(1 if failed else 0)
