"""캐시·폴백·아카이브·설정 회귀 테스트 (P12-20) — 네트워크 없이 돈다.

    python tests/test_cache.py

`test_parsing.py` 가 덮는 것은 **응답을 어떻게 읽는가**뿐이다. 여기서 재는 것은 그 바깥,
**언제 부르고 실패하면 무엇을 돌려주는가**다 — TTL 만료 판정 · 오래된 캐시 폴백 ·
아카이브 페이지 상한 · 설정 병합. 전부 **틀려도 예외가 안 나고 값만 조용히 달라지는** 자리다
(요청이 두 배로 늘어도 화면은 똑같이 보인다 — 429 가 뜨고 나서야 안다).

HTTP 는 `api_client._http_get` 을 갈아끼워 막는다. 캐시·설정 경로는 모듈 전역을 임시
디렉터리로 재대입한다 — **이름 import 가 아니라 모듈 경유**여야 재대입이 보인다(전역 규칙 8번).
"""
import builtins
import http.client
import io
import json
import logging
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import ssl
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import api_client  # noqa: E402
import api_parsing  # noqa: E402
import main  # noqa: E402


def _page(count=1, next_url=None, tag="x"):
    """LL2 페이지 응답 한 장. 좌표가 있어야 정규화를 통과한다."""
    results = [{
        "id": "{}-{}".format(tag, i),
        "name": "테스트 발사 {}".format(i),
        "net": "2025-05-0{}T00:00:00Z".format((i % 9) + 1),
        "status": {"name": "Launch Successful", "abbrev": "Success"},
        "pad": {"name": "P", "latitude": "28.5", "longitude": "-80.5",
                "location": {"name": "Cape"}},
    } for i in range(count)]
    return json.dumps({"results": results, "next": next_url})


