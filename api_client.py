"""RL3D 외부 데이터 클라이언트.

Launch Library 2(발사)와 Celestrak(위성 TLE)을 호출·정규화·디스크 캐싱한다.
파이썬이 네트워크/캐싱을 전담하고, 결과 JSON만 프론트엔드로 넘긴다.

응답 정규화는 `api_parsing.py`, 에러 문구는 `api_errors.py` 로 떼어냈다(P12-23 다음의 P12-19).
**둘 다 모듈 경유로 부른다**(`api_parsing._parse_launches(...)`) — 이름 import 로 당겨오면
나중에 그 이름이 재대입될 때 이쪽에 안 보인다(전역 규칙 8번). 지금은 재대입이 없지만,
이 파일의 `CACHE_DIR`·`_http_get` 은 **테스트가 재대입해서** 격리하는 값이라 같은 규칙을 지킨다.

터미널 스모크: `python api_client.py` → 소스별 [OK]/[FAIL]·건수 출력.
"""

import http.client
import json
import logging
import os
import sys
import tempfile
import threading
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
# 아카이브로 물어볼 수 있는 가장 이른 해 — 스푸트니크 1호(1957-10-04) 이전에는 궤도
# 발사가 없다. 이보다 이르거나 내년보다 먼 해는 **요청하지 않는다**(P38-1):
# 예전에는 `get_archive(0)`·`get_archive(99999)` 가 그대로 LL2 를 때리고, 빈 결과를
# `archive_0.json` 으로 **영구 캐시**까지 남겼다(지난 연도는 TTL 이 없다).
ARCHIVE_MIN_YEAR = 1957
ARCHIVE_PAGE_DELAY = 2              # 페이지 사이 딜레이(초) — 레이트리밋 보호


# ── 저수준 HTTP / 캐시 ────────────────────────────────────────────────────────
# 네트워크 호출에서 **잡아야 할 예외**. 다섯 곳(발사·아카이브·TLE·SATCAT·업데이트)이 같은 묶음을 쓴다.
#
# 예전에는 `(URLError, HTTPError, ValueError, TimeoutError)` 네 가지만 잡았고, 그래서
# **연결이 끊기는 방식에 따라 폴백이 갈렸다**(2026-09-22 실측: 13종 중 **7종이 그대로 터졌다**) —
# `ConnectionResetError` · `RemoteDisconnected` · `IncompleteRead` · `BadStatusLine` ·
# `SSLError` · `SSLEOFError` · 일반 `OSError`. 전부 실제 인터넷에서 흔한 것들이다
# (끊기는 와이파이 · 프록시 · 서버 재시작 · **응답을 읽는 도중** 끊김).
# 터지면 오래된 캐시 폴백이 통째로 건너뛰어져 **가진 데이터가 있는데 빈 화면**이 된다.
#
# 세 갈래면 실측한 13종을 전부 덮는다: `URLError`·`HTTPError`·`TimeoutError`·`socket.timeout`·
# `ConnectionResetError`·`SSLError` 는 `OSError` 하위, `UnicodeDecodeError` 는 `ValueError` 하위,
# `IncompleteRead`·`BadStatusLine`·`RemoteDisconnected` 는 `http.client.HTTPException`.
# 이 블록 안에는 네트워크 호출과 파싱만 있고 캐시 쓰기는 자체 `try` 를 갖고 있어,
# 넓혀도 삼킬 프로그래밍 오류가 없다.
NET_ERRORS = (OSError, ValueError, http.client.HTTPException)


