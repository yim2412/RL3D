"""F-002 재현 — LL2 경로가 200 응답의 **모양**을 검증하지 않는다.

    python docs/audit/probes/p002_ll2_shape.py   # 결함이 있으면 [FAIL]

두 갈래:
  (a) 본문이 `null`·`[]` → `.get` 에서 AttributeError. NET_ERRORS 밖이라 **폴백을 건너뛰고**
      브릿지 너머로 예외가 간다(JS 는 "데이터를 불러오지 못했습니다"로 받는다 — 가진 캐시가 있어도).
  (b) 본문이 `{"results": null}` 이나 결과 없는 JSON → **0건을 정상으로 캐시에 쓴다.**
      지난 연도 아카이브는 TTL 이 없으므로 그 연도는 **다시는 안 불러와진다**(스키마를 올릴 때까지).
      P38 이 "범위 밖 연도"로 막은 것과 같은 피해가 **서버 쪽 빈 응답**으로 다시 열린다.
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fault_matrix import Sandbox, GOOD, _body  # noqa: E402
import api_client  # noqa: E402


def main():
    bad = 0
    # (a) 캐시가 있는데 null 본문
    with Sandbox():
        api_client._http_get = _body(GOOD["ll2"])
        n0 = len(api_client.get_launches(force=True)["launches"])
        # 강제 갱신 쿨다운(F-005) 밖으로 — 안 그러면 null 경로를 안 타고 캐시만 돌려받아 공허하게 통과한다
        old = time.time() - 120
        os.utime(api_client._cache_path("launches.json"), (old, old))
        api_client._http_get = _body("null")
        try:
            r = api_client.get_launches(force=True)
            res = f"{len(r['launches'])}건 stale={r['stale']} error={r['error']!r}"
            ok = len(r["launches"]) > 0
        except Exception as e:  # noqa: BLE001
            res, ok = f"예외 {type(e).__name__}: {e}", False
        print(f"  [{'OK' if ok else 'FAIL'}]   (a) 발사 캐시 {n0}건 + 본문 null → {res}")
        bad += not ok
    # (b) 지난 연도 아카이브 — 캐시 없음 + 결과 없는 200
    with Sandbox():
        api_client._http_get = _body('{"count": 0, "next": null, "results": null}')
        r1 = api_client.get_archive(2019)
        calls = []
        api_client._http_get = lambda url: (calls.append(url), GOOD["ll2"])[1]
        r2 = api_client.get_archive(2019)
        ok = len(r2["launches"]) > 0 or bool(r1.get("error"))
        print(f"  [{'OK' if ok else 'FAIL'}]   (b) 2019 아카이브 빈 200 → {len(r1['launches'])}건 error={r1.get('error')!r}"
              f" → 서버 복구 뒤 {len(r2['launches'])}건(요청 {len(calls)}회 — 0 이면 영구히 빈 해)")
        bad += not ok
    print("[OK] p002" if not bad else f"[FAIL] p002: {bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    import logging
    logging.disable(logging.CRITICAL)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
