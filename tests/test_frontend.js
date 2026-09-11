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

  map.fire("error", { sourceId: "darkbase" });
  map.fire("error", { sourceId: "darkbase" });
  check("타일 실패 2회까지는 뜨지 않는다(한두 개 실패는 흔하다)", shown(), false);
  map.fire("error", { sourceId: "darkbase" });
  check("연속 3회에서 표시", shown(), true);
  check("문구에 오프라인 안내", el("offline-badge").textContent.includes("오프라인"), true);

  map.fire("data", { dataType: "source", sourceId: "darkbase", tile: { state: "loaded" } });
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
  // ⚠ 여기서 "세그먼트가 2개 이상"을 단언했었는데 **전제가 틀렸다**(2026-09-11).
  // 1주기가 반드시 날짜변경선을 넘는 것이 아니다 — 실측으로 경도가 156.4° → -177.9° 로
  // 연속 감소만 하는 구간이 있었고, 그래서 **시각에 따라 통과/실패가 갈렸다.**
  // 분할 규칙 자체는 아래 splitAtDateline 블록에서 합성 입력으로 결정론적으로 잰다.
  check("세그먼트가 최소 1개는 나온다", segs.length >= 1, true);
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
  // ⚠ 여기 있던 "가시 구간은 통과 전체보다 짧다"는 **시각 의존이라 저녁에 실패했다**
  //   (2026-09-11 저녁 실측). 가시 구간은 [visStart, visEnd] **하나**라 중간의 낮을
  //   표현하지 못한다 — 창의 시작과 끝이 모두 밤이면 구간이 창 전체와 같아진다.
  //   주장 자체가 틀렸던 자리다. 태양표를 주입해 **시각과 무관하게** 배선만 잰다.
  const win = { s: Date.now(), h: 24 * 3600 * 1000 };
  const geoTable = ctx.sunTable(SEOUL, win.s, win.s + win.h, 30000);
  const bright = geoTable.map((e) => ({ unit: e.unit, dark: false }));
  const dark = geoTable.map((e) => ({ unit: e.unit, dark: true }));
  check("관측자가 내내 밝으면 가시 통과가 하나도 없다",
    ctx.computePasses(geo, SEOUL, 24, 30, 10, bright).some((p) => p.visible), false);
  check("관측자가 내내 어두우면 정지궤도는 가시다(조명 판정은 통과)",
    ctx.computePasses(geo, SEOUL, 24, 30, 10, dark).every((p) => p.visible), true);

  // ⑦ 태양표를 넘겨도 안 넘겨도 결과가 같아야 한다(P12-2 가 표를 공유한다).
  const start = Date.now(), end = start + 24 * 3600 * 1000;
  const table = ctx.sunTable(SEOUL, start, end, 30000);
  check("태양표 길이가 시간창/간격과 맞는다", table.length, Math.floor(24 * 3600 * 1000 / 30000) + 1);
  check("태양표에 dark 플래그가 둘 다 나온다(하루니까)",
    table.some((e) => e.dark) && table.some((e) => !e.dark), true);
}

