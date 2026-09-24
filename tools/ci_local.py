"""CI 의 `test` 잡을 로컬에서 그대로 돈다 — 푸시 전에 (P51).

    python tools/ci_local.py            # test 잡 전부
    python tools/ci_local.py --skip 레이아웃   # 이름에 그 글자가 든 단계는 건너뛴다
    python tools/ci_local.py --build    # build 잡도(빌드 + 번들 대조)

**왜**: 2026-09-24 하루에 두 번 CI 가 빨갰다 — 한 번은 푸시 뒤 CI 를 안 봐서, 한 번은
테스트 넷만 로컬에서 돌리고 정적 스캔·감사 대장 검사를 빠뜨려서. *"푸시 전에 전 단계를
돌린다"* 는 사람이 기억하는 규칙이고, 그런 규칙은 바쁠 때 안 지켜진다(P48 과 같은 결론).

**단계 목록은 워크플로 파일에서 읽는다.** 여기에 손으로 적으면 CI 에 단계를 더할 때
이쪽이 뒤처진다 — 그게 정확히 오늘의 사고였다. PyYAML 에는 기대지 않는다(venv 에 우연히
깔려 있을 뿐 어떤 의존성도 요구하지 않는다) — 이 워크플로 모양만 읽는 작은 파서를 둔다.
"""
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "tests.yml")
# 이보다 적게 읽혔으면 파서가 틀린 것이다(지금 test 잡의 실행 단계 9개) — 0개면 공허한 초록이다
MIN_STEPS = 6
SKIP_RUN = re.compile(r"^\s*(python -m )?pip install|^\s*python -m pip install")


def parse_jobs(text):
    """{잡 이름: [(단계 이름, [명령 줄...]), ...]} — `run:` 이 있는 단계만."""
    jobs, job, step = {}, None, None
    in_jobs = False
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        ln = lines[i]
        if re.match(r"^jobs:\s*$", ln):
            in_jobs = True
        elif in_jobs and re.match(r"^  ([\w-]+):\s*$", ln):
            job = re.match(r"^  ([\w-]+):", ln).group(1)
            jobs[job] = []
            step = None
        elif job and re.match(r"^      - ", ln):
            m = re.match(r"^      - name:\s*(.+?)\s*$", ln)
            step = [m.group(1) if m else "(이름 없음)", []]
            jobs[job].append(step)
        elif step is not None and re.match(r"^        name:\s*", ln):
            step[0] = re.sub(r"^        name:\s*", "", ln).strip()
        elif step is not None and re.match(r"^        run:\s*", ln):
            body = re.sub(r"^        run:\s*", "", ln).strip()
            if body == "|":
                i += 1
                while i < len(lines) and (lines[i].startswith("          ") or not lines[i].strip()):
                    if lines[i].strip():
                        step[1].append(lines[i].strip())
                    i += 1
                continue
            step[1].append(body)
        i += 1
    return {k: [s for s in v if s[1]] for k, v in jobs.items()}


def localize(cmd):
    """러너의 `python` 을 이 venv 의 파이썬으로 — 로컬 PATH 의 파이썬은 다른 것일 수 있다."""
    # 치환은 **함수로** 한다 — 문자열로 주면 경로의 `\U`(C:\Users)가 이스케이프로 읽혀 죽는다(실제로 그랬다)
    return re.sub(r"^python(?=\s)", lambda _: '"%s"' % sys.executable, cmd)


def run_job(name, steps, skip):
    ok_all = True
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    for title, cmds in steps:
        if any(s in title for s in skip):
            print("[SKIP] %s" % title)
            continue
        cmds = [c for c in cmds if not SKIP_RUN.search(c)]
        if not cmds:
            continue
        t0 = time.time()
        failed = None
        for c in cmds:
            r = subprocess.run(localize(c), shell=True, cwd=ROOT, env=env,
                               capture_output=True, text=True, encoding="utf-8", errors="replace")
            if r.returncode != 0:
                failed = (c, (r.stdout + r.stderr).strip().splitlines()[-6:])
                break
        dt = time.time() - t0
        if failed:
            ok_all = False
            print("[FAIL] %s (%.1fs) — %s" % (title, dt, failed[0]))
            for tail in failed[1]:
                print("         " + tail)
        else:
            print("[OK]   %s (%.1fs)" % (title, dt))
    return ok_all


def main(argv):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    skip = [argv[i + 1] for i, a in enumerate(argv) if a == "--skip" and i + 1 < len(argv)]
    with open(WORKFLOW, "r", encoding="utf-8") as f:
        jobs = parse_jobs(f.read())
    test = jobs.get("test", [])
    if len(test) < MIN_STEPS:
        print("[FAIL] 워크플로에서 test 단계를 %d개만 읽었다 — 파서가 틀렸다(공허한 초록 방지)" % len(test))
        return 1
    print("test 잡 %d단계 (워크플로에서 읽음)" % len(test))
    ok = run_job("test", test, skip)
    if "--build" in argv:
        print("build 잡 %d단계" % len(jobs.get("build", [])))
        ok = run_job("build", jobs.get("build", []), skip) and ok
    print("[OK] ci_local — 푸시해도 된다" if ok else "[FAIL] ci_local — 푸시 전에 고친다")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