def _age_text(age):
    """캐시 나이를 사람이 읽는 말로. 로그에만 쓴다."""
    if age is None:
        return "나이 모름"
    if age < 90:
        return "%d초 전" % int(age)
    if age < 5400:
        return "%d분 전" % int(age // 60)
    return "%.1f시간 전" % (age / 3600.0)


def _log_result(what, count, source, t0=None):
    """데이터 한 번을 받을 때마다 **한 줄** 남긴다(P30-1).

    예전에는 **성공이 한 줄도 안 남았다** — 실제 exe 를 13분 띄운 로그가 3줄뿐이었고
    (시작·런타임·창 생성) 그사이 받은 발사·위성의 흔적이 없었다. 그래서 *"화면이 비었다"* ·
    *"데이터가 오래됐다"* 는 말이 나와도 **캐시를 썼는지 네트워크를 탔는지** 알 수 없었다.

    남기는 것은 넷뿐이다: 무엇을 · 몇 건 · 어디서 · 얼마나. 그 이상(요청 URL마다,
    페이지마다)은 안 남긴다 — 기준은 용량이 아니라 **읽을 수 있는가** 이다.
    """
    if t0 is None:
        log.info("%s %d건 (%s)", what, count, source)
    else:
        log.info("%s %d건 (%s, %.1f초)", what, count, source, time.time() - t0)


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
# v2(2026-09-13, P14-1): `rocket_spec`·`boosters` 추가.
# v3(2026-09-13, P14-2): `pad_timezone` 추가.
# v4(2026-09-13, P15-1): `pad_year_count`·`location_year_count`·`agency_count`·`orbital_count` 추가.
# v5(2026-09-13, P15-2): `rocket_spec.cost` 추가.
# v6(2026-09-13, P15-6): `rocket_spec.gto_capacity` 추가.
# v7(2026-09-13, P15-5): `mission_agencies` 추가.
# v8(2026-09-13, P15-3): `rocket_spec.land_*`·`provider_landings` 추가.
# v9(2026-09-13, P15-7): `last_updated` 추가.
# v10(2026-09-14, P15-4): `rocket_family` 추가.
CACHE_SCHEMA = 10


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


def _atomic_write_json(path, obj, **dump_kw):
    """같은 디렉터리의 임시 파일에 다 쓴 뒤 **바꿔 끼운다**(P22-1).

    `open(path, "w")` 는 **여는 순간 파일을 자른다.** 실측(2026-09-17):
      · 연 직후 파일 크기가 **0바이트** — 아직 한 글자도 안 썼는데 이미 비어 있다
      · 48KB 설정을 300번 쓰는 동안, 동시에 읽던 쪽이 **빈 설정을 45번** 봤다
      · 반쯤 쓰인 파일을 `load_settings()` 가 읽으면 `ValueError` → `{}` 로 삼킨다.
        그 뒤 무엇이든 한 번 저장하면 **키 5개가 1개로 줄고 파일은 정상 JSON 이 된다 —
        되돌릴 방법이 없다.** 날아가는 것은 관측지·관심 목록·위성 그룹·필터·배경이다.

    `os.replace` 는 같은 볼륨에서 원자적이라, 읽는 쪽은 **이전 완전본 아니면 새 완전본**만 본다.
    그래서 임시 파일도 **같은 디렉터리**에 만든다(다른 볼륨이면 원자성이 깨진다).

    실패하면 **기존 파일을 그대로 둔다** — 못 쓰는 것이 반쯤 쓰는 것보다 낫다.
    """
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, **dump_kw)
        # Windows 는 **대상 파일이 열려 있으면 교체를 거부한다**(WinError 5).
        # 읽기는 순식간이라 잠깐 기다렸다 다시 하면 대개 된다 — 2026-09-17 실측에서
        # 읽기가 쉬지 않고 도는 극단적 상황에도 3회 안에 들어왔다.
        for attempt in range(FILE_RETRIES):
            try:
                os.replace(tmp, path)
                return True
            except OSError:
                if attempt == FILE_RETRIES - 1:
                    raise
                time.sleep(FILE_RETRY_WAIT)
        return True
    except OSError:
        # 남은 임시 파일은 치운다 — 안 그러면 %APPDATA% 에 .tmp-*.json 이 쌓인다.
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _cache_write(name, data):
    # makedirs 도 try 안에 둔다 — 밖에 있으면 그 OSError 가 호출자의 `except NET_ERRORS` 로
    # 떨어져 **받은 데이터를 버리고 "연결이 끊겼다"** 고 말하며 폴링마다 다시 요청했다(F-006).
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        # 데이터를 **봉투에 담아** 모양 버전을 함께 남긴다(_cache_read 가 대조한다).
        _atomic_write_json(_cache_path(name), {"schema": CACHE_SCHEMA, "data": data})
    except OSError as e:
        # 치명적이지 않다(다음 호출이 다시 받는다) — 다만 매번 느려지므로 기록은 남긴다.
        log.warning("캐시 쓰기 실패 %s: %s", name, e)


