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
import api_errors  # noqa: E402
import api_parsing  # noqa: E402
import satcat_codes  # noqa: E402
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
        parsed = api_parsing._parse_launches(_read_json(os.path.join(FIXTURES, "ll2_upcoming.json")))
        self.assertEqual(parsed, _golden("launches_upcoming.json", parsed, UPDATE))

    def test_previous_matches_golden(self):
        parsed = api_parsing._parse_launches(_read_json(os.path.join(FIXTURES, "ll2_previous.json")))
        self.assertEqual(parsed, _golden("launches_previous.json", parsed, UPDATE))

    def test_required_fields_present(self):
        """지도·패널이 의존하는 필드가 빠지면 앱이 조용히 비어 보인다."""
        parsed = api_parsing._parse_launches(_read_json(os.path.join(FIXTURES, "ll2_previous.json")))
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
        self.assertEqual(api_parsing._parse_launches(payload), [])

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
        parsed = api_parsing._parse_launches(payload)
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
        parsed = api_parsing._parse_launches(payload)
        self.assertEqual(len(parsed), 1)
        d = parsed[0]
        self.assertEqual(d["outcome"], "upcoming")   # status 없으면 예정 계열
        self.assertIsNone(d["rocket"])
        self.assertIsNone(d["orbit"])

    def test_detail_fields_present(self):
        """detailed 응답에서만 오는 확장 필드(중계·소식·맥락)가 정규화에 실려야 한다."""
        parsed = api_parsing._parse_launches(_read_json(os.path.join(FIXTURES, "ll2_upcoming.json")))
        starship = next(d for d in parsed if "Starship" in (d["name"] or ""))
        self.assertTrue(starship["vid_urls"], "중계 링크가 비어 있다")
        self.assertTrue(all(set(v) == {"title", "url"} for v in starship["vid_urls"]))
        self.assertTrue(starship["patch"].startswith("http"))
        self.assertTrue(starship["updates"])
        self.assertEqual(starship["programs"], ["SpaceX Starship"])
        self.assertEqual(starship["net_precision"], "Second")
        # 전 세계 연내 궤도 발사 순번(P13-2) — 통계의 모수를 "불러온 N건" 너머로 넓히는
        # 유일한 외부 기준값이다. 안 실으면 화면에서 **조용히 사라진다**.
        counts = [d["orbital_year_count"] for d in parsed]
        self.assertTrue(any(isinstance(c, int) and c > 0 for c in counts),
                        "연내 궤도 발사 순번이 하나도 안 실렸다")
        # 발사장 통산·발사대 재사용 간격(P13-3). 프론트 테스트는 합성 입력을 쓰므로
        # **파이썬이 이 필드를 싣는지는 여기서만 드러난다**(P13-2 에서 변이를 놓쳤던 자리).
        self.assertTrue(any(isinstance(d["location_count"], int) and d["location_count"] > 0
                            for d in parsed), "발사장 통산 횟수가 하나도 안 실렸다")
        self.assertTrue(any(isinstance(d["pad_turnaround_sec"], int) and d["pad_turnaround_sec"] > 0
                            for d in parsed), "발사대 재사용 간격이 하나도 안 실렸다")
        self.assertIsInstance(starship["webcast_live"], bool)

    def test_relative_time_parsing(self):
        """ISO-8601 기간 → 초. 읽을 수 없으면 None(그 이벤트는 버린다)."""
        f = api_parsing.parse_relative_time
        self.assertEqual(f("-PT50M"), -3000)
        self.assertEqual(f("P0D"), 0)          # 리프토프 순간
        self.assertEqual(f("PT58S"), 58)
        self.assertEqual(f("PT1H2M23S"), 3743)
        self.assertEqual(f("-PT36M33S"), -2193)
        self.assertEqual(f("P1DT2H"), 93600)
        # 소수 초는 반올림해 정수로 — float 로 두면 캐시 JSON 만 커진다
        self.assertEqual(f("PT2.4S"), 2)
        self.assertIsInstance(f("PT58S"), int)
        for bad in ("", "  ", "garbage", None, "PT", "P"):
            self.assertIsNone(f(bad), bad)

    def test_timeline_sorted_and_kept_verbatim(self):
        """순서표는 시간순으로 **정렬**되고, 내용은 손대지 않는다."""
        parsed = api_parsing._parse_launches(_read_json(os.path.join(FIXTURES, "ll2_previous.json")))
        d = next(x for x in parsed if x["timeline"])
        tl = d["timeline"]
        self.assertEqual(len(tl), 32)
        self.assertTrue(all(tl[i]["t"] <= tl[i + 1]["t"] for i in range(len(tl) - 1)),
                        "정렬되지 않았다 — '다음 이벤트' 판정이 조용히 틀린다")
        self.assertEqual(tl[0]["abbrev"], "GO for Prop Load")
        self.assertEqual(tl[0]["t"], -3000)
        self.assertEqual(set(tl[0]), {"t", "abbrev", "desc"})
        # 같은 이름이 세 번 오는 것도 그대로 둔다(우리가 지울 근거가 없다)
        self.assertEqual(sum(1 for e in tl if e["abbrev"] == "Starship Landing"), 3)

    def test_timeline_unsorted_input_is_sorted(self):
        item = {"timeline": [
            {"relative_time": "PT58S", "type": {"abbrev": "Max-Q"}},
            {"relative_time": "-PT50M", "type": {"abbrev": "GO for Prop Load"}},
            {"relative_time": "P0D", "type": {"abbrev": "Liftoff"}},
        ]}
        self.assertEqual([e["abbrev"] for e in api_parsing._parse_timeline(item)],
                         ["GO for Prop Load", "Liftoff", "Max-Q"])

    def test_timeline_drops_unreadable_entries(self):
        """읽을 수 없는 시각은 **버린다** — 0 으로 두면 리프토프 순간에 정체불명 이벤트가 낀다."""
        item = {"timeline": [
            {"relative_time": "nonsense", "type": {"abbrev": "정체불명"}},
            {"relative_time": "PT10S", "type": {}},              # 이름이 없다
            {"relative_time": "PT20S", "type": {"abbrev": "OK"}},
            "문자열이 들어온 경우",
        ]}
        self.assertEqual(api_parsing._parse_timeline(item), [{"t": 20, "abbrev": "OK", "desc": None}])

    def test_timeline_absent_is_empty_list(self):
        """실측 10% 에만 있다 — 없는 것이 정상이고, 그때 빈 리스트여야 화면이 블록을 안 그린다."""
        self.assertEqual(api_parsing._parse_timeline({}), [])
        self.assertEqual(api_parsing._parse_timeline({"timeline": None}), [])

    def test_timeline_capped(self):
        item = {"timeline": [{"relative_time": "PT{}S".format(i), "type": {"abbrev": "e"}}
                             for i in range(200)]}
        self.assertEqual(len(api_parsing._parse_timeline(item)), api_parsing.MAX_TIMELINE)

    def test_vid_urls_capped_and_cleaned(self):
        item = {"vidURLs": [{"url": "https://e/{}".format(i), "title": "t{}".format(i),
                             "description": "x" * 500} for i in range(10)]}
        vids = api_parsing._parse_vid_urls(item)
        self.assertEqual(len(vids), api_parsing.MAX_VID_URLS)
        self.assertEqual(set(vids[0]), {"title", "url"})   # description 은 버린다(캐시 비대 방지)

    def test_vid_urls_skip_broken(self):
        item = {"vidURLs": [None, {"title": "제목만"}, {"url": "https://ok"}, "문자열"]}
        self.assertEqual(api_parsing._parse_vid_urls(item), [{"title": "중계", "url": "https://ok"}])

    def test_updates_newest_first_and_capped(self):
        item = {"updates": [
            {"comment": "old", "created_on": "2026-01-01T00:00:00Z"},
            {"comment": "new", "created_on": "2026-07-01T00:00:00Z"},
            {"comment": None, "created_on": "2026-08-01T00:00:00Z"},  # 본문 없는 건 제외
        ] + [{"comment": "c{}".format(i), "created_on": "2026-06-{:02d}T00:00:00Z".format(i + 1)}
             for i in range(10)]}
        ups = api_parsing._parse_updates(item)
        self.assertEqual(len(ups), api_parsing.MAX_UPDATES)
        self.assertEqual(ups[0]["comment"], "new")
        self.assertNotIn(None, [u["comment"] for u in ups])

    def test_detail_fields_default_when_absent(self):
        """구버전/간이 응답이라 확장 필드가 없어도 죽지 않고 빈 값이 된다."""
        payload = {"results": [{"id": "m", "name": "Minimal",
                                "pad": {"latitude": 1, "longitude": 2}}]}
        d = api_parsing._parse_launches(payload)[0]
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
            self.assertEqual(api_parsing._outcome_from_status(abbrev), expected, abbrev)

    def test_dedupe_keeps_first(self):
        """LL2는 막 발사된 건을 upcoming·previous 양쪽에 낸다 → 앞의 것(결과 확정본) 유지."""
        items = [
            {"id": "a", "outcome": "success"},
            {"id": "a", "outcome": "upcoming"},
            {"id": "b", "outcome": "upcoming"},
            {"id": None, "name": "no-id-1"},
            {"id": None, "name": "no-id-2"},
        ]
        out = api_parsing._dedupe_launches(items)
        self.assertEqual([d.get("id") for d in out], ["a", "b", None, None])
        self.assertEqual(out[0]["outcome"], "success")


