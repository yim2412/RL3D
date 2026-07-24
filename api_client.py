"""RL3D 외부 데이터 클라이언트.

Launch Library 2(발사)와 Celestrak(위성 TLE)을 호출·정규화·디스크 캐싱한다.
파이썬이 네트워크/캐싱을 전담하고, 결과 JSON만 프론트엔드로 넘긴다.

터미널 스모크: `python api_client.py` → 소스별 [OK]/[FAIL]·건수 출력.
"""

import json
import os
import time
import urllib.error
import urllib.request

# ── 엔드포인트·상수 (경로가 바뀌면 여기 한 곳만 고친다) ───────────────────────
LL2_BASE = "https://ll.thespacedevs.com/2.2.0"
LL2_UPCOMING = LL2_BASE + "/launch/upcoming/?limit=50&ordering=net&mode=detailed"
LL2_PREVIOUS = LL2_BASE + "/launch/previous/?limit=50&ordering=-net&mode=detailed"

CELESTRAK_GP = "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=tle"
# v1 위성 그룹: 눈에 띄는 정거장 + 밝게 보이는 위성 (성능 위해 소규모)
SATELLITE_GROUPS = ["stations", "visual"]

USER_AGENT = "RL3D/0.1 (personal desktop app)"
HTTP_TIMEOUT = 20  # 초

# 캐시: onefile exe 는 실행폴더가 임시라 %APPDATA% 아래 영구 위치가 필수
CACHE_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "RL3D", "cache")
# 발사 15분: 자동 갱신(5분 폴링)과 맞물려 상태 변화를 15분 내 반영.
# upcoming+previous 2요청 × 4회/시간 = 8요청/시간 → LL2 15회/시간 제한 내 안전.
TTL_LAUNCHES = 15 * 60      # 발사 15분
TTL_TLE = 2 * 60 * 60       # TLE 2시간


