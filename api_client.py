"""RL3D 외부 데이터 클라이언트.

Launch Library 2(발사)와 Celestrak(위성 TLE)을 호출·정규화·디스크 캐싱한다.
파이썬이 네트워크/캐싱을 전담하고, 결과 JSON만 프론트엔드로 넘긴다.

응답 정규화는 `api_parsing.py`, 에러 문구는 `api_errors.py` 로 떼어냈다(P12-23 다음의 P12-19).
**둘 다 모듈 경유로 부른다**(`api_parsing._parse_launches(...)`) — 이름 import 로 당겨오면
나중에 그 이름이 재대입될 때 이쪽에 안 보인다(전역 규칙 8번). 지금은 재대입이 없지만,
이 파일의 `CACHE_DIR`·`_http_get` 은 **테스트가 재대입해서** 격리하는 값이라 같은 규칙을 지킨다.

터미널 스모크: `python api_client.py` → 소스별 [OK]/[FAIL]·건수 출력.
"""

import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request

import api_errors
import api_parsing

# 핸들러 설정은 진입점(main.py → applog)에서만 한다 — 여기선 기록만 남긴다.
log = logging.getLogger(__name__)

# ── 엔드포인트·상수 (경로가 바뀌면 여기 한 곳만 고친다) ───────────────────────
LL2_BASE = "https://ll.thespacedevs.com/2.2.0"
LL2_UPCOMING = LL2_BASE + "/launch/upcoming/?limit=50&ordering=net&mode=detailed"
LL2_PREVIOUS = LL2_BASE + "/launch/previous/?limit=50&ordering=-net&mode=detailed"
# 연도별 아카이브: net 범위로 한 해치를 페이지네이션 수집(P7-5)
LL2_ARCHIVE = (LL2_BASE + "/launch/?net__gte={year}-01-01T00:00:00Z"
               "&net__lte={year}-12-31T23:59:59Z&limit=100&ordering=net&mode=detailed")

CELESTRAK_GP = "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=tle"
# 위성 메타데이터(P12-5). TLE 와 같은 GROUP 단위로 받아 같은 단위로 캐싱한다 —
# 전체 satcat.csv 는 6.7MB 지만 그룹별은 2KB~1MB 다(2026-09-11 실측).
CELESTRAK_SATCAT = "https://celestrak.org/satcat/records.php?GROUP={group}&FORMAT=csv"
# 업데이트 확인(P12-12). 비인증 GitHub API 는 IP 당 시간당 60회라 TTL 하루면 넉넉하다.
# 이 URL 이 가리키는 릴리스가 곧 "최신" 이다 — 태그만 있고 릴리스가 없으면 보이지 않는다
# (P12-22 가 이 항목의 선행 조건이었던 이유).
GITHUB_LATEST_RELEASE = "https://api.github.com/repos/yim2412/RL3D/releases/latest"
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
# SATCAT 은 발사일·소유국·타입처럼 거의 안 변하는 값이라 길게 잡는다. 짧게 잡을 이유가
# 없고, Celestrak 은 같은 데이터를 짧은 간격으로 거듭 받으면 403 으로 막는다.
TTL_SATCAT = 24 * 60 * 60   # 위성 메타데이터 24시간
# 아카이브: 지난 연도는 영구 캐시(과거 발사는 안 변함), 올해만 TTL 갱신.
TTL_ARCHIVE_CURRENT = 6 * 60 * 60   # 올해 아카이브 6시간(연중 새 발사 추가)
TTL_UPDATE = 24 * 60 * 60           # 업데이트 확인 하루 1회(P12-12)
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


# 캐시에 담긴 **정규화 결과의 모양** 버전. 파싱에 필드를 더하거나 구조를 바꾸면 올린다.
#
# **이게 없어서 실제로 당했다(2026-09-12)**: 하루 사이 파싱에 필드 넷을 더했는데
# (`timeline`·`orbital_year_count`·`location_count`·`pad_turnaround_sec`),
# **지난 연도 아카이브 캐시는 TTL 이 없어 영구**다. 그래서 2025년을 이미 불러온 사용자는
# 그 해 발사에서 새 기능이 **영원히 안 보인다** — 오류도 경고도 없다.
# `launches.json` 은 TTL 15분이라 저절로 나아서 개발 중에는 보이지도 않았다.
CACHE_SCHEMA = 1


