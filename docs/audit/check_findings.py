"""발견 대장·COVERAGE 규약 검사기 — 전면 감사(2026-09-24).

    python docs/audit/check_findings.py              # [OK]/[FAIL]
    python docs/audit/check_findings.py --selftest   # 규칙마다 위반을 주입해 FAIL 이 나는지

규약을 문서로만 두면 지켜지지 않는다(국방 00_PROTOCOL 6절의 교훈). 여기서 기계로 막는 것:
  · 항목 필드가 다 있고 값이 정해진 목록 안에 있다
  · **재현 없는 발견은 `높음` 이상 금지** · 근거가 `실측` 이 아니면 `높음` 이상 금지
  · 위치의 앵커 텍스트가 **지금 그 파일에 실제로 있다**(이미 고쳐진 것을 1순위로 올리지 않게)
  · `완료` 는 `결과:`, `기각` 은 `사유:` 가 있다
  · COVERAGE.md 가 추적 파일을 전부 덮는다(누락) · 없는 파일을 적지 않았다(유령)
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

FIELDS = ["위치", "근거", "이력", "심각도", "재현", "반증조건", "수정비용", "대상", "요약"]
ENUMS = {
    "근거": {"실측", "인용", "추정"},
    "심각도": {"치명", "높음", "중간", "낮음", "판단필요"},
    "수정비용": {"소", "중", "대"},
}
STATES = {"미처리", "수정중", "완료", "기각"}
# 영역 이름에 "·" 가 들어갈 수 있다(코드·로직) — 마지막 " · 상태:" 로 가른다
HEAD = re.compile(r"^### (F-\d{3}) · 영역: (.+) · 상태: (\S+)\s*$")
# COVERAGE 대상에서 빼는 것 — 사람이 읽을 코드가 아닌 것(사유가 곧 이 주석이다)
COVERAGE_SKIP = ("tests/fixtures/", "tests/golden/", "web/lib/", "docs/audit/", "docs/notes/")


def tracked(root):
    out = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True,
                         encoding="utf-8", errors="replace").stdout.splitlines()
    return [p for p in out if p and not p.startswith(COVERAGE_SKIP)]


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def parse(text):
    items, cur, fence = [], None, False
    for line in text.splitlines():
        if line.startswith("```"):   # 형식 견본은 코드 블록 안에 있다
            fence = not fence
            continue
        if fence:
            continue
        m = HEAD.match(line)
        if m:
            cur = {"id": m.group(1), "영역": m.group(2).strip(), "상태": m.group(3), "_f": {}}
            items.append(cur)
            continue
        if line.startswith("### F-"):
            items.append({"id": line, "_bad_head": True, "_f": {}})
            cur = None
            continue
        if cur is not None:
            fm = re.match(r"^- (\S+?):\s*(.*)$", line)
            if fm:
                cur["_f"][fm.group(1)] = fm.group(2).strip()
    return items


def check(root, files=None):
    errs = []
    fpath = os.path.join(root, "docs", "audit", "FINDINGS.md")
    items = parse(read(fpath))
    ids = []
    for it in items:
        if it.get("_bad_head"):
            errs.append(f"머리 형식이 틀렸다: {it['id']}")
            continue
        i, f = it["id"], it["_f"]
        ids.append(i)
        if it["상태"] not in STATES:
            errs.append(f"{i}: 상태 '{it['상태']}' 는 {sorted(STATES)} 밖")
        for k in FIELDS:
            if not f.get(k):
                errs.append(f"{i}: 필드 '{k}' 없음")
        for k, allowed in ENUMS.items():
            v = f.get(k, "").split()[0] if f.get(k) else ""
            if v and v not in allowed:
                errs.append(f"{i}: {k} '{v}' 는 {sorted(allowed)} 밖")
        sev = (f.get("심각도") or "").split()[0] if f.get("심각도") else ""
        if sev in ("치명", "높음"):
            rep = f.get("재현", "")
            m = re.search(r"docs/audit/probes/\S+?\.py", rep)
            if not m or not os.path.exists(os.path.join(root, m.group(0))):
                errs.append(f"{i}: 심각도 {sev} 인데 재현 프로브가 없다(재현 없는 발견은 높음 이상 금지)")
            if not (f.get("근거") or "").startswith("실측"):
                errs.append(f"{i}: 심각도 {sev} 인데 근거가 실측이 아니다")
        if not re.match(r"^(\[신규\]|\[기존)", f.get("이력", "")):
            errs.append(f"{i}: 이력은 [신규] 또는 [기존: …]")
        # 위치 앵커 — `path:line` — `앵커`   (완료·기각은 코드가 바뀌었으니 보지 않는다)
        loc = f.get("위치", "")
        lm = re.match(r"^`([^`:]+)(?::(\d+))?`\s*—\s*`(.+)`", loc)
        if not lm:
            errs.append(f"{i}: 위치 형식은 `path:line` — `앵커 텍스트`")
        elif it["상태"] in ("미처리", "수정중"):
            p = os.path.join(root, lm.group(1))
            if not os.path.exists(p):
                errs.append(f"{i}: 위치 파일 없음 {lm.group(1)}")
            elif lm.group(3) not in read(p):
                errs.append(f"{i}: 앵커가 파일에 없다(이미 고쳐졌나?) — {lm.group(3)[:40]}")
        if it["상태"] == "완료" and not f.get("결과"):
            errs.append(f"{i}: 완료인데 결과: 없음")
        if it["상태"] == "기각" and not f.get("사유"):
            errs.append(f"{i}: 기각인데 사유: 없음")
    if len(set(ids)) != len(ids):
        errs.append("F 번호 중복")
    # COVERAGE
    cpath = os.path.join(root, "docs", "audit", "COVERAGE.md")
    cov = set(re.findall(r"^\| `([^`]+)` \|", read(cpath), re.M))
    files = tracked(root) if files is None else files
    missing = [p for p in files if p not in cov]
    ghosts = [p for p in cov if not os.path.exists(os.path.join(root, p))]
    if missing:
        errs.append(f"COVERAGE 누락 {len(missing)}: {missing[:6]}")
    if ghosts:
        errs.append(f"COVERAGE 유령 {len(ghosts)}: {ghosts[:6]}")
    return items, errs


def selftest():
    items, base = check(ROOT)
    if base:
        print(f"[FAIL] selftest: 기준이 이미 FAIL — {base[:3]}")
        return 1
    good = ("### F-900 · 영역: 테스트 · 상태: 미처리\n"
            "- 위치: `api_client.py:1` — `import`\n- 근거: 실측\n- 이력: [신규]\n- 심각도: 높음\n"
            "- 재현: docs/audit/probes/fault_matrix.py\n- 반증조건: x\n- 수정비용: 소\n- 대상: x\n- 요약: x\n")
    # 대조군이 맨 앞 — 정상 견본이 오류를 내면 아래 경우가 전부 공허하게 "잡힘"이 된다
    cases = {
        "대조군(정상)": good,
        "재현 없는 높음": good.replace("docs/audit/probes/fault_matrix.py", "없음"),
        "추정인 높음": good.replace("근거: 실측", "근거: 추정"),
        "필드 누락": good.replace("- 반증조건: x\n", ""),
        "사라진 앵커": good.replace("`import`", "`절대로 없는 앵커 텍스트 zzz`"),
        "상태 오타": good.replace("상태: 미처리", "상태: 끝"),
        "완료에 결과 없음": good.replace("상태: 미처리", "상태: 완료"),
        "이력 없음": good.replace("[신규]", "새것"),
    }
    ok = True
    for name, block in cases.items():
        tmp = tempfile.mkdtemp(prefix="chkf_")
        try:
            os.makedirs(os.path.join(tmp, "docs", "audit", "probes"))
            for f in ("FINDINGS.md", "COVERAGE.md"):
                shutil.copyfile(os.path.join(HERE, f), os.path.join(tmp, "docs", "audit", f))
            shutil.copyfile(os.path.join(HERE, "probes", "fault_matrix.py"),
                            os.path.join(tmp, "docs", "audit", "probes", "fault_matrix.py"))
            shutil.copyfile(os.path.join(ROOT, "api_client.py"), os.path.join(tmp, "api_client.py"))
            with open(os.path.join(tmp, "docs", "audit", "FINDINGS.md"), "a", encoding="utf-8") as fh:
                fh.write("\n" + block)
            _, errs = check(tmp, files=[])
            errs = [e for e in errs if "F-900" in e]
            if block is good:
                ok &= not errs
                print(f"  [{'OK' if not errs else 'FAIL'}]   {name}: 오류 {len(errs)}건 {errs[:1]}")
                continue
            hit = bool(errs)
            ok &= hit
            print(f"  [{'OK' if hit else 'FAIL'}]   {name}: {'잡힘' if hit else '못 잡음'}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    # COVERAGE 누락 — 가짜 추적 파일 하나
    _, errs = check(ROOT, files=tracked(ROOT) + ["없는/파일.py"])
    hit = any("누락" in e for e in errs)
    ok &= hit
    print(f"  [{'OK' if hit else 'FAIL'}]   COVERAGE 누락: {'잡힘' if hit else '못 잡음'}")
    print("[OK] selftest" if ok else "[FAIL] selftest")
    return 0 if ok else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    items, errs = check(ROOT)
    by = {}
    for it in items:
        by[it.get("상태")] = by.get(it.get("상태"), 0) + 1
    print(f"발견 {len(items)}건 {by}")
    for e in errs:
        print("  [FAIL] " + e)
    print("[OK] check_findings" if not errs else f"[FAIL] check_findings: {len(errs)}건")
    sys.exit(1 if errs else 0)