// ── 위성 메타데이터 SATCAT (P12-5) ────────────────────────────────────────────
// 메타는 **늦게·따로** 오고, 아예 안 올 수도 있다. 그때 화면이 거짓을 말하거나
// 죽지 않는지가 핵심이다(위성 표시는 메타와 무관해야 한다).
{
  const { ctx, state } = loadApp();
  group("위성 메타데이터 (P12-5)");

  state.satcat = {
    "25544": { norad_id: 25544, name: "ISS (ZARYA)", type: "위성체",
               owner: "국제우주정거장(공동)", status: "운용 중",
               launch_date: "1998-11-20", launch_site: "바이코누르(카자흐)",
               intl_code: "1998-067A", size: "큼", decay_date: null },
    "90001": { norad_id: 90001, name: "COSMOS 1408 DEB", type: "잔해",
               owner: "러시아/구소련", status: "궤도 이탈(재진입)",
               launch_date: "1982-09-16", launch_site: null,
               intl_code: null, size: "작음", decay_date: "2024-03-02" },
    "90004": { norad_id: 90004, name: "MINIMAL", type: null, owner: null,
               status: null, launch_date: null, launch_site: null,
               intl_code: null, size: null, decay_date: null },
  };

  check("satMeta — 숫자로 넘겨도 찾는다(키는 문자열)", ctx.satMeta(25544).type, "위성체");
  check("satMeta — 문자열로도 찾는다", ctx.satMeta("25544").owner, "국제우주정거장(공동)");
  check("satMeta — 없는 NORAD 는 null", ctx.satMeta(99999), null);

  const iss = ctx.satMetaHtml(25544);
  check("메타 HTML 에 발사장이 들어간다", iss.includes("바이코누르"), true);
  check("메타 HTML 에 재진입 행이 없다(값이 null)", iss.includes("재진입"), false);

  const deb = ctx.satMetaHtml(90001);
  check("재진입 물체는 재진입 행이 있다", deb.includes("2024-03-02"), true);
  check("값이 null 인 발사장 행은 아예 안 그린다", deb.includes("발사장"), false);

  // 메타가 전부 비어 있으면 빈 표를 그리지 말고 아예 아무것도 내지 않아야 한다 —
  // 빈 테두리만 남으면 "불러오는 중"처럼 보인다.
  check("전 필드가 null 이면 빈 문자열", ctx.satMetaHtml(90004), "");
  check("메타가 없으면 빈 문자열", ctx.satMetaHtml(99999), "");

  check("배지 — 위성체는 '위성'", ctx.satBadgeHtml(25544).includes("위성"), true);
  check("배지 — 재진입이 타입보다 우선", ctx.satBadgeHtml(90001).includes("재진입"), true);
  check("배지 — 메타 없으면 기본 '위성'", ctx.satBadgeHtml(99999).includes("위성"), true);

  // 이스케이프 — 메타는 외부 API 문자열이다(프로젝트 규칙 2번).
  state.satcat["90005"] = { type: "<img src=x onerror=alert(1)>", owner: null, status: null,
                            launch_date: null, launch_site: null, intl_code: null,
                            size: null, decay_date: null };
  check("메타 문자열도 이스케이프된다",
    ctx.satMetaHtml(90005).includes("&lt;img"), true);
  check("배지의 타입도 이스케이프된다",
    ctx.satBadgeHtml(90005).includes("<img src=x"), false);

  // 메타가 통째로 없는 상태(로드 실패)에서도 죽지 않아야 한다.
  state.satcat = {};
  check("satcat 이 비어도 satMeta 는 null", ctx.satMeta(25544), null);
  check("satcat 이 비어도 HTML 은 빈 문자열", ctx.satMetaHtml(25544), "");
  state.satcat = null;
  check("satcat 이 null 이어도 죽지 않는다", ctx.satMeta(25544), null);
}

