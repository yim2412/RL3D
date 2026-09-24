"""F-004 재현 — 실패하면 백오프 없이 폴링마다 다시 요청한다(429 가 스스로 이어진다).

    python docs/audit/probes/p004_retry_storm.py   # 한도를 넘으면 [FAIL]

프론트는 5분마다 `get_launches(false)` 를 부른다(`AUTO_REFRESH_MS`). 성공하면 캐시가 TTL(15분)
동안 요청을 막지만, **실패하면 캐시가 안 바뀌어** 다음 폴링이 또 요청한다. 1시간 = 폴링 12회.
LL2 한도는 시간당 약 15회(CLAUDE.md) — 429 상태에서 이렇게 치면 한도가 풀리지 않는다.
Celestrak 은 반복 요청을 403 으로 막는 서버라, 그룹 수만큼 곱해진다.
(독립 리뷰 에이전트 발견 1 — 여기서 재현.)
"""
import os
import sys
import time
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fault_matrix import Sandbox, GOOD  # noqa: E402
import api_client  # noqa: E402

POLLS_PER_HOUR = 60 * 60 * 1000 // 300000   # AUTO_REFRESH_MS = 5분 (state.js)
LL2_HOURLY_CAP = 15


def main():
    bad = 0
    e429 = urllib.error.HTTPError("u", 429, "Too Many Requests", None, None)
    # A) 캐시 만료 + 계속 429
    with Sandbox():
        calls = []
        api_client._http_get = lambda url: (calls.append(url), GOOD["ll2"])[1]
        api_client.get_launches()
        old = time.time() - 3600
        os.utime(api_client._cache_path("launches.json"), (old, old))
        calls.clear()

        def fail(url):
            calls.append(url)
            raise e429
        api_client._http_get = fail
        for _ in range(POLLS_PER_HOUR):
            api_client.get_launches()
        ok = len(calls) <= LL2_HOURLY_CAP // 2
        print(f"  [{'OK' if ok else 'FAIL'}]   LL2 429 지속 · 1시간 폴링 {POLLS_PER_HOUR}회 → 요청 {len(calls)}회 (한도 {LL2_HOURLY_CAP})")
        bad += not ok
    # B) upcoming 은 되고 previous 만 429 — 성공한 절반도 버린다
    with Sandbox():
        calls = []

        def half(url):
            calls.append(url)
            if "upcoming" in url:
                return GOOD["ll2"]
            raise e429
        api_client._http_get = half
        for _ in range(POLLS_PER_HOUR):
            api_client.get_launches()
        ok = len(calls) <= LL2_HOURLY_CAP // 2
        print(f"  [{'OK' if ok else 'FAIL'}]   upcoming 성공·previous 429 · 1시간 → 요청 {len(calls)}회")
        bad += not ok
    # C) Celestrak 403 — 그룹 8개
    with Sandbox():
        calls = []

        def f403(url):
            calls.append(url)
            raise urllib.error.HTTPError(url, 403, "Forbidden", None, None)
        api_client._http_get = f403
        groups = list(api_client.SATELLITE_GROUP_CATALOG)[:8]
        for _ in range(POLLS_PER_HOUR):
            api_client.get_satellites(groups=groups)
        print(f"  [{'OK' if len(calls) <= 16 else 'FAIL'}]   Celestrak 403 · 그룹 {len(groups)}개 · 폴링 {POLLS_PER_HOUR}회 → 요청 {len(calls)}회"
              f" (TLE 만 — 프론트가 TLE 를 폴링마다 부르는지는 아래 주석)")
        bad += len(calls) > 16
    print("[OK] p004" if not bad else f"[FAIL] p004: {bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    import logging
    logging.disable(logging.CRITICAL)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
