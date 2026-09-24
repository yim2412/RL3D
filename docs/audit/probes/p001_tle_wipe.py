"""F-001 재현 — 200 으로 온 엉뚱한 본문이 TLE·SATCAT 캐시를 빈 결과로 덮는다.

    python docs/audit/probes/p001_tle_wipe.py    # 결함이 있으면 [FAIL] (고치면 [OK])

시나리오(캡티브 포털 — 호텔·카페 와이파이의 로그인 화면이 모든 요청에 200 + HTML 로 답한다):
  1) 정상 TLE 를 받아 캐시가 있다(오래됨 — TTL 지남)
  2) 포털 HTML 이 200 으로 온다 → 파서는 0건을 돌려주고, 코드는 그걸 **정상 결과로 캐시에 쓴다**
  3) 인터넷이 돌아온 뒤에도 TTL(TLE 2시간 · SATCAT 24시간) 동안 **빈 캐시가 '신선'** 하다
     → 요청도 안 하고 위성 0개, error 없음. 오래된 캐시 폴백도 이미 덮여 사라졌다.
네트워크 0 — `_http_get` 을 주입한다.
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fault_matrix import Sandbox, GOOD, _body  # noqa: E402
import api_client  # noqa: E402

PORTAL = "<html><head><title>Wi-Fi 로그인</title></head><body>약관에 동의하세요</body></html>"


def scenario(call, pick, good):
    with Sandbox():
        api_client._http_get = _body(good)
        n0 = len(pick(call(False)))
        for f in os.listdir(api_client.CACHE_DIR):
            old = time.time() - 30 * 24 * 3600
            os.utime(os.path.join(api_client.CACHE_DIR, f), (old, old))
        api_client._http_get = _body(PORTAL)
        r1 = call(False)
        # 인터넷 복구 — 이제 정상 본문이 오지만, 요청이 나가는지 센다
        calls = []
        api_client._http_get = lambda url: (calls.append(url), good)[1]
        r2 = call(False)
        return n0, len(pick(r1)), r1.get("error"), r1.get("stale"), len(pick(r2)), len(calls)


def main():
    bad = 0
    cases = [
        ("TLE", lambda f: api_client.get_satellites(force=f, groups=["stations"]),
         lambda r: r["satellites"], GOOD["tle"]),
        ("SATCAT", lambda f: api_client.get_satcat(groups=["stations"], force=f),
         lambda r: r["satcat"], GOOD["satcat"]),
    ]
    for name, call, pick, good in cases:
        n0, n1, err, stale, n2, req = scenario(call, pick, good)
        ok = n1 > 0 or bool(err)            # 포털 응답에 가진 데이터를 지키거나, 최소한 말은 해야 한다
        ok2 = n2 > 0                        # 복구 뒤 첫 호출에는 데이터가 돌아와야 한다
        print(f"  [{'OK' if ok and ok2 else 'FAIL'}]   {name}: 정상 {n0}건 → 포털 응답 {n1}건(error={err!r}, stale={stale})"
              f" → 복구 뒤 {n2}건(요청 {req}회)")
        bad += not (ok and ok2)
    print("[OK] p001" if not bad else f"[FAIL] p001: {bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    import logging
    logging.disable(logging.CRITICAL)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