def _key_paths(obj, prefix=""):
    """정규화 결과의 필드 경로 집합 — 값이 아니라 **모양**만."""
    out = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.add(prefix + k)
            out |= _key_paths(v, prefix + k + ".")
    elif isinstance(obj, list):
        for v in obj:
            out |= _key_paths(v, prefix + "[].")
    return out


class SchemaShapeGuard(unittest.TestCase):
    """정규화 결과의 모양이 바뀌면 `CACHE_SCHEMA` 도 바뀌어야 한다(전면 감사 2026-09-24).

    안 올리면 **지난 연도 아카이브는 TTL 이 없어 영구**라 새 필드가 영원히 안 채워진다 —
    2026-09-12 에 실제로 당했다(필드 넷). 골든 비교는 값이 바뀐 것만 알고 **스키마를 올렸는지는
    모른다**. 백테스트(docs/audit/backtest.py)에서 이 사건을 어떤 도구도 못 잡았다.

    모양이나 스키마가 바뀌면 여기가 빨개진다 → 스키마를 올렸는지 확인하고 `--update`.
    """

    def shape(self):
        launches = (api_parsing._parse_launches(_read_json(os.path.join(FIXTURES, "ll2_upcoming.json")))
                    + api_parsing._parse_launches(_read_json(os.path.join(FIXTURES, "ll2_previous.json"))))
        tle = api_parsing._parse_tle(_read_text(os.path.join(FIXTURES, "celestrak_stations.txt")))
        satcat = api_parsing._parse_satcat(_read_text(os.path.join(FIXTURES, "celestrak_satcat.csv")))
        return {"launch": sorted(_key_paths(launches)), "tle": sorted(_key_paths(tle)),
                "satcat": sorted(_key_paths(list(satcat.values())))}

    def test_shape_change_requires_schema_bump(self):
        now = {"schema": api_client.CACHE_SCHEMA, "shape": self.shape()}
        rec = _golden("schema_shape.json", now, UPDATE)
        if now["shape"] != rec["shape"] and now["schema"] == rec["schema"]:
            added = {k: sorted(set(now["shape"][k]) - set(rec["shape"][k])) for k in now["shape"]}
            removed = {k: sorted(set(rec["shape"][k]) - set(now["shape"][k])) for k in now["shape"]}
            self.fail(f"정규화 결과의 모양이 바뀌었는데 CACHE_SCHEMA({now['schema']}) 를 안 올렸다 — "
                      f"추가 {added} · 제거 {removed}. 올린 뒤 --update")
        self.assertEqual(now, rec, "스키마나 모양이 바뀌었다 — 의도한 것이면 --update 로 기록을 갱신한다")


