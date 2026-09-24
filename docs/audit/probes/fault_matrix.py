"""고장 주입 매트릭스 + 필드 퍼징 — 전면 감사 1단계 도구(2026-09-24).

    python docs/audit/probes/fault_matrix.py            # 매트릭스·퍼징 결과를 [OK]/[FAIL] 로
    python docs/audit/probes/fault_matrix.py --selftest # 판정기가 실패를 실패로 보는지

네트워크 0 · 결정론. `api_client._http_get` 을 갈아끼우고 캐시를 임시 폴더로 돌린다
(`tests/test_cache.py` 의 CacheTestBase 와 같은 수법 — 모듈 경유로 재대입한다, 전역 8번).

무엇을 재나 — 경로(호스트 셋, 다섯 함수) × 고장(예외 넷 + **200 인데 모양이 틀린 본문** 일곱)
× 캐시(없음/오래됨). `test_cache.py` 는 예외 12종을 **발사 경로에만** 재고, 200 본문은 안 잰다.

판정(칸마다):
  RAISE — 브릿지 너머로 예외가 올라간다(화면은 파이썬 예외 문구를 받거나 아무것도 못 받는다)
  LOST  — 캐시가 있었는데 결과가 비었다(가진 데이터를 버렸다)
  WIPE  — 고장 뒤 **캐시 파일이 빈 결과로 덮였다**(다음 실행도 빈 화면 — 지난 연도는 영구)
  RAW   — 오류 문구에 예외 이름이 그대로 나온다(사람 말이 아니다)
  SILENT— 고장인데 error 도 stale 도 없다(화면은 "정상, 0건"으로 읽는다)
"""
import copy
import http.client
import json
import logging
import os
import shutil
import sys
import tempfile
import time
import urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, ROOT)
import api_client    # noqa: E402
import api_parsing   # noqa: E402

FIX = os.path.join(ROOT, "tests", "fixtures")


def _fix(name):
    with open(os.path.join(FIX, name), "r", encoding="utf-8") as f:
        return f.read()


GOOD = {
    "ll2": _fix("ll2_upcoming.json"),
    "tle": _fix("celestrak_stations.txt"),
    "satcat": _fix("celestrak_satcat.csv"),
    "gh": json.dumps({"tag_name": "v9.9.9", "html_url": "https://github.com/x", "name": "v9.9.9"}),
}

# 경로: (이름, 호출, 결과에서 데이터를 꺼내는 함수, 캐시 파일, 좋은 본문 키)
PATHS = [
    ("launches", lambda: api_client.get_launches(force=True), lambda r: r.get("launches"), "launches.json", "ll2"),
    ("archive", lambda: api_client.get_archive(2024, force=True), lambda r: r.get("launches"), None, "ll2"),
    ("satellites", lambda: api_client.get_satellites(force=True, groups=["stations"]),
     lambda r: r.get("satellites"), None, "tle"),
    ("satcat", lambda: api_client.get_satcat(groups=["stations"], force=True), lambda r: r.get("satcat"), None, "satcat"),
    ("update", lambda: api_client.check_update("1.0.0", force=True), lambda r: r.get("latest"), None, "gh"),
]


def _exc(e):
    def f(url):
        raise e
    return f


def _body(b):
    return lambda url: b


FAULTS = [
    ("offline", _exc(urllib.error.URLError("refused"))),
    ("429", _exc(urllib.error.HTTPError("u", 429, "Too Many", None, None))),
    ("403", _exc(urllib.error.HTTPError("u", 403, "Forbidden", None, None))),
    ("incomplete", _exc(http.client.IncompleteRead(b"", 10))),
    ("200 empty", _body("")),
    ("200 html", _body("<html><body>Service Unavailable</body></html>")),
    ("200 null", _body("null")),
    ("200 []", _body("[]")),
    ("200 throttled", _body('{"detail": "Request was throttled. Expected available in 900 seconds."}')),
    ("200 results null", _body('{"count": 0, "next": null, "results": null}')),
    ("200 truncated", None),   # 좋은 본문의 앞 절반 — 경로마다 다르다
]

