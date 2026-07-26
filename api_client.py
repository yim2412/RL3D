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
# 연도별 아카이브: net 범위로 한 해치를 페이지네이션 수집(P7-5)
LL2_ARCHIVE = (LL2_BASE + "/launch/?net__gte={year}-01-01T00:00:00Z"
               "&net__lte={year}-12-31T23:59:59Z&limit=100&ordering=net&mode=detailed")

CELESTRAK_GP = "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=tle"
# 위성 그룹 카탈로그: key=Celestrak GROUP, label=표시명, cap=개수 상한(None=무제한).
# cap 은 **지도에 그릴 개수**만 줄인다 — 응답 전체를 받은 뒤 자르므로 다운로드는 줄지 않는다.
# 값 근거(2026-07-26 실측, P11-6): 위성 8,000개에서도 초당 갱신이 동기 28ms·화면 반영 33ms 라
# 렌더는 병목이 아니었다. 실제 제약은 Celestrak 쪽 — Starlink 전체(10,776개·1.7MB)를 거듭
# 받으면 403 으로 막힌다. 그래서 GEO(568개·93KB)는 캡을 풀고, Starlink 만 상한을 둔다.
SATELLITE_GROUP_CATALOG = {
    "stations": {"label": "우주정거장", "cap": None},
    "visual":   {"label": "밝게 보이는 위성", "cap": None},
    "starlink": {"label": "Starlink", "cap": 2000},
    "gps-ops":  {"label": "GPS", "cap": None},
    "galileo":  {"label": "Galileo", "cap": None},
    "weather":  {"label": "기상 위성", "cap": None},
    "science":  {"label": "과학 위성", "cap": None},
    "geo":      {"label": "정지궤도(GEO)", "cap": None},
}
DEFAULT_SATELLITE_GROUPS = ["stations", "visual"]


def satellite_group_catalog():
    """UI용 그룹 목록(key/label/cap)."""
    return [{"key": k, "label": v["label"], "cap": v["cap"]}
            for k, v in SATELLITE_GROUP_CATALOG.items()]

USER_AGENT = "RL3D/0.1 (personal desktop app)"
HTTP_TIMEOUT = 20  # 초

# 캐시: onefile exe 는 실행폴더가 임시라 %APPDATA% 아래 영구 위치가 필수
APP_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "RL3D")
CACHE_DIR = os.path.join(APP_DIR, "cache")
SETTINGS_PATH = os.path.join(APP_DIR, "settings.json")  # 창 상태·필터 등(P8-9)
# 발사 15분: 자동 갱신(5분 폴링)과 맞물려 상태 변화를 15분 내 반영.
# upcoming+previous 2요청 × 4회/시간 = 8요청/시간 → LL2 15회/시간 제한 내 안전.
TTL_LAUNCHES = 15 * 60      # 발사 15분
TTL_TLE = 2 * 60 * 60       # TLE 2시간
# 아카이브: 지난 연도는 영구 캐시(과거 발사는 안 변함), 올해만 TTL 갱신.
TTL_ARCHIVE_CURRENT = 6 * 60 * 60   # 올해 아카이브 6시간(연중 새 발사 추가)
ARCHIVE_MAX_PAGES = 5               # 연도당 최대 페이지(요청 폭주 방지)
ARCHIVE_PAGE_DELAY = 2              # 페이지 사이 딜레이(초) — 레이트리밋 보호


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


# ── 설정 저장 (P8-9) ──────────────────────────────────────────────────────────
def load_settings():
    """settings.json 반환(없으면 빈 dict)."""
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(patch):
    """부분 갱신: 기존 설정 최상위 키에 patch를 병합해 저장하고 결과를 반환.

    프론트(필터·토글·관측)와 파이썬(창 위치)이 서로 다른 최상위 키만 쓰므로
    얕은 병합으로 충돌 없이 각자 값을 보존한다.
    """
    data = load_settings()
    if isinstance(patch, dict):
        data.update(patch)
    os.makedirs(APP_DIR, exist_ok=True)
    try:
        with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except OSError:
        pass
    return data


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


MAX_VID_URLS = 4     # 중계 링크는 상위 몇 개만(응답에 10개 넘게 오는 건도 있다)
MAX_UPDATES = 6      # 발사 소식도 최신 몇 건만 — 캐시 파일이 커지는 걸 막는다