class TleParsing(unittest.TestCase):
    def test_tle_matches_golden(self):
        parsed = api_parsing._parse_tle(_read_text(os.path.join(FIXTURES, "celestrak_stations.txt")))
        self.assertEqual(parsed, _golden("satellites_stations.json", parsed, UPDATE))

    def test_tle_fields(self):
        parsed = api_parsing._parse_tle(_read_text(os.path.join(FIXTURES, "celestrak_stations.txt")))
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
        parsed = api_parsing._parse_tle(text)
        self.assertEqual([s["norad_id"] for s in parsed], ["25544"])

    def test_empty_text(self):
        self.assertEqual(api_parsing._parse_tle(""), [])


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
        self.assertEqual(api_errors._friendly_error(e), api_errors.TIMEOUT_MESSAGE)

    def test_timeout_reason_as_plain_string(self):
        """reason 이 예외가 아니라 문자열로 오는 경우도 타임아웃으로 읽는다."""
        e = urllib.error.URLError("timed out")
        self.assertEqual(api_errors._friendly_error(e), api_errors.TIMEOUT_MESSAGE)

    def test_offline_is_not_timeout(self):
        """DNS 실패는 타임아웃이 아니라 연결 문제로 안내한다."""
        e = urllib.error.URLError(OSError(11001, "getaddrinfo failed"))
        msg = api_errors._friendly_error(e)
        self.assertNotEqual(msg, api_errors.TIMEOUT_MESSAGE)
        self.assertIn("인터넷 연결", msg)

    def test_403_has_own_message(self):
        """Celestrak 이 실제로 돌려주는 코드 — 숫자만 보여주면 안 된다."""
        msg = api_errors._friendly_error(self._http_error(403, "Forbidden"))
        self.assertEqual(msg, api_errors.HTTP_ERROR_MESSAGES[403])
        self.assertNotEqual(msg, "서버 응답 오류(403).")

    def test_429_still_mentions_rate_limit(self):
        msg = api_errors._friendly_error(self._http_error(429, "Too Many"))
        self.assertIn("한도", msg)

    def test_unmapped_code_falls_back(self):
        """표에 없는 코드는 코드 번호라도 알려준다."""
        self.assertEqual(
            api_errors._friendly_error(self._http_error(418, "Teapot")),
            "서버 응답 오류(418).")

    def test_http_error_is_not_read_as_timeout(self):
        """HTTPError 도 URLError 라 reason 을 갖는다 — 표가 먼저 이겨야 한다."""
        e = self._http_error(503, "timed out")
        self.assertEqual(api_errors._friendly_error(e),
                         api_errors.HTTP_ERROR_MESSAGES[503])


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


class TestRestoredGeometry(unittest.TestCase):
    """저장된 창 상태 복원 판정 (전면 감사 F-011·F-021).

    `_run()` 안에 있을 때는 조건을 뒤집어도 아무 테스트도 실패하지 않았고, `window` 가
    dict 가 아니면 매 실행 크래시 안내가 떴다. 순수 함수로 떼어 창 없이 잰다.
    """
    PRIMARY = [(0, 0, 1920, 1040)]
    f = staticmethod(lambda *a: main_mod.restored_geometry(*a))

    def test_size_and_position_are_restored(self):
        self.assertEqual(self.f({"width": 1000, "height": 700, "x": 50, "y": 60}, 1280, 800, None, None,
                                lambda: self.PRIMARY), (1000, 700, 50, 60))

    def test_wrong_shapes_fall_back_to_defaults_without_raising(self):
        for bad in ("창", ["x"], 3, None, {"width": "1000", "height": 700}, {"width": True, "height": 700}):
            with self.subTest(bad=bad):
                self.assertEqual(self.f(bad, 1280, 800, None, None, lambda: self.PRIMARY)[:2], (1280, 800))

    def test_offscreen_position_is_ignored(self):
        got = self.f({"x": 5000, "y": 60}, 1280, 800, None, None, lambda: self.PRIMARY)
        self.assertEqual(got[2:], (None, None), "보이지 않는 자리에 창을 띄웠다")

    def test_unknown_monitors_trust_saved_position(self):
        got = self.f({"x": 5000, "y": 60}, 1280, 800, None, None, lambda: None)
        self.assertEqual(got[2:], (5000, 60))

    def test_dev_position_is_not_overridden(self):
        """개발 모니터 위치(x 가 이미 정해짐)는 저장된 위치로 덮지 않는다."""
        got = self.f({"x": 50, "y": 60}, 1280, 800, 3000, 10, lambda: self.PRIMARY)
        self.assertEqual(got[2:], (3000, 10))

    def test_monitors_are_read_only_when_restoring_position(self):
        called = []
        self.f({"width": 900, "height": 600}, 1280, 800, None, None, lambda: called.append(1))
        self.assertEqual(called, [], "위치를 복원하지 않는데 모니터를 읽었다(느린 호출)")


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


