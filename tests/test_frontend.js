/* 프론트엔드 회귀 테스트 (P11-8) — 네트워크·GUI·마우스 없이 web/app.js 의 함수를 직접 부른다.
 *
 *     node tests/test_frontend.js
 *
 * 대상은 "깨져도 화면이 조용히 잘못 나오는" 로직 — 궤도 대역 분류, 필터, 설정 복원 방어,
 * 오프라인 판정, 이스케이프, 통계 집계처럼 눈으로는 틀린 걸 알아채기 어려운 것들.
 * 로딩·스텁은 harness.js 에 있다(app.js 구조가 바뀌면 그 파일만 고친다).
 */
const { loadApp, group, check, done } = require("./harness");

// ── 유틸 ──────────────────────────────────────────────────────────────────────
{
  const { ctx } = loadApp();
  group("유틸");
  check("escapeHtml — 태그·따옴표 무력화",
    ctx.escapeHtml(`<img src=x onerror="alert('x')">`),
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;");
  check("escapeHtml — & 를 먼저 치환(이중 이스케이프 방지)", ctx.escapeHtml("a&lt;b"), "a&amp;lt;b");
  check("escapeHtml — null 은 빈 문자열", ctx.escapeHtml(null), "");
  check("fmtDate — 값 없으면 '미정'", ctx.fmtDate(null), "미정");
  check("countdown — 값 없으면 빈 문자열", ctx.countdown(null), "");
  check("azToCompass — 0°는 북", ctx.azToCompass(0), "북");
  check("azToCompass — 음수 방위도 처리", ctx.azToCompass(-90), "서");
  check("shortenPad — 긴 패드명 약어", ctx.shortenPad("Space Launch Complex 4E"), "SLC 4E");
  check("shortenPad — 규칙에 없으면 그대로", ctx.shortenPad("Pad A"), "Pad A");
}

// ── 발사 합본/조회 ────────────────────────────────────────────────────────────
{
  const { ctx, state } = loadApp();
  group("발사 합본(rebuildAll)");
  state.launches = [{ id: "a", name: "라이브" }];
  ctx.archiveLaunches = [];  // 아카이브는 전역이 아니므로 rebuildAll 이 참조하는 값만 확인
  ctx.rebuildAll();
  check("라이브만 있을 때", state.allLaunches.map((d) => d.id), ["a"]);
  check("findLaunch — 문자열/숫자 id 를 섞어도 찾는다", ctx.findLaunch("a").name, "라이브");
  check("findLaunch — 없는 id 는 undefined", ctx.findLaunch("zzz"), undefined);
}

// ── 궤도 대역 분류 (P11-3) ────────────────────────────────────────────────────
{
  const { ctx } = loadApp();
  group("궤도 대역 분류");
  const rpd = (r) => ({ no: (r * 2 * Math.PI) / 1440 });   // rev/day → rad/min
  const fromAlt = (alt) => {
    const a = 6371 + alt;
    return { no: Math.sqrt(398600.4418 / (a * a * a)) * 60 };
  };
  check("ISS(15.5 rev/day) → leo", ctx.orbitBand(rpd(15.5)), "leo");
  check("Starlink(15.06) → leo", ctx.orbitBand(rpd(15.06)), "leo");
  check("GPS(2.0056) → meo", ctx.orbitBand(rpd(2.0056)), "meo");
  check("Galileo(1.7047) → meo", ctx.orbitBand(rpd(1.7047)), "meo");
  check("정지궤도(1.0027) → geo", ctx.orbitBand(rpd(1.0027)), "geo");
  check("고도 1990km → leo", ctx.orbitBand(fromAlt(1990)), "leo");
  check("고도 2010km → meo", ctx.orbitBand(fromAlt(2010)), "meo");
  check("고도 34900km → meo", ctx.orbitBand(fromAlt(34900)), "meo");
  check("고도 35786km → geo", ctx.orbitBand(fromAlt(35786)), "geo");
  check("no=0 인 이상 TLE 는 leo 로 떨어뜨린다", ctx.orbitBand({ no: 0 }), "leo");
  check("rec 자체가 없어도 죽지 않는다", ctx.orbitBand(null), "leo");
  check("bandLabel", [ctx.bandLabel("leo"), ctx.bandLabel("geo"), ctx.bandLabel("?")], ["LEO", "GEO", ""]);
}

// ── 대역 필터 (P11-3) ─────────────────────────────────────────────────────────
{
  const { ctx, state, el } = loadApp();
  group("대역 필터");
  state.satrecs = [
    { name: "ISS", norad: 25544, band: "leo" },
    { name: "GPS BIIF-1", norad: 36585, band: "meo" },
    { name: "GOES 18", norad: 51850, band: "geo" },
  ];
  const names = () => ctx.visibleSats().map((s) => s.name);
  check("기본은 전부 보인다", names(), ["ISS", "GPS BIIF-1", "GOES 18"]);
  state.satBands = { leo: false, meo: true, geo: true };
  check("LEO 끄면 LEO 만 빠진다", names(), ["GPS BIIF-1", "GOES 18"]);
  state.favSats = new Set(["25544"]);
  check("관심 위성은 필터를 무시하고 남는다", names(), ["ISS", "GPS BIIF-1", "GOES 18"]);
  state.favSats = new Set();
  state.satBands = { leo: false, meo: false, geo: false };
  check("전부 끄면 비어도 죽지 않는다", names(), []);

  state.satBands = { leo: true, meo: true, geo: true };
  ctx.updateSatCount();
  check("개수 표시 — 전부 보이면 (3)", el("sat-count").textContent, "(3)");
  state.satBands = { leo: true, meo: false, geo: false };
  ctx.updateSatCount();
  check("개수 표시 — 걸러지면 (1/3)", el("sat-count").textContent, "(1/3)");
  state.satrecs = [];
  ctx.updateSatCount();
  check("위성이 없으면 표시도 없다", el("sat-count").textContent, "");
}

// ── 설정 복원 (P8-9 · P11-2 · P11-3 · P11-4) ─────────────────────────────────
{
  const { ctx, state } = loadApp();
  group("설정 복원");
  ctx.applySettings(null);
  check("설정이 없어도 죽지 않는다", state.satBands, { leo: true, meo: true, geo: true });

  ctx.applySettings({ satellites: { groups: ["stations"], bands: { leo: false, meo: true, geo: false } } });
  check("저장된 대역 복원", state.satBands, { leo: false, meo: true, geo: false });
  check("저장된 그룹 복원", state.satGroups, ["stations"]);

  state.satBands = { leo: true, meo: true, geo: true };
  ctx.applySettings({ satellites: { bands: { leo: false, meo: false, geo: false } } });
  check("대역이 전부 꺼진 설정은 무시(위성이 하나도 안 보이는 시작 방지)",
    state.satBands, { leo: true, meo: true, geo: true });
  ctx.applySettings({ satellites: {} });
  check("bands 없는 구버전 설정도 안전", state.satBands, { leo: true, meo: true, geo: true });

  ctx.applySettings({ satellites: { groups: [] } });
  check("빈 그룹 배열은 무시(위성이 안 뜨는 상태로 시작하지 않게)", state.satGroups, ["stations"]);

  ctx.applySettings({ favorites: { launches: [123, "abc"], sats: [25544] } });
  check("관심 id 는 항상 문자열로 보관", [...state.favLaunches], ["123", "abc"]);
  check("관심 NORAD 도 문자열", [...state.favSats], ["25544"]);
  check("isFavSat — 숫자로 물어도 맞는다", ctx.isFavSat(25544), true);
  check("isFavLaunch — 숫자로 물어도 맞는다", ctx.isFavLaunch(123), true);

  ctx.applySettings({ camera: { lng: 20, lat: 15, zoom: 99 } });
  check("저장된 줌은 지도 한계로 clamp", state.savedCamera.zoom, 20);
  ctx.applySettings({ camera: { lng: "x", lat: 15, zoom: 3 } });
  check("망가진 카메라 값은 무시", state.savedCamera.zoom, 20);
}

// ── 오프라인 배지 (P11-7) ─────────────────────────────────────────────────────
{
  const { ctx, state, el, map, win } = loadApp();
  group("오프라인 배지");
  state.map = map;
  ctx.setupOfflineBadge();
  const shown = () => !el("offline-badge").hidden;
  check("온라인 시작 — 안 보임", shown(), false);

  map.fire("error", { sourceId: "carto" });
  map.fire("error", { sourceId: "carto" });
  check("타일 실패 2회까지는 뜨지 않는다(한두 개 실패는 흔하다)", shown(), false);
  map.fire("error", { sourceId: "carto" });
  check("연속 3회에서 표시", shown(), true);
  check("문구에 오프라인 안내", el("offline-badge").textContent.includes("오프라인"), true);

  map.fire("data", { dataType: "source", sourceId: "carto", tile: { state: "loaded" } });
  check("타일이 다시 받아지면 스스로 사라진다", [shown(), state.tileFails], [false, 0]);

  map.fire("error", { sourceId: "launches" });
  map.fire("error", {});
  check("배경 타일 외 에러는 세지 않는다", [shown(), state.tileFails], [false, 0]);

  state.tileFails = 2;
  map.fire("error", { sourceId: "esri" });
  check("위성사진 배경 실패도 같이 센다", shown(), true);
  map.fire("data", { dataType: "source", sourceId: "esri", tile: { state: "errored" } });
  check("errored 타일은 복구가 아니다", shown(), true);
  map.fire("data", { dataType: "source", sourceId: "esri" });
  check("tile 없는 data 도 복구가 아니다", shown(), true);
  map.fire("data", { dataType: "source", sourceId: "esri", tile: { state: "loaded" } });
  check("loaded 라야 복구", shown(), false);

  win.fire("offline");
  check("offline 이벤트 → 즉시 표시", shown(), true);
  win.fire("online");
  check("online 이벤트 → 숨김 + 카운터 리셋", [shown(), state.tileFails], [false, 0]);

  win.fire("offline");
  el("offline-badge").fire("click");
  check("클릭하면 닫힌다", shown(), false);
  win.fire("offline");
  check("닫은 뒤에는 다시 뜨지 않는다", shown(), false);
}
{
  const { ctx, state, el, map } = loadApp({ onLine: false });
  group("오프라인 배지 — 시작부터 오프라인");
  state.map = map;
  ctx.setupOfflineBadge();
  check("navigator.onLine=false 면 바로 표시", !el("offline-badge").hidden, true);
}

// ── 통계 집계 (P8-10) ─────────────────────────────────────────────────────────
{
  const { ctx } = loadApp();
  group("통계 집계");
  const s = ctx.computeStats([
    { outcome: "success", provider: "SpaceX", provider_country: "USA", net: "2025-03-01T00:00:00Z" },
    { outcome: "success", provider: "SpaceX", provider_country: "USA", net: "2026-01-01T00:00:00Z" },
    { outcome: "failure", provider: "Rocket Lab", provider_country: "USA", net: "2026-02-01T00:00:00Z" },
    { outcome: "upcoming", provider: "", provider_country: "", net: null },
    { outcome: "unknown", provider: "X", provider_country: "", net: "깨진값" },
  ]);
  check("총 건수는 입력 그대로", s.total, 5);
  check("결과별 집계(모르는 outcome 은 세지 않는다)",
    s.byOutcome, { success: 2, failure: 1, partial: 0, upcoming: 1 });
  check("기관별 집계(빈 값 제외)", s.byProvider, { SpaceX: 2, "Rocket Lab": 1, X: 1 });
  check("연도별 집계(파싱 불가 net 제외)", s.byYear, { 2025: 1, 2026: 2 });
}

// ── 필터 / 검색 / 타임라인 ────────────────────────────────────────────────────
{
  const { ctx, state, el, map, sel } = loadApp();
  group("필터 · 검색 · 타임라인");
  state.map = map;
  map.stubSource("launches");
  state.sidebarTab = "launches";
  state.allLaunches = [
    { id: "1", name: "Falcon 9 | Starlink", outcome: "success", rocket: "Falcon 9", provider: "SpaceX", net: "2026-01-10T00:00:00Z", lat: 28.5, lng: -80.6 },
    { id: "2", name: "Electron | 위성", outcome: "failure", rocket: "Electron", provider: "Rocket Lab", net: "2026-02-20T00:00:00Z", lat: -39.2, lng: 177.8 },
    { id: "3", name: "Long March 5", outcome: "upcoming", rocket: "Long March 5", provider: "CASC", net: "2026-12-01T00:00:00Z", lat: 19.6, lng: 110.9 },
    { id: "4", name: "좌표 없는 발사", outcome: "success", rocket: "X", provider: "Y", net: "2026-03-01T00:00:00Z", lat: null, lng: null },
  ];
  const shownIds = () => (map.data("launches").features || []).map((f) => f.properties.id);

  sel[".flt:checked"] = [{ value: "success" }, { value: "failure" }, { value: "upcoming" }, { value: "partial" }];
  el("search").value = "";
  ctx.applyFilters();
  check("좌표 없는 발사는 지도에서 빠진다(목록엔 남는다)", shownIds(), ["1", "2", "3"]);
  check("목록에는 4건 모두", el("sidebar-count").textContent, "4건");

  sel[".flt:checked"] = [{ value: "success" }];
  ctx.applyFilters();
  check("결과 필터 — 성공만", shownIds(), ["1"]);

  sel[".flt:checked"] = [{ value: "success" }, { value: "failure" }, { value: "upcoming" }];
  el("search").value = "electron";
  ctx.applyFilters();
  check("검색은 로켓명도 본다(대소문자 무시)", shownIds(), ["2"]);
  el("search").value = "SPACEX";
  ctx.applyFilters();
  check("검색은 기관명도 본다", shownIds(), ["1"]);
  el("search").value = "  ";
  ctx.applyFilters();
  check("공백만 입력하면 검색 없음으로 취급", shownIds(), ["1", "2", "3"]);

  el("search").value = "";
  state.timelineMax = new Date("2026-02-01T00:00:00Z").getTime();
  ctx.applyFilters();
  check("타임라인 이후 발사는 제외", shownIds(), ["1"]);
  state.timelineMax = null;

  ctx.recomputeTimeline();
  check("타임라인 범위 = 최소/최대 net",
    [new Date(state.tlMin).toISOString(), new Date(state.tlMax).toISOString()],
    ["2026-01-10T00:00:00.000Z", "2026-12-01T00:00:00.000Z"]);

  const before = [state.tlMin, state.tlMax];
  state.allLaunches = [{ id: "x", name: "net 없음", outcome: "upcoming", net: null }];
  ctx.recomputeTimeline();
  check("net 이 하나도 없으면 이전 범위를 지우지 않는다", [state.tlMin, state.tlMax], before);
}

// ── 사이드바 정렬 ─────────────────────────────────────────────────────────────
{
  const { ctx, state, el } = loadApp();
  group("사이드바 정렬");
  state.sidebarTab = "launches";
  const list = [
    { id: "a", name: "지난 발사 오래된", outcome: "success", net: "2026-01-01T00:00:00Z" },
    { id: "b", name: "예정 나중", outcome: "upcoming", net: "2027-01-01T00:00:00Z" },
    { id: "c", name: "지난 발사 최근", outcome: "failure", net: "2026-06-01T00:00:00Z" },
    { id: "d", name: "예정 임박", outcome: "upcoming", net: "2026-08-01T00:00:00Z" },
  ];
  ctx.renderSidebar(list);
  const order = [...el("sidebar-list").innerHTML.matchAll(/sb-name">(?:★ )?([^<]+)</g)].map((m) => m[1]);
  check("예정이 임박한 순으로 먼저, 지난 발사는 최근 순",
    order, ["예정 임박", "예정 나중", "지난 발사 최근", "지난 발사 오래된"]);
  check("건수 표시", el("sidebar-count").textContent, "4건");

  state.favLaunches = new Set(["d"]);
  ctx.renderSidebar(list);
  check("관심 발사에는 별이 붙는다", el("sidebar-list").innerHTML.includes("★ 예정 임박"), true);

  ctx.renderSidebar([{ id: "z", name: "<img onerror=x>", outcome: "success", net: "2026-01-01T00:00:00Z" }]);
  check("발사명은 이스케이프된다", el("sidebar-list").innerHTML.includes("&lt;img"), true);
}

// ── 자동 갱신 변화 감지 ───────────────────────────────────────────────────────
{
  const { ctx, el } = loadApp();
  group("자동 갱신 변화 감지");
  const msg = () => el("status").textContent;
  const A = { id: "1", name: "발사 A", outcome: "upcoming", status: "Go" };

  ctx.announceChanges([], [A]);
  check("이전 스냅샷이 비면 알리지 않는다(첫 로드)", msg(), "");

  ctx.announceChanges([A], [A, { id: "2", name: "발사 B", outcome: "upcoming" }]);
  check("새 발사가 들어오면 건수로 알린다", msg().includes("새 발사 1건 추가"), true);

  el("status").textContent = "";
  ctx.announceChanges([A], [{ ...A, outcome: "success", status: "Launch Successful" }]);
  check("예정→성공 은 알린다", msg().includes("발사 A"), true);

  el("status").textContent = "";
  ctx.announceChanges([{ ...A, outcome: "success" }], [{ ...A, outcome: "upcoming" }]);
  check("성공→예정 처럼 미확정으로 되돌아가는 변화는 알리지 않는다", msg(), "");

  el("status").textContent = "";
  ctx.announceChanges([A], [A]);
  check("변화가 없으면 조용하다", msg(), "");
}

// ── 지상궤적선 (P6-1) — 실제 SGP4 ─────────────────────────────────────────────
{
  const { ctx } = loadApp({ realSatellite: true });
  group("지상궤적선 (실제 SGP4)");
  // TLE 는 tests/fixtures/celestrak_stations.txt 의 ISS(epoch 2026-07-24)와 같은 값
  const ISS_1 = "1 25544U 98067A   26205.47558714  .00010646  00000+0  20005-3 0  9992";
  const ISS_2 = "2 25544  51.6316 115.5643 0006921 332.7863  27.2762 15.49141208577537";
  const rec = ctx.satellite.twoline2satrec(ISS_1, ISS_2);
  const f = ctx.computeGroundTrack(rec);
  const segs = f.geometry.coordinates;
  const pts = segs.flat();
  check("MultiLineString 으로 돌려준다", f.geometry.type, "MultiLineString");
  check("1주기(약 93분)를 1분 간격 → 점이 90개 이상", pts.length >= 90, true);
  check("ISS 궤도 경사(51.6°) 밖으로는 안 간다",
    pts.every(([, lat]) => Math.abs(lat) <= 53), true);
  check("경도는 항상 -180~180", pts.every(([lng]) => lng >= -180 && lng <= 180), true);
  check("날짜변경선에서 끊어 세그먼트가 2개 이상", segs.length >= 2, true);
  const jump = segs.some((s) => s.some((p, i) => i > 0 && Math.abs(p[0] - s[i - 1][0]) > 180));
  check("한 세그먼트 안에서 180° 이상 건너뛰는 구간이 없다(가짜 선 방지)", jump, false);
  check("길이 1인 세그먼트는 버린다(선이 안 그려진다)",
    segs.every((s) => s.length > 1), true);

  const bad = ctx.computeGroundTrack({ no: 0 });   // 평균운동이 이상한 TLE
  check("이상한 rec 이어도 죽지 않는다", bad.geometry.type, "MultiLineString");
}

// ── 통과 예측 (P6-2) — 실제 SGP4 ──────────────────────────────────────────────
{
  const { ctx } = loadApp({ realSatellite: true });
  group("통과 예측 (실제 SGP4)");
  const rec = () => ctx.satellite.twoline2satrec(
    "1 25544U 98067A   26205.47558714  .00010646  00000+0  20005-3 0  9992",
    "2 25544  51.6316 115.5643 0006921 332.7863  27.2762 15.49141208577537");

  const seoul = ctx.computePasses(rec(), { lat: 37.5665, lng: 126.978 });
  check("서울에서 24시간 안에 통과가 있다", seoul.length > 0, true);
  // ISS 는 하루 약 15.5바퀴 도는데 관측지 상공을 스치는 건 그중 일부 → 보통 4~8회.
  // 넉넉히 2~12 로 두되, 계산이 크게 어긋나면(예: 좌표계 혼동) 이 범위를 벗어난다.
  check("통과 횟수가 LEO 답다(2~12회)", seoul.length >= 2 && seoul.length <= 12, true);
  // 연속한 두 통과 사이는 궤도 주기(약 93분)의 정수배에 가깝다
  const periodMin = (2 * Math.PI) / rec().no;
  const gapsOk = seoul.slice(1).every((p, i) => {
    const gapMin = (p.start - seoul[i].end) / 60000;
    const k = Math.round(gapMin / periodMin);
    return k >= 1 && Math.abs(gapMin - k * periodMin) < periodMin * 0.5;
  });
  check(`통과 간격이 궤도 주기(${periodMin.toFixed(1)}분)의 배수 근처`, gapsOk, true);
  check("모든 통과가 최소고도(10°) 이상", seoul.every((p) => p.maxEl >= 10), true);
  check("최대고도는 90°를 넘지 않는다", seoul.every((p) => p.maxEl <= 90), true);
  check("방위는 0~360 범위", seoul.every((p) =>
    p.startAz >= 0 && p.startAz <= 360 && p.endAz >= 0 && p.endAz <= 360), true);
  check("시작 <= 끝", seoul.every((p) => p.start <= p.end), true);
  check("통과들은 시간순이며 겹치지 않는다",
    seoul.every((p, i) => i === 0 || p.start > seoul[i - 1].end), true);
  check("지속시간이 LEO 답다(1~15분)", seoul.every((p) => {
    const min = (p.end - p.start) / 60000;
    return min >= 0 && min <= 15;
  }), true);
  check("24시간 창을 벗어나지 않는다",
    seoul.every((p) => p.end <= Date.now() + 24 * 3600 * 1000 + 1000), true);

  // 궤도 경사 51.6° 위성은 극지방 상공에 오지 않는다 → 물리적으로 통과가 없어야 한다
  const pole = ctx.computePasses(rec(), { lat: -82, lng: 0 });
  check("남극(-82°)에서는 ISS 통과가 없다", pole.length, 0);

  // 최소고도를 올리면 통과 수는 줄어들고, 남은 것은 그 고도를 넘는다
  const high = ctx.computePasses(rec(), { lat: 37.5665, lng: 126.978 }, 24, 30, 45);
  check("minEl 을 45°로 올리면 통과가 줄거나 같다", high.length <= seoul.length, true);
  check("남은 통과는 모두 45° 이상", high.every((p) => p.maxEl >= 45), true);

  const short = ctx.computePasses(rec(), { lat: 37.5665, lng: 126.978 }, 3);
  check("3시간 창이면 24시간보다 통과가 적거나 같다", short.length <= seoul.length, true);
}

// ── 가시 통과 (P12-1) — 실제 SGP4 + 태양 기하 ─────────────────────────────────
// 정답표가 없으므로 물리 불변식으로 잰다(P6-2 통과 예측과 같은 방식).
{
  const { ctx, date } = loadApp({ realSatellite: true });
  group("가시 통과 (P12-1)");
  const rec = () => ctx.satellite.twoline2satrec(
    "1 25544U 98067A   26205.47558714  .00010646  00000+0  20005-3 0  9992",
    "2 25544  51.6316 115.5643 0006921 332.7863  27.2762 15.49141208577537");
  const SEOUL = { lat: 37.5665, lng: 126.978 };

  // ① 태양 고도 — 정오/자정의 부호는 물리적으로 정해져 있다.
  //    (경도 127°는 UTC+8.47h → UTC 03:00 ≈ 현지 정오, UTC 15:00 ≈ 현지 자정)
  const noonUtc = date(Date.UTC(2026, 5, 21, 3, 0, 0));    // 하지 무렵 현지 정오
  const midUtc = date(Date.UTC(2026, 5, 21, 15, 0, 0));    // 현지 자정
  const elNoon = ctx.observerSunElev(SEOUL, noonUtc);
  const elMid = ctx.observerSunElev(SEOUL, midUtc);
  check("현지 정오에 태양 고도가 양수", elNoon > 0, true);
  check("현지 자정에 태양 고도가 음수", elMid < 0, true);
  check("하지 정오 서울 태양 고도가 70~80°", elNoon > 70 && elNoon < 80, true);

  // ② 북극권은 하지에 백야 — 하루 종일 태양이 지평선 위다.
  const polarDay = [0, 6, 12, 18].every((h) =>
    ctx.observerSunElev({ lat: 80, lng: 0 }, date(Date.UTC(2026, 5, 21, h))) > 0);
  check("하지의 북위 80°는 백야(24시간 태양 고도 > 0)", polarDay, true);

  // ③ 조명 판정 — 태양 쪽에 있으면 무조건 조명, 정반대 저고도는 그림자.
  const sun = ctx.sunEciUnit(date(Date.now()));
  const R = 6378.137;
  const toward = { x: sun.x * (R + 400), y: sun.y * (R + 400), z: sun.z * (R + 400) };
  const behind = { x: -sun.x * (R + 400), y: -sun.y * (R + 400), z: -sun.z * (R + 400) };
  check("태양 쪽 위성은 조명됨", ctx.isSunlit(toward, sun), true);
  check("태양 정반대 저궤도는 그림자", ctx.isSunlit(behind, sun), false);
  // 그림자 원통 밖으로 비껴 있으면(태양축 수직거리 > 지구반지름) 반대쪽이어도 조명.
  const perp = Math.abs(sun.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const d = perp.x * sun.x + perp.y * sun.y + perp.z * sun.z;
  const u = { x: perp.x - d * sun.x, y: perp.y - d * sun.y, z: perp.z - d * sun.z };
  const un = Math.hypot(u.x, u.y, u.z);
  const side = { x: -sun.x * R + u.x / un * R * 1.5,
                 y: -sun.y * R + u.y / un * R * 1.5,
                 z: -sun.z * R + u.z / un * R * 1.5 };
  check("반대쪽이라도 그림자 원통 밖이면 조명", ctx.isSunlit(side, sun), true);
  check("위치가 없으면 조명 아님", ctx.isSunlit(null, sun), false);

  // ④ 가시 통과는 전체 통과의 부분집합이어야 한다 — 뒤집히면 논리가 반대로 붙은 것이다.
  const all = ctx.computePasses(rec(), SEOUL);
  const vis = all.filter((p) => p.visible);
  check("가시 통과 <= 전체 통과", vis.length <= all.length, true);
  check("모든 가시 통과에 조명 구간 시각이 있다",
    vis.every((p) => p.visStart !== undefined && p.visEnd !== undefined), true);
  check("조명 구간은 통과 구간 안에 있다",
    vis.every((p) => p.visStart >= p.start && p.visEnd <= p.end), true);
  check("조명 최대고도 <= 통과 최대고도",
    vis.every((p) => p.visMaxEl <= p.maxEl + 1e-9), true);
  check("보이지 않는 통과에는 조명 구간이 없다",
    all.filter((p) => !p.visible).every((p) => p.visStart === undefined), true);

  // ⑤ **배선을 직접 잰다.** 위의 "부분집합" 류는 어두움 조건을 통째로 떼어내도 참이라
  //    아무것도 검증하지 못했다(2026-09-11 변이 실험에서 실제로 안 잡혔다).
  //    가시로 판정된 순간에는 관측지가 반드시 기준보다 어두워야 한다.
  check("가시 순간에는 관측지가 어둡다(태양고도 < −6°)",
    vis.every((p) => ctx.observerSunElev(SEOUL, date(p.visStart)) < -6), true);
  check("가시 순간에는 위성이 조명돼 있다", vis.every((p) => {
    const pv = ctx.satellite.propagate(rec(), date(p.visStart));
    return pv && pv.position && ctx.isSunlit(pv.position, ctx.sunEciUnit(date(p.visStart)));
  }), true);
  // 낮 통과가 가시로 새지 않는가 — 반대 방향의 단언.
  check("보이지 않는다고 표시된 통과 중 '어둡고 조명된' 순간이 있는 것은 없다",
    all.filter((p) => !p.visible).every((p) => {
      for (let t = p.start; t <= p.end; t += 30000) {
        const d = date(t);
        if (ctx.observerSunElev(SEOUL, d) >= -6) continue;
        const pv = ctx.satellite.propagate(rec(), d);
        if (pv && pv.position && ctx.isSunlit(pv.position, ctx.sunEciUnit(d))) return false;
      }
      return true;
    }), true);

  // ⑥ **어두움 조건이 실제로 쓰이는가** — 위의 ISS 단언들만으로는 부족했다.
  //    2026-09-11 변이 실험: `sky.dark &&` 를 통째로 지워도 ISS 결과가 그대로였다.
  //    이 시간창의 ISS 통과 중 "낮인데 위성은 조명된" 경우가 없어 **데이터가 그 자리를
  //    덮지 못했기** 때문이다. 정지궤도 위성은 24시간 내내 지평선 위에 있고 늘 조명되므로
  //    그 자리를 확정적으로 만든다 — 어두움 조건이 없으면 낮에도 '보인다'가 된다.
  //    (실제로 GEO 위성이 눈에 보이느냐는 밝기 문제로 별개다. 여기서 재는 건 배선이다.)
  // 서울에서 고도 약 47°에 늘 떠 있는 진짜 정지궤도 위성(경사각 0.03°, Celestrak geo 그룹).
  // 경사각이 큰 위성을 고르면 지평선 아래로 내려가 이 테스트가 무의미해진다.
  const geo = ctx.satellite.twoline2satrec(
    "1 43432U 18037A   26206.54211402 -.00000339  00000+0  00000+0 0  9994",
    "2 43432   0.0313  98.4352 0000953 142.8422  25.1979  1.00273212 30347");
  const geoPasses = ctx.computePasses(geo, SEOUL);
  const geoVis = geoPasses.filter((p) => p.visible);
  check("정지궤도는 24시간 내내 한 통과로 잡힌다", geoPasses.length >= 1, true);
  check("정지궤도 가시 구간의 시작은 어두울 때다(어두움 조건이 실제로 쓰인다)",
    geoVis.length > 0 && geoVis.every((p) =>
      ctx.observerSunElev(SEOUL, date(p.visStart)) < -6), true);
  check("정지궤도 가시 구간은 통과 전체보다 짧다(낮 시간이 빠진다)",
    geoVis.every((p) => (p.visEnd - p.visStart) < (p.end - p.start)), true);

  // ⑦ 태양표를 넘겨도 안 넘겨도 결과가 같아야 한다(P12-2 가 표를 공유한다).
  const start = Date.now(), end = start + 24 * 3600 * 1000;
  const table = ctx.sunTable(SEOUL, start, end, 30000);
  check("태양표 길이가 시간창/간격과 맞는다", table.length, Math.floor(24 * 3600 * 1000 / 30000) + 1);
  check("태양표에 dark 플래그가 둘 다 나온다(하루니까)",
    table.some((e) => e.dark) && table.some((e) => !e.dark), true);
}

done();