// ── 종류·소유국 필터 (P12-5b) ──────────────────────────────────────────────────
// 실측 근거: visual 159개 중 위성체 66 · 로켓 몸체 92 · 잔해 1.
// 이 필터가 조용히 틀리면 "위성이 왜 사라졌지"가 되므로 경계를 촘촘히 잰다.
{
  const { ctx, state } = loadApp();
  group("종류·소유국 필터 (P12-5b)");

  state.satrecs = [
    { name: "PAY-US", norad: 1, band: "leo" },
    { name: "PAY-CN", norad: 2, band: "leo" },
    { name: "RB-RU", norad: 3, band: "leo" },
    { name: "DEB-RU", norad: 4, band: "leo" },
    { name: "META-없음", norad: 5, band: "leo" },
    { name: "MEO-PAY", norad: 6, band: "meo" },
  ];
  const meta = (type, owner) => ({ type, owner, status: null, launch_date: null,
    launch_site: null, intl_code: null, size: null, decay_date: null });
  state.satcat = {
    "1": meta("위성체", "미국"),
    "2": meta("위성체", "중국"),
    "3": meta("로켓 몸체", "러시아/구소련"),
    "4": meta("잔해", "러시아/구소련"),
    "6": meta("위성체", "미국"),
    // norad 5 는 일부러 없다 — 메타가 안 온 위성
  };
  state.satBands = { leo: true, meo: true, geo: true };
  state.satTypesOff = {};
  state.satOwnersOff = {};
  state.favSats = new Set();

  const names = () => ctx.visibleSats().map((s) => s.name).sort();

  check("기본은 전부 보인다", ctx.visibleSats().length, 6);

  // 종류 필터
  state.satTypesOff = { "로켓 몸체": true };
  check("로켓 몸체를 끄면 사라진다", names().includes("RB-RU"), false);
  check("끈 것 외에는 남는다", ctx.visibleSats().length, 5);
  state.satTypesOff = { "로켓 몸체": true, "잔해": true };
  check("잔해까지 끄면 위성체만 남는다", names().join(","), "MEO-PAY,META-없음,PAY-CN,PAY-US");

  // **메타가 없는 위성은 숨기지 않는다** — 이게 깨지면 SATCAT 이 늦게 올 때
  // 위성이 사라졌다 나타난다.
  check("메타 없는 위성은 종류 필터로 숨기지 않는다", names().includes("META-없음"), true);

  // 소유국 필터
  state.satTypesOff = {};
  state.satOwnersOff = { "미국": true };
  check("미국을 끄면 미국 것만 사라진다", names().join(","), "DEB-RU,META-없음,PAY-CN,RB-RU");
  state.satOwnersOff = {};

  // 대역 필터와 함께 걸린다(AND)
  state.satBands = { leo: true, meo: false, geo: true };
  state.satTypesOff = { "잔해": true };
  check("대역과 종류가 함께 걸린다(MEO 위성체도 빠진다)",
    names().join(","), "META-없음,PAY-CN,PAY-US,RB-RU");

  // 관심 위성은 어떤 필터도 넘어선다 — 골라 뒀는데 지도에 없으면 고장으로 보인다.
  state.favSats = new Set(["4"]);   // Set 이고 키는 문자열이다
  check("관심 위성은 종류 필터를 넘어선다", names().includes("DEB-RU"), true);
  state.favSats = new Set(["6"]);
  check("관심 위성은 대역 필터도 넘어선다", names().includes("MEO-PAY"), true);
  state.favSats = new Set();
  state.satBands = { leo: true, meo: true, geo: true };
  state.satTypesOff = {};

  // 분포 집계 — 필터 UI 를 만드는 재료다
  const types = ctx.satFacet("type");
  check("종류 분포가 많은 순", types.map((t) => `${t.value}:${t.count}`).join(","),
    "위성체:3,로켓 몸체:1,잔해:1");
  const owners = ctx.satFacet("owner");
  // 동수(미국 2 · 러시아 2)는 한국어 정렬 — '러'가 '미'보다 앞이다.
  check("소유국 분포가 많은 순", owners.map((t) => `${t.value}:${t.count}`).join(","),
    "러시아/구소련:2,미국:2,중국:1");
  check("메타 없는 위성은 분포에 세지 않는다",
    types.reduce((a, t) => a + t.count, 0), 5);

  // 같은 개수면 이름순 — 순서가 매번 바뀌면 체크박스가 튄다
  check("동수는 이름순(러시아 < 미국)",
    owners.filter((o) => o.count === 2).map((o) => o.value).join(","), "러시아/구소련,미국");

  // 메타가 통째로 없을 때
  state.satcat = {};
  check("메타가 없으면 분포는 빈 배열", ctx.satFacet("type").length, 0);
  check("메타가 없어도 위성은 전부 보인다", ctx.visibleSats().length, 6);
  state.satTypesOff = { "위성체": true };
  check("메타가 없으면 종류 필터는 아무것도 못 숨긴다", ctx.visibleSats().length, 6);
}