class TestWebLogBridge(unittest.TestCase):
    """JS→파이썬 로그 통로 (P23-1). 창 없이 Api.log 만 직접 부른다."""

    def setUp(self):
        self.api = main_mod.Api()
        self.records = []
        self.handler = logging.Handler()
        self.handler.emit = self.records.append
        self.weblog = logging.getLogger("rl3d.web")
        self.weblog.addHandler(self.handler)
        self.weblog.setLevel(logging.DEBUG)
        self.addCleanup(self.weblog.removeHandler, self.handler)

    def test_error_lands_in_web_logger(self):
        """**파이썬 오류와 이름이 갈려 있어야** 로그를 볼 때 어느 쪽이 터진 건지 안다."""
        self.assertTrue(self.api.log("error", "[오류] boom @ sats.js:7"))
        self.assertEqual(len(self.records), 1)
        self.assertEqual(self.records[0].name, "rl3d.web")
        self.assertEqual(self.records[0].levelno, logging.ERROR)
        self.assertIn("sats.js:7", self.records[0].getMessage())

    def test_warning_level_is_honored(self):
        self.api.log("warning", "조심")
        self.assertEqual(self.records[0].levelno, logging.WARNING)

    def test_unknown_level_falls_back_to_error(self):
        """브릿지로 들어오는 값은 신뢰하지 않는다 — 모르는 레벨은 error 로 본다."""
        self.api.log("critical", "x")
        self.assertEqual(self.records[0].levelno, logging.ERROR)

    def test_message_is_truncated(self):
        """길이를 안 자르면 매초 도는 틱의 예외 하나가 로그를 통째로 밀어낸다."""
        self.api.log("error", "x" * 99999)
        self.assertEqual(len(self.records[0].getMessage()), main_mod.WEB_LOG_MAX_CHARS)

    def test_never_raises(self):
        """여기서 예외가 나면 JS 쪽 보고 경로가 그걸 또 보고해 **재귀한다.**

        막지 않았으면 무슨 일이 났을지부터 단언한다 — `str()` 이 던지는 값을 넣어
        본다(방어를 뜯으면 이 테스트가 TypeError 가 아니라 실패로 드러나야 한다).
        """
        class Hostile:
            def __str__(self):
                raise RuntimeError("문자열로 못 바꿈")

        self.assertFalse(self.api.log("error", Hostile()))
        self.assertEqual(self.records, [])


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


class TestMonitorOrder(unittest.TestCase):
    """개발 모니터 번호 (2026-09-11 실측 버그).

    `Screen.AllScreens` 순서는 사용자가 보는 "디스플레이 1/2"와 무관하다 — 이 PC 는
    AllScreens[0] 이 **보조**, [1] 이 **주**였다. 그대로 인덱싱하면 `RL3D_DEV_MONITOR=2`
    가 주 모니터를 가리켜 "보조에서만 테스트한다"는 규칙이 **조용히** 안 지켜진다.
    """

    class _S:
        def __init__(self, name, primary):
            self.name, self.Primary = name, primary

        def __repr__(self):
            return self.name

    def test_primary_comes_first_even_when_listed_last(self):
        """실측된 배치 그대로 — 보조가 먼저 나열돼도 주가 1번이어야 한다."""
        sec, pri = self._S("보조", False), self._S("주", True)
        order = main_mod.order_screens([sec, pri])
        self.assertIs(order[0], pri)
        self.assertIs(order[1], sec)
        # 막지 않았으면 무엇이 일어났을 것인가 — 정렬 없이는 2번이 주 모니터였다.
        self.assertIs([sec, pri][1], pri)

    def test_already_primary_first_is_unchanged(self):
        pri, sec = self._S("주", True), self._S("보조", False)
        self.assertEqual(main_mod.order_screens([pri, sec]), [pri, sec])

    def test_three_screens_keep_relative_order_of_others(self):
        a, pri, b = self._S("a", False), self._S("주", True), self._S("b", False)
        self.assertEqual(main_mod.order_screens([a, pri, b]), [pri, a, b])

    def test_single_screen(self):
        pri = self._S("주", True)
        self.assertEqual(main_mod.order_screens([pri]), [pri])

    def test_no_primary_reported(self):
        """주 모니터가 없다고 보고되는 환경에서도 죽지 않는다(원격 세션 등)."""
        a, b = self._S("a", False), self._S("b", False)
        self.assertEqual(main_mod.order_screens([a, b]), [a, b])