# ── 설정 저장 (P8-9) ──────────────────────────────────────────────────────────
# 파일이 잠깐 잠기는 순간을 넘기기 위한 재시도(P22-1). 값은 실측으로 정했다 —
# 읽기·교체 모두 순식간이라 3회 × 20ms 면 충분하고, 사용자가 느낄 지연도 아니다.
FILE_RETRIES = 3
FILE_RETRY_WAIT = 0.02


def _read_settings(path=None):
    """`(설정, 저장해도 되나)` — **"못 읽었다"와 "내용이 못 쓰게 됐다"를 가른다**(P22-1).

    이 구분이 없던 것이 진짜 결함이었다. 예전 `load_settings` 는 모든 실패를 `{}` 로
    삼켰고, `save_settings` 가 그 `{}` 위에 patch 를 얹어 저장하면서 **관측지·관심 목록·
    위성 그룹·필터·배경이 한 번에 사라졌다** — 그리고 파일은 정상 JSON 이 되어 되돌릴 수 없었다.

    실패는 두 갈래이고 **대응이 반대다**:

    · **잠깐 못 읽는 것** — 교체·읽기가 겹치는 순간(Windows `WinError 5`, 실측 2026-09-17),
      또는 누가 쓰는 중이라 반쯤 읽히는 것. 재시도로 넘어가고, 그래도 안 되면
      **저장을 건너뛴다**(덮어쓰면 나머지를 잃는다).
    · **내용이 못 쓰게 된 것** — 파일은 멀쩡히 읽히는데 JSON 이 아니다(옛 판이 쓰다 만 것 등).
      재시도해도 영원히 그대로다. 여기서 저장을 막으면 **설정이 다시는 저장되지 않는다** —
      그래서 **망가진 파일을 옆에 치워 두고**(`settings.bad.json`) 새로 시작한다.

    둘을 가르는 기준은 **바이트가 변하는가**다. 재시도 사이에 내용이 그대로면 아무도 쓰고
    있지 않다는 뜻이라 *못 쓰게 된 것*이고, 달라졌으면 누가 쓰는 중이라 *잠깐*이다.

    파일이 **아예 없는 것은 실패가 아니다** — 첫 실행이 그렇다.
    """
    path = path or SETTINGS_PATH
    if not os.path.exists(path):
        return {}, True
    prev = None
    last = None
    for attempt in range(FILE_RETRIES):
        try:
            with open(path, "rb") as f:
                raw = f.read()
            data = json.loads(raw.decode("utf-8"))
            return (data if isinstance(data, dict) else {}), True
        except OSError as e:
            last, prev = e, None          # 열지도 못했다 — 내용 비교가 불가능하다
        except (ValueError, UnicodeDecodeError) as e:
            last = e
            if prev is not None and prev == raw:
                # 두 번 읽어도 같은 내용인데 JSON 이 아니다 → 아무도 안 쓰고 있다.
                _quarantine_settings(path)
                return {}, True
            prev = raw
        if attempt < FILE_RETRIES - 1:
            time.sleep(FILE_RETRY_WAIT)
    log.warning("설정 읽기 실패(%d회 시도) %s: %s", FILE_RETRIES, path, last)
    return {}, False


