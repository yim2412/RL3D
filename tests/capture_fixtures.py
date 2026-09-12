"""실제 API 응답을 픽스처로 내려받는다(수동 실행 · 네트워크 필요).

    python tests/capture_fixtures.py

LL2는 시간당 약 15회 제한이 있으므로 자주 돌리지 않는다. 응답이 크기 때문에
results 는 앞 KEEP 건만 남겨 저장한다(파싱 회귀 검증에는 그 정도면 충분).
픽스처를 새로 받은 뒤에는 골든도 갱신해야 한다:

    python tests/test_parsing.py --update
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import api_client  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
KEEP = 3          # 발사 응답에서 남길 건수
KEEP_TLE = 4      # TLE에서 남길 위성 수(3줄 × N)


def _strip_video_descriptions(results):
    """중계 영상의 설명문을 버린다.

    유튜브 설명문에는 채널 운영자의 SNS 계정·사업용 이메일과 저작권 문구가 통째로
    딸려 온다. 공개 저장소에 남의 연락처를 픽스처로 올릴 이유가 없다.

    파싱에도 필요 없다 — `api_parsing._parse_launches` 는 중계 링크에서 title·url 만
    남기고 description 은 버린다(캐시 비대 방지). 지워도 골든값은 바뀌지 않는다.
    """
    for launch in results:
        for video in launch.get("vidURLs") or []:
            if isinstance(video, dict) and video.get("description"):
                video["description"] = ""
    return results


def _trim_launch_payload(payload):
    results = _strip_video_descriptions((payload.get("results") or [])[:KEEP])
    return {"count": payload.get("count"), "next": None, "previous": None, "results": results}


def main():
    os.makedirs(FIXTURES, exist_ok=True)

    for fname, url in (
        ("ll2_upcoming.json", api_client.LL2_UPCOMING),
        ("ll2_previous.json", api_client.LL2_PREVIOUS),
    ):
        payload = _trim_launch_payload(json.loads(api_client._http_get(url)))
        path = os.path.join(FIXTURES, fname)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1, sort_keys=True)
        print("[OK] {} - {}건".format(fname, len(payload["results"])))

    text = api_client._http_get(api_client.CELESTRAK_GP.format(group="stations"))
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()][: KEEP_TLE * 3]
    path = os.path.join(FIXTURES, "celestrak_stations.txt")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print("[OK] celestrak_stations.txt - {}개".format(len(lines) // 3))


if __name__ == "__main__":
    main()