def _cache_read(name, any_schema=False):
    """(data, age_seconds) 반환. 없거나 **모양이 다르면** (None, None).

    모양이 다른 캐시는 **없는 것으로 본다** — 읽어서 쓰면 새 필드가 빠진 채 화면에
    나오고, 그건 오류 없이 조용히 틀린 상태다. 다시 받는 비용(요청 1회)이 훨씬 싸다.

    `any_schema=True` 는 **네트워크가 실패했을 때만** 쓴다(`_stale_fallback`).
    그 자리에서까지 버리면 오프라인 사용자는 **예전에 보이던 데이터마저 못 본다** —
    모양이 조금 낡은 화면이 빈 화면보다 낫다.
    """
    path = _cache_path(name)
    try:
        age = time.time() - os.path.getmtime(path)
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        # 캐시 없음은 정상(첫 실행) — 그 외 사유가 궁금해질 때를 위해 debug 로만.
        log.debug("캐시 읽기 실패 %s: %s", name, e)
        return None, None
    if not isinstance(raw, dict) or "schema" not in raw:
        # 봉투가 없다 = CACHE_SCHEMA 도입 전에 저장된 것. 그때는 데이터가 통째로 들어 있다.
        if any_schema:
            return raw, age
        log.info("옛 캐시 형식 %s — 다시 받는다", name)
        return None, None
    if raw.get("schema") != CACHE_SCHEMA:
        if any_schema:
            return raw.get("data"), age
        log.info("캐시 스키마 불일치 %s (%s ≠ %s) — 다시 받는다",
                 name, raw.get("schema"), CACHE_SCHEMA)
        return None, None
    return raw.get("data"), age


def _stale_fallback(name):
    """네트워크가 실패했을 때의 마지막 보루 — **모양이 달라도** 옛 캐시를 돌려준다.

    스키마가 바뀐 직후 오프라인이 되면 정상 경로는 캐시를 버리는데, 그 자리에서까지
    버리면 **화면이 통째로 빈다**. 새 필드가 없는 화면이 빈 화면보다 낫다
    (그 상태는 `stale=True` 로 "저장된 데이터 표시" 경고가 함께 뜬다).
    """
    return _cache_read(name, any_schema=True)


# 그룹별 TLE 캐시(tle_<group>.json)로 바꾸기 전에 쓰던 파일. 코드가 더 이상 읽지
# 않는데 %APPDATA% 에 남아 용량만 차지한다(실측 36KB).
LEGACY_CACHE_FILES = ("tle.json",)


def cleanup_legacy_cache():
    """읽지 않는 옛 캐시 파일을 지우고 지운 이름을 반환. 실패는 무시(캐시일 뿐이다)."""
    removed = []
    for name in LEGACY_CACHE_FILES:
        path = _cache_path(name)
        try:
            if os.path.exists(path):
                os.remove(path)
                removed.append(name)
        except OSError as e:
            log.warning("옛 캐시 삭제 실패 %s: %s", name, e)
    return removed


def _cache_write(name, data):
    os.makedirs(CACHE_DIR, exist_ok=True)
    try:
        with open(_cache_path(name), "w", encoding="utf-8") as f:
            # 데이터를 **봉투에 담아** 모양 버전을 함께 남긴다(_cache_read 가 대조한다).
            json.dump({"schema": CACHE_SCHEMA, "data": data}, f, ensure_ascii=False)
    except OSError as e:
        # 치명적이지 않다(다음 호출이 다시 받는다) — 다만 매번 느려지므로 기록은 남긴다.
        log.warning("캐시 쓰기 실패 %s: %s", name, e)


# ── 설정 저장 (P8-9) ──────────────────────────────────────────────────────────
def load_settings():
    """settings.json 반환(없으면 빈 dict)."""
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError) as e:
        log.debug("설정 읽기 실패: %s", e)
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
    except OSError as e:
        # 설정이 저장 안 되면 창 위치·필터가 매번 초기화된다 — 사용자가 겪는 증상이다.
        log.warning("설정 저장 실패 %s: %s", SETTINGS_PATH, e)
    return data


# ── 발사(Launch Library 2) ────────────────────────────────────────────────────


