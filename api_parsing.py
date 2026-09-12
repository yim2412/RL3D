"""RL3D 응답·문자열 정규화 (순수 함수만).

Launch Library 2 / Celestrak 응답과 버전 문자열을 **값으로 바꾸는 일만** 한다 —
네트워크도, 캐시도, 모듈 전역 재대입도 여기엔 없다(그래서 떼어낼 수 있었다).
`api_client.py` 가 모듈 경유로 부른다: `api_parsing._parse_launches(payload)`.

**이름이 `api_` 로 시작하는 이유**: `parsing` 같은 흔한 이름을 최상위에 두면 exe 번들 안에서
서드파티 최상위 모듈과 겹칠 수 있고, 그 실패는 조용하다. `api_client.py` 와 짝이 맞기도 한다.
"""

import csv
import io
import logging

import satcat_codes

log = logging.getLogger(__name__)

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
        except (TypeError, ValueError, AttributeError, KeyError) as e:
            # 1건 실패가 전체를 죽이지 않게. 다만 조용히 사라지면 API 필드 변경을
            # 눈치채지 못한다 — id 와 사유를 남긴다.
            log.warning("발사 1건 파싱 실패 id=%s: %s", item.get("id"), e)
            continue
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


def _parse_satcat(text):
    """SATCAT CSV → {norad: {...}} 정규화.

    1건 파싱 실패가 나머지를 날리지 않게 행마다 감싼다(전역 규칙 7번).
    코드는 여기서 사람 말로 바꾼다 — 프론트가 표를 또 갖지 않게.
    """
    out = {}
    reader = csv.DictReader(io.StringIO(text))
    for row in reader:
        try:
            norad = int((row.get("NORAD_CAT_ID") or "").strip())
        except (TypeError, ValueError):
            continue  # NORAD 가 없으면 조인할 수 없다 — 이 행만 버린다
        try:
            decay = (row.get("DECAY_DATE") or "").strip() or None
            out[norad] = {
                "norad_id": norad,
                "name": (row.get("OBJECT_NAME") or "").strip() or None,
                "intl_code": (row.get("OBJECT_ID") or "").strip() or None,
                "type": satcat_codes.label(satcat_codes.OBJECT_TYPES, row.get("OBJECT_TYPE")),
                "status": satcat_codes.label(satcat_codes.OPS_STATUS, row.get("OPS_STATUS_CODE")),
                "owner": satcat_codes.label(satcat_codes.OWNERS, row.get("OWNER")),
                "launch_date": (row.get("LAUNCH_DATE") or "").strip() or None,
                "launch_site": satcat_codes.label(satcat_codes.LAUNCH_SITES, row.get("LAUNCH_SITE")),
                "decay_date": decay,
                "size": satcat_codes.rcs_size(row.get("RCS")),
            }
        except (TypeError, ValueError, AttributeError) as e:
            log.warning("SATCAT 1건 파싱 실패 norad=%s: %s", norad, e)
    return out


def parse_version(text):
    """`v1.13.0` · `1.13.0` → (1, 13, 0). 읽을 수 없으면 None.

    None 은 "모른다"는 뜻이고, 비교하는 쪽은 모를 때 **업데이트 없음**으로 본다 —
    알 수 없는 태그(`nightly` 등) 때문에 없는 새 버전을 알리는 것이 더 나쁘다.
    """
    if not isinstance(text, str):
        return None
    t = text.strip().lstrip("vV")
    parts = t.split(".")
    out = []
    for part in parts[:3]:
        # 1.13.0-rc1 처럼 꼬리가 붙어도 앞의 숫자까지는 읽는다
        num = ""
        for ch in part:
            if ch.isdigit():
                num += ch
            else:
                break
        if not num:
            return None
        out.append(int(num))
    if not out:
        return None
    while len(out) < 3:
        out.append(0)
    return tuple(out)


def is_newer(latest, current):
    """latest 가 current 보다 높은 버전인가. 어느 한쪽이라도 못 읽으면 False."""
    a, b = parse_version(latest), parse_version(current)
    if a is None or b is None:
        return False
    return a > b