EXC_NAMES = ("Error", "Exception", "Traceback", "KeyError", "TypeError", "AttributeError")


class Sandbox:
    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="rl3d-fault-")
        self.saved = (api_client.APP_DIR, api_client.CACHE_DIR, api_client.SETTINGS_PATH,
                      api_client._http_get, api_client.ARCHIVE_PAGE_DELAY)
        api_client.APP_DIR = self.tmp
        api_client.CACHE_DIR = os.path.join(self.tmp, "cache")
        api_client.SETTINGS_PATH = os.path.join(self.tmp, "settings.json")
        api_client.ARCHIVE_PAGE_DELAY = 0
        if hasattr(api_client, "_reset_request_memory"):   # 백테스트는 옛 트리에서도 돈다
            api_client._reset_request_memory()
        return self

    def __exit__(self, *a):
        (api_client.APP_DIR, api_client.CACHE_DIR, api_client.SETTINGS_PATH,
         api_client._http_get, api_client.ARCHIVE_PAGE_DELAY) = self.saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cache_files(self):
        d = api_client.CACHE_DIR
        return {n: os.path.getsize(os.path.join(d, n)) for n in os.listdir(d)} if os.path.isdir(d) else {}


def _size(x):
    return len(x) if isinstance(x, (list, dict, str)) else (0 if x is None else 1)


def judge(res, exc, cached_before, data, fault_is_fault=True):
    """칸 하나의 판정 목록. 비면 OK."""
    bad = []
    if exc is not None:
        return [f"RAISE {type(exc).__name__}: {str(exc)[:60]}"]
    if not isinstance(res, dict):
        return [f"RAISE 결과가 dict 가 아님: {type(res).__name__}"]
    err = res.get("error")
    if cached_before and _size(data) == 0:
        bad.append("LOST")
    if isinstance(err, str) and any(n in err for n in EXC_NAMES):
        bad.append(f"RAW {err[:60]}")
    if fault_is_fault and not err and not res.get("stale") and _size(data) == 0:
        bad.append("SILENT")
    return bad