def _quarantine_settings(path):
    """못 쓰게 된 설정을 `*.bad.json` 으로 옮겨 둔다 — 지우지는 않는다.

    이 앱에서 설정은 **다시 만들기 번거로운 것**을 담는다(관측지·관심 목록·위성 그룹).
    새로 시작하더라도 원본은 남겨야 사람이 열어 볼 수 있다.
    """
    bad = path + ".bad.json"
    try:
        os.replace(path, bad)
        log.warning("설정 파일을 읽을 수 없어 %s 로 옮기고 새로 시작한다", bad)
    except OSError as e:
        log.warning("망가진 설정을 옮기지 못했다 %s: %s", path, e)


def load_settings():
    """settings.json 반환(없거나 못 읽으면 빈 dict).

    **못 읽은 것과 없는 것을 구분해야 하면 `_read_settings()` 를 쓴다** —
    이 함수의 빈 dict 는 그 둘을 합쳐 버린다. 저장 경로가 그래서 저쪽을 쓴다.
    """
    return _read_settings()[0]


# 읽고-고치고-쓰기를 한 번에 하나만 하게 한다(P22-3).
#
# **pywebview 는 브릿지 호출마다 새 스레드를 만든다**(`webview/util.py` 의
# `Thread(target=_call); thread.start()`). 그래서 JS 가 저장을 연달아 부르면 두 스레드가
# 동시에 읽고-고치고-쓴다 — 실측 200회 중 **1회(0.5%)** 한쪽 값이 사라졌다.
# 원자적 쓰기로는 **안 고쳐진다**: 원자성은 *반쯤 쓰임*을 막지 *덮어쓰기*를 막지 않는다.
#
# ⚠ 이 락은 **한 프로세스 안**에서만 듣는다. 인스턴스가 둘이면 여전히 서로를 덮어쓴다
#   (그쪽은 P22-2 의 단일 인스턴스 가드가 다룰 문제다).
_settings_lock = threading.Lock()


def save_settings(patch):
    """부분 갱신: 기존 설정 최상위 키에 patch를 병합해 저장하고 결과를 반환.

    프론트(필터·토글·관측)와 파이썬(창 위치)이 서로 다른 최상위 키만 쓰므로
    얕은 병합으로 충돌 없이 각자 값을 보존한다.

    읽기·병합·쓰기를 `_settings_lock` 으로 묶는다 — 이 셋이 갈라지면 한쪽 값이 사라진다.
    """
    with _settings_lock:
        data, ok = _read_settings()
        if isinstance(patch, dict):
            data.update(patch)
        if not ok:
            # **못 읽었으면 쓰지 않는다**(P22-1). 여기서 저장하면 읽지 못한 나머지 설정이
            # 통째로 지워지고 **파일은 정상 JSON 이 되어 되돌릴 수 없다.**
            # 이번 변경 하나를 잃는 쪽이 전부를 잃는 쪽보다 낫다.
            log.warning("설정을 읽지 못해 저장을 건너뛴다(기존 파일 보존): %s", SETTINGS_PATH)
            return data
        try:
            _atomic_write_json(SETTINGS_PATH, data, indent=2)
        except OSError as e:
            # 설정이 저장 안 되면 창 위치·필터가 매번 초기화된다 — 사용자가 겪는 증상이다.
            # **기존 파일은 그대로 살아 있다**(원자적 교체라 덮어쓰다 만 상태가 없다).
            log.warning("설정 저장 실패 %s: %s", SETTINGS_PATH, e)
        return data


# ── 요청 간격 — 실패 백오프 · 강제 갱신 쿨다운 (전면 감사 F-004·F-005) ─────────
# 예전에는 실패해도 캐시가 안 바뀌어 **5분 폴링마다 다시 때렸다** — 2026-09-24 실측: 429 가
# 이어지면 LL2 시간당 12회, previous 만 실패하면 24회(한도 15), Celestrak 403 에 그룹 8개면
# TLE 96회. 한도를 스스로 채워 429 가 풀리지 않는다. 강제 갱신(↻·R)도 누르는 만큼 2회씩 나갔다.
FAIL_BACKOFF = {"ll2": 30 * 60,             # LL2 실패 뒤 30분 — 폴링 6회를 건너뛴다
                "celestrak": 2 * 60 * 60}   # Celestrak 은 같은 그룹을 2시간 안에 다시 받으면 403