def _parse_vid_urls(item):
    """중계 링크 → [{title, url}]. description 은 길어서 버린다."""
    out = []
    for v in (item.get("vidURLs") or []):
        if not isinstance(v, dict):
            continue
        url = v.get("url")
        if not url:
            continue
        out.append({"title": v.get("title") or "중계", "url": url})
        if len(out) >= MAX_VID_URLS:
            break
    return out


def _parse_updates(item):
    """발사 소식 → 최신순 [{comment, created_on, info_url}]."""
    items = [u for u in (item.get("updates") or []) if isinstance(u, dict) and u.get("comment")]
    items.sort(key=lambda u: u.get("created_on") or "", reverse=True)
    return [{"comment": u.get("comment"),
             "created_on": u.get("created_on"),
             "info_url": u.get("info_url")} for u in items[:MAX_UPDATES]]


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
        "mission_desc": mission.get("description"),
        "orbit": ((mission.get("orbit") or {}).get("name")),
        "image": image,
        # 실패/지연(홀드) 사유 — 있을 때만 채워짐(상세 모드)
        "fail_reason": item.get("failreason"),
        "hold_reason": item.get("holdreason"),
        # 아래는 이미 detailed 응답에 들어오던 값들(추가 요청 없음)
        "vid_urls": _parse_vid_urls(item),
        "webcast_live": bool(item.get("webcast_live")),
        "patch": ((item.get("mission_patches") or [{}])[0] or {}).get("image_url"),
        "updates": _parse_updates(item),
        "window_start": item.get("window_start"),
        "window_end": item.get("window_end"),
        # net 이 어디까지 확정인지(Second/Hour/Day/Month…) — 카운트다운의 신뢰도
        "net_precision": (item.get("net_precision") or {}).get("name"),
        "programs": [p.get("name") for p in (item.get("program") or [])
                     if isinstance(p, dict) and p.get("name")],
        "pad_count": item.get("pad_launch_attempt_count"),
        "agency_year_count": item.get("agency_launch_attempt_count_year"),
        "probability": item.get("probability"),
        "weather_concerns": item.get("weather_concerns"),
    }


def _parse_launches(payload):
    out = []
    for item in payload.get("results", []) or []:
        if not isinstance(item, dict):
            continue  # results 안에 null 이 섞여 오는 경우가 있다
        try:
            parsed = _parse_launch(item)
        except (TypeError, ValueError, AttributeError, KeyError):
            continue  # 1건 실패가 전체를 죽이지 않게
        if parsed:
            out.append(parsed)
    return out


def _dedupe_launches(items):
    """id 기준 중복 제거(먼저 온 항목 우선). id가 없는 건은 그대로 남긴다."""
    seen, out = set(), []
    for d in items:
        key = d.get("id")
        if key is not None:
            if key in seen:
                continue
            seen.add(key)
        out.append(d)
    return out


def get_launches(force=False):
    """예정+과거 발사를 정규화해 반환.

    반환: {"launches": [...], "stale": bool, "error": str|None}
    캐시 유효 → 캐시 / 만료 → API / 실패 → 오래된 캐시라도 반환.
    """
    cached, age = _cache_read("launches.json")
    if not force and cached is not None and age is not None and age < TTL_LAUNCHES:
        return {"launches": cached, "stale": False, "error": None, "age": age}

    try:
        upcoming = _parse_launches(json.loads(_http_get(LL2_UPCOMING)))
        previous = _parse_launches(json.loads(_http_get(LL2_PREVIOUS)))
        # 막 발사된 건은 LL2가 upcoming·previous 양쪽에 내보낸다 → id로 중복 제거.
        # (안 하면 마커·통계·티커에 같은 발사가 두 번 잡힌다. previous 쪽이 결과가 최신)
        launches = _dedupe_launches(previous + upcoming)
        _cache_write("launches.json", launches)
        return {"launches": launches, "stale": False, "error": None, "age": 0}
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as e:
        msg = _friendly_error(e)
        if cached is not None:
            return {"launches": cached, "stale": True, "error": msg, "age": age}
        return {"launches": [], "stale": False, "error": msg, "age": None}


# ── 과거 발사 아카이브 (P7-5) ─────────────────────────────────────────────────
def _fetch_launch_pages(url, max_pages):
    """`next`를 따라 최대 max_pages 페이지를 수집·정규화. 페이지 사이 딜레이로 보호."""
    launches, pages = [], 0
    while url and pages < max_pages:
        payload = json.loads(_http_get(url))
        launches.extend(_parse_launches(payload))
        url = payload.get("next")
        pages += 1
        if url and pages < max_pages:
            time.sleep(ARCHIVE_PAGE_DELAY)
    return launches