def run_cell(path, fault, with_cache):
    name, call, pick, _, good_key = path
    fname, fn = fault
    with Sandbox() as sb:
        if with_cache:
            api_client._http_get = _body(GOOD[good_key])
            try:
                call()
            except Exception:  # noqa: BLE001 — 준비 실패는 칸 판정으로 보인다
                pass
            for n in os.listdir(api_client.CACHE_DIR):
                old = time.time() - 400 * 24 * 3600
                os.utime(os.path.join(api_client.CACHE_DIR, n), (old, old))
        before = sb.cache_files()
        if fn is None:
            g = GOOD[good_key]
            fn = _body(g[: len(g) // 2])
        api_client._http_get = fn
        res, exc = None, None
        try:
            res = call()
        except Exception as e:  # noqa: BLE001 — 무엇이든 올라가면 그게 발견이다
            exc = e
        data = pick(res) if isinstance(res, dict) else None
        bad = judge(res, exc, with_cache and bool(before), data)
        after = sb.cache_files()
        shrunk = [n for n, s in before.items() if after.get(n, 0) < s * 0.2]
        if shrunk:
            bad.append("WIPE " + ",".join(shrunk))
        return bad


def matrix():
    fails = 0
    cells = 0
    for path in PATHS:
        for fault in FAULTS:
            for with_cache in (False, True):
                cells += 1
                bad = run_cell(path, fault, with_cache)
                tag = "캐시있음" if with_cache else "캐시없음"
                if bad:
                    fails += 1
                    print(f"  [FAIL] {path[0]:<10} {fault[0]:<17} {tag}  {' · '.join(bad)}")
    print(f"매트릭스: 칸 {cells} · FAIL {fails}")
    return cells, fails


# ── 필드 퍼징 — 발사 한 건의 필드를 하나씩 빼거나 null 로 ──────────────────────
def _paths(obj, prefix=()):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield prefix + (k,)
            yield from _paths(v, prefix + (k,))
    elif isinstance(obj, list) and obj:
        yield from _paths(obj[0], prefix + (0,))


def _mutate(obj, path, how):
    o = obj
    for k in path[:-1]:
        o = o[k]
    if how == "del":
        if isinstance(o, dict):
            del o[path[-1]]
    else:
        o[path[-1]] = None if how == "null" else "x"


# 의도된 탈락 — (필드 경로 앞 두 칸) → 사유. 여기 없는 탈락·예외는 전부 FAIL.
EXPECTED_DROPS = {
    ("pad",): "발사장이 없으면 지도에 못 놓는다 — api_parsing._parse_launch 가 None 을 돌려 버린다(의도)",
    ("pad", "latitude"): "위와 같음(좌표 없음)",
    ("pad", "longitude"): "위와 같음(좌표 없음)",
}


def fuzz():
    payload = json.loads(GOOD["ll2"])
    base = payload["results"][0]
    paths = list(_paths(base))
    cases, fails = 0, 0
    seen = set()
    for p in paths:
        for how in ("del", "null", "str"):
            one = copy.deepcopy(base)
            try:
                _mutate(one, p, how)
            except (KeyError, IndexError, TypeError):
                continue
            cases += 1
            try:
                out = api_parsing._parse_launches({"results": [one, copy.deepcopy(base)]})
                if len(out) != 2 and tuple(p[:2]) in EXPECTED_DROPS and len(out) == 1:
                    continue
                if len(out) != 2:
                    fails += 1
                    key = ("drop", p[:2], how)
                    if key not in seen:
                        seen.add(key)
                        print(f"  [FAIL] 퍼징 {how:<4} {'.'.join(map(str, p))}: 2건 중 {len(out)}건만 남음")
            except Exception as e:  # noqa: BLE001
                fails += 1
                key = ("raise", type(e).__name__, p[:2], how)
                if key not in seen:
                    seen.add(key)
                    print(f"  [FAIL] 퍼징 {how:<4} {'.'.join(map(str, p))}: {type(e).__name__}: {str(e)[:50]}")
    print(f"퍼징: 경우 {cases} (필드 경로 {len(paths)}) · FAIL {fails}")
    return cases, fails


def selftest():
    """판정기가 관대해지지 않는지 — 알려진 나쁜 결과를 넣어 각 판정이 나오는지."""
    ok = True
    probes = [
        ("RAISE", judge(None, KeyError("x"), False, None)),
        ("LOST", judge({"launches": [], "error": "인터넷 연결", "stale": False}, None, True, [])),
        ("RAW", judge({"launches": [1], "error": "KeyError: 'results'"}, None, False, [1])),
        ("SILENT", judge({"launches": [], "error": None, "stale": False}, None, False, [])),
    ]
    for want, got in probes:
        hit = any(g.startswith(want) for g in got)
        ok &= hit
        print(f"  [{'OK' if hit else 'FAIL'}]   판정 {want}: {got}")
    clean = judge({"launches": [1], "error": None, "stale": False}, None, True, [1])
    ok &= clean == []
    print(f"  [{'OK' if clean == [] else 'FAIL'}]   정상 결과는 판정 없음: {clean}")
    # 퍼징·매트릭스가 대상을 실제로 만들었나(0칸 통과 방지)
    cells = len(PATHS) * len(FAULTS) * 2
    ok &= cells >= 100
    print(f"  [{'OK' if cells >= 100 else 'FAIL'}]   매트릭스 칸 수 {cells} ≥ 100")
    print("[OK] selftest" if ok else "[FAIL] selftest")
    return 0 if ok else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    logging.disable(logging.CRITICAL)
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    c, f = matrix()
    fc, ff = fuzz()
    if fc < 100:
        print(f"[FAIL] 퍼징 대상이 {fc}건 — 픽스처를 못 읽었다")
        sys.exit(1)
    print("[OK] fault_matrix" if not (f or ff) else f"[FAIL] fault_matrix: 매트릭스 {f} · 퍼징 {ff}")
    sys.exit(1 if (f or ff) else 0)
