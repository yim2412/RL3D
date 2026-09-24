"""F-003 재현 — 해가 바뀌면 '올해' 아카이브가 받은 시점 그대로 영구 캐시가 된다.

    python docs/audit/probes/p003_year_rollover.py   # 결함이 있으면 [FAIL]

`get_archive` 는 `year >= time.gmtime().tm_year` 로 올해인지 가르고, 올해가 아니면 캐시를 **나이와
무관하게** 신선으로 본다. 그래서 12월 31일 20:00 UTC 에 받은 2026 아카이브는, 1월 1일이 되는 순간
'지난 연도'가 되어 **12월 31일 20:00 이후의 발사와, 그 뒤에 확정된 결과(성공·실패)** 를 영영 못 받는다.
(아카이브는 LL2 previous 엔드포인트 — 발사 직후 결과가 갱신되는 일이 흔하다.)
시계만 주입한다(`api_client.time` 을 바꾼 가짜) — 파일 mtime 은 실제 시각으로 두고 나이를 잰다.
"""
import os
import sys
import time as _time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fault_matrix import Sandbox, GOOD  # noqa: E402
import api_client  # noqa: E402


class FakeTime:
    """gmtime 의 연도만 바꾼다. time()·sleep 은 실제 것."""

    def __init__(self, year):
        self.year = year

    def gmtime(self, *a):
        # 인자가 있으면(파일 시각 변환) 진짜 시각 — '지금'만 바꾼다
        t = _time.gmtime(*a)
        if a and a[0] is not None:
            return t
        return _time.struct_time((self.year,) + tuple(t)[1:])

    def __getattr__(self, n):
        return getattr(_time, n)


def main():
    real = api_client.time
    try:
        with Sandbox():
            calls = []
            api_client._http_get = lambda url: (calls.append(url), GOOD["ll2"])[1]
            api_client.time = FakeTime(2026)
            api_client.get_archive(2026)                  # 12월 31일 — 올해로 받음
            path = api_client._cache_path("archive_2026.json")
            old = _time.time() - 5 * 3600                 # 5시간 전(올해 TTL 6시간 안)
            os.utime(path, (old, old))
            n_before = len(calls)
            api_client.time = FakeTime(2027)              # 1월 1일
            api_client.get_archive(2026)
            refetched = len(calls) > n_before
            # 한 해가 더 지나도(나이 1년) 다시 받는가
            older = _time.time() - 400 * 24 * 3600
            os.utime(path, (older, older))
            n2 = len(calls)
            api_client.get_archive(2026)
            ever = len(calls) > n2
        ok = refetched or ever
        print(f"  [{'OK' if ok else 'FAIL'}]   12/31 에 받은 2026 아카이브 → 1/1 에 다시 받나: {refetched} · "
              f"1년 뒤에라도 받나: {ever}")
        print("[OK] p003" if ok else "[FAIL] p003: 해가 바뀌는 순간의 스냅샷이 영구 캐시가 된다")
        return 0 if ok else 1
    finally:
        api_client.time = real


if __name__ == "__main__":
    import logging
    logging.disable(logging.CRITICAL)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