// ── 날짜변경선 분할 규칙 (순수 함수) ──────────────────────────────────────────
// 실제 SGP4 결과에 기대면 시각에 따라 결과가 달라진다(위 ⚠ 참조). 합성 입력으로 잰다.
{
  const { ctx } = loadApp();
  group("날짜변경선 분할 (splitAtDateline)");
  const S = (pts) => ctx.splitAtDateline(pts);

  check("넘지 않으면 한 덩어리", S([[10,0],[20,0],[30,0]]).length, 1);
  check("+179 → -179 는 끊는다", S([[178,0],[179,0],[-179,0],[-178,0]]).length, 2);
  check("끊긴 두 덩어리의 점 수", S([[178,0],[179,0],[-179,0],[-178,0]]).map((x)=>x.length).join(","), "2,2");
  check("두 번 넘으면 세 덩어리",
    S([[170,0],[179,0],[-179,0],[-170,0],[-179,0],[179,0],[170,0]]).length, 3);

  // 경계: 정확히 180° 차이는 끊지 않는다(> 180 이어야 한다). 부등호가 >= 로 바뀌면
  // -90 → 90 같은 정상 이동까지 끊겨 선이 조각난다.
  check("정확히 180° 차이는 끊지 않는다", S([[-90,0],[90,0]]).length, 1);
  // 1점짜리 덩어리는 버려지므로 앞뒤에 점을 하나씩 더 둔다 — 안 그러면 0 이 나온다.
  check("180.1° 차이는 끊는다", S([[-91,0],[-90,0],[90.1,0],[91,0]]).length, 2);
  check("180.0° 차이는 안 끊는다(같은 입력 모양으로 비교)",
    S([[-91,0],[-90,0],[90,0],[91,0]]).length, 1);

  // 점이 1개뿐인 덩어리는 버린다 — 선이 안 그려지는데 빈 배열이 지도로 넘어간다.
  check("끊긴 뒤 점이 1개면 버린다", S([[178,0],[179,0],[-179,0]]).map((x)=>x.length).join(","), "2");
  check("점이 1개면 빈 배열", S([[0,0]]).length, 0);
  check("빈 입력은 빈 배열", S([]).length, 0);

  // 막지 않았으면 무엇이 일어났을 것인가 — 끊지 않으면 지구를 가로지르는 가짜 선이 된다.
  const notSplit = S([[178,0],[179,0],[-179,0],[-178,0]]).flat();
  check("한 세그먼트 안에 180° 넘는 도약이 없다",
    S([[178,0],[179,0],[-179,0],[-178,0]]).every((seg) =>
      seg.every((p, i) => i === 0 || Math.abs(p[0] - seg[i-1][0]) <= 180)), true);
}