FORCE_MIN_INTERVAL = 60                     # 강제 갱신의 최소 간격(초)
_gate_lock = threading.Lock()
_blocked_until = {}   # 키 → (이 시각까지 막음, 그때의 사람 말 오류)
_last_attempt = {}    # 키 → 마지막으로 실제 요청을 낸 시각


def _reset_request_memory():
    """테스트·프로브 격리용 — 모듈 전역이라 안 비우면 앞 테스트의 실패가 뒤로 샌다."""
    with _gate_lock:
        _blocked_until.clear()
        _last_attempt.clear()


def _gate(key, force, cached_age):
    """요청을 내도 되나 → (허용, 막힌 이유). 이유가 None 이면 '방금 받은 캐시가 있다'.

    · 강제 갱신이라도 캐시가 FORCE_MIN_INTERVAL 보다 새것이면 요청하지 않는다(F-005).
    · 실패 뒤 백오프 동안은 폴링이 요청하지 않는다(F-004). 강제 갱신은 사용자가 명시적으로
      다시 해 보는 것이라 허용하되, 그것도 FORCE_MIN_INTERVAL 에 한 번이다.
    """
    now = time.time()
    if force and cached_age is not None and 0 <= cached_age < FORCE_MIN_INTERVAL:
        return False, None
    with _gate_lock:
        until, msg = _blocked_until.get(key, (0, None))
        if now < until and (not force or now - _last_attempt.get(key, 0) < FORCE_MIN_INTERVAL):
            return False, msg
        _last_attempt[key] = now
    return True, None


def _gate_fail(key, msg):
    with _gate_lock:
        _blocked_until[key] = (time.time() + FAIL_BACKOFF[key.split(":")[0]], msg)


def _gate_ok(key):
    with _gate_lock:
        _blocked_until.pop(key, None)


# ── 발사(Launch Library 2) ────────────────────────────────────────────────────


def _ll2_payload(url):
    """LL2 한 페이지 → dict. **모양이 틀린 200 은 ValueError** 로 올려 폴백 경로를 태운다.

    전면 감사 F-002(2026-09-24): 본문이 `null`·`[]` 이면 `.get` 에서 AttributeError 가 나
    NET_ERRORS 밖으로 새 **캐시 폴백을 건너뛰었고**, `{"results": null}` 은 0건을 정상으로
    캐시에 써 **지난 연도가 영구히 비었다**(P38 과 같은 피해의 다른 길).
    """
    payload = json.loads(_http_get(url))
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise ValueError("LL2 응답의 모양이 아닙니다")
    return payload


