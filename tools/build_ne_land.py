"""Natural Earth 육지 폴리곤 → `web/lib/ne_land.js` (오프라인 배경, P17-2).

**왜 이 데이터인가.** 원안은 Esri 저줌 타일 341장을 exe 에 넣는 것이었고 크기(1.35MB)는
문제가 아니었는데, 라이선스에서 끊겼다 — Esri 문서가 *"Systematically requesting ArcGIS
tiles for offline use through other apps or services is prohibited"* 라고 명시한다.
Natural Earth 는 **퍼블릭 도메인**(https://www.naturalearthdata.com/about/terms-of-use/)
이라 재배포 제한이 없다.

**왜 `.js` 인가.** `file://` 로 열리는 앱이라 `fetch()` 가 오리진 제한에 걸린다.
클래식 스크립트로 전역에 박아 두면 다른 `web/lib/*` 와 같은 경로로 로드된다.

실행: `python tools/build_ne_land.py [50m|110m]`  (네트워크 필요 · 결과는 커밋한다)

**왜 50m 인가.** 110m 로 먼저 만들어 오프라인 화면을 캡처해 보니 확대 시 섬이 뭉텅이로
뭉개졌다(필리핀 군도가 덩어리 하나). 50m 는 +1.08MB 로 군도·마리아나 제도까지 나온다.
"""
import json
import os
import sys
import urllib.request

SRC = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_{}_land.geojson"
OUT = os.path.join(os.path.dirname(__file__), "..", "web", "lib", "ne_land.js")
PRECISION = 3   # 소수 3자리 ≈ 100m. 저줌 배경이라 그 아래는 화면에서 구분되지 않는다


def trim(o, nd=PRECISION):
    if isinstance(o, list):
        return [trim(x, nd) for x in o]
    if isinstance(o, float):
        return round(o, nd)
    return o


def main(scale="110m"):
    with urllib.request.urlopen(SRC.format(scale)) as r:
        g = json.loads(r.read().decode("utf-8"))
    for ft in g["features"]:
        ft["properties"] = {}          # 속성은 안 쓴다 — 전부 버려 용량을 아낀다
        ft.pop("id", None)
        ft["geometry"]["coordinates"] = trim(ft["geometry"]["coordinates"])
    body = json.dumps(g, separators=(",", ":"), ensure_ascii=False)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("/* Natural Earth {} 육지 폴리곤 (퍼블릭 도메인) — tools/build_ne_land.py 생성물.\n"
                "   손으로 고치지 않는다. 오프라인 배경(P17-2)용. */\n".format(scale))
        f.write("const NE_LAND = " + body + ";\n")
    print("[OK] {} · feature {} · {} KB".format(scale, len(g["features"]),
                                                os.path.getsize(OUT) // 1024))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "50m")