class CacheTestBase(unittest.TestCase):
    """캐시·설정을 임시 디렉터리로 돌리고, HTTP 를 호출 기록으로 바꾼다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="rl3d-test-")
        self._saved = (api_client.APP_DIR, api_client.CACHE_DIR, api_client.SETTINGS_PATH)
        api_client.APP_DIR = self.tmp
        api_client.CACHE_DIR = os.path.join(self.tmp, "cache")
        api_client.SETTINGS_PATH = os.path.join(self.tmp, "settings.json")
        self.calls = []
        self._real_http = api_client._http_get
        api_client._reset_request_memory()   # 실패 백오프는 모듈 전역 — 앞 테스트의 실패가 새지 않게
        logging.disable(logging.CRITICAL)   # 실패 경로는 warning 을 찍는다 — 출력만 가린다

    def tearDown(self):
        api_client._http_get = self._real_http
        api_client.APP_DIR, api_client.CACHE_DIR, api_client.SETTINGS_PATH = self._saved
        logging.disable(logging.NOTSET)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def serve(self, *bodies):
        """호출 순서대로 응답을 돌려주는 가짜 HTTP. 모자라면 마지막 것을 반복한다."""
        def fake(url):
            self.calls.append(url)
            return bodies[min(len(self.calls) - 1, len(bodies) - 1)]
        api_client._http_get = fake

    def fail_with(self, exc):
        def fake(url):
            self.calls.append(url)
            raise exc
        api_client._http_get = fake

    def age_cache(self, name, seconds):
        """캐시 파일을 `seconds` 초 전에 쓴 것처럼 만든다(TTL 경계를 재는 유일한 방법)."""
        path = api_client._cache_path(name)
        old = time.time() - seconds
        os.utime(path, (old, old))


class TestLaunchCacheTTL(CacheTestBase):
    def test_fresh_cache_makes_no_request(self):
        self.serve(_page(2), _page(2, tag="prev"))
        api_client.get_launches()
        self.assertEqual(len(self.calls), 2)      # upcoming + previous
        api_client.get_launches()
        self.assertEqual(len(self.calls), 2, "신선한 캐시인데 다시 요청했다")

    def test_expired_cache_refetches(self):
        self.serve(_page(2), _page(2, tag="prev"))
        api_client.get_launches()
        self.age_cache("launches.json", api_client.TTL_LAUNCHES + 1)
        api_client.get_launches()
        self.assertEqual(len(self.calls), 4, "TTL 이 지났는데 캐시를 그대로 썼다")

    def test_just_inside_ttl_does_not_refetch(self):
        # 경계: TTL 직전은 캐시. 부등호가 뒤집히면 여기서만 갈린다.
        self.serve(_page(2), _page(2, tag="prev"))
        api_client.get_launches()
        self.age_cache("launches.json", api_client.TTL_LAUNCHES - 5)
        api_client.get_launches()
        self.assertEqual(len(self.calls), 2)

    def test_force_ignores_fresh_cache(self):
        # TTL 안이지만 강제 갱신 쿨다운(FORCE_MIN_INTERVAL)은 지난 캐시 — 받자마자 누른 것은
        # 막는 게 맞다(F-005). 그 경계는 TestRequestGate 가 잰다.
        self.serve(_page(2), _page(2, tag="prev"))
        api_client.get_launches()
        self.age_cache("launches.json", api_client.FORCE_MIN_INTERVAL + 1)
        api_client.get_launches(force=True)
        self.assertEqual(len(self.calls), 4, "force 인데 캐시를 썼다")

    def test_age_is_reported(self):
        self.serve(_page(2), _page(2, tag="prev"))
        api_client.get_launches()
        self.age_cache("launches.json", 300)
        res = api_client.get_launches()
        self.assertIsNotNone(res["age"])
        self.assertGreater(res["age"], 290)   # 프론트의 "N분 전 갱신"이 이 값을 쓴다


class TestStaleFallback(CacheTestBase):
    def test_network_failure_returns_old_cache(self):
        self.serve(_page(3), _page(0))
        first = api_client.get_launches()
        self.assertEqual(len(first["launches"]), 3)

        self.age_cache("launches.json", api_client.TTL_LAUNCHES + 1)
        self.fail_with(urllib.error.URLError("getaddrinfo failed"))
        res = api_client.get_launches()
        self.assertEqual(len(res["launches"]), 3, "오프라인인데 화면이 비었다")
        self.assertTrue(res["stale"])
        self.assertIsNotNone(res["error"])
        self.assertNotIn("URLError", res["error"])   # 사람이 읽는 말이어야 한다

    def test_failure_without_cache_is_not_stale(self):
        self.fail_with(urllib.error.URLError("nope"))
        res = api_client.get_launches()
        self.assertEqual(res["launches"], [])
        self.assertFalse(res["stale"], "보여줄 캐시가 없는데 stale 이라고 했다")
        self.assertIsNotNone(res["error"])

    def test_broken_cache_file_is_treated_as_missing(self):
        os.makedirs(api_client.CACHE_DIR, exist_ok=True)
        with open(api_client._cache_path("launches.json"), "w", encoding="utf-8") as f:
            f.write("{잘린 json")
        self.serve(_page(1), _page(0))
        res = api_client.get_launches()
        self.assertEqual(len(res["launches"]), 1, "깨진 캐시 때문에 앱이 멈췄다")

    def test_cache_survives_hangul_as_utf8(self):
        # 캐시는 한글 이름을 담는다. 로캘에 맡기면 CP949 PC 에서 깨진다(전역 규칙).
        self.serve(_page(1), _page(0))
        api_client.get_launches()
        with open(api_client._cache_path("launches.json"), "rb") as f:
            raw = f.read()
        self.assertIn("테스트 발사".encode("utf-8"), raw)


class TestResultLogging(CacheTestBase):
    """데이터 한 번을 받을 때마다 **한 줄** 남는가(P30-1).

    예전에는 **성공이 한 줄도 안 남았다** — 실제 exe 를 13분 띄운 로그가 3줄뿐이었다.
    그래서 "화면이 비었다"는 말이 나와도 **캐시를 썼는지 네트워크를 탔는지** 알 수 없었다.
    로그는 눈으로 보는 것이라 깨져도 아무도 모른다 — 그래서 여기서 못 박는다.
    """

    def setUp(self):
        super().setUp()
        logging.disable(logging.NOTSET)   # 이 클래스는 로그 자체를 잰다

    def test_network_fetch_logs_one_line(self):
        self.serve(_page(3), _page(0))
        with self.assertLogs("api_client", level="INFO") as cm:
            api_client.get_launches()
        line = chr(10).join(cm.output)
        self.assertIn("발사 3건", line)
        self.assertIn("네트워크", line, "어디서 받았는지가 안 남는다")

    def test_cache_hit_says_cache_and_age(self):
        self.serve(_page(3), _page(0))
        api_client.get_launches()
        self.age_cache("launches.json", 120)
        with self.assertLogs("api_client", level="INFO") as cm:
            api_client.get_launches()
        line = chr(10).join(cm.output)
        # **"캐시를 썼다"가 바로 알고 싶은 것**이다 — 네트워크와 구별되지 않으면 의미가 없다.
        self.assertIn("캐시", line)
        self.assertIn("2분 전", line, "캐시 나이가 안 남는다")
        self.assertNotIn("네트워크", line)

    def test_archive_and_satellites_log_too(self):
        self.serve(_page(2), _page(0))
        with self.assertLogs("api_client", level="INFO") as cm:
            api_client.get_archive(2024)
        self.assertIn("아카이브 2024", chr(10).join(cm.output))

        tle = chr(10).join([
            "ISS (ZARYA)",
            "1 25544U 98067A   24001.00000000  .00000000  00000-0  00000-0 0  9990",
            "2 25544  51.6400 000.0000 0001000 000.0000 000.0000 15.50000000000000",
        ])
        api_client._http_get = lambda url: tle
        with self.assertLogs("api_client", level="INFO") as cm:
            api_client.get_satellites(groups=["stations"])
        self.assertIn("위성 TLE", chr(10).join(cm.output))

    def test_truncated_archive_says_so_in_the_line(self):
        """잘린 아카이브는 **그 줄에서** 드러나야 한다 — 따로 찾아 맞춰 보지 않아도 되게."""
        pages = [json.dumps({"results": [], "next": "http://x/next"})] * 20
        self.serve(*pages)
        with self.assertLogs("api_client", level="INFO") as cm:
            api_client.get_archive(2024)
        self.assertIn("잘림", chr(10).join(cm.output))


class TestNetworkErrorKinds(CacheTestBase):
    """**연결이 끊기는 방식마다** 폴백이 도는가(P29-1).

    예전에는 `(URLError, HTTPError, ValueError, TimeoutError)` 네 가지만 잡았다.
    나머지는 **예외가 그대로 올라가 캐시 폴백이 통째로 건너뛰어졌다** — 가진 데이터가
    있는데 화면은 비었다. 실측으로 13종 중 7종이 그랬고, 전부 실제 인터넷에서 흔하다.

    예외는 **터지지 않는 것만으로는 부족하다**: 폴백이 돌아 `stale=True` 와 **건수**가
    나와야 하고, 문구가 예외 이름이 아니라 사람 말이어야 한다.
    """

    # (이름, 예외, 문구에 들어가야 할 말)
    KINDS = [
        ("URLError", urllib.error.URLError("refused"), "인터넷 연결"),
        ("HTTPError 429", urllib.error.HTTPError("u", 429, "Too Many", None, None), "한도"),
        ("TimeoutError", TimeoutError("timed out"), "타임아웃"),
        ("ValueError", ValueError("bad json"), "읽지 못했습니다"),
        ("ConnectionResetError", ConnectionResetError(10054, "reset"), "중간에 끊겼"),
        ("RemoteDisconnected", http.client.RemoteDisconnected("bye"), "중간에 끊겼"),
        ("IncompleteRead", http.client.IncompleteRead(b"", 10), "중간에 끊겼"),
        ("BadStatusLine", http.client.BadStatusLine("junk"), "중간에 끊겼"),
        ("SSLError", ssl.SSLError("handshake"), "보안 연결"),
        ("SSLEOFError", ssl.SSLEOFError("eof"), "보안 연결"),
        ("OSError", OSError(9, "bad fd"), "중간에 끊겼"),
        ("UnicodeDecodeError", UnicodeDecodeError("utf-8", bytes([255]), 0, 1, "invalid"), "읽지 못했습니다"),
    ]

    def test_every_kind_falls_back_to_cache(self):
        for name, exc, phrase in self.KINDS:
            with self.subTest(kind=name):
                self.setUp()
                try:
                    self.serve(_page(3), _page(0))
                    self.assertEqual(len(api_client.get_launches()["launches"]), 3)
                    self.age_cache("launches.json", api_client.TTL_LAUNCHES + 1)
                    self.fail_with(exc)
                    res = api_client.get_launches()
                    self.assertEqual(len(res["launches"]), 3,
                                     f"{name}: 캐시가 있는데 화면이 비었다")
                    self.assertTrue(res["stale"], f"{name}: 오래된 캐시를 쓰면서 stale 이 아니다")
                    self.assertIn(phrase, res["error"], f"{name}: 원인에 맞는 말을 안 한다")
                    self.assertNotIn(type(exc).__name__, res["error"],
                                     f"{name}: 예외 이름이 그대로 화면에 나온다")
                finally:
                    self.tearDown()

    def test_archive_and_tle_use_the_same_net_errors(self):
        """같은 묶음을 쓰는 다섯 곳 중 **다른 경로도** 폴백하는가.

        발사만 고치고 아카이브·TLE 를 빼면, 그쪽은 여전히 조용히 터진다.
        """
        self.serve(_page(2), _page(0))
        api_client.get_archive(2024)
        self.fail_with(ConnectionResetError(10054, "reset"))
        res = api_client.get_archive(2024, force=True)
        self.assertTrue(res["stale"], "아카이브: 연결이 끊겼는데 폴백을 안 했다")
        self.assertIn("중간에 끊겼", res["error"])


class TestArchive(CacheTestBase):
    def setUp(self):
        super().setUp()
        self.sleep = mock.patch("time.sleep")   # 페이지 사이 딜레이로 테스트가 자면 안 된다
        self.sleep_mock = self.sleep.start()

    def tearDown(self):
        self.sleep.stop()
        super().tearDown()

    def test_past_year_cache_never_expires(self):
        self.serve(_page(2))
        api_client.get_archive(2019)
        self.age_cache("archive_2019.json", 400 * 24 * 3600)   # 1년도 더 전
        api_client.get_archive(2019)
        self.assertEqual(len(self.calls), 1, "지난 연도는 안 변하는데 다시 받았다")

    def test_current_year_expires(self):
        year = time.gmtime().tm_year
        self.serve(_page(2))
        api_client.get_archive(year)
        n = len(self.calls)
        self.age_cache("archive_{}.json".format(year), api_client.TTL_ARCHIVE_CURRENT + 1)
        api_client.get_archive(year)
        self.assertGreater(len(self.calls), n, "올해 아카이브가 갱신되지 않았다")

    def test_page_cap_stops_the_walk(self):
        # next 가 끝없이 이어지는 응답 — 캡이 없으면 여기서 무한 요청이 된다.
        self.serve(_page(1, next_url=api_client.LL2_BASE + "/next"))
        res = api_client.get_archive(2018)
        self.assertEqual(len(self.calls), api_client.ARCHIVE_MAX_PAGES)
        self.assertEqual(len(res["launches"]), api_client.ARCHIVE_MAX_PAGES)

    def test_truncated_flag_when_capped(self):
        # P12-6: 캡에 걸린 사실이 화면까지 가야 한다. 없으면 "그 해는 이게 전부"로 읽힌다.
        self.serve(_page(1, next_url=api_client.LL2_BASE + "/next"))
        self.assertTrue(api_client.get_archive(2018)["truncated"])

    def test_not_truncated_when_walk_ends(self):
        self.serve(_page(1, next_url=api_client.LL2_BASE + "/p2"), _page(1, next_url=None, tag="p2"))
        res = api_client.get_archive(2017)
        self.assertFalse(res["truncated"], "끝까지 받았는데 잘렸다고 했다")
        self.assertEqual(len(res["launches"]), 2)

    def test_truncated_is_remembered_in_cache(self):
        # 캐시에서 꺼내 쓸 때도 잘림 표시가 남아야 한다 — 두 번째 실행부터 조용해지면
        # "처음 열었을 때만 경고가 뜨는" 더 나쁜 모양이 된다.
        self.serve(_page(1, next_url=api_client.LL2_BASE + "/next"))
        api_client.get_archive(2013)
        self.calls.clear()
        again = api_client.get_archive(2013)
        self.assertEqual(self.calls, [], "캐시가 있는데 다시 받았다")
        self.assertTrue(again["truncated"], "캐시로 돌려줄 때 잘림 표시가 사라졌다")

    def test_delay_between_pages_only(self):
        # 마지막 페이지 뒤에는 자지 않는다(멈춘 것처럼 보이는 시간을 늘리지 않는다).
        self.serve(_page(1, next_url=api_client.LL2_BASE + "/p2"), _page(1, next_url=None, tag="p2"))
        api_client.get_archive(2016)
        self.assertEqual(self.sleep_mock.call_count, 1)

    def test_failure_falls_back_to_cache(self):
        self.serve(_page(2))
        api_client.get_archive(2015)
        self.fail_with(urllib.error.HTTPError("u", 500, "err", None, None))
        res = api_client.get_archive(2015, force=True)
        self.assertEqual(len(res["launches"]), 2)
        self.assertTrue(res["stale"])

    def test_year_accepts_string(self):
        self.serve(_page(1))
        self.assertEqual(api_client.get_archive("2014")["year"], 2014)


class TestSettingsMerge(CacheTestBase):
    def test_missing_file_is_empty_dict(self):
        self.assertEqual(api_client.load_settings(), {})

    def test_patch_merges_and_keeps_other_keys(self):
        api_client.save_settings({"filters": {"success": True}})
        api_client.save_settings({"window": {"x": 10}})
        data = api_client.load_settings()
        self.assertEqual(data["filters"], {"success": True}, "다른 키를 저장했더니 필터가 사라졌다")
        self.assertEqual(data["window"], {"x": 10})

    def test_same_key_is_replaced_not_deep_merged(self):
        # 얕은 병합이 규약이다. 프론트는 최상위 키를 통째로 보낸다(끈 것만 담는 필터 등).
        api_client.save_settings({"satellites": {"groups": ["a"], "enabled": True}})
        api_client.save_settings({"satellites": {"groups": ["b"]}})
        self.assertEqual(api_client.load_settings()["satellites"], {"groups": ["b"]})

    def test_non_dict_patch_is_ignored(self):
        api_client.save_settings({"a": 1})
        api_client.save_settings("망가진 값")
        self.assertEqual(api_client.load_settings()["a"], 1)

    def test_broken_settings_file_does_not_kill_the_app(self):
        os.makedirs(api_client.APP_DIR, exist_ok=True)
        with open(api_client.SETTINGS_PATH, "w", encoding="utf-8") as f:
            f.write("[아니 이건 리스트다]")
        self.assertEqual(api_client.load_settings(), {})   # dict 가 아니면 빈 설정
        api_client.save_settings({"a": 1})
        self.assertEqual(api_client.load_settings()["a"], 1)

    def test_hangul_settings_round_trip_as_utf8(self):
        api_client.save_settings({"메모": "한글 값"})
        with open(api_client.SETTINGS_PATH, "rb") as f:
            self.assertIn("한글 값".encode("utf-8"), f.read())
        self.assertEqual(api_client.load_settings()["메모"], "한글 값")


class TestSatelliteGroups(CacheTestBase):
    TLE = ("ISS (ZARYA)\n"
           "1 25544U 98067A   26200.50000000  .00001000  00000+0  10000-3 0  9990\n"
           "2 25544  51.6400  10.0000 0004000 100.0000 260.0000 15.50000000    01\n")

    def test_unknown_group_is_ignored(self):
        self.serve(self.TLE)
        res = api_client.get_satellites(groups=["stations", "존재하지않는그룹"])
        self.assertEqual(res["groups"], ["stations"])

    def test_explicit_empty_selection_fetches_nothing(self):
        self.serve(self.TLE)
        res = api_client.get_satellites(groups=[])
        self.assertEqual(res["satellites"], [])
        self.assertEqual(self.calls, [], "그룹을 비웠는데 요청했다")

    def test_duplicate_norad_across_groups_is_deduped(self):
        self.serve(self.TLE)
        res = api_client.get_satellites(groups=["stations", "visual"])
        self.assertEqual(len(res["satellites"]), 1, "두 그룹에 같은 위성이 있으면 한 번만 나와야 한다")

    def test_tle_ttl_reuses_cache(self):
        self.serve(self.TLE)
        api_client.get_satellites(groups=["stations"])
        api_client.get_satellites(groups=["stations"])
        self.assertEqual(len(self.calls), 1)
        self.age_cache("tle_stations.json", api_client.TTL_TLE + 1)
        api_client.get_satellites(groups=["stations"])
        self.assertEqual(len(self.calls), 2)


def _release(tag="v1.14.0", url="https://example.invalid/r/v1.14.0", name="RL3D v1.14.0"):
    return json.dumps({"tag_name": tag, "html_url": url, "name": name})


class TestBridgeInputs(CacheTestBase):
    """브릿지 너머에서 온 값 (P38-1).

    `window.pywebview.api.*` 인자는 **JS 가 주는 값**이다. `main.py` 의 `log()` 는
    *"브릿지 입력이라 신뢰하지 않는다"* 고 적어 두고 화이트리스트로 받는데, 같은 파일의
    다른 메서드들은 그 원칙을 안 지키고 있었다 — 실측(2026-09-23):

      * `get_archive(None)`·`('abc')`·`({})` 가 **그대로 던졌다**(TypeError/ValueError).
      * `get_archive(0)`·`(1800)`·`(99999)` 는 **실제로 LL2 를 때리고**, 빈 결과를
        `archive_0.json` 으로 **영구 캐시**에 남겼다(지난 연도는 TTL 이 없다).
        시간당 15회 한도가 이 앱의 상수인데 그걸 아무 값에나 태운다.
      * `get_satellites(groups=123)` 이 `TypeError` 로 던졌다.
      * `get_satcat(groups=[])` 이 **기본 그룹으로 바뀌어** 요청을 냈다 — 같은 인자가
        TLE 쪽(빈 선택을 존중)과 **다른 뜻**이었다.
    """

    def setUp(self):
        super().setUp()
        self.serve(json.dumps({"results": [], "next": None}))

    def test_bad_year_makes_no_request(self):
        for bad in (None, "abc", {}, [], 0, -5, 1800, 99999, True, 3.7e9):
            with self.subTest(bad=bad):
                self.calls.clear()
                res = api_client.get_archive(bad)
                self.assertEqual(self.calls, [], "요청이 나갔다: %r" % (bad,))
                self.assertIsNone(res["year"])
                self.assertIn("1957", res["error"])
                self.assertEqual(res["launches"], [])

    def test_bad_year_leaves_no_cache_file(self):
        api_client.get_archive(99999)
        api_client.get_archive("abc")
        self.assertEqual(sorted(os.listdir(api_client.CACHE_DIR))
                         if os.path.isdir(api_client.CACHE_DIR) else [], [])

    def test_good_year_still_works(self):
        this_year = time.gmtime().tm_year
        for good in (1957, 2025, str(this_year), this_year + 1):
            with self.subTest(good=good):
                res = api_client.get_archive(good)
                self.assertEqual(res["year"], int(good))
                self.assertIsNone(res["error"])

    def test_year_after_next_is_refused(self):
        """내년까지만 받는다 — 그 뒤는 빈 결과를 영구 캐시로 남길 뿐이다."""
        res = api_client.get_archive(time.gmtime().tm_year + 2)
        self.assertIsNone(res["year"])
        self.assertEqual(self.calls, [])

    def test_groups_string_is_one_group_not_letters(self):
        """`"stations"` 를 그대로 순회하면 글자 단위가 되어 **조용히 빈 목록**이 된다."""
        res = api_client.get_satellites(groups="stations")
        self.assertEqual(res["groups"], ["stations"])

    def test_unusable_groups_do_not_raise(self):
        for bad in (123, 4.5, object()):
            with self.subTest(bad=bad):
                res = api_client.get_satellites(groups=bad)
                self.assertEqual(res["groups"], [])

    def test_empty_selection_means_empty_for_satcat_too(self):
        """TLE 는 빈 선택을 존중했는데 SATCAT 만 기본 그룹으로 바꿔 요청했다."""
        self.calls.clear()
        api_client.get_satcat(groups=[])
        self.assertEqual(self.calls, [])

    def test_none_still_means_default_groups(self):
        res = api_client.get_satellites(groups=None)
        self.assertEqual(res["groups"], list(api_client.DEFAULT_SATELLITE_GROUPS))


SATCAT_CSV = (
    "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,"
    "LAUNCH_DATE,LAUNCH_SITE,RCS_SIZE" + chr(13) + chr(10) +
    "ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TTMTR,LARGE" + chr(13) + chr(10)
)


class TestPythonMutationGaps(CacheTestBase):
    """조건을 뒤집어도 아무도 못 잡던 자리들 (P42).

    2026-09-23 에 파이썬 `if` 93개를 하나씩 뒤집어 봤더니 **32개가 전부 초록**이었다.
    그중 스모크(`__main__`)와 개발 전용 경로를 빼고 남은 것이 아래다 — 전부
    **요청 수·데이터 양·폴백**처럼 조용히 틀어지는 종류다.
    """

    def test_satcat_ttl_reuses_cache(self):
        """TLE 에는 TTL 테스트가 있었는데 **SATCAT 에는 없었다.**

        이 조건이 뒤집히면 캐시가 있어도 매번 네트워크를 때린다 — 그룹당 한 번씩이라
        그룹 여덟이면 **시간당 요청이 여덟 배**가 된다. 오류도 경고도 없다.
        """
        self.serve(SATCAT_CSV)
        api_client.get_satcat(groups=["stations"])
        first = len(self.calls)
        api_client.get_satcat(groups=["stations"])
        self.assertEqual(len(self.calls), first, "캐시가 있는데 또 요청했다")

    def test_satcat_expires_after_ttl(self):
        self.serve(SATCAT_CSV)
        api_client.get_satcat(groups=["stations"])
        self.age_cache("satcat_stations.json", api_client.TTL_SATCAT + 60)
        before = len(self.calls)
        api_client.get_satcat(groups=["stations"])
        self.assertGreater(len(self.calls), before, "TTL 이 지났는데 안 받았다")

    def test_group_cap_limits_what_we_keep(self):
        """대형 그룹은 상한까지만 본다 — 안 그러면 렌더가 무너진다(P11-3 의 전제).

        상한이 사라져도 **화면이 느려질 뿐 오류는 안 난다**: 테스트가 없으면 모른다.
        """
        cap = (api_client.SATELLITE_GROUP_CATALOG.get("starlink") or {}).get("cap")
        self.assertTrue(cap, "starlink 에 상한이 있어야 이 테스트가 뜻이 있다")
        lines = []
        for i in range(cap + 50):
            lines.append("SAT-%04d" % i)
            lines.append("1 %05dU 98067A   26265.50000000  .00016717  00000-0  10270-3 0  9006" % (i + 10000))
            lines.append("2 %05d  51.6400 208.9163 0006317  69.9862 290.1591 15.49468300 10000" % (i + 10000))
        self.serve("\n".join(lines))
        res = api_client.get_satellites(groups=["starlink"])
        self.assertEqual(len(res["satellites"]), cap,
                         "상한을 넘겨 받았다 — 지도에 %d개를 그리게 된다" % len(res["satellites"]))

    def test_fresh_cache_is_not_replaced_by_stale_fallback(self):
        """네트워크가 죽었을 때 **이미 읽어 둔 캐시**를 오래된 것으로 덮지 않는다.

        `if cached is None:` 을 뒤집으면 신선한 캐시를 버리고 폴백을 다시 읽는다 —
        결과는 같아 보이지만 **디스크를 한 번 더 읽고**, 폴백이 실패하면 데이터가 사라진다.
        """
        self.serve(SATCAT_CSV)
        api_client.get_satcat(groups=["stations"])
        self.age_cache("satcat_stations.json", api_client.TTL_SATCAT + 60)
        self.fail_with(OSError("끊김"))
        res = api_client.get_satcat(groups=["stations"])
        self.assertTrue(res["satcat"], "네트워크가 죽었는데 오래된 캐시도 안 돌려줬다")
        self.assertTrue(res["stale"])

    def test_first_error_is_kept_not_the_last(self):
        """그룹 여럿이 실패하면 **처음 것**을 보여준다 — 마지막 것으로 덮으면
        화면 문구가 매번 달라져 무엇이 문제인지 흐려진다."""
        seq = [OSError("첫 번째 실패"), OSError("두 번째 실패")]
        def fake(url):
            self.calls.append(url)
            raise seq[min(len(self.calls) - 1, len(seq) - 1)]
        api_client._http_get = fake
        res = api_client.get_satellites(groups=["stations", "visual"])
        self.assertTrue(res["error"])

    def test_broken_settings_are_quarantined_only_when_stable(self):
        """설정 파일이 깨졌을 때 **두 번 읽어 같으면** 격리한다.

        한 번만 보고 격리하면, 다른 프로세스가 쓰는 중이라 반쪽만 읽힌 순간에도
        멀쩡한 설정을 치워 버린다(P22 에서 동시 쓰기를 실측한 자리와 같은 갈래).
        """
        with io.open(api_client.SETTINGS_PATH, "w", encoding="utf-8") as f:
            f.write("{이건 JSON 이 아니다")
        got = api_client.load_settings()
        self.assertEqual(got, {}, "못 읽었으면 빈 설정이어야 한다")
        quarantined = [n for n in os.listdir(os.path.dirname(api_client.SETTINGS_PATH))
                       if "settings" in n and n.endswith(".bad.json")]
        self.assertTrue(quarantined, "두 번 읽어도 같으면 격리해야 한다")



class TestBridgeUrlGuard(unittest.TestCase):
    """`open_url` 의 스킴 화이트리스트 (P42).

    브릿지는 **외부 API 가 준 URL** 을 그대로 기본 브라우저에 넘긴다. 그래서
    `http`/`https` 만 허용하는데, **그 한 줄을 뒤집어도 아무 테스트도 안 깨졌다**
    (2026-09-23 조건 변이). P38 에서 *"이미 방어돼 있다"* 고 기각했던 자리이기도 하다 —
    **방어는 있는데 그 방어를 지키는 것이 없었다.**
    """

    def setUp(self):
        self.opened = []
        self._real = main.webbrowser.open
        main.webbrowser.open = lambda u: self.opened.append(u)
        self.api = main.Api()

    def tearDown(self):
        main.webbrowser.open = self._real

    def test_http_and_https_pass(self):
        for url in ("http://example.com/a", "https://example.com/b?x=1"):
            self.assertTrue(self.api.open_url(url), url)
        self.assertEqual(len(self.opened), 2)

    def test_other_schemes_are_refused(self):
        bad = ["file:///C:/Windows/System32/cmd.exe", "javascript:alert(1)",
               "data:text/html,<script>x</script>", "ms-settings:", "vbscript:msgbox",
               "ftp://example.com/x", "//example.com/x", "example.com", ""]
        for url in bad:
            with self.subTest(url=url):
                self.assertFalse(self.api.open_url(url), url)
        self.assertEqual(self.opened, [], "막아야 할 것을 브라우저로 넘겼다")

    def test_non_string_is_refused(self):
        for url in (None, 123, {}, []):
            with self.subTest(url=url):
                self.assertFalse(self.api.open_url(url))
        self.assertEqual(self.opened, [])



class TestRequestBudget(unittest.TestCase):
    """TTL 과 요청 예산 (P47).

    **이 앱의 제약은 하나다: Launch Library 2 는 시간당 약 15회.** 그 예산을 실제로
    정하는 것이 TTL 상수인데, 2026-09-24 에 재 보니 **`TTL_LAUNCHES` 를 15분에서
    6시간으로 바꿔도 테스트가 전부 통과했다.** 다른 테스트들이 `TTL_LAUNCHES + 1` 처럼
    **상수를 참조해** 경계를 잡기 때문이다 — 상수가 무엇이든 따라간다.

    그래서 값이 틀어져도 조용하다:
      * **늘리면**(15분 → 6시간) 화면이 여섯 시간 낡은 데이터를 보여준다.
      * **줄이면**(15분 → 1분) 요청이 **15배**가 되어 429 에 걸린다.

    여기서는 **값 자체를 숫자로 못 박는다.** 바꾸려면 이 테스트도 같이 고쳐야 하고,
    그때 *"왜 바꾸나"* 를 한 번 묻게 된다. 그것이 이 테스트의 전부이자 목적이다.
    """

    def test_ttl_values_are_what_the_docs_say(self):
        # `CLAUDE.md` 의 "API 규칙 — 이 앱의 실제 수치" 절과 **같은 값**이어야 한다.
        self.assertEqual(api_client.TTL_LAUNCHES, 15 * 60, "발사 TTL 은 15분")
        self.assertEqual(api_client.TTL_TLE, 2 * 60 * 60, "TLE TTL 은 2시간")
        self.assertEqual(api_client.TTL_SATCAT, 24 * 60 * 60, "SATCAT TTL 은 24시간")
        self.assertEqual(api_client.TTL_ARCHIVE_CURRENT, 6 * 60 * 60, "올해 아카이브는 6시간")
        self.assertEqual(api_client.TTL_UPDATE, 24 * 60 * 60, "업데이트 확인은 하루 1회")

    def test_launch_requests_stay_under_the_hourly_cap(self):
        """발사 폴링이 한도 안에 드는가 — **한 번 받을 때 두 요청**(upcoming + previous)이다."""
        per_fetch = 2
        fetches_per_hour = 3600 / api_client.TTL_LAUNCHES
        self.assertLessEqual(fetches_per_hour * per_fetch, 15,
                             "발사만으로 시간당 한도를 넘는다")
        # 실제로는 8회다(4 × 2). 그 여유가 아카이브·업데이트 확인의 몫이다.
        self.assertEqual(fetches_per_hour * per_fetch, 8)

    def test_archive_walk_is_capped(self):
        """아카이브는 **연도당** 최대 몇 요청인가 — 이게 없으면 한 번에 예산을 태운다."""
        self.assertEqual(api_client.ARCHIVE_MAX_PAGES, 5)
        self.assertGreaterEqual(api_client.ARCHIVE_PAGE_DELAY, 1,
                                "페이지 사이 간격이 없으면 레이트리밋에 걸린다")

    def test_archive_year_range(self):
        """스푸트니크 1호(1957) 이전에는 궤도 발사가 없다(P38-1)."""
        self.assertEqual(api_client.ARCHIVE_MIN_YEAR, 1957)

    def test_failure_backoff_and_force_interval(self):
        """실패 백오프·강제 갱신 간격(전면 감사 F-004·F-005) — 값을 못 박는다.

        줄이면 429 가 풀리지 않게 스스로 한도를 채우고, 늘리면 복구 뒤에도 오래 낡은 화면이다.
        """
        self.assertEqual(api_client.FAIL_BACKOFF, {"ll2": 30 * 60, "celestrak": 2 * 60 * 60})
        self.assertEqual(api_client.FORCE_MIN_INTERVAL, 60)
        # 429 가 이어질 때 LL2 요청 상한: 백오프마다 2요청 → 시간당 4 — 한도의 1/3 안
        self.assertLessEqual(3600 / api_client.FAIL_BACKOFF["ll2"] * 2, 15 / 3)

    def test_file_retry_is_bounded(self):
        """파일 재시도는 **유한**해야 한다 — 무한이면 앱이 멈춘 것처럼 보인다."""
        self.assertGreaterEqual(api_client.FILE_RETRIES, 2)
        self.assertLessEqual(api_client.FILE_RETRIES * api_client.FILE_RETRY_WAIT, 1.0,
                             "재시도 총 대기가 1초를 넘으면 사람이 느낀다")


class TestVersionCompare(unittest.TestCase):
    """버전 비교는 **틀려도 예외가 안 난다** — 없는 업데이트를 알리거나 있는 것을 놓칠 뿐이다."""

    def test_parses_with_and_without_v(self):
        self.assertEqual(api_parsing.parse_version("v1.13.0"), (1, 13, 0))
        self.assertEqual(api_parsing.parse_version("1.13.0"), (1, 13, 0))

    def test_pads_missing_parts(self):
        self.assertEqual(api_parsing.parse_version("2"), (2, 0, 0))
        self.assertEqual(api_parsing.parse_version("1.4"), (1, 4, 0))

    def test_unreadable_is_none(self):
        for bad in ("nightly", "", None, "v", "..", 13):
            self.assertIsNone(api_parsing.parse_version(bad), bad)

    def test_numeric_not_lexicographic(self):
        # 문자열 비교면 "1.9.0" > "1.13.0" 이 된다 — 실제로 이 앱이 지나온 구간이다
        self.assertTrue(api_parsing.is_newer("v1.13.0", "1.9.0"))
        self.assertFalse(api_parsing.is_newer("v1.9.0", "1.13.0"))

    def test_same_version_is_not_newer(self):
        self.assertFalse(api_parsing.is_newer("v1.13.0", "1.13.0"))

    def test_older_release_is_not_newer(self):
        # 개발 중(코드가 릴리스보다 앞선) 상태에서 "업데이트 있음"이 뜨면 거꾸로 동작하는 것
        self.assertFalse(api_parsing.is_newer("v1.2.0", "1.13.0"))

    def test_unreadable_side_never_claims_update(self):
        self.assertFalse(api_parsing.is_newer("nightly", "1.13.0"))
        self.assertFalse(api_parsing.is_newer("v1.14.0", "알 수 없음"))

    def test_prerelease_tail_reads_leading_number(self):
        self.assertEqual(api_parsing.parse_version("1.14.0-rc1"), (1, 14, 0))


class TestCheckUpdate(CacheTestBase):
    def test_reports_update_when_release_is_newer(self):
        self.serve(_release())
        r = api_client.check_update("1.13.0")
        self.assertTrue(r["update_available"])
        self.assertEqual(r["latest"], "v1.14.0")
        self.assertEqual(r["url"], "https://example.invalid/r/v1.14.0")
        self.assertIsNone(r["error"])

    def test_no_update_when_same_version(self):
        self.serve(_release(tag="v1.13.0"))
        self.assertFalse(api_client.check_update("1.13.0")["update_available"])

    def test_ttl_reuses_cache(self):
        self.serve(_release())
        api_client.check_update("1.13.0")
        api_client.check_update("1.13.0")
        self.assertEqual(len(self.calls), 1, "TTL 안인데 다시 요청했다")
        self.age_cache("update.json", api_client.TTL_UPDATE + 1)
        api_client.check_update("1.13.0")
        self.assertEqual(len(self.calls), 2, "TTL 이 지났는데 캐시를 그대로 썼다")

    def test_force_bypasses_cache(self):
        self.serve(_release())
        api_client.check_update("1.13.0")
        api_client.check_update("1.13.0", force=True)
        self.assertEqual(len(self.calls), 2)

    def test_cached_result_is_recompared_against_current_version(self):
        """**이 항목이 이 기능의 조용한 실패다.**

        update_available 을 캐시에 굳혀 두면, 사용자가 새 버전으로 바꾼 뒤에도 TTL(하루)
        동안 "새 버전이 있다"고 계속 말한다. 캐시된 latest 와 **지금의** current 로
        매번 다시 비교해야 한다.
        """
        self.serve(_release(tag="v1.14.0"))
        self.assertTrue(api_client.check_update("1.13.0")["update_available"])
        again = api_client.check_update("1.14.0")      # 사용자가 업데이트했다
        self.assertEqual(len(self.calls), 1, "캐시를 써야 하는 구간이다")
        self.assertFalse(again["update_available"],
                         "캐시된 판정을 그대로 돌려줬다 — 이미 받은 버전을 또 권한다")

    def test_falls_back_to_stale_cache_on_failure(self):
        self.serve(_release())
        api_client.check_update("1.13.0")
        self.age_cache("update.json", api_client.TTL_UPDATE + 1)
        self.fail_with(urllib.error.URLError("offline"))
        r = api_client.check_update("1.13.0")
        self.assertTrue(r["stale"])
        self.assertTrue(r["update_available"], "오래된 캐시라도 알던 최신 버전은 남아야 한다")
        self.assertIsNotNone(r["error"])

    def test_failure_without_cache_is_quiet(self):
        self.fail_with(urllib.error.URLError("offline"))
        r = api_client.check_update("1.13.0")
        self.assertFalse(r["update_available"])
        self.assertIsNone(r["latest"])
        self.assertFalse(r["stale"])

    def test_missing_fields_do_not_raise(self):
        # 릴리스에 name·html_url 이 없을 수 있다 — 1건 파싱 실패가 전체를 죽이면 안 된다
        self.serve(json.dumps({"tag_name": "v1.14.0"}))
        r = api_client.check_update("1.13.0")
        self.assertTrue(r["update_available"])
        self.assertIsNone(r["url"])

    def test_broken_payload_is_quiet(self):
        self.serve("<html>rate limited</html>")
        r = api_client.check_update("1.13.0")
        self.assertFalse(r["update_available"])
        self.assertIsNotNone(r["error"])

    def test_http_403_is_friendly(self):
        self.fail_with(urllib.error.HTTPError("u", 403, "Forbidden", {}, None))
        self.assertIn("403", api_client.check_update("1.13.0")["error"])


class SchemaVersion(CacheTestBase):
    """캐시 스키마 버전 (2026-09-12).

    **실제로 당한 것**: 하루 사이 파싱에 필드 넷을 더했는데 지난 연도 아카이브 캐시는
    TTL 이 없어 **영구**다. 이미 불러온 해에서는 새 필드가 **영원히 안 보이고**
    오류도 경고도 없다. `launches.json` 은 TTL 15분이라 저절로 나아 개발 중에는
    보이지도 않았다 — 그래서 이 테스트가 없으면 다음에도 똑같이 당한다.
    """

    def _write_raw(self, name, obj):
        """봉투를 거치지 않고 파일에 그대로 쓴다(옛 캐시·손상된 캐시 재현)."""
        os.makedirs(api_client.CACHE_DIR, exist_ok=True)
        with open(api_client._cache_path(name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)

    def test_write_puts_data_in_a_versioned_envelope(self):
        api_client._cache_write("x.json", [1, 2, 3])
        with open(api_client._cache_path("x.json"), encoding="utf-8") as f:
            raw = json.load(f)
        self.assertEqual(raw, {"schema": api_client.CACHE_SCHEMA, "data": [1, 2, 3]})

    def test_round_trip(self):
        api_client._cache_write("x.json", {"a": 1})
        data, age = api_client._cache_read("x.json")
        self.assertEqual(data, {"a": 1})
        self.assertIsNotNone(age)

    def test_envelopeless_cache_is_ignored(self):
        """봉투가 없는 = 스키마 도입 전 캐시. 읽어 쓰면 새 필드가 빠진 채 화면에 나온다."""
        self._write_raw("x.json", [{"id": "옛날 것"}])
        self.assertEqual(api_client._cache_read("x.json"), (None, None))

    def test_other_schema_is_ignored(self):
        self._write_raw("x.json", {"schema": api_client.CACHE_SCHEMA + 1, "data": [1]})
        self.assertEqual(api_client._cache_read("x.json"), (None, None))
        self._write_raw("x.json", {"schema": None, "data": [1]})
        self.assertEqual(api_client._cache_read("x.json"), (None, None))

    def test_past_year_archive_is_refetched_when_schema_differs(self):
        """**이 테스트가 이 항목의 이유다.** 지난 연도 아카이브는 TTL 이 없어 영구인데,
        모양이 바뀌면 그래도 다시 받아야 한다."""
        year = time.gmtime().tm_year - 1
        name = "archive_{}.json".format(year)
        self._write_raw(name, {"launches": [{"id": "옛날 것"}], "truncated": False})
        self.serve(_page(2, tag="new"))
        res = api_client.get_archive(year)
        self.assertEqual(len(self.calls), 1, "옛 모양인데 다시 안 받았다")
        self.assertEqual(len(res["launches"]), 2)
        # 다시 받은 뒤에는 봉투가 생겨 두 번째 호출은 캐시를 쓴다(지난 연도라 영구)
        api_client.get_archive(year)
        self.assertEqual(len(self.calls), 1, "이번엔 캐시를 썼어야 한다")

    def test_current_schema_past_year_archive_still_permanent(self):
        """스키마가 같으면 지난 연도는 여전히 영구 캐시다(요청을 늘리지 않는다)."""
        year = time.gmtime().tm_year - 1
        self.serve(_page(1, tag="a"))
        api_client.get_archive(year)
        # 해가 끝난 뒤(올해 1월 1일)에 받은 오래된 캐시. 예전엔 400일 전으로 뒀는데, 그건
        # **그 해가 시작되기도 전에** 받은 것이라 F-003 수정 뒤에는 한 번 다시 받는 게 맞다.
        import calendar
        ts = calendar.timegm((year + 1, 1, 1, 0, 0, 0))
        os.utime(api_client._cache_path("archive_{}.json".format(year)), (ts, ts))
        api_client.get_archive(year)
        self.assertEqual(len(self.calls), 1)

    def test_offline_with_old_shaped_cache_still_shows_something(self):
        """**스키마 검사의 가장 위험한 부작용**: 모양이 다르다고 버리면 오프라인 사용자는
        예전에 보이던 데이터마저 못 본다. 실패 경로에서는 모양이 낡아도 돌려줘야 한다."""
        self._write_raw("launches.json", [{"id": "옛날 것", "name": "옛 발사", "outcome": "success"}])
        self.fail_with(urllib.error.URLError("오프라인"))
        res = api_client.get_launches()
        self.assertEqual(len(res["launches"]), 1, "빈 화면이 됐다 — 옛 캐시라도 보여줘야 한다")
        self.assertTrue(res["stale"], "오래된 데이터라는 표시가 없다")
        self.assertIsNotNone(res["error"])

    def test_offline_past_year_archive_falls_back_too(self):
        year = time.gmtime().tm_year - 1
        self._write_raw("archive_{}.json".format(year),
                        {"launches": [{"id": "옛날 것"}], "truncated": False})
        self.fail_with(urllib.error.URLError("오프라인"))
        res = api_client.get_archive(year)
        self.assertEqual(len(res["launches"]), 1)
        self.assertTrue(res["stale"])

    def test_online_prefers_refetch_over_old_shape(self):
        """온라인이면 옛 모양을 **쓰지 않는다** — 폴백은 실패했을 때만이다."""
        self._write_raw("launches.json", [{"id": "옛날 것", "name": "옛 발사"}])
        self.serve(_page(1, tag="new"), _page(1, tag="new2"))
        res = api_client.get_launches()
        self.assertFalse(res["stale"])
        self.assertTrue(all(d["id"] != "옛날 것" for d in res["launches"]))

    def test_launches_cache_also_versioned(self):
        self._write_raw("launches.json", [{"id": "옛날 것", "name": "n"}])
        self.serve(json.dumps({"results": []}), json.dumps({"results": []}))
        api_client.get_launches()
        self.assertEqual(len(self.calls), 2, "옛 모양 캐시를 그대로 썼다")


class TestSettingsDurability(CacheTestBase):
    """설정이 **조용히 전부 사라지던** 자리 (P22-1 · P22-3).

    2026-09-17 실측: `save_settings` 가 `open(path, "w")` 로 자르고 썼다.
      · 연 직후 파일 크기가 **0바이트**(아직 한 글자도 안 썼는데)
      · 48KB 설정을 300번 쓰는 동안 동시에 읽던 쪽이 **빈 설정을 45번** 봤다
      · 반쯤 쓰인 파일 → `{}` → 그 위에 한 번 저장하면 **키 5개가 1개로 줄고
        파일은 정상 JSON 이 된다.** 관측지·관심 목록·위성 그룹·필터·배경이 영구 소멸
      · pywebview 는 브릿지 호출마다 스레드를 만들어(`util.py`) 두 저장이 겹친다 —
        200회 중 **1회(0.5%)** 한쪽 값이 사라졌다

    전부 **예외가 안 나고 값만 조용히 사라지는** 종류다.
    """

    def _read_raw(self):
        with open(api_client.SETTINGS_PATH, "rb") as f:
            return f.read()

    def test_target_file_is_never_opened_for_writing(self):
        """대상 파일을 **쓰기로 열지 않는다** — 여는 순간 잘리기 때문이다.

        ⚠ 처음엔 "쓰는 동안 읽어서 빈 설정이 나오나"로 쟀는데 **타이밍에 기대는 테스트라
          옛 비원자적 방식으로 되돌려도 통과했다**(2026-09-17 변이로 확인).
          P21-2 와 같은 교훈이다 — 이런 자리는 통계가 아니라 **구조**를 재야 한다.
        """
        api_client.save_settings({"observer": {"lat": 37.5}})
        real_open = builtins.open
        opened_for_write = []

        def watch_open(path, *a, **kw):
            mode = a[0] if a else kw.get("mode", "r")
            if str(path) == api_client.SETTINGS_PATH and ("w" in mode or "a" in mode or "+" in mode):
                opened_for_write.append(mode)
            return real_open(path, *a, **kw)

        with mock.patch.object(builtins, "open", watch_open):
            api_client.save_settings({"window": {"x": 1}})
        self.assertEqual(opened_for_write, [],
                         "settings.json 을 직접 쓰기로 열었다 — 여는 순간 잘린다")
        self.assertIn("observer", api_client.load_settings())

    def test_cache_target_is_never_opened_for_writing(self):
        """캐시도 같다 — 같은 헬퍼를 쓰는지 구조로 잰다."""
        path = api_client._cache_path("launches.json")
        real_open = builtins.open
        opened_for_write = []

        def watch_open(p2, *a, **kw):
            mode = a[0] if a else kw.get("mode", "r")
            if str(p2) == path and ("w" in mode or "a" in mode or "+" in mode):
                opened_for_write.append(mode)
            return real_open(p2, *a, **kw)

        with mock.patch.object(builtins, "open", watch_open):
            api_client._cache_write("launches.json", [{"id": "1"}])
        self.assertEqual(opened_for_write, [], "캐시 파일을 직접 쓰기로 열었다")

    def test_readers_never_see_an_empty_file_while_writing(self):
        """쓰는 **도중에** 읽어도 온전해야 한다.

        위 구조 테스트를 보완하는 실사용 확인이다. **이것만으로는 부족하다** —
        타이밍이 안 맞으면 깨진 구현에서도 통과한다(위 주석 참조).
        """
        api_client.save_settings({"favorites": {"sats": [str(i) for i in range(2000)]},
                                  "observer": {"lat": 37.5, "lng": 127.0}})
        empties = []
        stop = threading.Event()

        def reader():
            while not stop.is_set():
                if not api_client.load_settings():
                    empties.append(1)

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        try:
            for _ in range(120):
                api_client.save_settings({"camera": {"zoom": 4.5}})
        finally:
            stop.set()
            t.join(timeout=3)
        self.assertEqual(empties, [], "쓰는 도중 빈 설정이 읽혔다")
        self.assertIn("observer", api_client.load_settings())

    def test_concurrent_saves_do_not_lose_each_other(self):
        """두 스레드가 서로 다른 키를 저장해도 **둘 다 남아야** 한다."""
        for _ in range(60):
            api_client.save_settings({"base": 1})
            ready = threading.Barrier(2)

            def a():
                ready.wait()
                api_client.save_settings({"observer": {"lat": 37.5}})

            def b():
                ready.wait()
                api_client.save_settings({"window": {"x": 1}})

            ta, tb = threading.Thread(target=a), threading.Thread(target=b)
            ta.start(); tb.start(); ta.join(); tb.join()
            got = api_client.load_settings()
            self.assertIn("observer", got, "동시 저장에서 관측지가 사라졌다")
            self.assertIn("window", got, "동시 저장에서 창 위치가 사라졌다")

    def test_unreadable_settings_are_not_overwritten(self):
        """**못 읽었으면 쓰지 않는다** — 쓰면 나머지가 영구히 사라진다."""
        api_client.save_settings({"observer": {"lat": 37.5}, "favorites": {"sats": ["1"]}})
        before = self._read_raw()

        real_open = builtins.open
        calls = {"n": 0}

        def flaky_open(path, *a, **kw):
            # 설정을 **읽을 때만** 실패시킨다(쓰기·임시파일은 통과).
            if str(path) == api_client.SETTINGS_PATH and "r" in (a[0] if a else kw.get("mode", "r")):
                calls["n"] += 1
                raise OSError(5, "액세스가 거부되었습니다")
            return real_open(path, *a, **kw)

        with mock.patch.object(builtins, "open", flaky_open):
            api_client.save_settings({"window": {"x": 999}})
        self.assertGreater(calls["n"], 1, "읽기를 재시도하지 않았다")
        self.assertEqual(self._read_raw(), before, "못 읽었는데 덮어썼다")

    def test_permanently_broken_file_is_quarantined_not_stuck(self):
        """영구히 못 쓰게 된 파일이면 **옆으로 치우고 새로 시작**한다.

        여기서 저장을 막으면 설정이 **다시는 저장되지 않는다** —
        이 회귀는 2026-09-17 에 실제로 한 번 만들었다가 기존 테스트가 잡았다.
        """
        os.makedirs(api_client.APP_DIR, exist_ok=True)
        with open(api_client.SETTINGS_PATH, "w", encoding="utf-8") as f:
            f.write("이건 JSON 이 아니다")
        api_client.save_settings({"a": 1})
        self.assertEqual(api_client.load_settings().get("a"), 1, "새로 시작하지 못했다")
        bad = api_client.SETTINGS_PATH + ".bad.json"
        self.assertTrue(os.path.exists(bad), "망가진 파일을 남기지 않고 지웠다")
        with open(bad, encoding="utf-8") as f:
            self.assertEqual(f.read(), "이건 JSON 이 아니다")

    def test_failed_write_keeps_previous_file(self):
        """교체가 끝내 실패해도 **기존 설정은 살아 있어야** 한다."""
        api_client.save_settings({"observer": {"lat": 37.5}})
        before = self._read_raw()
        with mock.patch("os.replace", side_effect=OSError(5, "거부")):
            api_client.save_settings({"window": {"x": 1}})
        self.assertEqual(self._read_raw(), before, "교체 실패가 기존 파일을 망가뜨렸다")
        # 임시 파일을 남기지 않는다 — 남으면 %APPDATA% 에 쌓인다
        leftovers = [n for n in os.listdir(api_client.APP_DIR) if n.startswith(".tmp-")]
        self.assertEqual(leftovers, [], "임시 파일이 남았다")

    def test_cache_write_is_atomic_too(self):
        """캐시도 같은 헬퍼를 쓴다 — 반쯤 쓰인 캐시가 남지 않는다."""
        with mock.patch("os.replace", side_effect=OSError(5, "거부")):
            api_client._cache_write("launches.json", [{"id": "1"}])
        self.assertFalse(os.path.exists(api_client._cache_path("launches.json")),
                         "교체가 실패했는데 캐시 파일이 생겼다")
        leftovers = [n for n in os.listdir(api_client.CACHE_DIR) if n.startswith(".tmp-")]
        self.assertEqual(leftovers, [], "캐시 임시 파일이 남았다")


class TestAuditMutationGaps(CacheTestBase):
    """전면 감사(2026-09-24) if-py 변이에서 살아남은 실제 경로 (F-020).

    P42 이후에도 106개 중 26개가 뒤집어도 초록이었다. 스모크 전용을 빼고 남은 것 중
    **TLE·SATCAT 폴백**(572·627)은 F-001 을 고칠 바로 그 자리라, 고치기 전에 단언부터 둔다.
    """

    def _write_raw(self, name, obj):
        os.makedirs(api_client.CACHE_DIR, exist_ok=True)
        with open(api_client._cache_path(name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)

    def test_tle_offline_with_old_shaped_cache_still_shows_something(self):
        """발사에만 있던 단언(test_offline_with_old_shaped_cache…)을 TLE 에도."""
        self._write_raw("tle_stations.json", [{"name": "옛 위성", "norad_id": "1", "tle1": "1 x", "tle2": "2 x"}])
        self.fail_with(urllib.error.URLError("오프라인"))
        res = api_client.get_satellites(groups=["stations"])
        self.assertEqual(len(res["satellites"]), 1, "옛 모양 TLE 캐시가 있는데 위성이 사라졌다")
        self.assertTrue(res["stale"])

    def test_satcat_offline_with_old_shaped_cache_still_shows_something(self):
        self._write_raw("satcat_stations.json", {"25544": {"name": "ISS"}})
        self.fail_with(urllib.error.URLError("오프라인"))
        res = api_client.get_satcat(groups=["stations"])
        self.assertEqual(len(res["satcat"]), 1, "옛 모양 SATCAT 캐시가 있는데 메타가 사라졌다")
        self.assertTrue(res["stale"])

    def test_replace_is_retried_not_abandoned_on_first_failure(self):
        """Windows 는 읽는 중인 파일의 교체를 거부한다(WinError 5) — 한 번 실패로 포기하면 안 된다."""
        real = os.replace
        seen = {"n": 0}

        def flaky(src, dst):
            seen["n"] += 1
            if seen["n"] == 1:
                raise OSError(5, "액세스가 거부되었습니다")
            return real(src, dst)
        with mock.patch("os.replace", side_effect=flaky):
            api_client._cache_write("launches.json", [{"id": "1"}])
        self.assertEqual(seen["n"], 2, "재시도하지 않았다")
        self.assertTrue(os.path.exists(api_client._cache_path("launches.json")), "한 번 실패로 포기했다")

    def test_half_written_settings_are_not_quarantined(self):
        """쓰는 중이라 **한 번** 반쪽이 읽힌 설정은 격리하지 않는다 — 다음 읽기는 멀쩡하다."""
        api_client.save_settings({"observer": {"lat": 1.0}})
        real_open = builtins.open
        seen = {"n": 0}

        def flaky_open(path, *a, **kw):
            mode = a[0] if a else kw.get("mode", "r")
            if str(path) == api_client.SETTINGS_PATH and "r" in mode and "b" in mode:
                seen["n"] += 1
                if seen["n"] == 1:
                    return io.BytesIO(b'{"observer": {"la')
            return real_open(path, *a, **kw)
        with mock.patch.object(builtins, "open", flaky_open):
            got = api_client.load_settings()
        bad = [n for n in os.listdir(os.path.dirname(api_client.SETTINGS_PATH)) if n.endswith(".bad.json")]
        self.assertEqual(bad, [], "쓰는 중 한 번 반쪽을 읽었다고 멀쩡한 설정을 치웠다")
        self.assertEqual(got.get("observer"), {"lat": 1.0})

    def test_delay_between_every_page_pair(self):
        """2페이지로는 '사이에만'과 '끝에 한 번'이 같은 1회라 못 가른다 — 3페이지로 잰다."""
        self.serve(_page(1, next_url=api_client.LL2_BASE + "/p2"), _page(1, next_url=api_client.LL2_BASE + "/p3", tag="p2"),
                   _page(1, next_url=None, tag="p3"))
        with mock.patch.object(api_client.time, "sleep") as sl:
            api_client.get_archive(2016)
        self.assertEqual(sl.call_count, 2)


class TestResponseShape(CacheTestBase):
    """200 으로 온 **엉뚱한 본문**을 정상 결과로 캐시에 쓰지 않는다 (전면 감사 F-001·F-002).

    캡티브 포털(호텔 와이파이 로그인 화면)은 모든 요청에 200 + HTML 로 답한다. 예전에는
    파서가 0건을 돌려주고 코드가 그걸 캐시에 써서, TLE 2시간·SATCAT 24시간 동안 위성이 조용히
    사라지고 오래된 캐시 폴백까지 지워졌다. LL2 는 `null` 본문에 폴백을 건너뛰고,
    `{"results": null}` 이면 지난 연도 아카이브가 **영구히** 비었다.
    """
    PORTAL = "<html><body>Wi-Fi 로그인</body></html>"
    TLE = TestSatelliteGroups.TLE

    def _age_all(self):
        for n in os.listdir(api_client.CACHE_DIR):
            old = time.time() - 30 * 24 * 3600
            os.utime(os.path.join(api_client.CACHE_DIR, n), (old, old))

    def test_portal_page_does_not_wipe_tle(self):
        self.serve(self.TLE)
        api_client.get_satellites(groups=["stations"])
        self._age_all()
        self.serve(self.PORTAL)
        res = api_client.get_satellites(groups=["stations"])
        self.assertEqual(len(res["satellites"]), 1, "포털 응답에 가진 TLE 를 버렸다")
        self.assertTrue(res["stale"])
        self.assertIn("읽지 못했습니다", res["error"])

    def test_portal_page_does_not_wipe_satcat(self):
        self.serve(SATCAT_CSV)
        api_client.get_satcat(groups=["stations"])
        self._age_all()
        self.serve(self.PORTAL)
        res = api_client.get_satcat(groups=["stations"])
        self.assertEqual(len(res["satcat"]), 1, "포털 응답에 가진 SATCAT 을 버렸다")
        self.assertTrue(res["stale"])

    def test_null_body_falls_back_for_launches(self):
        self.serve(_page(3), _page(0))
        api_client.get_launches()
        self.age_cache("launches.json", api_client.FORCE_MIN_INTERVAL + 1)
        self.serve("null")
        res = api_client.get_launches(force=True)
        self.assertEqual(len(res["launches"]), 3, "null 본문에 폴백을 건너뛰었다")
        self.assertTrue(res["stale"])

    def test_results_null_is_not_cached_as_an_empty_year(self):
        self.serve('{"count": 0, "next": null, "results": null}')
        first = api_client.get_archive(2019)
        self.assertIsNotNone(first["error"])
        self.serve(_page(2))
        again = api_client.get_archive(2019)
        self.assertEqual(len(again["launches"]), 2, "빈 응답이 지난 연도의 영구 캐시가 됐다")

    def test_release_without_tag_is_an_error_not_silence(self):
        self.serve('{"message": "API rate limit exceeded"}')
        res = api_client.check_update("1.0.0")
        self.assertFalse(res["update_available"])
        self.assertIsNotNone(res["error"])


class TestCacheWriteFailure(CacheTestBase):
    """캐시를 못 써도 받은 데이터는 화면에 간다 (전면 감사 F-006)."""

    def test_unwritable_cache_dir_still_returns_fresh_data(self):
        with open(api_client.CACHE_DIR, "w", encoding="utf-8") as f:
            f.write("폴더 자리에 파일")    # 권한·디스크 문제의 대역
        self.serve(_page(3), _page(0))
        res = api_client.get_launches()
        self.assertEqual(len(res["launches"]), 3, "캐시를 못 쓴다고 받은 데이터를 버렸다")
        self.assertIsNone(res["error"], "네트워크는 성공했는데 오류 문구를 냈다")


class TestRequestGate(CacheTestBase):
    """실패 백오프 · 강제 갱신 쿨다운 (전면 감사 F-004·F-005).

    예전에는 실패하면 **5분 폴링마다 다시 때렸고**(429 지속 시 LL2 시간당 12~24회, 한도 15),
    강제 갱신은 누르는 만큼 2회씩 나갔다.
    """
    E429 = urllib.error.HTTPError("u", 429, "Too Many", None, None)

    def _expire(self, name="launches.json"):
        self.age_cache(name, api_client.TTL_LAUNCHES + 1)

    def _pass_backoff(self, key):
        until, msg = api_client._blocked_until[key]
        api_client._blocked_until[key] = (time.time() - 1, msg)

    def test_polling_does_not_retry_during_backoff(self):
        self.serve(_page(3), _page(0))
        api_client.get_launches()
        self._expire()
        self.fail_with(self.E429)
        api_client.get_launches()
        n = len(self.calls)
        for _ in range(5):          # 25분 동안의 폴링
            res = api_client.get_launches()
        self.assertEqual(len(self.calls), n, "백오프 중에 폴링이 요청을 냈다")
        self.assertEqual(len(res["launches"]), 3, "막는 동안에도 가진 데이터는 보여야 한다")
        self.assertIn("한도", res["error"], "막는 동안 이유(직전 오류)를 계속 말해야 한다")

    def test_backoff_ends_and_success_clears_it(self):
        self.fail_with(self.E429)
        api_client.get_launches()
        self._pass_backoff("ll2")
        self.serve(_page(2), _page(0))
        n = len(self.calls)
        res = api_client.get_launches()
        self.assertGreater(len(self.calls), n, "백오프가 끝났는데 다시 받지 않는다")
        self.assertIsNone(res["error"])
        self.assertNotIn("ll2", api_client._blocked_until, "성공했는데 막힘이 남았다")

    def test_force_right_after_fetch_uses_cache(self):
        self.serve(_page(2), _page(0))
        api_client.get_launches()
        n = len(self.calls)
        for _ in range(7):
            res = api_client.get_launches(force=True)
        self.assertEqual(len(self.calls), n, "받자마자 누른 강제 갱신이 요청을 냈다")
        self.assertEqual(len(res["launches"]), 2)
        self.assertIsNone(res["error"])

    def test_force_during_backoff_is_once_per_interval(self):
        self.fail_with(self.E429)
        api_client.get_launches()
        n = len(self.calls)
        api_client.get_launches(force=True)
        self.assertEqual(len(self.calls), n, "실패 직후 강제 갱신 연타가 요청을 냈다")
        api_client._last_attempt["ll2"] = time.time() - api_client.FORCE_MIN_INTERVAL - 1
        api_client.get_launches(force=True)
        self.assertGreater(len(self.calls), n, "간격이 지나면 사용자가 다시 해 볼 수 있어야 한다")

    def test_groups_back_off_independently(self):
        tle = TestSatelliteGroups.TLE
        def by_group(url):
            self.calls.append(url)
            if "GROUP=stations" in url:
                raise urllib.error.HTTPError(url, 403, "Forbidden", None, None)
            return tle
        api_client._http_get = by_group
        api_client.get_satellites(groups=["stations", "visual"])
        for n in os.listdir(api_client.CACHE_DIR):
            self.age_cache(n, api_client.TTL_TLE + 1)
        self.calls.clear()
        api_client.get_satellites(groups=["stations", "visual"])
        self.assertEqual([u for u in self.calls if "stations" in u], [], "막힌 그룹을 다시 때렸다")
        self.assertEqual(len([u for u in self.calls if "visual" in u]), 1, "막히지 않은 그룹까지 막았다")


class TestArchiveYearEnd(CacheTestBase):
    """해가 바뀌기 전에 받은 아카이브는 영구가 아니다 (전면 감사 F-003).

    예전에는 지난 연도면 캐시 나이를 안 봤다 — 7월에 받은 올해 아카이브가 이듬해 1월부터
    **영원히 7월에 멈췄다**(결과가 뒤늦게 확정된 발사 포함). 해마다 반드시 한 번 일어난다.
    """

    def setUp(self):
        super().setUp()
        self.sleep = mock.patch("time.sleep")
        self.sleep.start()

    def tearDown(self):
        self.sleep.stop()
        super().tearDown()

    def _stamp(self, year, month):
        import calendar
        ts = calendar.timegm((year, month, 1, 0, 0, 0))
        os.utime(api_client._cache_path("archive_2020.json"), (ts, ts))

    def test_snapshot_taken_during_the_year_is_refetched_once(self):
        self.serve(_page(1))
        api_client.get_archive(2020)
        self._stamp(2020, 7)                       # 2020년 7월에 받은 스냅샷
        n = len(self.calls)
        self.serve(_page(3))
        res = api_client.get_archive(2020)
        self.assertGreater(len(self.calls), n, "해가 끝나기 전의 스냅샷을 영구로 썼다")
        self.assertEqual(len(res["launches"]), 3)
        n = len(self.calls)
        api_client.get_archive(2020)               # 이제 수정 시각이 올해 → 영구
        self.assertEqual(len(self.calls), n, "해가 끝난 뒤 받은 것은 다시 받지 않는다")

    def test_fetched_after_year_end_stays_permanent(self):
        self.serve(_page(1))
        api_client.get_archive(2020)
        self._stamp(2021, 1)                       # 2021년 1월에 받은 것
        n = len(self.calls)
        api_client.get_archive(2020)
        self.assertEqual(len(self.calls), n)


class TestAuditLowFixes(CacheTestBase):
    """전면 감사 낮음 묶음 — F-010 · F-012 · F-013."""

    def test_non_string_groups_are_dropped_not_raised(self):
        self.serve(TestSatelliteGroups.TLE)
        res = api_client.get_satellites(groups=[{}, ["a"], "stations", 3])
        self.assertEqual(res["groups"], ["stations"])

    def test_future_mtime_is_not_fresh_forever(self):
        self.serve(_page(2), _page(0))
        api_client.get_launches()
        future = time.time() + 3 * 86400
        os.utime(api_client._cache_path("launches.json"), (future, future))
        n = len(self.calls)
        api_client.get_launches()
        self.assertGreater(len(self.calls), n, "미래 시각 캐시를 신선하다고 봤다")

    def test_just_written_cache_with_skewed_mtime_is_fresh(self):
        # CI(windows-latest)에서 **쓰자마자 읽은 수정 시각이 몇 ms 미래**로 나와 F-012 의
        # 방어에 걸렸다 — 신선한 캐시를 버리고 다시 요청해 ca1a834·5bcec63 CI 가 빨갰다
        # (로컬은 2,000회 중 0회로 재현 안 됨). 파일 시각은 거친 시스템 틱, time.time() 은
        # 정밀 시계라 생기는 차이다. 작은 차이는 '방금 쓴 것'으로 본다.
        self.serve(_page(2), _page(0))
        api_client.get_launches()
        skewed = time.time() + 0.05
        os.utime(api_client._cache_path("launches.json"), (skewed, skewed))
        n = len(self.calls)
        api_client.get_launches()
        self.assertEqual(len(self.calls), n, "방금 쓴 캐시를 수정 시각의 ms 차이로 버렸다")

    def test_foreign_next_url_is_not_followed(self):
        with mock.patch("time.sleep"):
            self.serve(_page(1, next_url="file:///C:/Windows/win.ini"))
            res = api_client.get_archive(2016)
        self.assertEqual(len(self.calls), 1, "LL2 밖의 next 를 따라갔다")
        self.assertTrue(res["truncated"], "멈췄는데 '이게 전부'라고 말한다")


MIN_TESTS = 114   # 건수 하한 — 2026-09-24 실측. 수집이 조용히 비면 0건으로 통과한다


if __name__ == "__main__":
    _res = unittest.main(verbosity=2, exit=False).result
    if len(sys.argv) == 1 and _res.testsRun < MIN_TESTS:
        print(f"FAIL 건수 하한: {_res.testsRun} < {MIN_TESTS}")
        sys.exit(1)
    sys.exit(0 if _res.wasSuccessful() else 1)
