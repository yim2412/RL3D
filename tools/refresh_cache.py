"""재감사·재측정 전에 캐시를 받는다 (P109·P112).

    python tools/refresh_cache.py          # 발사 + 올해 아카이브 + 전 위성 그룹의 TLE·SATCAT
    python tools/refresh_cache.py --tle    # 전 위성 그룹의 TLE 만(Celestrak 그룹당 1회)

앱은 설정에 켠 그룹만 받고 아카이브는 열어야 받는다 — 앱을 켜는 것으로는 캐시가 다 새로워지지 않아,
한 달 묵은 캐시로 cache_audit 가 전부 [OK] 였다가 받아 보니 57건이 나왔다(P109).
force 를 쓰지 않는다: TTL 안의 것은 요청하지 않으므로 한도(LL2 시간당 15회)를 태우지 않는다.
"""
import logging
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import api_client  # noqa: E402


def report(label, result, key):
    values = result.get(key)
    count = len(values) if values is not None else 0
    state = "FAIL" if result.get("error") and not values else ("OK(stale)" if result.get("stale") else "OK")
    print(f"[{state}] {label} - {count}건" + (f" (경고: {result['error']})" if result.get("error") else ""))
    return state == "FAIL"


def main(argv):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    logging.basicConfig(level=logging.WARNING, format="[log] %(levelname)s %(message)s")
    tle_only = "--tle" in argv[1:]

    calls = []
    real_get = api_client._http_get

    def counted(*args, **kwargs):
        calls.append(args[0] if args else "")
        return real_get(*args, **kwargs)

    api_client._http_get = counted   # 재대입이라 모듈 경유 호출에 그대로 걸린다(전역 8번)

    started = time.time()
    failed = False
    if not tle_only:
        failed |= report("launches", api_client.get_launches(), "launches")
        year = time.gmtime().tm_year
        failed |= report(f"archive {year}", api_client.get_archive(year), "launches")
    for group in api_client.SATELLITE_GROUP_CATALOG:
        failed |= report(f"tle {group}", api_client.get_satellites(groups=[group]), "satellites")
        if not tle_only:
            failed |= report(f"satcat {group}", api_client.get_satcat(groups=[group]), "satcat")
    print(f"[{'FAIL' if failed else 'OK'}] refresh_cache - 요청 {len(calls)}회 · {time.time() - started:.1f}초")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