class TestSatcatParsing(unittest.TestCase):
    """SATCAT 정규화 (P12-5). 실제 응답 + 일부러 넣은 경계 사례로 잰다."""

    @classmethod
    def setUpClass(cls):
        text = _read_text(os.path.join(FIXTURES, "celestrak_satcat.csv"))
        cls.meta = api_parsing._parse_satcat(text)

    def test_real_row_normalized(self):
        """ISS — 코드가 사람 말로 바뀌는가."""
        iss = self.meta[25544]
        self.assertEqual(iss["name"], "ISS (ZARYA)")
        self.assertEqual(iss["type"], "위성체")          # PAY
        self.assertEqual(iss["owner"], "국제우주정거장(공동)")  # ISS
        self.assertEqual(iss["status"], "운용 중")        # +
        self.assertEqual(iss["launch_date"], "1998-11-20")
        self.assertEqual(iss["launch_site"], "바이코누르(카자흐)")  # TYMSC
        self.assertEqual(iss["intl_code"], "1998-067A")
        self.assertEqual(iss["size"], "큼")               # RCS 399.05
        self.assertIsNone(iss["decay_date"])              # 아직 궤도에 있다

    def test_decayed_object_keeps_decay_date(self):
        """재진입 물체 — 이 값이 P12-8(재진입 표시)의 근거가 된다."""
        deb = self.meta[90001]
        self.assertEqual(deb["type"], "잔해")             # DEB
        self.assertEqual(deb["status"], "궤도 이탈(재진입)")  # D
        self.assertEqual(deb["decay_date"], "2024-03-02")
        self.assertEqual(deb["size"], "작음")             # RCS 0.0182 < 0.1

    def test_unknown_owner_code_falls_back_to_raw(self):
        """모르는 코드는 **원문 그대로**. '알 수 없음'으로 뭉개면 정보가 사라진다."""
        rb = self.meta[90002]
        self.assertEqual(rb["owner"], "ZZZ")
        self.assertEqual(rb["type"], "로켓 몸체")         # R/B
        self.assertEqual(rb["size"], "보통")              # RCS 0.55

    def test_row_without_norad_is_dropped(self):
        """NORAD 가 없으면 조인할 수 없다 — 그 행만 버리고 나머지는 산다."""
        self.assertNotIn(0, self.meta)
        self.assertIn(25544, self.meta)   # 깨진 행 뒤의 정상 행도 살아 있다
        self.assertIn(90003, self.meta)

    def test_non_numeric_rcs_only_loses_size(self):
        """RCS 가 숫자가 아니면 크기만 None — 나머지 필드는 살아야 한다."""
        odd = self.meta[90003]
        self.assertIsNone(odd["size"])
        self.assertEqual(odd["owner"], "미국")
        self.assertEqual(odd["launch_date"], "2001-01-01")

    def test_empty_rcs_is_none_not_zero(self):
        """빈 RCS 를 0 으로 읽으면 전부 '작음'이 된다 — 실측상 절반이 비어 있다."""
        sputnik = self.meta[2]
        self.assertIsNone(sputnik["size"])

    def test_empty_input_is_empty_dict(self):
        self.assertEqual(api_parsing._parse_satcat(""), {})
        self.assertEqual(api_parsing._parse_satcat("OBJECT_NAME,NORAD_CAT_ID" + chr(10)), {})


class TestSatcatCodes(unittest.TestCase):
    """코드 표 (satcat_codes). 표가 비거나 기준이 뒤집히면 화면이 조용히 틀린다."""

    def test_all_measured_object_types_are_covered(self):
        """실측 4종(DEB/PAY/R/B/UNK)은 전부 표에 있어야 한다."""
        for code in ("DEB", "PAY", "R/B", "UNK"):
            self.assertIn(code, satcat_codes.OBJECT_TYPES)
            self.assertNotEqual(satcat_codes.label(satcat_codes.OBJECT_TYPES, code), code)

    def test_rcs_bucket_boundaries(self):
        """경계값을 잰다 — 부등호가 뒤집혀도 중간값만으로는 안 잡힌다."""
        self.assertEqual(satcat_codes.rcs_size(0.09), "작음")
        self.assertEqual(satcat_codes.rcs_size(0.1), "보통")   # 경계는 위쪽 구간
        self.assertEqual(satcat_codes.rcs_size(0.99), "보통")
        self.assertEqual(satcat_codes.rcs_size(1.0), "큼")
        self.assertIsNone(satcat_codes.rcs_size(""))
        self.assertIsNone(satcat_codes.rcs_size(None))
        self.assertIsNone(satcat_codes.rcs_size("N/A"))

    def test_label_returns_raw_code_when_unmapped(self):
        self.assertEqual(satcat_codes.label(satcat_codes.OWNERS, "NOPE"), "NOPE")
        self.assertIsNone(satcat_codes.label(satcat_codes.OWNERS, None))
        self.assertIsNone(satcat_codes.label(satcat_codes.OWNERS, "   "))


