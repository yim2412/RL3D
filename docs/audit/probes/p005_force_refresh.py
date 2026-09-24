"""F-005 재현 — 강제 갱신에 쿨다운이 없다(파이썬 쪽).

    python docs/audit/probes/p005_force_refresh.py

`↻ 갱신` 버튼·단축키 R → `loadLaunches(true)` → `get_launches(force=True)` 는 TTL 을 **무조건** 건너뛴다.
프론트의 `beginLoad` 는 *진행 중인* 같은 요청만 막는다 — 끝난 뒤 다시 누르면 또 나간다.
한 번에 LL2 2회(upcoming+previous). 방금 받은 캐시가 있어도 마찬가지다.
(독립 리뷰 에이전트 발견 2 — 여기서 재현. 프론트 쪽 동시 실행은 재지 않았다.)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fault_matrix import Sandbox, GOOD  # noqa: E402
import api_client  # noqa: E402


def main():
    with Sandbox():
        calls = []
        api_client._http_get = lambda url: (calls.append(url), GOOD["ll2"])[1]
        for _ in range(8):   # 수 초 간격으로 R 을 여덟 번 — 매번 끝난 뒤 누른다
            api_client.get_launches(force=True)
    ok = len(calls) <= 4
    print(f"  [{'OK' if ok else 'FAIL'}]   방금 받은 캐시가 있는데 강제 갱신 8회 → LL2 요청 {len(calls)}회 (한도 시간당 15)")
    print("[OK] p005" if ok else "[FAIL] p005")
    return 0 if ok else 1


if __name__ == "__main__":
    import logging
    logging.disable(logging.CRITICAL)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