# ── 저수준 HTTP / 캐시 ────────────────────────────────────────────────────────
def _http_get(url):
    """텍스트 응답을 반환. 실패는 예외로 올린다(상위에서 캐시 폴백)."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.read().decode("utf-8")


def _cache_path(name):
    return os.path.join(CACHE_DIR, name)


def _cache_read(name):
    """(data, age_seconds) 반환. 없으면 (None, None)."""
    path = _cache_path(name)
    try:
        age = time.time() - os.path.getmtime(path)
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f), age
    except (OSError, ValueError):
        return None, None


def _cache_write(name, data):
    os.makedirs(CACHE_DIR, exist_ok=True)
    try:
        with open(_cache_path(name), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except OSError:
        pass  # 캐시 쓰기 실패는 치명적이지 않다


# ── 발사(Launch Library 2) ────────────────────────────────────────────────────
def _outcome_from_status(status_abbrev):
    """LL2 status.abbrev → 정규화된 outcome."""
    s = (status_abbrev or "").lower()
    if s == "success":
        return "success"
    if s == "failure":
        return "failure"
    if s in ("partial failure", "partial"):
        return "partial"
    return "upcoming"  # TBD / Go / TBC / Hold 등 예정 계열


def _parse_launch(item):
    """LL2 발사 1건 → 정규화 dict. 좌표 없으면 None(지도에 못 찍음)."""
    pad = item.get("pad") or {}
    location = pad.get("location") or {}
    lat, lng = pad.get("latitude"), pad.get("longitude")
    if lat is None or lng is None:
        return None

    rocket = item.get("rocket") or {}
    config = rocket.get("configuration") or {}
    provider = item.get("launch_service_provider") or {}
    status = item.get("status") or {}
    mission = item.get("mission") or {}
    image = item.get("image")

    return {
        "id": item.get("id"),
        "name": item.get("name"),
        "net": item.get("net"),
        "status": status.get("name"),
        "outcome": _outcome_from_status(status.get("abbrev")),
        "rocket": config.get("full_name") or config.get("name"),
        "provider": provider.get("name"),
        "provider_country": provider.get("country_code"),
        "pad_name": pad.get("name"),
        "location_name": location.get("name"),
        "lat": float(lat),
        "lng": float(lng),
        "mission_name": mission.get("name"),
        "mission_type": mission.get("type"),
        "orbit": ((mission.get("orbit") or {}).get("name")),
        "image": image,
    }


def _parse_launches(payload):
    out = []
    for item in payload.get("results", []) or []:
        try:
            parsed = _parse_launch(item)
        except (TypeError, ValueError):
            continue  # 1건 실패가 전체를 죽이지 않게
        if parsed:
            out.append(parsed)
    return out


def get_launches(force=False):
    """예정+과거 발사를 정규화해 반환.

    반환: {"launches": [...], "stale": bool, "error": str|None}
    캐시 유효 → 캐시 / 만료 → API / 실패 → 오래된 캐시라도 반환.
    """
    cached, age = _cache_read("launches.json")
    if not force and cached is not None and age is not None and age < TTL_LAUNCHES:
        return {"launches": cached, "stale": False, "error": None}

    try:
        upcoming = _parse_launches(json.loads(_http_get(LL2_UPCOMING)))
        previous = _parse_launches(json.loads(_http_get(LL2_PREVIOUS)))
        launches = upcoming + previous
        _cache_write("launches.json", launches)
        return {"launches": launches, "stale": False, "error": None}
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as e:
        msg = _friendly_error(e)
        if cached is not None:
            return {"launches": cached, "stale": True, "error": msg}
        return {"launches": [], "stale": False, "error": msg}


# ── 위성(Celestrak TLE) ───────────────────────────────────────────────────────
def _parse_tle(text):
    """TLE 텍스트(3줄 1세트: 이름/L1/L2) → 위성 dict 리스트."""
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    out = []
    for i in range(0, len(lines) - 2, 3):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if not (l1.startswith("1 ") and l2.startswith("2 ")):
            continue  # 정렬이 어긋난 블록은 건너뛴다
        norad = l1[2:7].strip()
        out.append({"name": name.strip(), "norad_id": norad, "tle1": l1, "tle2": l2})
    return out


def get_satellites(force=False):
    """설정된 그룹의 TLE를 합쳐 반환.

    반환: {"satellites": [...], "stale": bool, "error": str|None}
    """
    cached, age = _cache_read("tle.json")
    if not force and cached is not None and age is not None and age < TTL_TLE:
        return {"satellites": cached, "stale": False, "error": None}

    try:
        sats = []
        for group in SATELLITE_GROUPS:
            text = _http_get(CELESTRAK_GP.format(group=group))
            sats.extend(_parse_tle(text))
        # norad_id 중복 제거(그룹 간 겹칠 수 있음)
        seen, deduped = set(), []
        for s in sats:
            if s["norad_id"] in seen:
                continue
            seen.add(s["norad_id"])
            deduped.append(s)
        _cache_write("tle.json", deduped)
        return {"satellites": deduped, "stale": False, "error": None}
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as e:
        msg = _friendly_error(e)
        if cached is not None:
            return {"satellites": cached, "stale": True, "error": msg}
        return {"satellites": [], "stale": False, "error": msg}


# ── 에러 메시지(사람이 읽는 말로) ─────────────────────────────────────────────
def _friendly_error(e):
    if isinstance(e, urllib.error.HTTPError):
        if e.code == 429:
            return "요청이 많아 잠시 제한됐습니다(시간당 한도). 잠시 후 다시 시도하세요."
        return f"서버 응답 오류({e.code})."
    if isinstance(e, urllib.error.URLError):
        return "네트워크에 연결할 수 없습니다. 인터넷 연결을 확인하세요."
    if isinstance(e, TimeoutError):
        return "응답이 지연됩니다(타임아웃). 잠시 후 다시 시도하세요."
    return "데이터를 불러오지 못했습니다."


# ── 터미널 스모크 ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"[cache] {CACHE_DIR}")

    r = get_launches()
    if r["error"] and not r["launches"]:
        print(f"[FAIL] launches - {r['error']}")
    else:
        tag = "OK(stale)" if r["stale"] else "OK"
        print(f"[{tag}] launches - {len(r['launches'])}건"
              + (f" (경고: {r['error']})" if r["error"] else ""))
        if r["launches"]:
            s = r["launches"][0]
            print(f"        예: {s['name']} @ {s['location_name']} [{s['outcome']}]")

    r = get_satellites()
    if r["error"] and not r["satellites"]:
        print(f"[FAIL] satellites - {r['error']}")
    else:
        tag = "OK(stale)" if r["stale"] else "OK"
        print(f"[{tag}] satellites - {len(r['satellites'])}개"
              + (f" (경고: {r['error']})" if r["error"] else ""))
        if r["satellites"]:
            print(f"        예: {r['satellites'][0]['name']} (NORAD {r['satellites'][0]['norad_id']})")
