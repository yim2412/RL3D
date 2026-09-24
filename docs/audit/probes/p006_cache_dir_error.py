"""F-006 재현 — 캐시 폴더를 못 만들면 받은 데이터를 버리고 "연결이 끊겼다"고 말한다.

    python docs/audit/probes/p006_cache_dir_error.py

`_cache_write` 의 `os.makedirs(CACHE_DIR)` 가 try 밖이라, 그 OSError 가 `get_launches` 의
`except NET_ERRORS`(OSError 포함)로 떨어진다 → 네트워크는 성공했는데 0건 + 네트워크 오류 문구,
그리고 캐시가 안 생기니 **폴링마다 다시 요청**한다.
(독립 리뷰 에이전트 발견 4 — 여기서 재현.)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fault_matrix import Sandbox, GOOD  # noqa: E402
import api_client  # noqa: E402


def main():
    with Sandbox() as sb:
        # 캐시 폴더 자리에 일반 파일 — 권한·디스크 문제의 대역
        with open(api_client.CACHE_DIR, "w", encoding="utf-8") as f:
            f.write("x")
        calls = []
        api_client._http_get = lambda url: (calls.append(url), GOOD["ll2"])[1]
        rs = [api_client.get_launches() for _ in range(3)]
    n = len(rs[-1]["launches"])
    err = rs[-1]["error"]
    ok = n > 0
    print(f"  [{'OK' if ok else 'FAIL'}]   캐시 폴더 불가 · 3회 호출 → 요청 {len(calls)}회 · 발사 {n}건 · error={err!r}")
    print("[OK] p006" if ok else "[FAIL] p006")
    return 0 if ok else 1


if __name__ == "__main__":
    import logging
    logging.disable(logging.CRITICAL)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