def get_launches(force=False):
    """예정+과거 발사를 정규화해 반환.

    반환: {"launches": [...], "stale": bool, "error": str|None}
    캐시 유효 → 캐시 / 만료 → API / 실패 → 오래된 캐시라도 반환.
    """
    cached, age = _cache_read("launches.json")
    if not force and cached is not None and age is not None and age < TTL_LAUNCHES:
        return {"launches": cached, "stale": False, "error": None, "age": age}

    try:
        upcoming = api_parsing._parse_launches(json.loads(_http_get(LL2_UPCOMING)))
        previous = api_parsing._parse_launches(json.loads(_http_get(LL2_PREVIOUS)))
        # 막 발사된 건은 LL2가 upcoming·previous 양쪽에 내보낸다 → id로 중복 제거.
        # (안 하면 마커·통계·티커에 같은 발사가 두 번 잡힌다. previous 쪽이 결과가 최신)
        launches = api_parsing._dedupe_launches(previous + upcoming)
        _cache_write("launches.json", launches)
        return {"launches": launches, "stale": False, "error": None, "age": 0}
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as e:
        msg = api_errors._friendly_error(e)
        if cached is None:
            cached, age = _stale_fallback("launches.json")   # 모양이 낡아도 빈 화면보다 낫다
        log.warning("발사 조회 실패(%s) — %s", e, "오래된 캐시 사용" if cached is not None else "캐시 없음")
        if cached is not None:
            return {"launches": cached, "stale": True, "error": msg, "age": age}
        return {"launches": [], "stale": False, "error": msg, "age": None}


# ── 과거 발사 아카이브 (P7-5) ─────────────────────────────────────────────────
def _fetch_launch_pages(url, max_pages):
    """`next`를 따라 최대 max_pages 페이지를 수집·정규화. 페이지 사이 딜레이로 보호.

    반환: (launches, truncated). **truncated 는 캡에 걸려 남은 페이지를 버렸다는 뜻**이다
    (P12-6). 이 사실이 화면까지 가지 않으면 "그 해는 이게 전부"로 읽힌다 — 잘린 목록은
    통계의 모수까지 조용히 틀리게 만든다.
    """
    launches, pages = [], 0
    while url and pages < max_pages:
        payload = json.loads(_http_get(url))
        launches.extend(api_parsing._parse_launches(payload))
        url = payload.get("next")
        pages += 1
        if url and pages < max_pages:
            time.sleep(ARCHIVE_PAGE_DELAY)
    return launches, bool(url)   # 아직 next 가 남았는데 멈췄으면 잘린 것


def get_archive(year, force=False):
    """한 연도의 발사를 정규화해 반환.

    반환: {"launches": [...], "year": int, "stale": bool, "error": str|None}
    지난 연도는 영구 캐시(만료 없음), 올해는 6시간 TTL. 실패 시 캐시 폴백.
    """
    year = int(year)
    name = "archive_{}.json".format(year)
    cached, age = _cache_read(name)
    # 캐시는 예전 형식(리스트)일 수도 있다 — 그때는 잘림 여부를 모르니 False 로 본다.
    cached, cached_truncated = _unpack_archive_cache(cached)
    is_current = year >= time.gmtime().tm_year  # 올해(및 방어적으로 미래)는 갱신 대상
    fresh = cached is not None and (
        not is_current or (age is not None and age < TTL_ARCHIVE_CURRENT)
    )
    if not force and fresh:
        return {"launches": cached, "year": year, "stale": False, "error": None,
                "truncated": cached_truncated}

    try:
        launches, truncated = _fetch_launch_pages(LL2_ARCHIVE.format(year=year), ARCHIVE_MAX_PAGES)
        if truncated:
            log.warning("아카이브 %s 가 페이지 상한(%s)에 걸려 잘렸다 — %s건까지만 받았다",
                        year, ARCHIVE_MAX_PAGES, len(launches))
        _cache_write(name, {"launches": launches, "truncated": truncated})
        return {"launches": launches, "year": year, "stale": False, "error": None,
                "truncated": truncated}
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as e:
        msg = api_errors._friendly_error(e)
        if cached is None:
            cached, _ = _stale_fallback(name)
            cached, cached_truncated = _unpack_archive_cache(cached)
        log.warning("아카이브 %s 조회 실패: %s", year, e)
        if cached is not None:
            return {"launches": cached, "year": year, "stale": True, "error": msg,
                    "truncated": cached_truncated}
        return {"launches": [], "year": year, "stale": False, "error": msg, "truncated": False}