def get_launches(force=False):
    """예정+과거 발사를 정규화해 반환.

    반환: {"launches": [...], "stale": bool, "error": str|None}
    캐시 유효 → 캐시 / 만료 → API / 실패 → 오래된 캐시라도 반환.
    실패 직후와 연타한 강제 갱신은 요청을 내지 않는다(`_gate`, F-004·F-005).
    """
    cached, age = _cache_read("launches.json")
    if not force and cached is not None and age is not None and age < TTL_LAUNCHES:
        _log_result("발사", len(cached), "캐시 " + _age_text(age))
        return {"launches": cached, "stale": False, "error": None, "age": age}

    def fallback(msg):
        c, a = cached, age
        if c is None:
            c, a = _stale_fallback("launches.json")   # 모양이 낡아도 빈 화면보다 낫다
        if c is not None:
            return {"launches": c, "stale": True, "error": msg, "age": a}
        return {"launches": [], "stale": False, "error": msg, "age": None}

    allowed, why = _gate("ll2", force, age if cached is not None else None)
    if not allowed:
        if why is None:   # 방금 받은 캐시 — 강제 갱신 연타
            return {"launches": cached, "stale": False, "error": None, "age": age}
        return fallback(why)

    t0 = time.time()
    try:
        upcoming = api_parsing._parse_launches(_ll2_payload(LL2_UPCOMING))
        previous = api_parsing._parse_launches(_ll2_payload(LL2_PREVIOUS))
        # 막 발사된 건은 LL2가 upcoming·previous 양쪽에 내보낸다 → id로 중복 제거.
        # (안 하면 마커·통계·티커에 같은 발사가 두 번 잡힌다. previous 쪽이 결과가 최신)
        launches = api_parsing._dedupe_launches(previous + upcoming)
        _cache_write("launches.json", launches)
        _gate_ok("ll2")
        _log_result("발사", len(launches), "네트워크", t0)
        return {"launches": launches, "stale": False, "error": None, "age": 0}
    except NET_ERRORS as e:
        msg = api_errors._friendly_error(e)
        _gate_fail("ll2", msg)
        log.warning("발사 조회 실패(%s) — %s", e, "오래된 캐시 사용" if cached is not None else "캐시 없음")
        return fallback(msg)


# ── 과거 발사 아카이브 (P7-5) ─────────────────────────────────────────────────
def _fetch_launch_pages(url, max_pages):
    """`next`를 따라 최대 max_pages 페이지를 수집·정규화. 페이지 사이 딜레이로 보호.

    반환: (launches, truncated). **truncated 는 캡에 걸려 남은 페이지를 버렸다는 뜻**이다
    (P12-6). 이 사실이 화면까지 가지 않으면 "그 해는 이게 전부"로 읽힌다 — 잘린 목록은
    통계의 모수까지 조용히 틀리게 만든다.
    """
    launches, pages = [], 0
    while url and pages < max_pages:
        payload = _ll2_payload(url)
        launches.extend(api_parsing._parse_launches(payload))
        url = payload.get("next")
        pages += 1
        if url and pages < max_pages:
            time.sleep(ARCHIVE_PAGE_DELAY)
    return launches, bool(url)   # 아직 next 가 남았는데 멈췄으면 잘린 것


def _clean_groups(value, default):
    """브릿지에서 온 그룹 선택을 목록으로 바꾼다 (P38-1).

    `None`(미지정)이면 기본 그룹, **빈 목록이면 빈 채로**(위성을 끈 상태는 뜻이 있다).
    문자열 하나(`"stations"`)는 한 개짜리 목록으로 받아 준다 — 안 그러면 **글자 단위로
    순회**해 `s`·`t`·`a`… 가 되고, 카탈로그에 없어 조용히 빈 목록이 된다.
    순회할 수 없는 값(숫자·dict)은 예전에 `TypeError` 로 **브릿지 너머까지 던졌다.**
    """
    if value is None:
        return list(default)
    if isinstance(value, str):
        value = [value]
    try:
        items = list(value)
    except TypeError:
        log.warning("그룹 선택을 다룰 수 없어 무시했다: %r", value)
        return []
    return [g for g in items if g in SATELLITE_GROUP_CATALOG]


def _archive_year(value):
    """브릿지에서 온 값을 연도로 바꾼다. 다룰 수 없으면 None(요청하지 않는다).

    받아 주는 것: 정수 · 정수 문자열(`"2025"`). 그 밖(None·`"abc"`·dict·불리언)은 거절.
    범위는 `ARCHIVE_MIN_YEAR` ~ **내년**까지다 — 내년을 넣은 것은 연말에 다음 해 발사가
    이미 등록되기 때문이고, 그보다 먼 해는 받아도 빈 결과만 영구 캐시로 남는다.
    """
    if isinstance(value, bool):      # bool 은 int 의 하위형이다 — 먼저 걸러낸다
        return None
    try:
        year = int(value)
    except (TypeError, ValueError):
        return None
    if not (ARCHIVE_MIN_YEAR <= year <= time.gmtime().tm_year + 1):
        return None
    return year


