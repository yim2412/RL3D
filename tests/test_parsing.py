"""정규화 회귀 테스트 — 네트워크 없이 픽스처만으로 돈다.

    python tests/test_parsing.py            # 검증
    python tests/test_parsing.py --update   # 골든 갱신(픽스처를 새로 받은 뒤)

실제 API 응답(tests/fixtures/)을 파싱한 결과를 골든(tests/golden/)과 비교한다.
외부 API가 필드를 바꾸거나 파싱을 잘못 건드리면 여기서 잡힌다.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import api_client  # noqa: E402

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


def main():
    global UPDATE
    argv = list(sys.argv)
    if "--update" in argv:
        UPDATE = True
        argv.remove("--update")
    unittest.main(argv=argv, exit=True)


if __name__ == "__main__":
    main()
