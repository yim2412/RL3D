"""캐시·폴백·아카이브·설정 회귀 테스트 (P12-20) — 네트워크 없이 돈다.

    python tests/test_cache.py

`test_parsing.py` 가 덮는 것은 **응답을 어떻게 읽는가**뿐이다. 여기서 재는 것은 그 바깥,
**언제 부르고 실패하면 무엇을 돌려주는가**다 — TTL 만료 판정 · 오래된 캐시 폴백 ·
아카이브 페이지 상한 · 설정 병합. 전부 **틀려도 예외가 안 나고 값만 조용히 달라지는** 자리다
(요청이 두 배로 늘어도 화면은 똑같이 보인다 — 429 가 뜨고 나서야 안다).

HTTP 는 `api_client._http_get` 을 갈아끼워 막는다. 캐시·설정 경로는 모듈 전역을 임시
디렉터리로 재대입한다 — **이름 import 가 아니라 모듈 경유**여야 재대입이 보인다(전역 규칙 8번).
"""
import json
import logging
import os
import shutil
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import api_client  # noqa: E402


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
        self.serve(_page(2), _page(2, tag="prev"))
        api_client.get_launches()
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
        self.serve(_page(1, next_url="https://ll/next"))
        res = api_client.get_archive(2018)
        self.assertEqual(len(self.calls), api_client.ARCHIVE_MAX_PAGES)
        self.assertEqual(len(res["launches"]), api_client.ARCHIVE_MAX_PAGES)

    def test_truncated_flag_when_capped(self):
        # P12-6: 캡에 걸린 사실이 화면까지 가야 한다. 없으면 "그 해는 이게 전부"로 읽힌다.
        self.serve(_page(1, next_url="https://ll/next"))
        self.assertTrue(api_client.get_archive(2018)["truncated"])

    def test_not_truncated_when_walk_ends(self):
        self.serve(_page(1, next_url="https://ll/p2"), _page(1, next_url=None, tag="p2"))
        res = api_client.get_archive(2017)
        self.assertFalse(res["truncated"], "끝까지 받았는데 잘렸다고 했다")
        self.assertEqual(len(res["launches"]), 2)

    def test_truncated_is_remembered_in_cache(self):
        # 캐시에서 꺼내 쓸 때도 잘림 표시가 남아야 한다 — 두 번째 실행부터 조용해지면
        # "처음 열었을 때만 경고가 뜨는" 더 나쁜 모양이 된다.
        self.serve(_page(1, next_url="https://ll/next"))
        api_client.get_archive(2013)
        self.calls.clear()
        again = api_client.get_archive(2013)
        self.assertEqual(self.calls, [], "캐시가 있는데 다시 받았다")
        self.assertTrue(again["truncated"], "캐시로 돌려줄 때 잘림 표시가 사라졌다")

    def test_delay_between_pages_only(self):
        # 마지막 페이지 뒤에는 자지 않는다(멈춘 것처럼 보이는 시간을 늘리지 않는다).
        self.serve(_page(1, next_url="https://ll/p2"), _page(1, next_url=None, tag="p2"))
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


class TestVersionCompare(unittest.TestCase):
    """버전 비교는 **틀려도 예외가 안 난다** — 없는 업데이트를 알리거나 있는 것을 놓칠 뿐이다."""

    def test_parses_with_and_without_v(self):
        self.assertEqual(api_client.parse_version("v1.13.0"), (1, 13, 0))
        self.assertEqual(api_client.parse_version("1.13.0"), (1, 13, 0))

    def test_pads_missing_parts(self):
        self.assertEqual(api_client.parse_version("2"), (2, 0, 0))
        self.assertEqual(api_client.parse_version("1.4"), (1, 4, 0))

    def test_unreadable_is_none(self):
        for bad in ("nightly", "", None, "v", "..", 13):
            self.assertIsNone(api_client.parse_version(bad), bad)

    def test_numeric_not_lexicographic(self):
        # 문자열 비교면 "1.9.0" > "1.13.0" 이 된다 — 실제로 이 앱이 지나온 구간이다
        self.assertTrue(api_client.is_newer("v1.13.0", "1.9.0"))
        self.assertFalse(api_client.is_newer("v1.9.0", "1.13.0"))

    def test_same_version_is_not_newer(self):
        self.assertFalse(api_client.is_newer("v1.13.0", "1.13.0"))

    def test_older_release_is_not_newer(self):
        # 개발 중(코드가 릴리스보다 앞선) 상태에서 "업데이트 있음"이 뜨면 거꾸로 동작하는 것
        self.assertFalse(api_client.is_newer("v1.2.0", "1.13.0"))

    def test_unreadable_side_never_claims_update(self):
        self.assertFalse(api_client.is_newer("nightly", "1.13.0"))
        self.assertFalse(api_client.is_newer("v1.14.0", "알 수 없음"))

    def test_prerelease_tail_reads_leading_number(self):
        self.assertEqual(api_client.parse_version("1.14.0-rc1"), (1, 14, 0))


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