def _unpack_archive_cache(cached):
    """아카이브 캐시 → (launches, truncated).

    **옛 캐시는 리스트 그대로다**(P12-6 전에 저장된 것). %APPDATA% 에 이미 깔려 있으므로
    형식을 바꾸면서 그쪽을 못 읽으면, 사용자는 멀쩡한 아카이브를 다시 받게 된다.
    """
    if isinstance(cached, dict):
        return cached.get("launches") or [], bool(cached.get("truncated"))
    return cached, False


# ── 위성(Celestrak TLE) ───────────────────────────────────────────────────────


def _get_group_tle(group, force=False):
    """한 그룹의 TLE(개수 캡 적용) → (list, stale, error). 그룹별로 캐시."""
    name = "tle_{}.json".format(group)
    cached, age = _cache_read(name)
    if not force and cached is not None and age is not None and age < TTL_TLE:
        return cached, False, None
    try:
        sats = api_parsing._parse_tle(_http_get(CELESTRAK_GP.format(group=group)))
        cap = (SATELLITE_GROUP_CATALOG.get(group) or {}).get("cap")
        if cap:
            sats = sats[:cap]  # 대형 그룹은 상한까지만(렌더 성능)
        _cache_write(name, sats)
        return sats, False, None
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as e:
        msg = api_errors._friendly_error(e)
        if cached is None:
            cached, _ = _stale_fallback(name)
        log.warning("TLE 그룹 %s 조회 실패: %s", group, e)
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


# ── 위성 메타데이터 SATCAT (P12-5) ────────────────────────────────────────────
# TLE 는 "지금 어디 있나"만 준다 — 이름·NORAD·궤도요소가 전부다. SATCAT 은 그 물체가
# **무엇인지**(위성체/로켓몸체/잔해)와 발사일·소유국·발사장·크기를 준다.
# TLE 와 같은 GROUP 단위로 받아 같은 캐시 구조를 쓴다(조인은 프론트에서 NORAD 로).


def _get_group_satcat(group, force=False):
    """한 그룹의 SATCAT → (dict, stale, error). 그룹별로 캐시."""
    name = "satcat_{}.json".format(group)
    cached, age = _cache_read(name)
    if not force and cached is not None and age is not None and age < TTL_SATCAT:
        return cached, False, None
    try:
        meta = api_parsing._parse_satcat(_http_get(CELESTRAK_SATCAT.format(group=group)))
        # JSON 키는 문자열이 된다 → 저장 전에 문자열로 통일해 캐시/네트워크 결과 모양을 맞춘다.
        meta = {str(k): v for k, v in meta.items()}
        _cache_write(name, meta)
        return meta, False, None
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as e:
        msg = api_errors._friendly_error(e)
        if cached is None:
            cached, _ = _stale_fallback(name)
        log.warning("SATCAT 그룹 %s 조회 실패: %s", group, e)
        if cached is not None:
            return cached, True, msg
        return {}, False, msg


def get_satcat(groups=None, force=False):
    """지정 그룹의 위성 메타데이터를 합쳐 반환.

    반환: {"satcat": {norad(str): {...}}, "stale": bool, "error": str|None}
    **메타가 없어도 위성은 그대로 보여야 한다** — 실패해도 빈 dict 로 돌려주고,
    화면은 있는 값만 채운다(전역 규칙 7번: 1건 실패가 나머지를 날리지 않는다).
    """
    groups = [g for g in (groups or DEFAULT_SATELLITE_GROUPS)
              if g in SATELLITE_GROUP_CATALOG]
    merged, stale, error = {}, False, None
    for g in groups:
        meta, g_stale, g_err = _get_group_satcat(g, force=force)
        merged.update(meta or {})
        stale = stale or g_stale
        error = error or g_err
    return {"satcat": merged, "stale": stale, "error": error}


# ── 업데이트 확인 (P12-12) ────────────────────────────────────────────────────