// ── 발사 임박 집중 화면 (P12-3) ───────────────────────────────────────────────
// 조용히 깨지는 자리는 "고르는 규칙"이다 — 화면엔 카드가 하나 떠 있을 뿐이라
// 잘못된 발사를 고르거나, 초 단위가 아닌 net 에 초 단위 카운트다운을 붙여도 눈엔 똑같다.
{
  const { ctx, state, el } = loadApp();
  group("집중 화면 대상 선정 (pickFocusLaunch)");
  const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
  const at = (mins) => new Date(NOW + mins * 60000).toISOString();
  const L = (id, mins, extra = {}) => Object.assign(
    { id, name: id, net: at(mins), outcome: "upcoming", net_precision: "Minute" }, extra);
  const pick = (list, dismissed) => ctx.pickFocusLaunch(list, NOW, dismissed || new Set());

  check("T-30분은 뜬다", (pick([L("a", 30)]) || {}).id, "a");
  check("T-61분은 아직 안 뜬다", pick([L("a", 61)]), null);
  check("T-59분은 뜬다", (pick([L("a", 59)]) || {}).id, "a");
  check("T+29분은 남아 있다", (pick([L("a", -29)]) || {}).id, "a");
  check("T+31분은 사라진다", pick([L("a", -31)]), null);
  check("둘 중 임박한 쪽", (pick([L("late", 40), L("soon", 5)]) || {}).id, "soon");
  check("아직 안 온 것이 방금 발사한 것보다 우선",
    (pick([L("flown", -10), L("next", 50)]) || {}).id, "next");
  check("방금 발사한 것만 있으면 가장 최근",
    (pick([L("older", -25), L("newer", -3)]) || {}).id, "newer");
  check("결과가 확정된 발사는 대상이 아니다",
    pick([L("a", -10, { outcome: "success" })]), null);
  check("net 이 없으면 제외", pick([L("a", 10, { net: null })]), null);
  check("net 이 깨진 문자열이면 제외", pick([L("a", 10, { net: "언젠가" })]), null);
  check("닫은 발사는 건너뛰고 다음 후보로",
    (pick([L("a", 5), L("b", 20)], new Set(["a"])) || {}).id, "b");
  check("목록이 비어도 죽지 않는다", [pick([]), pick(null)], [null, null]);

  // ── net_precision — 여기가 이 기능의 진짜 주장이다 ──
  // "막지 않았으면 무엇이 일어났을 것인가": 같은 발사를 Minute 으로 바꾸면 반드시 선택된다.
  // 그 대조가 없으면 정밀도 규칙을 통째로 지워도 위 단언들이 전부 통과한다.
  check("Hour 정밀도는 초 단위 카운트다운을 띄우지 않는다",
    pick([L("h", 20, { net_precision: "Hour" })]), null);
  check("같은 발사가 Minute 이면 뜬다(규칙이 지워졌는지 가르는 대조)",
    (pick([L("h", 20, { net_precision: "Minute" })]) || {}).id, "h");
  check("Day/Month/Year/Quarter 4 전부 제외",
    ["Day", "Month", "Year", "Quarter 4", "Year Half 2"].map((p) =>
      pick([L("x", 20, { net_precision: p })])), [null, null, null, null, null]);
  check("net_precision 이 아예 없으면 제외(모르면 안 띄운다)",
    pick([L("a", 20, { net_precision: undefined })]), null);
  check("Second 는 뜬다", (pick([L("a", 20, { net_precision: "Second" })]) || {}).id, "a");

  // ── 화면 배선 — 고르는 규칙이 맞아도 카드가 안 뜨면 소용없다 ──
  // updateFocus 는 **실제 Date.now()** 를 본다 — 위의 고정 NOW 로 만든 net 을 넘기면
  // 실행 시각에 따라 결과가 달라진다(시각 의존 테스트, ⑤번에서 겪은 flaky 와 같은 모양).
  group("집중 화면 표시 (updateFocus)");
  const R = (id, mins, extra = {}) => Object.assign(
    { id, name: id, net: new Date(Date.now() + mins * 60000).toISOString(),
      outcome: "upcoming", net_precision: "Minute" }, extra);
  state.allLaunches = [R("live", 12, { rocket: "Falcon 9", location_name: "Cape" })];
  ctx.updateFocus();
  check("임박 발사가 있으면 카드가 보인다", el("focus").hidden, false);
  check("카드에 발사명이 들어간다", el("focus").innerHTML.includes("live"), true);
  check("큰 카운트다운이 T- 로 시작", el("focus").innerHTML.includes("T-"), true);
  state.allLaunches = [R("far", 300)];
  state.focusShownId = null;
  ctx.updateFocus();
  check("임박 발사가 없어지면 카드가 숨는다", el("focus").hidden, true);

  // 닫기: 그 발사는 다시 안 뜨고, 다음 후보가 있으면 이어서 뜬다
  state.allLaunches = [R("a", 5), R("b", 20)];
  ctx.updateFocus();
  check("닫기 전 대상", state.focusShownId, "a");
  el("focus-close").fire("click");
  check("닫으면 다음 후보로 이어진다", state.focusShownId, "b");
  check("닫은 뒤에도 카드는 보인다(다음 후보가 있으므로)", el("focus").hidden, false);
  el("focus-close").fire("click");
  check("둘 다 닫으면 숨는다", el("focus").hidden, true);
  ctx.updateFocus();
  check("닫은 발사는 다시 뜨지 않는다", el("focus").hidden, true);

  // XSS — 발사명은 API 문자열이다(전역 규칙: DOM 에 넣기 전 이스케이프)
  state.focusDismissed = new Set();
  state.focusShownId = null;
  state.allLaunches = [R("x", 10, { name: `<img src=x onerror="alert(1)">` })];
  ctx.updateFocus();
  check("발사명이 이스케이프된다", el("focus").innerHTML.includes("<img"), false);
}