def main():
    global UPDATE
    # 테스트가 일부러 실패 경로를 태우므로 로그가 stderr 로 샌다(핸들러 없을 때의 기본
    # 동작). NullHandler 를 달아 [OK]/[FAIL] 출력이 묻히지 않게 한다.
    logging.getLogger().addHandler(logging.NullHandler())
    argv = list(sys.argv)
    if "--update" in argv:
        UPDATE = True
        argv.remove("--update")
    res = unittest.main(argv=argv, exit=False).result
    # 건수 하한(전면 감사 2026-09-24 실측) — 수집이 조용히 비면 0건으로 통과한다.
    # 인자로 일부만 골라 돌릴 때는 하한을 보지 않는다.
    if len(argv) == 1 and res.testsRun < MIN_TESTS:
        print(f"FAIL 건수 하한: {res.testsRun} < {MIN_TESTS}")
        sys.exit(1)
    sys.exit(0 if res.wasSuccessful() else 1)


MIN_TESTS = 106


class TestPadTimezone(unittest.TestCase):
    """P14-2 — 발사장 현지 시간대. 실측 라이브 50/50 채워짐."""

    def test_timezone_name_is_carried(self):
        d = api_parsing._parse_launch({
            "pad": {"latitude": 1.0, "longitude": 2.0,
                    "location": {"timezone_name": "America/Chicago"}}})
        self.assertEqual(d["pad_timezone"], "America/Chicago")

    def test_missing_timezone_is_none(self):
        """없으면 None — 화면은 그 줄을 안 낸다(빈 문자열로 접으면 줄이 생긴다)."""
        d = api_parsing._parse_launch({"pad": {"latitude": 1.0, "longitude": 2.0}})
        self.assertIsNone(d["pad_timezone"])


class TestLandingTotals(unittest.TestCase):
    """P15-3 — 착륙 통산. P14-1 이 부스터 한 대를 넣었고, 그 위 집계가 없었다."""

    def _launch(self, provider=None, config=None):
        return {"pad": {"latitude": 1.0, "longitude": 2.0},
                "launch_service_provider": provider or {},
                "rocket": {"configuration": config or {}}}

    def test_rocket_landing_values_are_carried(self):
        d = api_parsing._parse_launch(self._launch(config={
            "attempted_landings": 620, "successful_landings": 615,
            "failed_landings": 5, "consecutive_successful_landings": 315}))
        sp = d["rocket_spec"]
        self.assertEqual((sp["land_att"], sp["land_ok"], sp["land_fail"], sp["land_streak"]),
                         (620, 615, 5, 315))

    def test_provider_landings_none_when_never(self):
        """**시도가 0 이면 None.** 소모형 운용사는 착륙을 안 하는 것이지 실패한 게 아니다
        (실측: Arianespace · ULA · ROSCOSMOS · JAXA 가 전부 0)."""
        d = api_parsing._parse_launch(self._launch(provider={
            "name": "Arianespace", "attempted_landings": 0, "successful_landings": 0}))
        self.assertIsNone(d["provider_landings"])

    def test_provider_landings_keeps_raw_values(self):
        """**합을 계산하지 않는다.** 실측 SpaceX 는 699 시도인데 671+29 = 700 으로
        LL2 값끼리 안 맞는다 — 유도하면 우리가 틀린 숫자를 지어내게 된다."""
        d = api_parsing._parse_launch(self._launch(provider={
            "name": "SpaceX", "attempted_landings": 699, "successful_landings": 671,
            "failed_landings": 29, "consecutive_successful_landings": 20}))
        self.assertEqual(d["provider_landings"], {"att": 699, "ok": 671, "fail": 29, "streak": 20})

    def test_zero_success_survives(self):
        """`2 시도 0 성공`(Starship V3)은 지워야 할 빈 값이 아니다."""
        d = api_parsing._parse_launch(self._launch(provider={
            "name": "SpaceX", "attempted_landings": 2, "successful_landings": 0,
            "failed_landings": 2, "consecutive_successful_landings": 0}))
        self.assertEqual(d["provider_landings"]["ok"], 0)

    def test_garbage_provider_does_not_kill_the_launch(self):
        """**`x or {}` 로는 부족했다.** 이 단언이 실제로 결함을 찾았다(2026-09-13) —
        `launch_service_provider` 가 문자열이면 `provider.get("name")` 이 `AttributeError`
        로 터져 **그 발사 한 건이 아니라 페이지 전체가 날아갔다.**
        """
        d = api_parsing._parse_launch({"pad": {"latitude": 1.0, "longitude": 2.0},
                                       "launch_service_provider": "문자열"})
        self.assertIsNone(d["provider_landings"])
        self.assertIsNone(d["provider"])

    def test_every_subdict_survives_a_string(self):
        """하위 dict 자리에 **문자열이 와도** 발사 한 건이 살아야 한다(전역 7번).

        `or {}` 는 `None`·`{}`·`""` 만 막고 **비어 있지 않은 문자열을 그대로 통과**시킨다.
        막지 않았으면 바로 다음 `.get()` 이 `AttributeError` 로 터졌을 자리들이다.
        """
        for key in ("rocket", "status", "mission", "launch_service_provider", "net_precision"):
            with self.subTest(key=key):
                d = api_parsing._parse_launch(
                    {"pad": {"latitude": 1.0, "longitude": 2.0}, key: "문자열"})
                self.assertEqual(d["lat"], 1.0)   # 발사 자체는 살아 있다

    def test_pad_as_string_is_skipped_not_crashed(self):
        """`pad` 가 문자열이면 좌표가 없어 **그 한 건만** 빠진다(예외로 안 죽는다)."""
        rows = api_parsing._parse_launches(
            {"results": [{"pad": "문자열"}, {"pad": {"latitude": 1.0, "longitude": 2.0}}]})
        self.assertEqual(len(rows), 1)