def check_update(current_version, force=False):
    """GitHub 최신 릴리스와 현재 버전을 비교한다.

    반환: {"current", "latest", "update_available", "url", "name",
           "stale": bool, "error": str|None, "age": float|None}

    **update_available 은 캐시에 저장하지 않고 매번 다시 계산한다.** bool 을 굳혀 두면
    사용자가 새 버전으로 바꾼 뒤에도 TTL(하루) 동안 계속 "새 버전이 있다"고 말한다 —
    예외도 안 나고 화면만 조용히 틀린다.
    """
    def result(latest, url, name, stale, error, age):
        return {
            "current": current_version,
            "latest": latest,
            "update_available": api_parsing.is_newer(latest, current_version),
            "url": url,
            "name": name,
            "stale": stale,
            "error": error,
            "age": age,
        }

    cached, age = _cache_read("update.json")
    if not force and isinstance(cached, dict) and age is not None and age < TTL_UPDATE:
        return result(cached.get("latest"), cached.get("url"), cached.get("name"),
                      False, None, age)

    try:
        payload = json.loads(_http_get(GITHUB_LATEST_RELEASE))
        latest = payload.get("tag_name")
        url = payload.get("html_url")
        name = payload.get("name")
        _cache_write("update.json", {"latest": latest, "url": url, "name": name})
        return result(latest, url, name, False, None, 0)
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as e:
        msg = api_errors._friendly_error(e)
        log.warning("업데이트 확인 실패(%s) — %s", e,
                    "오래된 캐시 사용" if isinstance(cached, dict) else "캐시 없음")
        if isinstance(cached, dict):
            return result(cached.get("latest"), cached.get("url"), cached.get("name"),
                          True, msg, age)
        # 업데이트 확인 실패는 앱 기능이 아니다 — 화면에 에러를 띄우지 않고 조용히 넘긴다.
        return result(None, None, None, False, msg, None)


# ── 터미널 스모크 ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # 콘솔 인코딩은 실행 PC 를 따른다 — 이 PC 는 UTF-8(65001), 한국어 PC 는 cp949 라
    # 한글이 넘어가지만 영문 로캘(cp1252)에서는 UnicodeEncodeError 로 죽는다.
    # 2026-09-11 CI 첫 실행이 실제로 여기서 깨졌다(GitHub 러너 = cp1252).
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    # 스모크는 터미널에서 도니 로그를 화면으로 보낸다(파일 로그는 main.py 가 설정).
    logging.basicConfig(level=logging.WARNING, format="[log] %(levelname)s %(message)s")
    print(f"[cache] {CACHE_DIR}")

    gone = cleanup_legacy_cache()
    if gone:
        print(f"[OK] legacy cache - {', '.join(gone)} 정리")

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

    r = get_satcat()
    if r["error"] and not r["satcat"]:
        print(f"[FAIL] satcat - {r['error']}")
    else:
        tag = "OK(stale)" if r["stale"] else "OK"
        print(f"[{tag}] satcat - {len(r['satcat'])}건"
              + (f" (경고: {r['error']})" if r["error"] else ""))
        iss = r["satcat"].get("25544")
        if iss:
            print(f"        예: {iss['name']} — {iss['type']} · {iss['owner']} · "
                  f"{iss['launch_date']} · {iss['launch_site']} · 크기 {iss['size']}")

    # 업데이트 확인(P12-12): **소스 도달 여부만** 잰다. 현재 버전은 앱(main.py)이 넘기는
    # 것이라 여기서 읽지 않는다 — main 을 import 하면 스모크가 webview(GUI)에 딸려간다.
    r = check_update("0.0.0")
    if r["error"] and not r["latest"]:
        print(f"[FAIL] update - {r['error']}")
    else:
        tag = "OK(stale)" if r["stale"] else "OK"
        print(f"[{tag}] update - 최신 릴리스 {r['latest']}"
              + (f" (경고: {r['error']})" if r["error"] else ""))

    # 아카이브: 작년치 1개 연도만(최초 1회 API, 이후 영구 캐시라 무료 스모크)
    last_year = time.gmtime().tm_year - 1
    r = get_archive(last_year)
    if r["error"] and not r["launches"]:
        print(f"[FAIL] archive {last_year} - {r['error']}")
    else:
        tag = "OK(stale)" if r["stale"] else "OK"
        print(f"[{tag}] archive {last_year} - {len(r['launches'])}건"
              + (f" (경고: {r['error']})" if r["error"] else ""))