def get_archive(year, force=False):
    year_raw = year
    """한 연도의 발사를 정규화해 반환.

    반환: {"launches": [...], "year": int, "stale": bool, "error": str|None}
    지난 연도는 영구 캐시(만료 없음), 올해는 6시간 TTL. 실패 시 캐시 폴백.
    """
    year = _archive_year(year)
    if year is None:
        # **던지지 않는다.** 브릿지 너머에서 온 값이라 무엇이든 올 수 있고, 예외는
        # 프론트에서 잡아도 화면에 할 말이 없다. 요청도 캐시도 없이 사람 말로 돌려준다.
        log.warning("아카이브 요청을 막았다 — 다룰 수 없는 연도: %r", year_raw)
        return {"launches": [], "year": None, "stale": False, "truncated": False,
                "error": "{}년부터 내년까지만 불러올 수 있습니다.".format(ARCHIVE_MIN_YEAR)}
    name = "archive_{}.json".format(year)
    cached, age = _cache_read(name)
    # 캐시는 예전 형식(리스트)일 수도 있다 — 그때는 잘림 여부를 모르니 False 로 본다.
    cached, cached_truncated = _unpack_archive_cache(cached)
    is_current = year >= time.gmtime().tm_year  # 올해(및 방어적으로 미래)는 갱신 대상
    # 지난 연도는 **그 해가 끝난 뒤에 받은 캐시만** 영구로 본다. 해가 바뀌기 전에 받은 것은
    # 그 시점의 스냅샷이라, 그대로 두면 7월에 받은 올해가 1월부터 영원히 7월에 멈춘다
    # (전면 감사 F-003). 한 번 다시 받으면 수정 시각이 이듬해가 되어 그 뒤로는 영구다.
    finished_when_fetched = (age is not None and
                             time.gmtime(time.time() - age).tm_year > year)
    fresh = cached is not None and (
        (not is_current and finished_when_fetched)
        or (is_current and age is not None and age < TTL_ARCHIVE_CURRENT)
    )
    if not force and fresh:
        _log_result("아카이브 %s" % year, len(cached), "캐시 " + _age_text(age))
        return {"launches": cached, "year": year, "stale": False, "error": None,
                "truncated": cached_truncated}

    t0 = time.time()
    try:
        launches, truncated = _fetch_launch_pages(LL2_ARCHIVE.format(year=year), ARCHIVE_MAX_PAGES)
        if truncated:
            log.warning("아카이브 %s 가 페이지 상한(%s)에 걸려 잘렸다 — %s건까지만 받았다",
                        year, ARCHIVE_MAX_PAGES, len(launches))
        _cache_write(name, {"launches": launches, "truncated": truncated})
        _log_result("아카이브 %s" % year, len(launches),
                    "네트워크" + (", 상한에 걸려 잘림" if truncated else ""), t0)
        return {"launches": launches, "year": year, "stale": False, "error": None,
                "truncated": truncated}
    except NET_ERRORS as e:
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
    key = "celestrak:tle:" + group

    def fallback(msg):
        c = cached
        if c is None:
            c, _ = _stale_fallback(name)
        if c is not None:
            return c, True, msg
        return [], False, msg

    allowed, why = _gate(key, force, age if cached is not None else None)
    if not allowed:
        return (cached, False, None) if why is None else fallback(why)
    try:
        sats = api_parsing._parse_tle(_http_get(CELESTRAK_GP.format(group=group)))
        if not sats:
            # 0건을 정상으로 캐시에 쓰면 TTL 동안 위성이 조용히 사라지고 폴백도 지워진다 —
            # 캡티브 포털·오류 페이지가 200 으로 오는 경우다(전면 감사 F-001).
            raise ValueError("TLE 응답에 위성이 없습니다")
        cap = (SATELLITE_GROUP_CATALOG.get(group) or {}).get("cap")
        if cap:
            sats = sats[:cap]  # 대형 그룹은 상한까지만(렌더 성능)
        _cache_write(name, sats)
        _gate_ok(key)
        return sats, False, None
    except NET_ERRORS as e:
        msg = api_errors._friendly_error(e)
        _gate_fail(key, msg)
        log.warning("TLE 그룹 %s 조회 실패: %s", group, e)
        return fallback(msg)