def get_archive(year, force=False):
    """한 연도의 발사를 정규화해 반환.

    반환: {"launches": [...], "year": int, "stale": bool, "error": str|None}
    지난 연도는 영구 캐시(만료 없음), 올해는 6시간 TTL. 실패 시 캐시 폴백.
    """
    year = int(year)
    name = "archive_{}.json".format(year)
    cached, age = _cache_read(name)
    is_current = year >= time.gmtime().tm_year  # 올해(및 방어적으로 미래)는 갱신 대상
    fresh = cached is not None and (
        not is_current or (age is not None and age < TTL_ARCHIVE_CURRENT)
    )
    if not force and fresh:
        return {"launches": cached, "year": year, "stale": False, "error": None}

    try:
        launches = _fetch_launch_pages(LL2_ARCHIVE.format(year=year), ARCHIVE_MAX_PAGES)
        _cache_write(name, launches)
        return {"launches": launches, "year": year, "stale": False, "error": None}
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as e:
        msg = _friendly_error(e)
        if cached is not None:
            return {"launches": cached, "year": year, "stale": True, "error": msg}
        return {"launches": [], "year": year, "stale": False, "error": msg}


# ── 위성(Celestrak TLE) ───────────────────────────────────────────────────────
def _parse_tle(text):
    """TLE 텍스트(3줄 1세트: 이름/L1/L2) → 위성 dict 리스트."""
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    out = []
    i, n = 0, len(lines)
    while i <= n - 3:
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if l1.startswith("1 ") and l2.startswith("2 "):
            out.append({"name": name.strip(), "norad_id": l1[2:7].strip(),
                        "tle1": l1, "tle2": l2})
            i += 3
        else:
            i += 1  # 3줄 정렬이 어긋났으면 한 줄씩 밀며 재동기화(헤더·잡음 줄 방어)
    return out


def _get_group_tle(group, force=False):
    """한 그룹의 TLE(개수 캡 적용) → (list, stale, error). 그룹별로 캐시."""
    name = "tle_{}.json".format(group)
    cached, age = _cache_read(name)
    if not force and cached is not None and age is not None and age < TTL_TLE:
        return cached, False, None
    try:
        sats = _parse_tle(_http_get(CELESTRAK_GP.format(group=group)))
        cap = (SATELLITE_GROUP_CATALOG.get(group) or {}).get("cap")
        if cap:
            sats = sats[:cap]  # 대형 그룹은 상한까지만(렌더 성능)
        _cache_write(name, sats)
        return sats, False, None
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as e:
        msg = _friendly_error(e)
        if cached is not None:
            return cached, True, msg
        return [], False, msg


def get_satellites(force=False, groups=None):
    """지정 그룹의 TLE를 합쳐 반환(norad_id 중복 제거).

    반환: {"satellites": [...], "stale": bool, "error": str|None, "groups": [...]}
    groups=None(미지정)이면 기본 그룹, groups=[](명시적 빈 선택)이면 위성 없음.
    카탈로그에 없는 키는 무시.
    """
    if groups is None:
        groups = list(DEFAULT_SATELLITE_GROUPS)
    else:
        groups = [g for g in groups if g in SATELLITE_GROUP_CATALOG]

    combined, seen = [], set()
    stale_any, err = False, None
    for g in groups:
        sats, stale, msg = _get_group_tle(g, force=force)
        stale_any = stale_any or stale
        if msg and not err:
            err = msg
        for s in sats:
            if s["norad_id"] in seen:
                continue
            seen.add(s["norad_id"])
            combined.append(s)
    return {"satellites": combined, "stale": stale_any, "error": err, "groups": groups}


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

    # 아카이브: 작년치 1개 연도만(최초 1회 API, 이후 영구 캐시라 무료 스모크)
    last_year = time.gmtime().tm_year - 1
    r = get_archive(last_year)
    if r["error"] and not r["launches"]:
        print(f"[FAIL] archive {last_year} - {r['error']}")
    else:
        tag = "OK(stale)" if r["stale"] else "OK"
        print(f"[{tag}] archive {last_year} - {len(r['launches'])}건"
              + (f" (경고: {r['error']})" if r["error"] else ""))