// ── net_precision 경고 문구 ───────────────────────────────────────────────────
{
  const { ctx } = loadApp();
  group("net_precision 경고 (netPrecisionNote)");
  check("Second/Minute 은 알리지 않는다",
    [ctx.netPrecisionNote("Second"), ctx.netPrecisionNote("Minute")], [null, null]);
  check("Hour", ctx.netPrecisionNote("Hour"), "시각이 시간 단위까지만 확정");
  // LL2 가 실제로 보내는 값 — 표에 정확히 일치하는 키가 없어 조용히 넘어가던 자리
  check("Quarter 4 (LL2 실제 값)", ctx.netPrecisionNote("Quarter 4"), "분기 단위로만 확정");
  check("Year Half 2 (LL2 실제 값)", ctx.netPrecisionNote("Year Half 2"), "반기 단위로만 확정");
  check("Year 보다 Year Half 를 먼저 본다",
    ctx.netPrecisionNote("Year") !== ctx.netPrecisionNote("Year Half 2"), true);
  check("모르는 값도 알린다", ctx.netPrecisionNote("Decade"), "Decade 단위로만 확정");
  check("값이 없으면 null", ctx.netPrecisionNote(null), null);
}

// ── 통계의 모수 (P12-7) ───────────────────────────────────────────────────────
// 조용한 거짓말의 전형: 라이브 데이터는 `previous` 50건뿐이라 **올해 앞부분이 통째로 없는데**
// "연도별 2026: 98" 막대는 올해 발사가 98건이었다고 읽힌다.
{
  const { ctx } = loadApp();
  group("통계 모수 (statsScope)");
  const D = (iso, id) => ({ id, net: iso, outcome: "success" });
  const list = [D("2025-03-01T00:00:00Z", 1), D("2025-11-01T00:00:00Z", 2),
                D("2026-07-14T00:00:00Z", 3), D("2026-09-11T00:00:00Z", 4)];

  const sc = ctx.statsScope(list, new Set([2025]), 2026);
  check("불러온 연도는 완전으로 센다", sc.full, [2025]);
  check("안 불러온 연도는 부분으로 센다", sc.partial, [2026]);
  check("총 건수", sc.total, 4);
  check("기간의 시작·끝", [new Date(sc.from).getUTCFullYear(), new Date(sc.to).getUTCMonth()], [2025, 8]);

  // 막지 않았으면 무엇이 일어났을 것인가 — 아카이브를 하나도 안 불러오면 **전부 부분**이다.
  // 이 대조가 없으면 판정을 "항상 완전"으로 바꿔도 위 단언이 통과할 수 있다.
  const none = ctx.statsScope(list, new Set(), 2026);
  check("아무것도 안 불러왔으면 전부 부분", [none.full, none.partial], [[], [2025, 2026]]);
  const both = ctx.statsScope(list, new Set([2025, 2026]), 2026);
  check("둘 다 불러왔으면 부분이 없다", [both.full, both.partial], [[2025, 2026], []]);

  check("net 이 없는 발사는 연도에 안 들어간다(총계에는 남는다)",
    (() => { const r = ctx.statsScope(list.concat([{ id: 9 }]), new Set(), 2026);
             return [r.total, r.partial]; })(), [5, [2025, 2026]]);
  check("깨진 net 도 연도에 안 들어간다",
    ctx.statsScope([D("언젠가", 1)], new Set(), 2026).partial, []);
  check("빈 목록", [ctx.statsScope([], new Set(), 2026).total,
                    ctx.statsScope(null, new Set(), 2026).partial], [0, []]);

  group("모수 안내 문구 (scopeNoteHtml)");
  const html = ctx.scopeNoteHtml(sc);
  check("부분 연도를 이름으로 알린다", html.includes("2026년은"), true);
  check("불러온 연도도 알린다", html.includes("2025"), true);
  check("부분이 없으면 경고를 띄우지 않는다", ctx.scopeNoteHtml(both).includes("일부만"), false);
  check("연도별 막대 라벨에 (일부) 표시",
    ctx.yearEntries([["2025", 2], ["2026", 2]], sc), [["2025", 2], ["2026 (일부)", 2]]);
  check("완전한 해에는 표시하지 않는다",
    ctx.yearEntries([["2025", 2]], both), [["2025", 2]]);

  // P12-6 × P12-7: **잘린 해를 완전으로 세면 경고가 거꾸로 거짓말이 된다.**
  group("잘린 아카이브 연도 (completeYears)");
  const { ctx: c2, state: s2 } = loadApp();
  s2.loadedYears = new Set([2024, 2025]);
  s2.truncatedYears = new Set();
  check("잘린 해가 없으면 불러온 해가 전부 완전", [...c2.completeYears()].sort(), [2024, 2025]);
  s2.truncatedYears = new Set([2024]);
  check("상한에 걸린 해는 완전에서 빠진다", [...c2.completeYears()], [2025]);
  check("그래서 통계에서 부분으로 잡힌다",
    c2.statsScope([{ id: 1, net: "2024-05-01T00:00:00Z" }], c2.completeYears(), 2026).partial,
    [2024]);
  check("불러오지도 않은 해는 애초에 완전이 아니다",
    c2.statsScope([{ id: 1, net: "2023-05-01T00:00:00Z" }], c2.completeYears(), 2026).full, []);
}