class TestMissionAgencies(unittest.TestCase):
    """P15-5 — 누구를 위한 발사인가. 앱은 그동안 **쏘는 쪽만** 말했다."""

    def _launch(self, provider, agencies):
        return {"pad": {"latitude": 1.0, "longitude": 2.0},
                "launch_service_provider": {"name": provider},
                "mission": {"agencies": agencies}}

    def test_provider_itself_is_dropped(self):
        """**제공자 자신은 뺀다.** 라이브 100건에서 참여 기관이 있는 59건 중 **28건이
        제공자 자신**이었다(Starlink 자체 발사 등). 안 빼면 "SpaceX 가 SpaceX 를 위해"다.
        """
        d = api_parsing._parse_launch(self._launch("SpaceX", [{"name": "SpaceX"}]))
        self.assertEqual(d["mission_agencies"], [])

    def test_others_survive_alongside_provider(self):
        """제공자가 섞여 있어도 **나머지는 남는다** — 한 건이라도 남으면 보여줄 값이 있다."""
        d = api_parsing._parse_launch(self._launch(
            "SpaceX", [{"name": "SpaceX"}, {"name": "NASA", "abbrev": "NASA"}]))
        self.assertEqual([a["name"] for a in d["mission_agencies"]], ["NASA"])

    def test_type_is_flattened(self):
        """`type` 은 dict 로도 문자열로도 온다 — 화면이 둘을 구분하지 않게 여기서 편다."""
        d = api_parsing._parse_launch(self._launch(
            "Rocket Lab", [{"name": "BlackSky", "abbrev": "BS", "type": {"name": "Private"}}]))
        self.assertEqual(d["mission_agencies"][0]["type"], "Private")
        d2 = api_parsing._parse_launch(self._launch(
            "Rocket Lab", [{"name": "BlackSky", "type": "Private"}]))
        self.assertEqual(d2["mission_agencies"][0]["type"], "Private")

    def test_garbage_does_not_kill_the_launch(self):
        """이름 없는 항목·dict 아닌 항목이 섞여도 **나머지 발사가 살아야 한다**(전역 7번)."""
        d = api_parsing._parse_launch(self._launch(
            "X", ["문자열", None, {"no_name": 1}, {"name": "SES"}]))
        self.assertEqual([a["name"] for a in d["mission_agencies"]], ["SES"])

    def test_missing_mission_is_empty_list(self):
        d = api_parsing._parse_launch({"pad": {"latitude": 1.0, "longitude": 2.0}})
        self.assertEqual(d["mission_agencies"], [])


class TestRocketSpecAndBoosters(unittest.TestCase):
    """P14-1 — 로켓 제원·부스터 이력. **전부 이미 받아오던 값이라 새 요청이 0이다.**"""

    def _launch(self, **rocket):
        return {"pad": {"latitude": 1.0, "longitude": 2.0}, "rocket": rocket}

    def test_spec_keeps_zero(self):
        """`fail: 0` 은 지워야 할 빈 값이 아니라 **좋은 소식**이다.

        `if v` 로 걸렀다면 실패 0회인 로켓만 조용히 통산에서 빠진다 — 화면에는
        '통산 15회 · 성공 15' 만 남아 **실패 줄이 없는 것과 구분되지 않는다.**
        """
        d = api_parsing._parse_launch(self._launch(
            configuration={"total_launch_count": 15, "successful_launches": 15,
                           "failed_launches": 0, "consecutive_successful_launches": 15}))
        self.assertEqual(d["rocket_spec"]["fail"], 0)
        self.assertIsNotNone(d["rocket_spec"])

    def test_spec_survives_when_every_value_is_zero(self):
        """**처녀비행 대기 중인 로켓은 통산이 0 이다** — 그래도 블록은 있어야 한다.

        `all(not v ...)` 로 비었는지 판정하면 `total=0` 한 값만 있는 신형 로켓의
        제원이 **통째로 None 이 되어** 화면에서 사라진다. 변이 실험에서 이 자리만
        안 잡혀서 알았다(2026-09-13) — `test_spec_keeps_zero` 는 `total=15` 를
        같이 넣고 있어 두 판정이 같은 답을 냈다.
        """
        d = api_parsing._parse_launch(self._launch(
            configuration={"total_launch_count": 0, "failed_launches": 0}))
        self.assertIsNotNone(d["rocket_spec"])
        self.assertEqual(d["rocket_spec"]["total"], 0)

    def test_spec_none_when_empty(self):
        """제원이 하나도 없으면 None — 화면이 빈 블록을 그리지 않는다."""
        self.assertIsNone(api_parsing._parse_launch(self._launch(configuration={}))["rocket_spec"])
        self.assertIsNone(api_parsing._parse_launch(self._launch())["rocket_spec"])

    def test_flights_zero_and_none_stay_apart(self):
        """`0`(신조)과 `None`(부스터 미배정)은 **다른 뜻**이다.

        실측으로 둘 다 온다: `Booster 21` 은 `flights=0`, `Unknown F9` 는 `flights=None`.
        None 을 0 으로 접으면 아직 배정도 안 된 부스터가 '첫 비행'이라고 단언된다.
        """
        b = api_parsing._parse_launch(self._launch(launcher_stage=[
            {"launcher": {"serial_number": "Booster 21", "flights": 0}},
            {"launcher": {"serial_number": "Unknown F9"}},
        ]))["boosters"]
        self.assertEqual(b[0]["flights"], 0)
        self.assertIsNone(b[1]["flights"])

    def test_landing_four_states_survive(self):
        """예정 발사는 `attempt=True`·`success=None` 으로 온다 — **네 상태가 구분돼야** 한다.

        `success` 만 넘기면 아직 날지도 않은 발사가 화면에서 '착륙 실패'가 된다.
        """
        b = api_parsing._parse_launch(self._launch(launcher_stage=[
            {"launcher": {"serial_number": "B1080", "flights": 28}, "reused": True,
             "landing": {"attempt": True, "success": None,
                         "location": {"name": "A Shortfall of Gravitas"}}},
            {"launcher": {"serial_number": "B1063"}, "landing": {"attempt": False}},
        ]))["boosters"]
        self.assertTrue(b[0]["landing_attempt"])
        self.assertIsNone(b[0]["landing_success"])
        self.assertEqual(b[0]["landing_name"], "A Shortfall of Gravitas")
        self.assertFalse(b[1]["landing_attempt"])

    def test_boosters_skip_unnamed_and_cap(self):
        """시리얼 없는 행은 버리고(화면에 빈 줄이 생긴다), 개수는 상한을 지킨다."""
        stages = [{"launcher": {"serial_number": ""}}] +                  [{"launcher": {"serial_number": "B%d" % i}} for i in range(20)]
        b = api_parsing._parse_launch(self._launch(launcher_stage=stages))["boosters"]
        self.assertEqual(len(b), api_parsing.MAX_BOOSTERS)
        self.assertEqual(b[0]["serial"], "B0")

    def test_launcher_stage_garbage_does_not_kill_launch(self):
        """리스트 안에 null 이 섞여 와도 그 발사 전체가 사라지면 안 된다."""
        d = api_parsing._parse_launch(self._launch(launcher_stage=[None, "x", {}]))
        self.assertEqual(d["boosters"], [])


