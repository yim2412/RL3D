"""공개 글 말투 검사 — README·CHANGELOG·릴리스 글 같은 마크다운을 잰다.

    python check_public_text.py                    # 기본 대상(README.md · CHANGELOG.md)
    python check_public_text.py README.md docs     # 파일·폴더 지정(폴더는 안의 .md 전부)
    python check_public_text.py --selftest         # 검사가 정말 잡는지 먼저 확인

결과는 [OK]/[FAIL] 로 찍고, 하나라도 FAIL 이면 종료 코드 1.
"""
import re
import sys
from pathlib import Path

# ── 설정(프로젝트마다 여기만 고친다) ─────────────────────────────
DEFAULT_TARGETS = ["README.md", "CHANGELOG.md"]
# 줄표(—) 상한. 파일마다 지금 개수를 적고, 고쳐서 줄면 상한도 내린다(0 을 향해).
# 여기 없는 파일은 0 이다.
DASH_MAX = {"README.md": 1}   # README 의 1 은 제목 부제(규칙 2 가 허용)
# 0 이어야 하는 위반의 임시 상한(RL3D 만의 추가 · P114). 2,047줄 CHANGELOG 를 바퀴마다 나눠 고치는 동안
# CI 가 고친 만큼을 지키게 한다. 줄표 상한처럼 내리기만 하고, 0 이 되면 항목을 지운다(여기 없으면 0)
HARD_MAX = {}   # 2026-11-26 CHANGELOG 를 0 으로 만들고 비웠다
# 어색한 말 · 이중 피동(국립국어원 기준)
BANNED = ("먹혔", "먹힌", "되어집", "되어져", "잊혀지")
# 이 표시가 있는 줄은 안 본다(규칙 문서 안의 "나쁜 예" 같은 곳)
IGNORE_MARK = "style-ignore"
# ─────────────────────────────────────────────────────────────

_END = re.compile(r"([가-힣]?)([가-힣])다\.(?=\s|$|<|\"|\)|\*)")
_DOT = re.compile(r"(니다|세요)\.?\s*·")
_INLINE_CODE = re.compile(r"`[^`]*`")
_URL = re.compile(r"https?://\S+")


def _is_formal(m):
    """'~ㅂ니다.' 이면 합쇼체 — '니' 앞 글자 받침이 ㅂ."""
    a, b = m.group(1), m.group(2)
    return b == "니" and bool(a) and (ord(a) - 0xAC00) % 28 == 17


def _strip_inline_code(line, open_):
    """인라인 코드를 지운 줄과, 줄 끝에서 코드가 아직 열려 있는지.

    마크다운의 인라인 코드는 줄을 넘어 이어질 수 있다(빈 줄에서 끝난다). 줄마다 따로 보면
    두 줄에 걸친 인용 안의 줄표와 끝맺음을 위반으로 센다(RL3D P114 에서 README · CHANGELOG 두 번).
    """
    out, i = [], 0
    while i < len(line):
        j = line.find("`", i)
        if j < 0:
            if not open_:
                out.append(line[i:])
            break
        if not open_:
            out.append(line[i:j])
        open_ = not open_
        i = j + 1
    return "".join(out), open_


def check_text(text):
    """→ (0 이어야 하는 위반 [(줄 번호, 내용)], 줄표 개수)"""
    hard, dash, in_code, in_tick = [], 0, False, False
    # 짝 없는 백틱 하나가 문단의 나머지를 검사에서 통째로 빼면 관대해진다 → 문단이 끝날 때 열려 있으면 위반으로 센다
    unclosed = "닫히지 않은 인라인 코드(짝 없는 백틱) → 문단의 나머지가 검사에서 빠집니다"
    lines = text.splitlines()
    for no, line in enumerate(lines, 1):
        if line.lstrip().startswith("```"):
            if in_tick:
                hard.append((no, unclosed))
            in_code = not in_code
            in_tick = False
            continue
        if not line.strip():
            if in_tick:
                hard.append((no, unclosed))
            in_tick = False          # 빈 줄에서 문단이 끝나면 열린 인라인 코드도 끝난다
        if in_code:
            continue
        stripped, in_tick = _strip_inline_code(line, in_tick)
        if IGNORE_MARK in line:
            continue
        s = _URL.sub("", stripped)
        if not re.search("[가-힣]", s):
            continue
        dash += s.count("—")
        for m in _END.finditer(s):
            if not _is_formal(m):
                hard.append((no, f"해라체 끝맺음 '{m.group(0)}' → '~합니다/~입니다'"))
        for w in BANNED:
            if w in s:
                hard.append((no, f"금지어 '{w}'"))
        if _DOT.search(s):
            hard.append((no, "문장 뒤 가운뎃점(·) → 문장을 끊습니다"))
    if in_tick:
        hard.append((len(lines), unclosed))
    return hard, dash


def over_cap(n_hard, dash, hard_cap, dash_cap):
    """상한과 다른가. 같으면 통과, 넘어도 실패, **남아도 실패**.

    남는 상한을 알림으로만 두었더니 내리는 것을 잊고 위반 6건만큼 느슨한 채로 커밋했다(2026-11-26, P114).
    상한은 내리기만 하는 것이라, 남은 만큼이 곧 다시 늘어도 모르는 폭이다.
    """
    return n_hard != hard_cap or dash != dash_cap