// ── 키보드 단축키 (P12-14) ────────────────────────────────────────────────────
{
  const { ctx } = loadApp();
  group("단축키 판정 (keyAction)");
  const K = (key, extra = {}) => ctx.keyAction(Object.assign({ key, target: { tagName: "BODY" } }, extra));

  check("/ 는 검색", K("/"), "search");
  check("Esc 는 닫기", K("Escape"), "escape");
  check("s 는 사이드바", K("s"), "sidebar");
  check("대문자 S 도 같다(Shift 를 눌러도 동작한다)", K("S"), "sidebar");
  check("r 는 새로고침", K("r"), "refresh");
  check("? 는 도움말", K("?"), "help");
  check("숫자키는 토글", [K("1"), K("5"), K("6")], ["toggle:1", "toggle:5", "toggle:6"]);
  check("정의되지 않은 키는 무시", [K("7"), K("z"), K("F5")], [null, null, null]);

  // **입력 중에는 단축키가 없어야 한다.** 검색창에 "s" 를 치면 사이드바가 열리는 앱은
  // 검색을 쓸 수 없는데, 화면으로는 "글자가 안 써진다"로만 보인다.
  const typing = { target: { tagName: "INPUT" } };
  check("입력 중 s 는 글자다", K("s", typing), null);
  check("입력 중 / 도 글자다", K("/", typing), null);
  check("입력 중 숫자도 글자다", K("3", typing), null);
  check("입력 중 Esc 만 빠져나오기", K("Escape", typing), "blur");
  check("textarea·select 도 같다",
    [K("s", { target: { tagName: "TEXTAREA" } }), K("s", { target: { tagName: "SELECT" } })], [null, null]);

  // 조합키는 브라우저·시스템 몫이다 — 뺏으면 Ctrl+R 같은 것이 죽는다.
  check("Ctrl/Alt/Meta 조합은 비켜난다",
    [K("r", { ctrlKey: true }), K("s", { altKey: true }), K("1", { metaKey: true })], [null, null, null]);

  group("Esc 우선순위 (escapeTarget)");
  const E = (o) => ctx.escapeTarget(o);
  check("아무것도 안 열렸으면 null", E({}), null);
  check("사이드바만", E({ sidebar: true }), "sidebar");
  check("상세가 사이드바보다 먼저", E({ sidebar: true, panel: true }), "panel");
  check("도움말이 가장 먼저", E({ help: true, panel: true, stats: true }), "help");
  check("통과 패널이 통계보다 먼저", E({ pass: true, stats: true }), "pass");
  check("위성 컨트롤이 사이드바보다 먼저", E({ satCtrl: true, sidebar: true }), "satCtrl");

  group("단축키 실행 (handleKey)");
  {
    const { ctx, el, sel, state, map } = loadApp();
    state.map = map;
    map.stubSource("launches");
    const press = (key, extra = {}) =>
      ctx.handleKey(Object.assign({ key, target: { tagName: "BODY" }, preventDefault() {} }, extra));

    // 숫자키 토글 — 체크박스를 바꾸고 원래의 change 경로를 탄다
    const flt = { value: "success", checked: true };
    sel['.flt[value="success"]'] = [flt];
    sel[".flt"] = [flt];
    state.allLaunches = [];
    press("2");
    check("2 는 성공 필터를 끈다", flt.checked, false);
    press("2");
    check("한 번 더 누르면 되돌아온다", flt.checked, true);

    // 레이어 토글은 체크박스의 change 핸들러를 그대로 타야 한다(설정 저장이 거기 있다)
    let changed = 0;
    el("toggle-terminator").addEventListener("change", () => changed++);
    press("6");
    check("6 은 낮/밤 체크박스를 뒤집는다", el("toggle-terminator").checked, true);
    check("원래의 change 경로를 탄다(설정 저장이 거기 있다)", changed, 1);

    // 도움말
    press("?");
    check("? 로 도움말이 열린다", el("keyhelp").hidden, false);
    check("도움말에 키 목록이 들어간다", el("keyhelp").innerHTML.includes("Esc"), true);
    press("s");
    check("도움말이 떠 있으면 아무 키나 먼저 닫는다", el("keyhelp").hidden, true);

    // Esc — 열린 것이 없으면 아무 일도 없어야 한다(예외로 죽지 않는다)
    press("Escape");
    check("열린 것이 없어도 죽지 않는다", el("keyhelp").hidden, true);
  }

  // 배선 — 위 단언들은 handleKey 를 **직접** 부른다. 실제로 document 에 붙지 않으면
  // 로직이 다 맞아도 앱에서는 아무 키도 안 먹는데, 그걸 가르는 건 이 한 줄뿐이다.
  {
    const { ctx, el, doc } = loadApp();
    check("bindUI 전에는 keydown 핸들러가 없다", doc.has("keydown"), false);
    ctx.bindUI();
    check("bindUI 가 document 에 keydown 을 붙인다", doc.has("keydown"), true);
    doc.fire("keydown", { key: "?", target: { tagName: "BODY" }, preventDefault() {} });
    check("그 핸들러로 실제 동작한다(도움말이 열린다)", el("keyhelp").hidden, false);
  }
}

