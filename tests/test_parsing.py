"""정규화 회귀 테스트 — 네트워크 없이 픽스처만으로 돈다.

    python tests/test_parsing.py            # 검증
    python tests/test_parsing.py --update   # 골든 갱신(픽스처를 새로 받은 뒤)

실제 API 응답(tests/fixtures/)을 파싱한 결과를 골든(tests/golden/)과 비교한다.
외부 API가 필드를 바꾸거나 파싱을 잘못 건드리면 여기서 잡힌다.
"""
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import api_client  # noqa: E402
import applog  # noqa: E402
import main as main_mod  # noqa: E402  (창 위치 판정 — 창을 띄우지 않는 순수 함수만 쓴다)
import startup  # noqa: E402  (WebView2 감지 — 레지스트리를 주입해 판정만 잰다)

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
GOLDEN = os.path.join(HERE, "golden")


def _read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _golden(name, produced, update):
    """골든과 비교하거나(-> 기대값 반환), --update 면 현재 결과로 덮어쓴다."""
    path = os.path.join(GOLDEN, name)
    if update:
        os.makedirs(GOLDEN, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(produced, f, ensure_ascii=False, indent=1, sort_keys=True)
        print("[updated] {}".format(name))
        return produced
    return _read_json(path)


UPDATE = False  # main()에서 --update 로 켜짐


class LaunchParsing(unittest.TestCase):
    def test_upcoming_matches_golden(self):
        parsed = api_client._parse_launches(_read_json(os.path.join(FIXTURES, "ll2_upcoming.json")))
        self.assertEqual(parsed, _golden("launches_upcoming.json", parsed, UPDATE))

    def test_previous_matches_golden(self):
        parsed = api_client._parse_launches(_read_json(os.path.join(FIXTURES, "ll2_previous.json")))
        self.assertEqual(parsed, _golden("launches_previous.json", parsed, UPDATE))

    def test_required_fields_present(self):
        """지도·패널이 의존하는 필드가 빠지면 앱이 조용히 비어 보인다."""
        parsed = api_client._parse_launches(_read_json(os.path.join(FIXTURES, "ll2_previous.json")))
        self.assertTrue(parsed, "픽스처에서 파싱된 발사가 0건")
        for d in parsed:
            for key in ("id", "name", "net", "outcome", "lat", "lng"):
                self.assertIn(key, d)
            self.assertIsNotNone(d["lat"])
            self.assertIsNotNone(d["lng"])
            self.assertIn(d["outcome"], ("upcoming", "success", "failure", "partial"))

    def test_missing_coords_dropped(self):
        """좌표 없는 발사는 지도에 못 찍으므로 제외된다."""
        payload = {"results": [{"id": "x", "name": "No pad", "pad": {}}]}
        self.assertEqual(api_client._parse_launches(payload), [])

    def test_broken_items_do_not_kill_the_rest(self):
        """1건이 깨져도 나머지는 살아야 한다(CLAUDE.md API 규칙 3)."""
        good = {"id": "ok", "name": "Good", "net": "2026-01-01T00:00:00Z",
                "pad": {"latitude": "28.5", "longitude": "-80.5", "name": "LC-39A"},
                "status": {"abbrev": "Success", "name": "Launch Successful"}}
        payload = {"results": [
            {"id": "bad1", "pad": {"latitude": "not-a-number", "longitude": "1"}},  # float() 실패
            None,                                                                   # 항목 자체가 None
            {"id": "bad2", "pad": None},                                            # pad 없음
            good,
        ]}
        parsed = api_client._parse_launches(payload)
        self.assertEqual([d["id"] for d in parsed], ["ok"])
        self.assertEqual(parsed[0]["outcome"], "success")

    def test_null_nested_objects(self):
        """LL2가 rocket/mission/status 를 null 로 주는 경우가 실제로 있다."""
        payload = {"results": [{
            "id": "n", "name": "Nulls", "net": None,
            "pad": {"latitude": 0, "longitude": 0, "location": None},
            "rocket": None, "mission": None, "status": None,
            "launch_service_provider": None,
        }]}
        parsed = api_client._parse_launches(payload)
        self.assertEqual(len(parsed), 1)
        d = parsed[0]
        self.assertEqual(d["outcome"], "upcoming")   # status 없으면 예정 계열
        self.assertIsNone(d["rocket"])
        self.assertIsNone(d["orbit"])

    def test_detail_fields_present(self):
        """detailed 응답에서만 오는 확장 필드(중계·소식·맥락)가 정규화에 실려야 한다."""
        parsed = api_client._parse_launches(_read_json(os.path.join(FIXTURES, "ll2_upcoming.json")))
        starship = next(d for d in parsed if "Starship" in (d["name"] or ""))
        self.assertTrue(starship["vid_urls"], "중계 링크가 비어 있다")
        self.assertTrue(all(set(v) == {"title", "url"} for v in starship["vid_urls"]))
        self.assertTrue(starship["patch"].startswith("http"))
        self.assertTrue(starship["updates"])
        self.assertEqual(starship["programs"], ["SpaceX Starship"])
        self.assertEqual(starship["net_precision"], "Second")
        self.assertIsInstance(starship["webcast_live"], bool)

    def test_vid_urls_capped_and_cleaned(self):
        item = {"vidURLs": [{"url": "https://e/{}".format(i), "title": "t{}".format(i),
                             "description": "x" * 500} for i in range(10)]}
        vids = api_client._parse_vid_urls(item)
        self.assertEqual(len(vids), api_client.MAX_VID_URLS)
        self.assertEqual(set(vids[0]), {"title", "url"})   # description 은 버린다(캐시 비대 방지)

    def test_vid_urls_skip_broken(self):
        item = {"vidURLs": [None, {"title": "제목만"}, {"url": "https://ok"}, "문자열"]}
        self.assertEqual(api_client._parse_vid_urls(item), [{"title": "중계", "url": "https://ok"}])

    def test_updates_newest_first_and_capped(self):
        item = {"updates": [
            {"comment": "old", "created_on": "2026-01-01T00:00:00Z"},
            {"comment": "new", "created_on": "2026-07-01T00:00:00Z"},
            {"comment": None, "created_on": "2026-08-01T00:00:00Z"},  # 본문 없는 건 제외
        ] + [{"comment": "c{}".format(i), "created_on": "2026-06-{:02d}T00:00:00Z".format(i + 1)}
             for i in range(10)]}
        ups = api_client._parse_updates(item)
        self.assertEqual(len(ups), api_client.MAX_UPDATES)
        self.assertEqual(ups[0]["comment"], "new")
        self.assertNotIn(None, [u["comment"] for u in ups])

    def test_detail_fields_default_when_absent(self):
        """구버전/간이 응답이라 확장 필드가 없어도 죽지 않고 빈 값이 된다."""
        payload = {"results": [{"id": "m", "name": "Minimal",
                                "pad": {"latitude": 1, "longitude": 2}}]}
        d = api_client._parse_launches(payload)[0]
        self.assertEqual(d["vid_urls"], [])
        self.assertEqual(d["updates"], [])
        self.assertEqual(d["programs"], [])
        self.assertFalse(d["webcast_live"])
        self.assertIsNone(d["patch"])
        self.assertIsNone(d["net_precision"])

    def test_outcome_mapping(self):
        cases = {
            "Success": "success", "success": "success",
            "Failure": "failure", "Partial Failure": "partial", "partial": "partial",
            "TBD": "upcoming", "Go": "upcoming", "Hold": "upcoming",
            None: "upcoming", "": "upcoming", "무슨상태": "upcoming",
        }
        for abbrev, expected in cases.items():
            self.assertEqual(api_client._outcome_from_status(abbrev), expected, abbrev)

    def test_dedupe_keeps_first(self):
        """LL2는 막 발사된 건을 upcoming·previous 양쪽에 낸다 → 앞의 것(결과 확정본) 유지."""
        items = [
            {"id": "a", "outcome": "success"},
            {"id": "a", "outcome": "upcoming"},
            {"id": "b", "outcome": "upcoming"},
            {"id": None, "name": "no-id-1"},
            {"id": None, "name": "no-id-2"},
        ]
        out = api_client._dedupe_launches(items)
        self.assertEqual([d.get("id") for d in out], ["a", "b", None, None])
        self.assertEqual(out[0]["outcome"], "success")


class TleParsing(unittest.TestCase):
    def test_tle_matches_golden(self):
        parsed = api_client._parse_tle(_read_text(os.path.join(FIXTURES, "celestrak_stations.txt")))
        self.assertEqual(parsed, _golden("satellites_stations.json", parsed, UPDATE))

    def test_tle_fields(self):
        parsed = api_client._parse_tle(_read_text(os.path.join(FIXTURES, "celestrak_stations.txt")))
        self.assertTrue(parsed)
        for s in parsed:
            self.assertTrue(s["name"])
            self.assertTrue(s["norad_id"].isdigit())
            self.assertTrue(s["tle1"].startswith("1 "))
            self.assertTrue(s["tle2"].startswith("2 "))

    def test_misaligned_block_skipped(self):
        """줄이 어긋난 블록은 건너뛰고 나머지는 파싱한다."""
        text = (
            "GARBAGE LINE\n"
            "ISS (ZARYA)\n"
            "1 25544U 98067A   26206.50000000  .00016717  00000-0  10270-3 0  9007\n"
            "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391 10000\n"
        )
        parsed = api_client._parse_tle(text)
        self.assertEqual([s["norad_id"] for s in parsed], ["25544"])

    def test_empty_text(self):
        self.assertEqual(api_client._parse_tle(""), [])


class TestFriendlyError(unittest.TestCase):
    """에러 문구 — 조용히 틀린 안내를 하던 자리(2026-08-20)."""

    def _http_error(self, code, reason="err"):
        """HTTPError 는 파일류라 닫지 않으면 ResourceWarning 이 남는다."""
        e = urllib.error.HTTPError("u", code, reason, {}, None)
        self.addCleanup(e.close)
        return e

    def test_timeout_wrapped_in_urlerror(self):
        """urlopen 은 타임아웃을 URLError(reason=timeout) 으로 감싼다.

        이 케이스가 없으면 "인터넷 연결을 확인하세요" 로 잘못 안내한다 —
        실제로 그랬고, isinstance(e, TimeoutError) 분기는 죽은 코드였다.
        """
        e = urllib.error.URLError(TimeoutError("timed out"))
        self.assertFalse(isinstance(e, TimeoutError))   # 막지 않았으면 아래가 틀렸을 것
        self.assertEqual(api_client._friendly_error(e), api_client.TIMEOUT_MESSAGE)

    def test_timeout_reason_as_plain_string(self):
        """reason 이 예외가 아니라 문자열로 오는 경우도 타임아웃으로 읽는다."""
        e = urllib.error.URLError("timed out")
        self.assertEqual(api_client._friendly_error(e), api_client.TIMEOUT_MESSAGE)

    def test_offline_is_not_timeout(self):
        """DNS 실패는 타임아웃이 아니라 연결 문제로 안내한다."""
        e = urllib.error.URLError(OSError(11001, "getaddrinfo failed"))
        msg = api_client._friendly_error(e)
        self.assertNotEqual(msg, api_client.TIMEOUT_MESSAGE)
        self.assertIn("인터넷 연결", msg)

    def test_403_has_own_message(self):
        """Celestrak 이 실제로 돌려주는 코드 — 숫자만 보여주면 안 된다."""
        msg = api_client._friendly_error(self._http_error(403, "Forbidden"))
        self.assertEqual(msg, api_client.HTTP_ERROR_MESSAGES[403])
        self.assertNotEqual(msg, "서버 응답 오류(403).")

    def test_429_still_mentions_rate_limit(self):
        msg = api_client._friendly_error(self._http_error(429, "Too Many"))
        self.assertIn("한도", msg)

    def test_unmapped_code_falls_back(self):
        """표에 없는 코드는 코드 번호라도 알려준다."""
        self.assertEqual(
            api_client._friendly_error(self._http_error(418, "Teapot")),
            "서버 응답 오류(418).")

    def test_http_error_is_not_read_as_timeout(self):
        """HTTPError 도 URLError 라 reason 을 갖는다 — 표가 먼저 이겨야 한다."""
        e = self._http_error(503, "timed out")
        self.assertEqual(api_client._friendly_error(e),
                         api_client.HTTP_ERROR_MESSAGES[503])


class TestLegacyCacheCleanup(unittest.TestCase):
    def test_removes_only_legacy_files(self):
        """옛 tle.json 만 지우고 현행 캐시는 건드리지 않는다."""
        tmp = tempfile.mkdtemp()
        orig = api_client.CACHE_DIR
        try:
            api_client.CACHE_DIR = tmp
            legacy = os.path.join(tmp, "tle.json")
            keep = os.path.join(tmp, "tle_stations.json")
            for f in (legacy, keep):
                with open(f, "w", encoding="utf-8") as fh:
                    fh.write("[]")
            self.assertEqual(api_client.cleanup_legacy_cache(), ["tle.json"])
            self.assertFalse(os.path.exists(legacy))
            self.assertTrue(os.path.exists(keep))
        finally:
            api_client.CACHE_DIR = orig
            shutil.rmtree(tmp, ignore_errors=True)

    def test_no_legacy_file_is_quiet(self):
        tmp = tempfile.mkdtemp()
        orig = api_client.CACHE_DIR
        try:
            api_client.CACHE_DIR = tmp
            self.assertEqual(api_client.cleanup_legacy_cache(), [])
        finally:
            api_client.CACHE_DIR = orig
            shutil.rmtree(tmp, ignore_errors=True)


class TestWindowVisibility(unittest.TestCase):
    """창 위치 복원 방어 — 모니터를 떼면 창이 안 보이는 자리에 뜨던 문제."""

    PRIMARY = (0, 0, 1920, 1040)          # 주 모니터 작업영역
    SECOND = (1920, 0, 1920, 1040)        # 오른쪽 보조 모니터
    W, H = 1280, 800

    def test_inside_primary(self):
        self.assertTrue(main_mod._rect_visible(100, 100, self.W, self.H, [self.PRIMARY]))

    def test_on_second_monitor_while_attached(self):
        self.assertTrue(main_mod._rect_visible(
            2000, 100, self.W, self.H, [self.PRIMARY, self.SECOND]))

    def test_same_coords_after_second_monitor_removed(self):
        """이게 이 방어의 존재 이유 — 좌표는 그대로인데 화면이 사라진 경우."""
        self.assertFalse(main_mod._rect_visible(2000, 100, self.W, self.H, [self.PRIMARY]))

    def test_negative_offscreen(self):
        self.assertFalse(main_mod._rect_visible(-1400, 100, self.W, self.H, [self.PRIMARY]))

    # 경계는 좌표를 직접 적는다 — MIN_VISIBLE_* 로 계산하면 그 상수를 0 으로 바꿔도
    # 기대값이 같이 움직여 테스트가 통과해 버린다(뮤테이션으로 확인한 실제 구멍).
    def test_barely_visible_edge_counts(self):
        """1920 폭 화면에 가로 120px 만 걸친 창 — 잡아서 옮길 수 있으니 허용."""
        self.assertTrue(main_mod._rect_visible(1800, 100, self.W, self.H, [self.PRIMARY]))

    def test_one_pixel_less_than_minimum_is_rejected(self):
        """가로 119px — 임계값(120)이 실제로 쓰이는지 잰다."""
        self.assertFalse(main_mod._rect_visible(1801, 100, self.W, self.H, [self.PRIMARY]))

    def test_vertical_threshold(self):
        """세로도 같은 기준(40px). 1040 높이 화면에 40px 걸치면 허용, 39px 이면 거부."""
        self.assertTrue(main_mod._rect_visible(100, 1000, self.W, self.H, [self.PRIMARY]))
        self.assertFalse(main_mod._rect_visible(100, 1001, self.W, self.H, [self.PRIMARY]))

    def test_no_monitors_means_not_visible(self):
        self.assertFalse(main_mod._rect_visible(0, 0, self.W, self.H, []))


class TestWebView2Detection(unittest.TestCase):
    """WebView2 감지 (P12-11). 레지스트리 읽기를 주입해 GUI·레지스트리 없이 잰다."""

    @staticmethod
    def _reader(values):
        """values: {(root, path): pv값} → read_value 함수"""
        def read(root, path, name):
            return values.get((root, path)) if name == "pv" else None
        return read

    def test_found_in_hklm(self):
        root, path = startup.WEBVIEW2_KEYS[0]
        v = startup.webview2_version(self._reader({(root, path): "120.0.2210.91"}))
        self.assertEqual(v, "120.0.2210.91")

    def test_found_in_hkcu_only(self):
        """사용자 설치본만 있어도 찾는다 — HKLM 만 보면 놓친다."""
        root, path = startup.WEBVIEW2_KEYS[-1]
        self.assertEqual(startup.WEBVIEW2_KEYS[-1][0], "HKCU")
        v = startup.webview2_version(self._reader({(root, path): "120.0.2210.91"}))
        self.assertEqual(v, "120.0.2210.91")

    def test_absent(self):
        self.assertIsNone(startup.webview2_version(self._reader({})))

    def test_zero_version_is_not_installed(self):
        """EdgeUpdate 가 남기는 pv=0.0.0.0 은 '설치 안 됨' — 있다고 보면 안내가 안 뜬다."""
        root, path = startup.WEBVIEW2_KEYS[0]
        self.assertIsNone(startup.webview2_version(self._reader({(root, path): "0.0.0.0"})))

    def test_empty_string_is_not_installed(self):
        root, path = startup.WEBVIEW2_KEYS[0]
        self.assertIsNone(startup.webview2_version(self._reader({(root, path): "  "})))


class TestWebView2Notice(unittest.TestCase):
    """안내가 '없을 때만' 뜨는가 — 막지 않았으면 무엇이 일어났을지까지 단언한다."""

    def setUp(self):
        self.shown = []

    def _notify(self, title, text):
        self.shown.append((title, text))
        return True

    def test_notifies_when_missing(self):
        ok = startup.check_webview2(version="", notify=self._notify)
        self.assertFalse(ok)
        self.assertEqual(len(self.shown), 1)
        self.assertEqual(self.shown[0][0], startup.WEBVIEW2_MISSING_TITLE)
        # 설치 경로를 안내하지 않으면 사용자는 무엇을 해야 할지 모른다.
        self.assertIn("webview2", self.shown[0][1].lower())

    def test_silent_when_present(self):
        ok = startup.check_webview2(version="120.0.2210.91", notify=self._notify)
        self.assertTrue(ok)
        self.assertEqual(self.shown, [])


class TestCrashNotice(unittest.TestCase):
    """크래시 안내 (P12-10) — 예외 문구와 로그 경로가 실제로 들어가는가."""

    def test_message_includes_exception_and_log_path(self):
        msg = startup.crash_message(ValueError("설정이 깨졌습니다"), os.path.join("C:", "logs", "rl3d.log"))
        self.assertIn("ValueError", msg)
        self.assertIn("설정이 깨졌습니다", msg)
        self.assertIn(os.path.join("C:", "logs", "rl3d.log"), msg)

    def test_message_without_log_path_says_so(self):
        """로그를 못 만든 경우 — 경로를 안 넣는 것만으로는 사용자가 알 수 없다."""
        msg = startup.crash_message(RuntimeError("boom"), None)
        self.assertIn("RuntimeError", msg)
        self.assertNotIn("rl3d.log", msg)
        self.assertIn("기록이 남지 않았습니다", msg)

    def test_report_crash_notifies(self):
        shown = []
        startup.report_crash(RuntimeError("boom"), "L", lambda t, x: shown.append((t, x)))
        self.assertEqual(len(shown), 1)
        self.assertEqual(shown[0][0], startup.CRASH_TITLE)


class TestLogFile(unittest.TestCase):
    """로그 파일 (P12-9) — 실제로 파일에 쓰이는가·UTF-8 인가."""

    def test_writes_utf8_log_line(self):
        tmp = tempfile.mkdtemp()
        root = logging.getLogger()
        before = list(root.handlers)
        try:
            path = applog.setup(tmp)
            self.assertIsNotNone(path)
            self.assertEqual(path, os.path.join(applog.log_dir(tmp), applog.LOG_FILENAME))
            logging.getLogger("rl3d.test").warning("한글 경고 — 실패 신호")
            logging.shutdown()
            with open(path, encoding="utf-8") as f:   # cp949 였으면 여기서 깨진다
                text = f.read()
            self.assertIn("한글 경고 — 실패 신호", text)
            self.assertIn("WARNING", text)
        finally:
            for h in list(root.handlers):
                if h not in before:
                    root.removeHandler(h)
                    h.close()
            shutil.rmtree(tmp, ignore_errors=True)

    def test_setup_failure_returns_none(self):
        """로그를 못 만들어도 앱은 떠야 한다 — 예외가 아니라 None 을 돌려준다."""
        tmp = tempfile.mkdtemp()
        try:
            blocker = os.path.join(tmp, "logs")
            with open(blocker, "w", encoding="utf-8") as f:   # 파일이 디렉터리 자리를 막는다
                f.write("x")
            self.assertIsNone(applog.setup(tmp))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestSmokeConsoleEncoding(unittest.TestCase):
    """스모크의 stdout 인코딩 (2026-09-11 CI 첫 실행이 여기서 깨졌다).

    개발 PC 는 UTF-8 로캘(65001)이고 한국어 PC 는 cp949 라 한글이 그냥 넘어간다.
    영문 로캘(cp1252)에서만 UnicodeEncodeError 로 죽으므로 **이 PC 에서는 재현되지
    않는다** — PYTHONIOENCODING 으로 자식의 stdio 만 cp1252 로 되돌려 재현한다.
    """

    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    def _run(self, script, encoding):
        env = dict(os.environ, PYTHONIOENCODING=encoding)
        return subprocess.run(
            [sys.executable, os.path.join(self.ROOT, script)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=env, cwd=self.ROOT,
        )

    def test_applog_smoke_survives_cp1252_console(self):
        done = self._run("applog.py", "cp1252")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("[OK] applog", done.stdout)
        # 막지 않았으면 무엇이 일어났을 것인가 — 바로 이 예외다.
        self.assertNotIn("UnicodeEncodeError", done.stderr)

    def test_unguarded_korean_print_really_breaks_on_cp1252(self):
        """보호 장치를 뜯으면 실제로 깨지는지 — 이게 없으면 위 테스트가 공허해진다."""
        env = dict(os.environ, PYTHONIOENCODING="cp1252")
        done = subprocess.run(
            [sys.executable, "-c", "print('한글')"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
        )
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("UnicodeEncodeError", done.stderr)


def main():
    global UPDATE
    # 테스트가 일부러 실패 경로를 태우므로 로그가 stderr 로 샌다(핸들러 없을 때의 기본
    # 동작). NullHandler 를 달아 [OK]/[FAIL] 출력이 묻히지 않게 한다.
    logging.getLogger().addHandler(logging.NullHandler())
    argv = list(sys.argv)
    if "--update" in argv:
        UPDATE = True
        argv.remove("--update")
    unittest.main(argv=argv, exit=True)


if __name__ == "__main__":
    main()