def _files(args):
    out = []
    for a in args:
        p = Path(a)
        if p.is_dir():
            out += sorted(p.rglob("*.md"))
        elif p.exists():
            out.append(p)
        else:
            print(f"[FAIL] 없는 경로: {a}")
            out.append(None)
    return out


def selftest():
    planted = (
        "기록이 있습니다. 경기를 쓴다.\n"        # 해라체 1
        "득점률이 아니다.\n"                    # 해라체 1
        "1골 먹혔습니다.\n"                     # 금지어 1
        "다시 시도합니다 · 3장\n"               # 가운뎃점 1
        "괜찮습니다 — 이어서\n"                 # 줄표 1
        "`코드 안 — 쓴다.` 는 안 본다\n"         # 안 셈
        "```\n블록 안 — 쓴다.\n```\n"           # 안 셈
        "나쁜 예: 쓴다. <!-- style-ignore -->\n"  # 안 셈
        "예: `두 줄에 걸친 — 인용\n이어지는 줄도 쓴다.` 는 안 본다\n"   # 안 셈(줄을 넘는 인라인 코드)
        "\n"
        "`닫히지 않은 코드\n"
        "\n"
        "빈 줄 뒤는 다시 본다 — 여기.\n"
        "`코드 블록 앞에서 닫히지 않은 코드\n"
        "```\n블록\n```\n"
        "블록 뒤도 다시 본다 — 여기.\n"            # 줄표 1 → 코드 블록 경계에서도 열린 인라인 코드를 닫는다           # 줄표 1 · 해라체 아님(마침표 앞이 '기') → 닫히지 않은 코드가 다음 문단까지 먹지 않는다
        "정상입니다. 됩니다. 승·무·패\n"          # 안 셈
    )
    hard, dash = check_text(planted)
    ok = len(hard) == 6 and dash == 3
    eof_hard, _ = check_text("마지막 줄에서 `열린 채 끝남")   # 파일 끝에서 열린 코드도 위반
    eof_ok = len(eof_hard) == 1
    print(("[OK]" if eof_ok else "[FAIL]") + f" 파일 끝의 짝 없는 백틱: 위반 {len(eof_hard)}(기대 1)")
    ok = ok and eof_ok
    # 상한 판정: 같으면 통과, 넘으면 실패, 위반과 줄표는 따로 본다
    cases = [((352, 0, 352, 0), False), ((353, 0, 352, 0), True), ((0, 2, 0, 1), True),
             ((0, 1, 0, 1), False), ((1, 0, 0, 5), True),
             ((351, 0, 352, 0), True), ((0, 0, 0, 1), True)]   # 남는 상한도 실패
    cap_ok = all(over_cap(*a) == want for a, want in cases)
    print(("[OK]" if cap_ok else "[FAIL]") + " 상한 판정: 같으면 통과 · 넘거나 남으면 실패")
    ok = ok and cap_ok
    # 실제 경로(파일 읽기 → 상한 찾기 → 판정)가 상한 밖의 위반 1건에 실패하는가. 상한 조회를 끊어도 판정 함수는 멀쩡하다
    import contextlib, io, tempfile
    with tempfile.TemporaryDirectory() as d:
        probe = Path(d) / "probe_not_in_caps.md"
        probe.write_text("위반 하나를 쓴다.\n", encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            rc = main([str(probe)])
    path_ok = rc == 1
    print(("[OK]" if path_ok else "[FAIL]") + f" 실제 경로: 상한 밖 위반 1건 → 종료 코드 {rc}(기대 1)")
    ok = ok and path_ok
    print(("[OK]" if ok else "[FAIL]") + f" 자체 검사: 위반 {len(hard)}(기대 6, 닫히지 않은 코드 2 포함) · 줄표 {dash}(기대 3)")
    for no, msg in hard:
        print(f"       {no}: {msg}")
    return ok


def main(argv):
    if "--selftest" in argv:
        return 0 if selftest() else 1
    failed = False
    for f in _files(argv or DEFAULT_TARGETS):
        if f is None:
            failed = True
            continue
        hard, dash = check_text(f.read_text(encoding="utf-8-sig", errors="replace"))
        cap = DASH_MAX.get(f.as_posix(), DASH_MAX.get(f.name, 0))
        hcap = HARD_MAX.get(f.as_posix(), HARD_MAX.get(f.name, 0))
        bad = over_cap(len(hard), dash, hcap, cap)
        failed |= bad
        note = f"줄표 {dash}/상한 {cap}"
        if dash < cap:
            note += " (줄었습니다. DASH_MAX 를 지금 개수로 내려야 통과합니다)"
        hnote = f"위반 {len(hard)}" + (f"/임시 상한 {hcap}" if hcap else "")
        if len(hard) < hcap:
            hnote += " (줄었습니다. HARD_MAX 를 지금 개수로 내려야 통과합니다)"
        print(("[FAIL]" if bad else "[OK]") + f" {f.as_posix()}: {hnote} · {note}")
        for no, msg in hard[:15]:
            print(f"       {no}: {msg}")
        if len(hard) > 15:
            print(f"       … 외 {len(hard) - 15}건")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