// ── 아카이브 잘림 배선 (P12-6) ────────────────────────────────────────────────
// 위의 completeYears 단언들은 truncatedYears 를 **테스트가 직접 채워** 잰다.
// 실제로 그 집합을 채우는 건 loadArchive 한 줄뿐이라, 그 줄이 빠지면 로직이 다 맞아도
// 경고가 영원히 안 뜬다(변이 실험에서 실제로 안 잡혔다 — 그래서 이 블록을 더했다).
(async () => {
  const mkApi = (truncated) => ({
    get_archive: async () => ({
      launches: [{ id: "a", name: "x", net: "2018-05-01T00:00:00Z", outcome: "success",
                   lat: 1, lng: 1 }],
      year: 2018, stale: false, error: null, truncated,
    }),
  });
  {
    const { ctx, state, map, el } = loadApp({ api: mkApi(true) });
    state.map = map; map.stubSource("launches");
    await ctx.loadArchive(2018);
    group("아카이브 잘림 배선 (loadArchive)");
    check("잘려서 왔으면 그 해를 기록한다", [...state.truncatedYears], [2018]);
    check("불러온 해로도 남는다", [...state.loadedYears], [2018]);
    check("완전한 해로 세지 않는다", [...ctx.completeYears()], []);
    check("사용자에게 잘렸다고 말한다", el("status").textContent.includes("일부만"), true);
  }
  {
    const { ctx, state, map, el } = loadApp({ api: mkApi(false) });
    state.map = map; map.stubSource("launches");
    await ctx.loadArchive(2018);
    check("끝까지 받았으면 기록하지 않는다", [...state.truncatedYears], []);
    check("그 해는 완전으로 센다", [...ctx.completeYears()], [2018]);
    check("평범한 안내만 한다", el("status").textContent.includes("일부만"), false);
  }
  done();
})();