def get_satellites(force=False, groups=None):
    """지정 그룹의 TLE를 합쳐 반환(norad_id 중복 제거).

    반환: {"satellites": [...], "stale": bool, "error": str|None, "groups": [...]}
    groups=None(미지정)이면 기본 그룹, groups=[](명시적 빈 선택)이면 위성 없음.
    카탈로그에 없는 키는 무시.
    """
    groups = _clean_groups(groups, DEFAULT_SATELLITE_GROUPS)

    t0 = time.time()
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
    _log_result("위성 TLE", len(combined),
                "그룹 %s%s" % (",".join(groups) or "없음", " · 오래된 캐시 포함" if stale_any else ""), t0)
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
    key = "celestrak:satcat:" + group

    def fallback(msg):
        c = cached
        if c is None:
            c, _ = _stale_fallback(name)
        if c is not None:
            return c, True, msg
        return {}, False, msg

    allowed, why = _gate(key, force, age if cached is not None else None)
    if not allowed:
        return (cached, False, None) if why is None else fallback(why)
    try:
        meta = api_parsing._parse_satcat(_http_get(CELESTRAK_SATCAT.format(group=group)))
        if not meta:
            raise ValueError("SATCAT 응답에 위성이 없습니다")   # F-001 과 같은 이유
        # JSON 키는 문자열이 된다 → 저장 전에 문자열로 통일해 캐시/네트워크 결과 모양을 맞춘다.
        meta = {str(k): v for k, v in meta.items()}
        _cache_write(name, meta)
        _gate_ok(key)
        return meta, False, None
    except NET_ERRORS as e:
        msg = api_errors._friendly_error(e)
        _gate_fail(key, msg)
        log.warning("SATCAT 그룹 %s 조회 실패: %s", group, e)
        return fallback(msg)


def get_satcat(groups=None, force=False):
    """지정 그룹의 위성 메타데이터를 합쳐 반환.

    반환: {"satcat": {norad(str): {...}}, "stale": bool, "error": str|None}
    **메타가 없어도 위성은 그대로 보여야 한다** — 실패해도 빈 dict 로 돌려주고,
    화면은 있는 값만 채운다(전역 규칙 7번: 1건 실패가 나머지를 날리지 않는다).
    """
    # `groups or DEFAULT` 였다 — **빈 선택이 기본 그룹으로 바뀌어**, 위성을 끈 상태인데도
    # SATCAT 을 받아 왔다(TLE 쪽은 빈 선택을 존중했다: 같은 인자가 두 뜻이었다).
    groups = _clean_groups(groups, DEFAULT_SATELLITE_GROUPS)
    t0 = time.time()
    merged, stale, error = {}, False, None
    for g in groups:
        meta, g_stale, g_err = _get_group_satcat(g, force=force)
        merged.update(meta or {})
        stale = stale or g_stale
        error = error or g_err
    _log_result("위성 정보(SATCAT)", len(merged),
                "그룹 %s%s" % (",".join(groups) or "없음", " · 오래된 캐시 포함" if stale else ""), t0)
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
        if not isinstance(payload, dict) or not isinstance(payload.get("tag_name"), str):
            raise ValueError("릴리스 응답의 모양이 아닙니다")   # F-002 와 같은 이유
        latest = payload.get("tag_name")
        url = payload.get("html_url")
        name = payload.get("name")
        _cache_write("update.json", {"latest": latest, "url": url, "name": name})
        return result(latest, url, name, False, None, 0)
    except NET_ERRORS as e:
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
