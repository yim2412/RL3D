"""백테스트 — 감사 도구를 **실제 과거 사고**로 채점한다(전면 감사 1단계, 2026-09-24).

    python docs/audit/backtest.py

지금까지의 확인(selftest·되돌리는 변이)은 전부 *내가 넣은 위반* 이라 순환이다. 여기서는
CLAUDE.md·CHANGELOG 에 적힌 실제 결함 사건의 **수정 직전 커밋**을 `git worktree` 로 꺼내,
HEAD 의 새 도구(정적 스캔·고장 매트릭스·문서 수치 대조표)를 돌려 그 사건을 잡는지 본다.

⚠ 한계를 먼저 적는다: 도구는 이 사건들을 **알고 나서** 만들었다. 그래서 잡힌 것도 "그 사건을
보고 만든 검사가 그 사건을 잡았다"일 수 있다 — 적중률은 상한으로 읽는다. 못 잡은 것이 진짜 정보다.
worktree 는 scratchpad(환경변수 RL3D_BT_DIR)에 만들고 끝나면 지운다.
"""
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BT = os.environ.get("RL3D_BT_DIR") or os.path.join(os.environ.get("TEMP", "/tmp"), "rl3d_backtest")

# (사건, 수정 커밋, 신호 정규식 — 도구 출력의 FAIL 줄 중 이것에 맞는 것이 있으면 "잡힘", 출처)
CASES = [
    ("캐시 스키마를 안 올려 아카이브에서 새 필드가 영원히 빠짐", "ba63a5c", r"schema|SCHEMA|스키마", "CLAUDE.md API 규칙"),
    ("CI 러너 UTC 에서 시간대 테스트 4건 실패", "d7dd417", r"TZ|시간대", "CLAUDE.md 검증"),
    ("오늘 밤 탭이 Set.includes 로 도입 이래 죽어 있었음", "8bf82e7", r"includes|tonight", "CLAUDE.md 검증"),
    ("상세 패널이 타임라인을 덮어 클릭을 못 받음 (P34)", "bac3032", r"ui-top", "CLAUDE.md 레이아웃"),
    ("글자 대비 미달 — color(srgb) 를 못 읽음 (P37)", "769c33a", r"contrast|대비", "CLAUDE.md 레이아웃"),
    ("브릿지 인자가 LL2 를 때리고 빈 결과를 영구 캐시 (P38)", "57bae51", r"archive .*(RAISE|WIPE)|get_archive\(0", "CLAUDE.md 브릿지"),
    ("문서 파일 개수·Phase 제목이 코드와 어긋남 (P32)", "988d2da", r"문서 수치.*FAIL|FAIL.*↔", "CLAUDE.md 문서"),
    ("문서 테스트가 로컬에만 있는 생성물에 기댐", "a284734", r"RL3D\.spec", "CLAUDE.md 검증"),
    ("변이된 코드가 저장소에 들어감 (P48)", "94b7633", r"mutation-residue", "CLAUDE.md API 규칙"),
    ("연결이 끊기는 방식 7종에서 캐시 폴백이 건너뛰어짐 (P29-1)", "c49b474",
     r"(offline|429|403|incomplete)\s+\S+\s+RAISE", "test_cache.py TestNetworkErrorKinds"),
    ("CI 콘솔 cp1252 에서 스모크의 한글 print 가 죽음", "51f227f", r"encoding", "커밋 51f227f"),
    ("save_settings 가 open('w') 로 잘라 설정이 통째로 사라짐 (P22-1)", "54cdaf8", r"settings|truncate|원자", "커밋 54cdaf8"),
]

TOOLS = ["tools/audit_scan.py", "tools/audit_allow.json", "docs/audit/probes/fault_matrix.py",
         "tests/test_docs.js", "tests/harness.js"]


def sh(args, cwd, timeout=600):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=timeout,
                       env=dict(os.environ, PYTHONIOENCODING="utf-8"))
    return r.returncode, r.stdout + r.stderr


def signals(commit):
    """그 커밋 트리에 HEAD 도구를 얹어 돌린 FAIL 줄 집합(줄 번호·건수는 지워 비교 가능하게)."""
    wt = os.path.join(BT, commit)
    if os.path.exists(wt):
        sh(["git", "worktree", "remove", "--force", wt], ROOT)
    rc, out = sh(["git", "worktree", "add", "--detach", wt, commit], ROOT)
    if rc:
        raise RuntimeError("worktree 실패: " + out[-200:])
    try:
        for t in TOOLS:   # HEAD 의 도구를 과거 트리에 얹는다
            dst = os.path.join(wt, t)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(os.path.join(ROOT, t), dst)
        fails = []
        _, o = sh([sys.executable, "tools/audit_scan.py"], wt)
        fails += [l for l in o.splitlines() if "[FAIL]" in l or l.startswith("         ")]
        _, o = sh([sys.executable, "docs/audit/probes/fault_matrix.py"], wt)
        fails += [l for l in o.splitlines() if "[FAIL]" in l]
        _, o = sh(["node", "tests/test_docs.js"], wt)
        sect = o.split("문서 수치 ↔ 코드 상수")[-1] if "문서 수치 ↔ 코드 상수" in o else ""
        fails += ["문서 수치 " + l for l in sect.splitlines() if "FAIL " in l and "건수 하한" not in l]
        norm = lambda l: re.sub(r"\d+", "#", l.strip())
        return {norm(l): l.strip() for l in fails}
    finally:
        sh(["git", "worktree", "remove", "--force", wt], ROOT)


def run_case(label, fix, pattern):
    """적중 = 수정 직전에는 있고 **수정 커밋에서는 사라진** FAIL 중 사건 패턴에 맞는 것.

    처음엔 수정 직전의 FAIL 만 봤다 — 12건 중 3건이 HEAD 에도 있는 무관한 FAIL(건수 하한·
    다른 경로의 RAISE)에 맞아 **거짓 적중**이었다(6/12 → 차분으로 다시 잼). 도구는 관대해지는
    방향으로 틀린다.
    """
    base = sh(["git", "rev-parse", "--short", fix + "^"], ROOT)[1].strip()
    try:
        before, after = signals(base), signals(fix)
    except RuntimeError as e:
        return base, None, str(e)
    gone = [v for k, v in before.items() if k not in after]
    hit = [l for l in gone if re.search(pattern, l)]
    return base, bool(hit), (hit[0][:110] if hit else f"수정으로 사라진 FAIL {len(gone)}줄 중 관련 없음")


def main():
    os.makedirs(BT, exist_ok=True)
    caught = 0
    for label, fix, pat, src in CASES:
        base, hit, note = run_case(label, fix, pat)
        caught += bool(hit)
        mark = "잡힘" if hit else ("오류" if hit is None else "못 잡음")
        print(f"  [{mark:^4}] {fix}^={base}  {label}\n           {note}")
    print(f"\n백테스트 적중: {caught}/{len(CASES)}")
    sh(["git", "worktree", "prune"], ROOT)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