class TestRocketFamily(unittest.TestCase):
    """P15-4 — 로켓 계열. 이미 받아오던 값이라 새 요청이 0이다."""

    def _launch(self, **config):
        return {"pad": {"latitude": 1.0, "longitude": 2.0},
                "rocket": {"configuration": config}}

    def test_family_is_kept_apart_from_rocket_name(self):
        """계열은 **변형 이름을 대신하지 않는다** — 둘 다 화면에 쓰인다.

        `rocket` 을 계열로 덮어쓰면 `Falcon 9 Block 5` 자체의 성적을 볼 길이 사라진다.
        """
        d = api_parsing._parse_launch(self._launch(
            full_name="Falcon 9 Block 5", name="Falcon 9", family="Falcon"))
        self.assertEqual(d["rocket"], "Falcon 9 Block 5")
        self.assertEqual(d["rocket_family"], "Falcon")

    def test_empty_string_family_becomes_none(self):
        """**LL2 는 계열이 없을 때 `null` 이 아니라 빈 문자열을 준다.**

        실측 라이브 100건 중 14건(Electron·Spectrum·Gravity-1·Kinetica 1·Pallas-1·
        Themis)이 `""` 다. `or None` 이 없으면 그 값이 그대로 흘러 계열 행의 판정이
        빈 문자열을 대상으로 돌고, 관점 화면은 **아무것도 못 찾는 버튼**을 그린다.
        """
        self.assertIsNone(api_parsing._parse_launch(
            self._launch(full_name="Electron", family=""))["rocket_family"])

    def test_missing_family_is_none(self):
        """필드 자체가 없어도 같은 답 — 옛 캐시·다른 응답 모양에서 터지지 않는다."""
        self.assertIsNone(api_parsing._parse_launch(
            self._launch(full_name="Electron"))["rocket_family"])
        self.assertIsNone(api_parsing._parse_launch(
            {"pad": {"latitude": 1.0, "longitude": 2.0}})["rocket_family"])

    def test_fixtures_carry_a_real_family(self):
        """픽스처가 이 기능을 **실제로 덮는지** 확인한다.

        P15-5 에서 `mission_agencies` 가 픽스처 6건 모두 빈 리스트라 골든을 갱신해도
        `[]` 만 굳었다. 같은 자리를 다시 밟지 않도록, 픽스처에 계열이 실제로 들어
        있다는 것과 **빈 것도 함께 있다**는 것을 여기서 못 박는다.
        """
        fams = {}
        for path in ("ll2_upcoming.json", "ll2_previous.json"):
            with open(os.path.join(FIXTURES, path), encoding="utf-8") as f:
                payload = json.load(f)
            for d in api_parsing._parse_launches(payload):
                fams[d["rocket"]] = d["rocket_family"]
        self.assertEqual(fams.get("Falcon 9 Block 5"), "Falcon")
        self.assertEqual(fams.get("Long March 3B/E"), "Long March")
        self.assertIsNone(fams.get("Kinetica 1"))   # 빈 문자열로 오는 쪽


if __name__ == "__main__":
    main()
