/* 프론트엔드 회귀 테스트 (P11-8) — 네트워크·GUI·마우스 없이 web/app.js 의 함수를 직접 부른다.
 *
 *     node tests/test_frontend.js
 *
 * 대상은 "깨져도 화면이 조용히 잘못 나오는" 로직 — 궤도 대역 분류, 필터, 설정 복원 방어,
 * 오프라인 판정, 이스케이프, 통계 집계처럼 눈으로는 틀린 걸 알아채기 어려운 것들.
 * 로딩·스텁은 harness.js 에 있다(app.js 구조가 바뀌면 그 파일만 고친다).
 */
// **실행 PC 의 시간대에 기대지 않는다.** 시간대 테스트(P13-5)는 "현지 시각과 UTC 가 다르다"를
// 재는데, CI 러너는 **UTC** 라 그 둘이 같아져 조용히 실패한다 — 2026-09-12 에 실제로 당했다
// (로컬 530 통과 / CI 526 통과·4 실패가 다섯 커밋 동안 이어졌다).
// 여기서 고정해 어느 환경에서든 UTC 와 9시간 차이가 나게 한다.
process.env.TZ = "Asia/Seoul";

const { loadApp, group, check, done , APP_FILES } = require("./harness");

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

  // ── 목록 캡 (P20-2) ────────────────────────────────────────────────────────
  // 행을 DOM 에 넣는 값이 비싸다(1,803행 56.9ms 실측). 넘치면 자르되 **몇 건이 더 있는지**를
  // 말한다. 단언은 상수 자체가 아니라 **`SIDEBAR_CAP` 을 읽어서** 한다 — 숫자를 박아 두면
  // 캡을 조정할 때 테스트가 "틀렸다"고 말하는데 실제로는 아무것도 안 깨진 것이다(P19 의 교훈).
  const CAP = state.SIDEBAR_CAP;
  const many = Array.from({ length: CAP + 37 }, (_, i) => ({
    id: "m" + i, name: "발사 " + i, outcome: "success",
    net: new Date(Date.UTC(2026, 0, 1) - i * 86400000).toISOString(),
  }));
  state.favLaunches = new Set();
  ctx.renderSidebar(many);
  const rowCount = (el("sidebar-list").innerHTML.match(/class="sb-row"/g) || []).length;
  check("캡을 넘으면 캡까지만 그린다", rowCount, CAP);
  check("건수는 전체를 말한다(자른 수가 아니다)", el("sidebar-count").textContent, CAP + 37 + "건");
  check("남은 건수를 말해 준다", el("sidebar-list").innerHTML.includes("…외 37건"), true);
  check("좁히는 방법을 알려 준다",
    /검색·필터로 좁히거나 타임라인/.test(el("sidebar-list").innerHTML), true);

  // 캡 아래면 안내가 없어야 한다 — 늘 붙으면 "더 있다"는 거짓말이 된다
  ctx.renderSidebar(many.slice(0, CAP));
  check("딱 캡이면 안내가 없다", el("sidebar-list").innerHTML.includes("…외"), false);
  check("딱 캡이면 전부 그린다",
    (el("sidebar-list").innerHTML.match(/class="sb-row"/g) || []).length, CAP);

  // **자르는 것은 정렬 뒤여야 한다** — 앞에서 자르면 예정 발사가 통째로 날아간다.
  // 예정을 캡보다 많이 섞어 두고, 잘린 목록의 첫 줄이 예정인지 본다.
  const mixed = many.slice(0, CAP).concat([
    { id: "up", name: "예정 임박", outcome: "upcoming", net: "2026-02-01T00:00:00Z" },
  ]);
  ctx.renderSidebar(mixed);
  const first = (el("sidebar-list").innerHTML.match(/sb-name">(?:★ )?([^<]+)</) || [])[1];
  check("정렬한 뒤에 자른다(예정이 잘려 나가지 않는다)", first, "예정 임박");
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

// ── 원지점·근지점 배선 (P14-3) — 실제 SGP4 ────────────────────────────────────
{
  const { ctx } = loadApp({ realSatellite: true });
  group("원지점·근지점 배선 (실제 SGP4)");
  const ISS_1 = "1 25544U 98067A   26205.47558714  .00010646  00000+0  20005-3 0  9992";
  const ISS_2 = "2 25544  51.6316 115.5643 0006921 332.7863  27.2762 15.49141208577537";
  const rec = ctx.satellite.twoline2satrec(ISS_1, ISS_2);
  // 실제 ISS 고도는 400km 대다 — **독립적으로 아는 사실**로 잰다(상수를 바꿔도 안 따라온다)
  const a = ctx.apsides(rec);
  check("실제 ISS TLE 로 고도 390~430km", [a.perigee > 390, a.apogee < 430], [true, true]);
  check("ISS 는 거의 원궤도", ctx.apsidesText(a).includes("원궤도"), true);
  // 순수 함수가 전부 맞아도 satRowsHtml 에 끼우는 줄이 없으면 앱에서는 안 보인다
  const html = ctx.satRowsHtml({ norad: 25544, name: "ISS", rec: rec });
  check("위성 상세 행에 실린다", html.includes("근지점 ~ 원지점"), true);
  check("그 줄에 km 값이 들어 있다", /\d\s*km/.test(html), true);
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
  // t 를 실어 보낸다 — 표가 시간축을 정하므로(P21-2) 실제 경로를 타게 한다
  const bright = geoTable.map((e) => ({ t: e.t, unit: e.unit, dark: false }));
  const dark = geoTable.map((e) => ({ t: e.t, unit: e.unit, dark: true }));
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
  const typing0 = { target: { tagName: "INPUT" } };

  check("/ 는 검색", K("/"), "search");
  check("Esc 는 닫기", K("Escape"), "escape");
  check("s 는 사이드바", K("s"), "sidebar");
  check("대문자 S 도 같다(Shift 를 눌러도 동작한다)", K("S"), "sidebar");
  check("r 는 새로고침", K("r"), "refresh");
  check("? 는 도움말", K("?"), "help");
  check("숫자키는 토글", [K("1"), K("5"), K("6"), K("7")],
    ["toggle:1", "toggle:5", "toggle:6", "toggle:7"]);
  check("정의되지 않은 키는 무시", [K("8"), K("z"), K("F5")], [null, null, null]);

  // P17-3 — 툴바에서 접힌 것(배경·통계)과 툴바 밖에 있는 것(그룹·아카이브).
  // 접은 버튼에 단축키가 없으면 기능이 한 단계 더 멀어지기만 한다.
  check("b·c·g·a 는 배경·통계·그룹·아카이브",
    [K("b"), K("c"), K("g"), K("a")], ["basemap", "stats", "satgroups", "archive"]);
  check("대문자도 같다", [K("B"), K("C"), K("G"), K("A")],
    ["basemap", "stats", "satgroups", "archive"]);
  check("입력 중에는 전부 글자다",
    [K("b", typing0), K("c", typing0), K("g", typing0), K("a", typing0)], [null, null, null, null]);

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
  // 툴바 팝오버(P17-1)는 툴바에 붙어 가장 위에 뜬다 — 도움말 다음으로 닫힌다
  check("툴바 팝오버가 상세·그룹보다 먼저", E({ more: true, panel: true, satGroups: true }), "more");
  check("도움말은 툴바 팝오버보다도 먼저", E({ help: true, more: true }), "help");
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

// ── 궤적 연장 · 미래 위치 (P12-16) ────────────────────────────────────────────
// 조용히 깨지는 자리: 범위 계산과 점 간격. 선은 어느 쪽이든 "그럴듯하게" 그려지므로
// 뒤쪽까지 늘어났는지, 점이 수천 개가 됐는지는 화면으로 알아채기 어렵다.
{
  const { ctx } = loadApp();
  group("궤적 범위 (trackWindow)");
  const W = (p, a) => ctx.trackWindow(p, a);
  check("기본은 ±½주기", [W(90, 0).from, W(90, 0).to], [-45, 45]);
  check("앞으로 볼 시간은 앞쪽만 늘린다", [W(90, 180).from, W(90, 180).to], [-45, 225]);
  check("뒤쪽은 절대 늘어나지 않는다",
    [0, 60, 360].every((a) => W(90, a).from === -45), true);
  check("음수나 빈 값은 0 으로 본다",
    [W(90, -10).to, W(90, null).to, W(90, undefined).to], [45, 45, 45]);

  // 점 간격 — 6시간을 1분 간격으로 그리면 점이 400개를 넘고 30초마다 다시 계산된다.
  const pts = (p, a) => { const w = W(p, a); return Math.floor((w.to - w.from) / w.stepMin) + 1; };
  check("짧은 범위는 1분 간격", W(90, 0).stepMin, 1);
  check("범위를 늘려도 점 수가 폭발하지 않는다",
    [pts(90, 0), pts(90, 360), pts(1436, 360)].every((n) => n <= 250), true);
  check("점 수가 의미 있게 남는다(선이 각지지 않는다)",
    [pts(90, 0), pts(90, 360)].every((n) => n >= 90), true);
  check("정지궤도(1436분)도 처리된다", W(1436, 0).stepMin >= 1, true);

  group("앞으로 볼 시간 라벨 (aheadLabel)");
  check("0 은 '지금'", ctx.aheadLabel(0), "지금");
  check("분", ctx.aheadLabel(45), "45분 뒤");
  check("정각 시간은 분을 안 붙인다", ctx.aheadLabel(120), "2시간 뒤");
  check("시간+분", ctx.aheadLabel(150), "2시간 30분 뒤");

  // 확대 상태에서는 그 시각 위치가 화면 밖이다 — 좌표를 같이 적어야 "아무 일도 안 일어난
  // 것처럼" 보이지 않는다(실제 화면 확인에서 나온 문제).
  check("좌표를 함께 적는다", ctx.aheadStatus(120, [-145.37, 41.4]), "2시간 뒤 · 41.4°, -145.4°");
  check("지금이면 좌표를 적지 않는다", ctx.aheadStatus(0, [1, 2]), "지금");
  check("위치를 못 구했으면 시간만", ctx.aheadStatus(60, null), "1시간 뒤");
}

{
  const { ctx } = loadApp({ realSatellite: true });
  group("미래 위치 (satPointAt) — 실제 SGP4");
  const rec = ctx.satellite.twoline2satrec(
    "1 25544U 98067A   26206.50000000  .00016717  00000+0  10270-3 0  9008",
    "2 25544  51.6400 208.9163 0006317  69.9862 290.1994 15.49309963 30347");
  const now = ctx.satPointAt(rec, 0);
  const soon = ctx.satPointAt(rec, 10);
  check("현재 위치가 유효한 좌표", now && Math.abs(now[1]) <= 90 && Math.abs(now[0]) <= 180, true);
  check("10분 뒤는 지금과 다른 곳이다(오프셋이 실제로 쓰인다)",
    now[0] !== soon[0] || now[1] !== soon[1], true);

  // ISS 는 약 92.8분에 한 바퀴 → 1주기 뒤 위도가 거의 같다(경도는 지구 자전으로 밀린다).
  // 오프셋을 분이 아니라 다른 단위로 쓰면 이 단언이 깨진다.
  const period = ctx.orbitPeriodMin(rec);
  const after = ctx.satPointAt(rec, period);
  check("주기는 ISS 답게 나온다(90~95분)", period > 90 && period < 95, true);
  check("1주기 뒤 위도가 거의 같다", Math.abs(after[1] - now[1]) < 3, true);
  check("1주기 뒤 경도는 서쪽으로 밀린다(지구가 돌았다)",
    Math.abs(((after[0] - now[0] + 540) % 360) - 180) > 5, true);

  check("궤적 점 수가 범위와 맞는다",
    ctx.computeGroundTrack(rec, 0).geometry.coordinates.flat().length >= 80, true);
  check("앞으로 볼 시간을 늘리면 궤적이 길어진다",
    ctx.computeGroundTrack(rec, 300).geometry.coordinates.flat().length >
    ctx.computeGroundTrack(rec, 0).geometry.coordinates.flat().length * 1.5, true);
  check("모든 궤적 점이 유효 좌표",
    ctx.computeGroundTrack(rec, 120).geometry.coordinates.flat()
      .every(([lng, lat]) => Math.abs(lng) <= 180 && Math.abs(lat) <= 90), true);
}

// 배선 — 위 단언들은 순수 함수를 직접 부른다. 슬라이더가 실제로 연결돼 있지 않으면
// 계산이 다 맞아도 화면에서는 아무 일도 일어나지 않는다(변이 실험에서 안 잡혔다 —
// v1.11.0 keydown · v1.12.0 loadArchive 에 이어 **세 번째**로 같은 구멍이 나왔다).
{
  const marks = { added: 0, removed: 0 };
  const maplibregl = {
    Marker: function (opts) {
      this.el = opts.element;
      this.getElement = () => this.el;
      this.setLngLat = (v) => { this.lngLat = v; return this; };
      this.addTo = () => { marks.added++; return this; };
      this.remove = () => { marks.removed++; };
    },
  };
  const { ctx, state, el, map } = loadApp({ realSatellite: true, maplibregl });
  state.map = map;
  map.stubSource("sat-track");
  ctx.bindUI();

  group("앞으로 볼 시간 배선 (슬라이더 → 궤적·마커)");
  check("bindUI 전 기본값은 지금", state.trackAheadMin, 0);
  el("sat-ahead").value = "120";
  el("sat-ahead").fire("input");
  check("슬라이더가 상태를 바꾼다", state.trackAheadMin, 120);
  check("라벨이 함께 바뀐다", el("sat-ahead-label").textContent, "2시간 뒤");
  // (아래에서 위성을 고른 뒤에는 좌표까지 붙는다 — 그 확인은 마커 단언 다음에 있다)

  // 위성을 고르면 고스트 마커가 선다 — 슬라이더가 0 이면 서지 않는다.
  const rec = ctx.satellite.twoline2satrec(
    "1 25544U 98067A   26206.50000000  .00016717  00000+0  10270-3 0  9008",
    "2 25544  51.6400 208.9163 0006317  69.9862 290.1994 15.49309963 30347");
  state.selectedSat = { name: "ISS", norad: "25544", rec };
  ctx.drawGroundTrack();
  check("앞으로 볼 시간이 있으면 고스트 마커가 선다", marks.added > 0, true);
  check("마커에 시각이 적힌다",
    state.futureMarker && state.futureMarker.getElement().textContent, "2시간 뒤");
  check("마커가 좌표를 받는다",
    state.futureMarker ? state.futureMarker.lngLat.length : null, 2);
  el("sat-ahead").fire("input");   // 위성이 선택된 상태로 다시 한 번
  check("위성이 선택돼 있으면 라벨에 좌표가 붙는다",
    /^2시간 뒤 · -?\d+\.\d°, -?\d+\.\d°$/.test(el("sat-ahead-label").textContent), true);

  el("sat-ahead").value = "0";
  el("sat-ahead").fire("input");
  check("지금으로 되돌리면 마커가 사라진다", state.futureMarker, null);
  check("실제로 remove 를 불렀다", marks.removed > 0, true);

  // 선택을 풀어도 남으면 안 된다(이전 위성의 미래 위치가 지도에 남는다)
  el("sat-ahead").value = "60";
  el("sat-ahead").fire("input");
  check("다시 켜면 다시 선다", state.futureMarker !== null, true);
  ctx.deselectSatellite();
  check("선택 해제하면 마커가 치워진다", state.futureMarker, null);
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
  {
    // 파이썬이 연도를 **거절**한 경우(P38-1). 거절을 "불러왔다"로 치면 그 해가
    // "이미 불러왔습니다"로 막혀 **다시 시도할 길이 없어진다.**
    const refused = {
      get_archive: async () => ({
        launches: [], year: null, stale: false, truncated: false,
        error: "1957년부터 내년까지만 불러올 수 있습니다.",
      }),
    };
    const { ctx, state, map, el } = loadApp({ api: refused });
    state.map = map; map.stubSource("launches");
    await ctx.loadArchive(3000);
    check("거절된 해는 불러온 것으로 치지 않는다", [...state.loadedYears], []);
    check("파이썬이 준 말을 그대로 보여준다",
      el("status").textContent.includes("1957년부터"), true);
  }

  // ── 업데이트 확인 배지 (P12-12) ─────────────────────────────────────────────
  // 순수 판정(shouldShowUpdate·updateBadgeText)과 **배선**을 따로 잰다 — 판정이 다 맞아도
  // initUpdateCheck 가 안 불리거나 클릭 핸들러가 없으면 앱에서는 아무 일도 안 일어난다.
  {
    const { ctx } = loadApp();
    group("업데이트 판정 (shouldShowUpdate)");
    const info = { update_available: true, latest: "v1.14.0", current: "1.13.0",
                   url: "https://example.invalid/r" };
    check("새 버전이면 띄운다", ctx.shouldShowUpdate(info, ""), true);
    check("업데이트 없음이면 안 띄운다",
      ctx.shouldShowUpdate({ ...info, update_available: false }, ""), false);
    check("latest 가 비면 안 띄운다", ctx.shouldShowUpdate({ ...info, latest: null }, ""), false);
    check("info 가 없으면 조용히 false", ctx.shouldShowUpdate(null, ""), false);
    check("닫은 버전과 같으면 안 띄운다", ctx.shouldShowUpdate(info, "1.14.0"), false);
    check("닫은 버전의 v 접두 차이를 흡수한다", ctx.shouldShowUpdate(info, "v1.14.0"), false);
    check("닫은 것보다 더 새 버전이면 다시 띄운다",
      ctx.shouldShowUpdate({ ...info, latest: "v1.15.0" }, "1.14.0"), true);

    group("업데이트 문구 (updateBadgeText)");
    check("새 버전과 현재 버전을 함께 적는다",
      ctx.updateBadgeText(info), "⬆ 새 버전 v1.14.0 가 있습니다 (현재 v1.13.0) — 눌러서 받기");
    check("현재 버전을 모르면 빈 괄호를 남기지 않는다",
      ctx.updateBadgeText({ latest: "v1.14.0" }).includes("("), false);
    check("태그의 v 접두는 한 번만 붙는다",
      ctx.updateBadgeText({ latest: "1.14.0", current: "1.13.0" }).includes("vv"), false);
  }
  {
    // 배선 ①: **부트(pywebviewready)가 실제로 부르는가.** 함수를 직접 부르면 판정은 보이지만
    // boot.js 의 호출 한 줄이 빠져도 통과한다 — 그 구멍은 이 프로젝트에서 이미 세 번 났다.
    const info = { update_available: true, latest: "v1.14.0", current: "1.13.0",
                   url: "https://example.invalid/r" };
    let asked = 0;
    const { ctx, el, state, win } = loadApp({
      api: { check_update: async () => { asked++; return info; } },
    });
    group("업데이트 배선 (부트 경로)");
    check("부트 전에는 배지에 클릭 핸들러가 없다", !!el("update-badge").handlers.click, false);
    check("부트 전에는 확인하지 않는다", asked, 0);
    await win.fire("pywebviewready");
    await new Promise((r) => setImmediate(r));
    check("bindUI 가 배지에 클릭을 붙인다", !!el("update-badge").handlers.click, true);
    check("부트가 업데이트 확인을 부른다", asked, 1);
    check("배지가 보인다", el("update-badge").hidden, false);
    check("문구에 새 버전이 적힌다", el("update-badge").innerHTML.includes("v1.14.0"), true);
    check("닫기 버튼이 함께 그려진다", el("update-badge").innerHTML.includes("ub-close"), true);
    check("나중에 쓰려고 결과를 들고 있는다", state.latestUpdateInfo.latest, "v1.14.0");
    check("확인을 기다리느라 지도를 막지 않는다", state.map !== null, true);
  }
  {
    // 배선 ②: 본문 클릭 → 릴리스 페이지 열기
    const info = { update_available: true, latest: "v1.14.0", current: "1.13.0",
                   url: "https://example.invalid/r" };
    const opened = [];
    const { ctx, el } = loadApp({ api: {
      check_update: async () => info,
      open_url: (u) => { opened.push(u); return true; },
    } });
    ctx.bindUpdateBadge();
    await ctx.initUpdateCheck();
    el("update-badge").fire("click", { target: { classList: { contains: () => false } } });
    check("본문을 누르면 릴리스 페이지를 연다", opened, ["https://example.invalid/r"]);
  }
  {
    // 배선 ③: ✕ → 그 버전만 닫고 설정에 남긴다(다음 실행에도 안 뜨게)
    const info = { update_available: true, latest: "v1.14.0", current: "1.13.0",
                   url: "https://example.invalid/r" };
    const saved = [];
    const opened = [];
    const { ctx, el, state } = loadApp({ api: {
      check_update: async () => info,
      save_settings: (p) => saved.push(p),
      open_url: (u) => { opened.push(u); return true; },
    } });
    ctx.bindUpdateBadge();
    await ctx.initUpdateCheck();
    el("update-badge").fire("click", { target: { classList: { contains: (c) => c === "ub-close" } } });
    check("배지가 닫힌다", el("update-badge").hidden, true);
    check("닫은 버전을 설정에 남긴다", saved, [{ dismissedUpdate: "v1.14.0" }]);
    check("닫기는 페이지를 열지 않는다", opened, []);
    check("상태에도 반영된다", state.settingsDismissedUpdate, "v1.14.0");
  }
  {
    // 배선 ④: 저장된 dismissedUpdate 가 복원돼 배지를 막는다
    const info = { update_available: true, latest: "v1.14.0", current: "1.13.0", url: "u" };
    const { ctx, el } = loadApp({ api: { check_update: async () => info } });
    ctx.applySettings({ dismissedUpdate: "v1.14.0" });
    await ctx.initUpdateCheck();
    check("이미 닫은 버전은 다음 실행에도 안 뜬다", el("update-badge").hidden, true);
  }
  {
    // 확인 실패는 앱 기능이 아니다 — 조용히 넘어가야 한다
    const { ctx, el } = loadApp({ api: { check_update: async () => { throw new Error("net"); } } });
    await ctx.initUpdateCheck();
    check("확인이 실패해도 배지는 안 뜬다", el("update-badge").hidden, true);
  }

// ── 발사 밀도 히트맵 (P12-15) ────────────────────────────────────────────────
// 조용히 깨지는 자리가 셋이다:
//   ① 히트맵 소스가 마커와 **다른 집합**을 받으면 한 지도의 두 표현이 서로 다른 말을 한다.
//   ② 겹친 발사가 한 점으로 합쳐지면 1건과 300건이 똑같이 그려진다 — 히트맵의 존재 이유가 사라진다.
//   ③ 모수 안내가 빠지면 라이브 100건짜리 얼룩을 "발사 중심"으로 읽는다(P12-7 과 같은 거짓말).
// 셋 다 예외가 없고 화면은 "그럴듯하게" 그려진다.
{
  const { ctx, state, el, map, sel } = loadApp();
  group("히트맵 GeoJSON (launchesToHeatFC)");
  const fc = ctx.launchesToHeatFC([
    { id: "1", lat: 28.5, lng: -80.6 },
    { id: "2", lat: 28.5, lng: -80.6 },   // 같은 발사장 — 합치지 않는다
    { id: "3", lat: null, lng: null },
  ]);
  check("좌표 없는 발사는 빠진다", fc.features.length, 2);
  check("좌표는 [경도, 위도] 순서", fc.features[0].geometry.coordinates, [-80.6, 28.5]);
  check("같은 발사장은 점으로 쌓인다(합치지 않는다 — 밀도의 근거)",
    fc.features.map((f) => f.geometry.coordinates), [[-80.6, 28.5], [-80.6, 28.5]]);
  check("빈 입력에도 죽지 않는다", ctx.launchesToHeatFC(null).features, []);

  group("히트맵 색 눈금 (heatScale)");
  // 가중치가 고정이면 점 하나로 색이 포화해 1건과 30건이 똑같이 빨강이 된다 — 화면은 멀쩡하다.
  const S = (l) => ctx.heatScale(l);
  check("최다 발사장 건수를 찾는다", S([
    { lat: 28.5, lng: -80.6 }, { lat: 28.5, lng: -80.6 }, { lat: 28.5, lng: -80.6 },
    { lat: -39.2, lng: 177.8 },
  ]).max, 3);
  // 커널 계수(GAUSS_COEF)를 빼면 최다 지점이 램프의 40% 에서 멈춘다 — 색만 안 나오고 오류는 없다.
  check("가중치는 그 최다 건수에서 색이 끝나도록 잡는다", Number(S([
    { lat: 1, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 1 },
  ]).weight.toFixed(4)), 0.6267);
  check("같은 발사장의 패드는 ≈1km 로 묶어 한 곳으로 센다",
    S([{ lat: 28.561, lng: -80.577 }, { lat: 28.562, lng: -80.579 }]).max, 2);
  check("멀리 떨어진 발사장은 따로 센다",
    S([{ lat: 28.5, lng: -80.6 }, { lat: 34.7, lng: -120.6 }]).max, 1);
  check("좌표 없는 발사는 세지 않는다", S([{ lat: null, lng: null }]).max, 0);
  check("빈 목록에서도 0 으로 나누지 않는다", S([]).weight, 1);
  check("한 곳에 1건뿐이어도 그 곳이 램프 끝이 된다", Number(S([{ lat: 1, lng: 1 }]).weight.toFixed(4)), 2.5066);

  group("히트맵 배선 (applyFilters · setHeatVisible)");
  state.map = map;
  state.sidebarTab = "launches";
  map.stubSource("launches");
  map.stubSource("launch-heat");
  state.allLaunches = [
    { id: "1", name: "A", outcome: "success", net: "2026-01-10T00:00:00Z", lat: 28.5, lng: -80.6 },
    { id: "2", name: "B", outcome: "success", net: "2026-02-10T00:00:00Z", lat: 28.5, lng: -80.6 },
    { id: "3", name: "C", outcome: "failure", net: "2026-03-10T00:00:00Z", lat: -39.2, lng: 177.8 },
    { id: "4", name: "좌표 없음", outcome: "success", net: "2026-04-10T00:00:00Z", lat: null, lng: null },
  ];
  sel[".flt:checked"] = [{ value: "success" }, { value: "failure" }];
  el("search").value = "";
  const heatCount = () => (map.data("launch-heat").features || []).length;
  const markerCount = () => (map.data("launches").features || []).length;

  ctx.applyFilters();
  check("꺼져 있으면 히트맵 소스는 비어 있다", heatCount(), 0);
  check("범례도 숨어 있다", el("heat-legend").hidden, true);

  ctx.setHeatVisible(true);
  check("켜면 레이어가 보인다", map.layout("launch-heat", "visibility"), "visible");
  check("켜면 클러스터 원을 흐린다(숨기지 않는다 — 저줌 클릭 대상이 사라진다)",
    map.paint("clusters", "circle-opacity"), 0.3);
  check("켠 순간 소스가 채워진다(토글이 applyFilters 를 부른다)", heatCount(), 3);
  check("마커와 같은 집합을 쓴다", heatCount(), markerCount());
  // 같은 발사장 2건이 최다 → 가중치 0.5. 이게 안 걸리면 1건짜리도 빨강이 된다.
  check("색 눈금을 지금 보고 있는 집합에 맞춘다",
    Number(map.paint("launch-heat", "heatmap-weight").toFixed(4)), 1.2533);

  sel[".flt:checked"] = [{ value: "success" }];
  ctx.applyFilters();
  check("결과 필터가 히트맵에도 걸린다", heatCount(), 2);
  check("여기서도 마커와 갈라지지 않는다", heatCount(), markerCount());
  el("search").value = "B";
  ctx.applyFilters();
  check("검색어도 히트맵에 걸린다", heatCount(), 1);
  el("search").value = "";
  sel[".flt:checked"] = [{ value: "success" }, { value: "failure" }];
  ctx.applyFilters();

  group("히트맵 범례 (모수)");
  check("켜면 범례가 보인다", el("heat-legend").hidden, false);
  // 좌표 없는 발사(4번)는 지도에 안 찍힌다 → 범례가 4건이라고 하면 그 자체가 거짓말이다.
  check("지도에 찍힌 건수만 적는다", el("heat-legend").innerHTML.includes("3건 기준"), true);
  check("눈금을 건수로 적는다(적음/많음은 아무 말도 안 한 것과 같다)",
    el("heat-legend").innerHTML.includes("한 발사장 최다 2건"), true);
  check("아카이브를 안 불러왔으면 부분 표본이라고 경고한다",
    el("heat-legend").innerHTML.includes("일부만"), true);
  state.loadedYears = new Set([2026]);
  ctx.applyFilters();
  check("연도 전체를 불러오면 경고가 사라진다",
    el("heat-legend").innerHTML.includes("일부만"), false);

  ctx.setHeatVisible(false);
  check("끄면 레이어가 숨는다", map.layout("launch-heat", "visibility"), "none");
  check("끄면 클러스터가 원래 밝기로 돌아온다", map.paint("clusters", "circle-opacity"), 0.92);
  check("끄면 소스를 비운다", heatCount(), 0);
  check("끄면 범례도 숨는다", el("heat-legend").hidden, true);
}

// 배선 — 위 단언은 setHeatVisible 을 **직접** 부른다. 체크박스와 단축키가 그 함수에
// 닿지 않으면 판정이 다 맞아도 앱에서는 아무 일도 일어나지 않는다.
{
  const { ctx, state, el, map, doc } = loadApp();
  group("히트맵 토글 배선 (체크박스 · 단축키 7)");
  state.map = map;
  map.stubSource("launches");
  map.stubSource("launch-heat");
  state.allLaunches = [];
  check("bindUI 전에는 체크박스에 change 가 없다", !!el("toggle-heat").handlers.change, false);
  ctx.bindUI();
  check("bindUI 가 체크박스에 change 를 붙인다", !!el("toggle-heat").handlers.change, true);

  el("toggle-heat").checked = true;
  el("toggle-heat").fire("change", { target: el("toggle-heat") });
  check("체크박스로 실제 켜진다", map.layout("launch-heat", "visibility"), "visible");
  check("상태에도 남는다(다음 applyFilters 가 소스를 채운다)", state.heatOn, true);

  doc.fire("keydown", { key: "7", target: { tagName: "BODY" }, preventDefault() {} });
  check("7 로 꺼진다(체크박스의 change 경로를 그대로 탄다)",
    [el("toggle-heat").checked, map.layout("launch-heat", "visibility")], [false, "none"]);
  doc.fire("keydown", { key: "7", target: { tagName: "BODY" }, preventDefault() {} });
  check("한 번 더 누르면 다시 켜진다", map.layout("launch-heat", "visibility"), "visible");
}

// 설정 복원 — 지도 생성 **전에** 불리므로 레이어가 아직 없다. 여기서 레이어를 만지면
// 조용히 예외가 나고 그 뒤 복원(카메라·관심목록)이 통째로 날아간다.
{
  const { ctx, el, state } = loadApp();
  group("히트맵 설정 복원");
  ctx.applySettings({ heatmap: true });
  check("저장된 값이 상태에 선다", state.heatOn, true);
  check("체크박스도 같이 켜진다", el("toggle-heat").checked, true);
  const { ctx: c2, state: s2, el: e2 } = loadApp();
  c2.applySettings({});
  check("설정이 없으면 꺼진 채로", [s2.heatOn, e2("toggle-heat").checked], [false, false]);
}

// ── 발사 궤적 근사선 (P12-4) ─────────────────────────────────────────────────
// 외부 정답표가 없다(실측 텔레메트리가 없어서 이 기능이 있는 것이다) → **물리 불변식**과
// 널리 알려진 실제 발사 방위각으로 잰다. 조용히 깨지는 자리: 방위각 해의 선택(순행/역행)과
// 경도 정규화 — 둘 다 선은 "그럴듯하게" 그려진다.
{
  const { ctx, state, el, map, sel } = loadApp();
  group("발사 방위각 (ascentAzimuth)");
  const A = (inc, lat) => Number(ctx.ascentAzimuth(inc, lat).toFixed(1));

  check("경사 = 발사장 위도면 정동(최소 에너지)", A(28.5, 28.5), 90);
  check("적도에서 경사 0° 도 정동", A(0, 0), 90);
  // 케네디(28.6°N)에서 ISS 궤도(51.6°) — 실제 발사 방위각은 약 44~45°
  check("케네디 → ISS 궤도는 북동 45° 부근", A(51.6, 28.6), 45);
  // 바이코누르(45.9°N)에서 같은 궤도 — 실제 약 61~65°
  check("바이코누르 → ISS 궤도는 더 북쪽으로", A(51.6, 45.9), 63.2);
  // 반덴버그(34.7°N) 태양동기 — 역행이라 **남서쪽**으로 나간다
  check("반덴버그 → 태양동기는 남서 190° 부근", A(98, 34.7), 189.7);
  check("극궤도(90°)는 정남", A(90, 34.7), 180);
  // i < |φ| 는 물리적으로 불가능하다 — 예외를 던지면 선만 조용히 사라진다
  check("위도보다 낮은 경사는 정동으로 클램프", A(20, 28.5), 90);
  check("남반구 발사장도 같다(위도 부호 무관)", A(45, -45), 90);

  // 같은 발사장에서 경사를 올리면 방위각은 정동에서 북쪽으로 단조 이동한다
  const seq = [30, 40, 50, 60, 70, 80].map((i) => ctx.ascentAzimuth(i, 28.5));
  check("경사가 커질수록 북쪽으로(단조 감소)",
    seq.every((v, i) => i === 0 || v < seq[i - 1]), true);

  group("경사각 가정 (ascentAssumption)");
  const P = (orbit, lat = 28.5, lng = -80.6) => ctx.ascentPath({ orbit, lat, lng });
  check("태양동기는 표의 값을 쓴다", P("Sun-Synchronous Orbit").inc, 98);
  check("극궤도는 90°", P("Polar Orbit").inc, 90);
  check("저궤도는 발사장 위도(모른다는 뜻)", [P("Low Earth Orbit").inc, P("Low Earth Orbit").vague], [28.5, true]);
  check("정지궤도 전이도 발사장 위도지만 모르는 게 아니다",
    P("Geostationary Transfer Orbit").vague, false);
  check("탄도 비행은 그리지 않는다(궤도 진입이 없다)", P("Suborbital"), null);
  check("모르는 궤도 이름은 Unknown 으로 본다(표에 없다고 죽지 않는다)",
    [P("Cislunar Gateway Orbit").inc, P("Cislunar Gateway Orbit").vague], [28.5, true]);
  check("좌표 없는 발사는 그릴 수 없다", ctx.ascentPath({ orbit: "Low Earth Orbit", lat: null, lng: null }), null);
  check("남반구 발사장은 위도의 절댓값을 경사로 쓴다(음수 경사는 없다)",
    P("Low Earth Orbit", -39.2, 177.8).inc, 39.2);

  group("근사 경로 (ascentPath)");
  const path = P("Low Earth Orbit");
  const hav = ([lng1, lat1], [lng2, lat2]) => {
    const R = 6371, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  };
  check("발사장에서 시작한다", path.points[0].map((v) => Number(v.toFixed(3))), [-80.6, 28.5]);
  check("점이 31개(0~30)", path.points.length, 31);
  check("끝점까지 약 2,200km(상승 구간)", Math.round(hav(path.points[0], path.points[30]) / 100) * 100, 2200);
  check("모든 점이 -180~180 안에 있다",
    path.points.every(([lng, lat]) => lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90), true);
  // 정동 발사는 위도가 거의 안 변해야 한다(경사 = 위도일 때)
  check("정동 발사는 위도가 크게 안 변한다",
    Math.abs(path.points[30][1] - 28.5) < 4, true);
  // 태양동기(남서)는 위도가 **내려가야** 한다 — 해를 잘못 고르면 북으로 올라간다
  check("태양동기는 남쪽으로 내려간다",
    P("Sun-Synchronous Orbit", 34.7, -120.6).points[30][1] < 34.7, true);

  group("날짜변경선 (근사선)");
  // 마샬제도·뉴질랜드처럼 날짜변경선 옆 발사장은 정동 2,200km 로 실제로 선을 넘는다
  const east = ctx.ascentPath({ orbit: "Low Earth Orbit", lat: 9, lng: 167.7 });
  check("넘는 경로도 경도가 180 을 안 넘는다(정규화)",
    east.points.every(([lng]) => lng >= -180 && lng <= 180), true);
  check("끊어 그리지 않으면 지도를 가로지르는 가짜 직선이 된다",
    ctx.splitAtDateline(east.points).length, 2);

  group("가정 문구 (ascentNote)");
  const n1 = ctx.ascentNote(P("Sun-Synchronous Orbit", 34.7, -120.6));
  check("경사와 방위를 숫자로 적는다", n1.head, "가정: 경사 98.0° (태양동기) · 방위 190° 남쪽");
  check("아는 궤도에는 경고가 없다", n1.warn, null);
  const n2 = ctx.ascentNote(P("Low Earth Orbit"));
  check("저궤도에는 모른다는 것을 적는다", n2.warn.includes("28~97°"), true);
  check("그릴 수 없으면 문구도 없다", ctx.ascentNote(null), null);
  check("나침반 방위", [ctx.compassKo(0), ctx.compassKo(90), ctx.compassKo(190), ctx.compassKo(350)],
    ["북", "동", "남", "북"]);

  group("근사선 배선 (상세 패널)");
  state.map = map;
  map.stubSource("launch-track");
  map.stubSource("launches");
  // 여는 발사가 **지금 화면 조건 안에 있어야** 선을 그린다(P25-1) — 밖이면 일부러 지운다.
  // 그래서 여기서 목록과 필터를 실제와 같게 세운다. 세우지 않으면 "0건 중 하나를 연" 상태다.
  const ascL = [
    { id: "1", name: "테스트 발사", outcome: "upcoming", net: "2026-12-01T00:00:00Z",
      orbit: "Sun-Synchronous Orbit", lat: 34.7, lng: -120.6 },
    { id: "3", name: "날짜변경선 옆 발사", outcome: "upcoming", net: "2026-12-01T00:00:00Z",
      orbit: "Low Earth Orbit", lat: 9, lng: 167.7 },
    { id: "2", name: "탄도 비행", outcome: "success", net: "2026-01-01T00:00:00Z",
      orbit: "Suborbital", lat: 32.99, lng: -106.97 },
  ];
  state.launches = ascL;
  ctx.rebuildAll();
  sel[".flt:checked"] = [{ value: "upcoming" }, { value: "success" }];
  const seg = () => {
    const d = map.data("launch-track");
    return d && d.geometry ? d.geometry.coordinates.length : 0;
  };
  ctx.openPanel({ id: "1", name: "테스트 발사", outcome: "upcoming", net: "2026-12-01T00:00:00Z",
                  orbit: "Sun-Synchronous Orbit", lat: 34.7, lng: -120.6 });
  check("패널을 열면 선이 그려진다", seg(), 1);
  check("패널에 가정을 적는다(선만 그리면 실측처럼 읽힌다)",
    el("panel-body").innerHTML.includes("가정: 경사 98.0°"), true);
  // 맨 아래에 붙이면 긴 패널에서 스크롤 끝까지 내려야 보인다 — "명시했다"고 할 수 없다.
  check("문구는 패널 위쪽(발사 시각보다 먼저)에 온다",
    el("panel-body").innerHTML.indexOf("상승 궤적") < el("panel-body").innerHTML.indexOf("발사 시각"), true);
  // 배선 — splitAtDateline 을 **그리는 쪽이** 실제로 타는지. 순수 함수 테스트만으로는
  // 끊기 로직이 맞아도 drawAscentPath 가 안 부르면 지도를 가로지르는 가짜 직선이 남는다.
  ctx.openPanel({ id: "3", name: "날짜변경선 옆 발사", outcome: "upcoming", net: "2026-12-01T00:00:00Z",
                  orbit: "Low Earth Orbit", lat: 9, lng: 167.7 });
  check("그릴 때도 날짜변경선에서 끊는다", seg(), 2);

  ctx.closePanel();
  check("패널을 닫으면 선도 지운다", map.data("launch-track"), { type: "FeatureCollection", features: [] });

  ctx.openPanel({ id: "2", name: "탄도 비행", outcome: "success", net: "2026-01-01T00:00:00Z",
                  orbit: "Suborbital", lat: 32.99, lng: -106.97 });
  check("탄도 비행은 선도 문구도 없다",
    [map.data("launch-track"), el("panel-body").innerHTML.includes("가정: 경사")],
    [{ type: "FeatureCollection", features: [] }, false]);
}

// ── 로드 순서 일치 (P12-23) ──────────────────────────────────────────────────
// 파일을 쪼갤 때마다 생기는 구멍: 하네스(APP_FILES)에만 넣고 **index.html 에 빠뜨리면**
// 테스트는 전부 통과하고 앱만 깨진다 — 클래식 스크립트라 "함수가 없다"로 죽는다.
// 순서까지 같아야 한다: 순서가 곧 의존 관계다(최상위 const 는 호이스팅되지 않는다).
{
  const fs = require("fs");
  const path = require("path");
  group("로드 순서 일치 (index.html ↔ harness)");
  const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
  const inHtml = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map((m) => m[1]);
  check("index.html 과 하네스가 같은 파일을 같은 순서로 읽는다", inHtml, APP_FILES);
  check("모든 파일이 실제로 있다",
    inHtml.filter((f) => !fs.existsSync(path.join(__dirname, "..", "web", "js", f))), []);

  // 오프라인 배경 데이터(P17-2)도 같은 갈래다 — `index.html` 에서 빠지면 `NE_LAND` 가
  // undefined 가 되고, `buildMapStyle` 은 **정상적으로** 배경 없는 스타일을 돌려준다.
  // 예외도 경고도 없고 화면에서만 사라진다.
  check("index.html 이 lib/ne_land.js 를 싣는다", html.includes('src="lib/ne_land.js"'), true);
  check("그 파일이 실제로 있다",
    fs.existsSync(path.join(__dirname, "..", "web", "lib", "ne_land.js")), true);
}

// ── 오프라인 배경 (P17-2) ────────────────────────────────────────────────────
// 원안(Esri 저줌 타일을 exe 에 번들)은 **라이선스에서 끊겼다** — Esri 문서가 "다른 앱을
// 통해 오프라인용으로 타일을 조직적으로 요청하는 것"을 금지한다. 그래서 퍼블릭 도메인인
// Natural Earth 육지 폴리곤으로 바꿨다.
//
// 조용히 깨지는 자리는 **순서**다: 육지 실루엣이 타일 위로 올라가도 예외가 안 나고,
// 화면으로는 "위성사진이 좀 이상하다"로만 보인다.
{
  const { ctx } = loadApp();
  group("지도 스타일 (buildMapStyle)");
  const LAND = { type: "FeatureCollection", features: [
    { type: "Feature", properties: {}, geometry: { type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] };

  const layerOf = (style, id) => style.layers.find((l) => l.id === id) || {};
  const st = ctx.buildMapStyle(LAND);
  const ids = st.layers.map((l) => l.id);
  check("바다 → 육지 → 해안선 → 다크 타일 → 위성사진 순", ids,
    ["ocean", "neland", "necoast", "darkbase", "esri"]);
  check("해안선은 같은 소스를 쓴다(추가 데이터 없이 대비만 올린다)",
    layerOf(st, "necoast").source, "ne-land");
  check("육지·해안선이 배경 타일보다 **아래**다(위면 타일을 가린다)",
    [ids.indexOf("neland") < ids.indexOf("darkbase"),
     ids.indexOf("necoast") < ids.indexOf("darkbase")], [true, true]);
  // id 로 찾는다 — 인덱스로 집으면 순서가 틀어졌을 때 단언이 실패하는 대신 **예외로 죽어**
  // 뒤 테스트가 통째로 안 돈다(2026-09-16 변이 실험에서 실제로 그랬다).
  const layer = (id) => layerOf(st, id);
  check("위성사진은 숨긴 채 시작한다", (layer("esri").layout || {}).visibility, "none");
  check("육지 소스가 그 데이터를 쓴다", st.sources["ne-land"].data, LAND);

  // 데이터를 못 읽어도 지도는 떠야 한다 — 배경만 빠진다
  const bare = ctx.buildMapStyle(null);
  check("데이터가 없으면 육지·해안선 없이 돈다",
    bare.layers.map((l) => l.id), ["ocean", "darkbase", "esri"]);
  check("없는 소스를 가리키지 않는다", bare.sources["ne-land"], undefined);
  check("그래도 바다색은 남는다(지도가 흰 화면이 되지 않게)",
    (bare.layers.find((l) => l.id === "ocean") || {}).paint["background-color"], "#070c16");
}

// ── 발사 순서표 (P13-1) ──────────────────────────────────────────────────────
// 조용히 깨지는 자리: "지금 어느 단계" 판정의 경계(리프토프 순간)와, net 이 부정확한
// 발사에 절대 시각을 붙이는 것. 둘 다 화면에는 그럴듯한 목록이 그대로 나온다.
// **시각은 전부 주입한다** — Date.now() 에 기대면 오전엔 통과하고 저녁엔 실패한다.
{
  const { ctx, state, el, map } = loadApp();
  group("T± 표기 (tMinus)");
  const T = (s) => ctx.tMinus(s);
  check("리프토프 전", T(-3000), "T-50:00");
  check("리프토프 후", T(138), "T+2:18");
  check("한 시간을 넘으면 시:분:초", T(3743), "T+1:02:23");
  check("0 은 T± (전도 후도 아니다)", T(0), "T±0:00");
  check("한 자리 초도 두 자리로", T(58), "T+0:58");

  group("지금 어느 단계 (currentPhase)");
  const TL = [
    { t: -3000, abbrev: "GO for Prop Load" },
    { t: -3, abbrev: "Ignition" },
    { t: 0, abbrev: "Liftoff" },
    { t: 58, abbrev: "Max-Q" },
    { t: 138, abbrev: "MECO" },
  ];
  const P = (elapsed) => {
    const r = ctx.currentPhase(TL, elapsed);
    return [r.past && r.past.abbrev, r.next && r.next.abbrev];
  };
  check("아직 아무것도 안 지났으면 past 는 null", P(-4000), [null, "GO for Prop Load"]);
  check("중간 — 아직 안 온 이벤트가 next 다", P(-10), ["GO for Prop Load", "Ignition"]);
  check("점화를 지난 뒤", P(-1), ["Ignition", "Liftoff"]);
  // 경계 — 리프토프 순간에 Liftoff 가 "다음"으로 남아 있으면 틀려 보인다
  check("같은 시각 이벤트는 지난 것으로 본다", P(0), ["Liftoff", "Max-Q"]);
  check("마지막을 지나면 next 는 null", P(9999), ["MECO", null]);
  check("빈 순서표에서도 죽지 않는다", P.call(null, 0) && ctx.currentPhase(null, 0).past, null);

  group("절대 시각을 붙여도 되는가 (canShowClock)");
  // 날짜만 확정된 발사에 "05:12:58 MECO" 를 찍는 것은 없는 정밀도를 지어내는 것이다(P12-3).
  check("초·분 단위 확정이면 붙인다",
    [ctx.canShowClock("Second"), ctx.canShowClock("Minute")], [true, true]);
  check("시·일·달 단위면 안 붙인다",
    [ctx.canShowClock("Hour"), ctx.canShowClock("Day"), ctx.canShowClock("Month")],
    [false, false, false]);
  check("모르면 안 붙인다", [ctx.canShowClock(null), ctx.canShowClock(undefined)], [false, false]);

  group("순서표 HTML (timelineHtml)");
  const base = Date.parse("2026-05-01T00:00:00Z");
  const withTl = (extra) => Object.assign({ id: "1", name: "테스트", net: "2026-05-01T00:00:00Z",
                                            net_precision: "Second", timeline: TL }, extra || {});
  const html = ctx.timelineHtml(withTl(), 0);
  check("순서표가 없으면 아무것도 안 그린다(없는 게 정상인 필드다)",
    ctx.timelineHtml(withTl({ timeline: [] }), 0), "");
  check("이벤트 수만큼 줄이 생긴다", (html.match(/class="sq-row/g) || []).length, 5);
  check("표에 있는 이름은 한국어로", html.includes("리프토프"), true);
  check("표에 없는 이름은 원문 그대로(표가 낡아도 화면이 안 빈다)",
    ctx.timelineHtml(withTl({ timeline: [{ t: 0, abbrev: "Brand New Event" }] }), null)
      .includes("Brand New Event"), true);
  check("지난 것과 다음 것을 각각 표시한다",
    [html.includes("sq-past"), html.includes("sq-next")], [true, true]);
  check("net 이 초 단위 확정이면 시계도 적는다", html.includes("sq-clock"), true);
  check("net 이 날짜까지만이면 시계를 안 적는다",
    ctx.timelineHtml(withTl({ net_precision: "Day" }), 0).includes("sq-clock"), false);
  check("경과를 모르면 강조하지 않는다",
    ctx.timelineHtml(withTl(), null).includes("sq-next"), false);
  check("설명은 title 로 (XSS 방어 경로를 탄다)",
    ctx.timelineHtml(withTl({ timeline: [{ t: 0, abbrev: "x", desc: '<img src=x onerror=1>' }] }), null)
      .includes("<img src=x"), false);

  group("집중 화면 한 줄 (phaseLineHtml)");
  const L = (sec) => ctx.phaseLineHtml(withTl(), base + sec * 1000);
  check("리프토프 직후", [L(1).includes("리프토프"), L(1).includes("최대 동압")], [true, true]);
  check("남은 시간을 초로 적는다", L(1).includes("57초 뒤"), true);
  check("순서표가 없으면 빈 문자열", ctx.phaseLineHtml(withTl({ timeline: [] }), base), "");
  // new Date(null) 은 NaN 이 아니라 epoch 0 이다 — 막지 않으면 1970년 기준으로 "MECO 지남"이 찍힌다
  check("발사 시각이 미정이면 빈 문자열", ctx.phaseLineHtml(withTl({ net: null }), base), "");
  check("읽을 수 없는 net 도 빈 문자열", ctx.phaseLineHtml(withTl({ net: "언젠가" }), base), "");
  check("미정이면 순서표에 시계도 안 붙는다",
    ctx.timelineHtml(withTl({ net: null }), 0).includes("sq-clock"), false);
  check("다 끝났으면 지난 것만", [L(99999).includes("MECO"), L(99999).includes("다음")], [true, false]);

  group("원지점 · 근지점 (P14-3)");
  // ISS 에 가까운 값: 주기 약 92.8분 → no ≈ 0.0677 rad/min, 이심률 0.0003
  const issRec = { no: 2 * Math.PI / 92.8, ecco: 0.0003, inclo: 0.9 };
  const iss = ctx.apsides(issRec);
  // 절대값을 단언하면 상수를 바꿔도 테스트가 같이 따라가 아무것도 못 잡는다.
  // **독립적으로 아는 사실**로 잰다: ISS 는 고도 400km 대이고 거의 원궤도다.
  check("ISS 급 궤도는 고도 380~440km", [iss.perigee > 380, iss.apogee < 440], [true, true]);
  check("원지점이 근지점보다 높다", iss.apogee > iss.perigee, true);
  check("거의 원궤도로 읽힌다", ctx.apsidesText(iss).includes("원궤도"), true);

  // 타원 궤도(몰니야 급): 이심률이 크면 두 값이 크게 벌어져야 한다
  const molniya = ctx.apsides({ no: 2 * Math.PI / 717, ecco: 0.74 });
  check("타원 궤도는 두 값이 크게 벌어진다", molniya.apogee - molniya.perigee > 30000, true);
  check("타원은 범위로 적는다",
    [ctx.apsidesText(molniya).includes("~"), ctx.apsidesText(molniya).includes("원궤도")],
    [true, false]);

  // **이심률만으로는 궤도 모양이 안 읽힌다** — 이 줄이 있어야 하는 이유.
  // 0.0003 과 0.74 가 각각 어떤 궤도인지는 km 로 봐야 안다.
  check("같은 주기라도 이심률이 다르면 다른 궤도로 읽힌다",
    ctx.apsidesText(ctx.apsides({ no: 2 * Math.PI / 717, ecco: 0.0001 })) !==
    ctx.apsidesText(molniya), true);

  // 고도는 지표 기준이다 — 지구 반지름을 안 빼면 6,378km 가 통째로 더해진다
  check("고도는 지표 기준(장반경이 아니다)", iss.apogee < 1000, true);

  // 방어: 이 값들이 오면 계산이 발산하거나 음수 제곱근이 된다
  check("no=0 이면 null", ctx.apsides({ no: 0, ecco: 0.1 }).apogee, null);
  check("이심률 1 이상이면 null", ctx.apsides({ no: 0.06, ecco: 1 }).apogee, null);
  check("이심률 음수면 null", ctx.apsides({ no: 0.06, ecco: -0.1 }).apogee, null);
  check("rec 이 없어도 죽지 않는다", ctx.apsides(null).apogee, null);
  check("값이 없으면 줄을 안 낸다", ctx.apsidesText({ apogee: null, perigee: null }), null);

  group("발사장 현지 시각 (P14-2)");
  // **로캘 문자열을 비교하지 않는다** — Node 의 ICU 는 "PM 01:14", 앱(WebView2)은 "오후 01:14"
  // 를 낸다. 단언은 차이와 구조로 한다(이 리포가 P13-5 에서 당한 자리다).
  const utcNoon = "2026-09-14T18:14:00Z";   // 서울 9/15 03:14 · 시카고 9/14 13:14
  const chicago = { net: utcNoon, pad_timezone: "America/Chicago" };
  check("발사장 현지 시각이 내 시각과 다르면 낸다", typeof ctx.padLocalTimeText(chicago), "string");
  // 날짜 자체가 다르다 — 이 기능이 있어야 하는 이유이자, 오프셋이 실제로 적용됐다는 증거.
  // **자릿수로 자르지 않는다**: slice(0,11) 은 "2026. 09. 1" 까지만 봐서 일(日)의
  // 마지막 자리를 놓친다(처음에 그렇게 썼다가 14일과 15일이 같다고 나왔다).
  // ko-KR 은 연-월-일 순서이므로 **앞 세 숫자**를 뽑아 비교한다.
  const ymd = (t) => (String(t).match(/\d+/g) || []).slice(0, 3).join("-");
  check("내 시각과 날짜가 다르다",
    [ymd(ctx.padLocalTimeText(chicago)), ymd(ctx.fmtDate(utcNoon))],
    ["2026-09-14", "2026-09-15"]);
  // 일본 발사장은 한국과 같은 GMT+9 다 — 같은 줄을 두 번 쓰면 화면만 길어진다
  check("표기가 같으면 줄을 안 낸다",
    ctx.padLocalTimeText({ net: utcNoon, pad_timezone: "Asia/Tokyo" }), null);
  // Intl 은 모르는 시간대에 RangeError 를 던진다 — 그 예외 하나가 패널 전체를 날린다
  check("모르는 시간대에도 죽지 않는다",
    ctx.padLocalTimeText({ net: utcNoon, pad_timezone: "Mars/Olympus" }), null);
  check("시간대가 없으면 null", ctx.padLocalTimeText({ net: utcNoon, pad_timezone: null }), null);
  check("net 이 없으면 null", ctx.padLocalTimeText({ net: null, pad_timezone: "America/Chicago" }), null);
  check("읽을 수 없는 net 도 null",
    ctx.padLocalTimeText({ net: "언젠가", pad_timezone: "America/Chicago" }), null);
  check("필드가 아예 없어도 죽지 않는다", ctx.padLocalTimeText({}), null);
  // UTC 모드에서도 발사장 현지는 그대로 유용하다 — 오히려 더(둘 다 내 시각이 아니다)
  check("UTC 모드에서도 낸다",
    (ctx.setTimeZoneMode("utc"),
     typeof ctx.padLocalTimeText(chicago) === "string"), true);
  ctx.setTimeZoneMode("local");

  group("로켓 제원 · 부스터 이력 (P14-1)");
  // `flights` 는 **이번 비행 직전까지의 횟수**다 — LL2 가 flights=28 인 B1080 을 같은
  // 응답에서 "after its 29th flight" 라고 부른다. 그대로 쓰면 매번 하나씩 어긋난다.
  check("28회 비행한 부스터는 29번째", ctx.boosterFlightText({ flights: 28 }), "29번째 비행");
  check("0 은 첫 비행", ctx.boosterFlightText({ flights: 0 }), "첫 비행");
  // 0 과 null 이 같은 문장이 되면, 배정도 안 된 부스터가 "첫 비행"이라고 단언된다
  check("미배정(null)은 횟수를 말하지 않는다", ctx.boosterFlightText({ flights: null }), null);

  // 착륙 네 상태. success 만 보면 아직 날지도 않은 발사가 전부 "착륙 실패"가 된다
  check("예정 발사는 시도 예정",
    ctx.boosterLandingText({ landing_attempt: true, landing_success: null, landing_name: "ASOG" }),
    "착륙 시도 예정 · ASOG");
  check("성공", ctx.boosterLandingText({ landing_attempt: true, landing_success: true }), "착륙 성공");
  check("실패", ctx.boosterLandingText({ landing_attempt: true, landing_success: false }), "착륙 실패");
  check("시도 안 함", ctx.boosterLandingText({ landing_attempt: false }), "착륙 시도 안 함");
  check("모르면 지어내지 않는다", ctx.boosterLandingText({}), null);

  // `fail: 0` 은 지워야 할 빈 값이 아니라 좋은 소식이다 — 사라지면 실패 줄이 없는 것과 구분되지 않는다
  check("통산에 실패 0 이 남는다",
    ctx.rocketSpecBlock({ rocket_spec: { total: 15, success: 15, fail: 0 } }).includes("실패 0"), true);
  check("연속 성공 0 은 자랑이 아니라 적지 않는다",
    ctx.rocketSpecBlock({ rocket_spec: { total: 3, streak: 0 } }).includes("연속"), false);
  check("제원이 없으면 빈 문자열", ctx.rocketSpecBlock({ rocket_spec: null }), "");
  check("큰 값은 단위를 바꾼다",
    [ctx.fmtQty(100000, "kg"), ctx.fmtQty(80807, "kN"), ctx.fmtQty(9, "m")],
    ["100 t", "81 MN", "9 m"]);

  // ── 공시 발사가 · kg 당 (P15-2) ────────────────────────────────────────────
  check("금액을 만 달러 단위로",
    [ctx.fmtUsd(52000000), ctx.fmtUsd(6000000), ctx.fmtUsd(90000000)],
    ["5,200만 달러", "600만 달러", "9,000만 달러"]);
  check("금액이 없으면 null", [ctx.fmtUsd(null), ctx.fmtUsd(0)], [null, null]);
  check("kg 당 값 — 실측 세 로켓",
    [ctx.costPerKg(52000000, 22800), ctx.costPerKg(6000000, 300), ctx.costPerKg(90000000, 63800)],
    ["$2,281", "$20,000", "$1,411"]);
  // 막지 않았으면 무엇이 일어났을 것인가를 먼저 단언한다 — 이게 없으면 방어를 뜯어내도 통과한다
  check("막지 않았으면 Infinity 였다", isFinite(50000000 / 0), false);
  check("탑재량 0 이면 kg 당을 안 만든다", ctx.costPerKg(50000000, 0), null);
  check("탑재량이 없어도 안 만든다", ctx.costPerKg(50000000, null), null);
  check("비용이 없으면 안 만든다", ctx.costPerKg(null, 22800), null);

  // ── 물리량의 0 은 "모름"이다 (P15-2) ───────────────────────────────────────
  // "0 kg" 은 truthy 문자열이라 호출부의 .filter(x => x[1]) 를 그대로 통과했다.
  check("물리량 0 은 버린다", [ctx.fmtQty(0, "kg"), ctx.fmtQty(0, "m")], [null, null]);
  check("막지 않았으면 '0 kg' 이 truthy 였다", Boolean("0 kg"), true);
  const zeroCap = ctx.rocketSpecBlock({ rocket_spec: { leo_capacity: 0, length: 63, total: 5, fail: 0 } });
  check("LEO 탑재량 0 kg 이 화면에 안 뜬다", zeroCap.includes("LEO 탑재량"), false);
  check("같은 블록에서 통산 실패 0 은 그대로 남는다", zeroCap.includes("실패 0"), true);
  check("공시 발사가가 제원에 실린다",
    ctx.rocketSpecBlock({ rocket_spec: { cost: 52000000, leo_capacity: 22800 } })
      .includes("5,200만 달러"), true);
  check("kg 당도 같이 실린다",
    ctx.rocketSpecBlock({ rocket_spec: { cost: 52000000, leo_capacity: 22800 } })
      .includes("$2,281"), true);
  check("비용만 있고 탑재량이 없으면 kg 당 줄이 없다",
    ctx.rocketSpecBlock({ rocket_spec: { cost: 52000000 } }).includes("kg당"), false);

  // ── 정보 갱신 시각 (P15-7) ────────────────────────────────────────────────
  const agoIso = (days) => new Date(Date.now() - days * 86400000).toISOString();
  check("분·시간·일", [ctx.agoText(agoIso(0.002)), ctx.agoText(agoIso(0.2)), ctx.agoText(agoIso(3))],
    ["2분 전", "4시간 전", "3일 전"]);
  // 실측 예정 발사에 1,164일 전 갱신된 것이 있었다(H3-24) — 날짜 수로는 안 읽힌다
  check("1년이 넘으면 연 단위", ctx.agoText(agoIso(1164)), "3.2년 전");
  check("364일은 아직 날짜로", ctx.agoText(agoIso(364)), "364일 전");
  check("365일에서 바뀐다", ctx.agoText(agoIso(365)), "1.0년 전");
  check("정보 갱신 줄은 상대시간만", ctx.freshnessText(agoIso(27)), "27일 전");
  // 날짜를 붙였다면 로캘을 타게 된다 — Node 는 PM, WebView2 는 오후를 낸다
  check("괄호로 날짜를 붙이지 않는다", ctx.freshnessText(agoIso(27)).includes("("), false);
  check("없거나 이상하면 null",
    [ctx.freshnessText(null), ctx.freshnessText("헛소리"), ctx.freshnessText("")], [null, null, null]);
  check("행 자체가 안 그려진다", ctx.row("정보 갱신", ctx.freshnessText(null)), "");

  // ── 착륙 통산 (P15-3) ─────────────────────────────────────────────────────
  const LR = ctx.landingRecord;
  check("성공률까지 적는다", LR(620, 615, 5, 315), "착륙 620회 시도 · 성공 615 (99%) · 실패 5 · 연속 315");
  check("네 자리는 쉼표", LR(1200, 1000, 200, 5).includes("1,200회"), true);
  // 소모형 로켓·기관은 착륙을 안 하는 것이지 실패한 게 아니다(Arianespace·ULA·ROSCOSMOS)
  check("시도 0 이면 줄이 없다", [LR(0, 0, 0, 0), LR(null, 1, 1, 1)], [null, null]);
  // Starship V3 의 2 시도 0 성공은 지워야 할 빈 값이 아니다
  check("성공 0 은 살린다", LR(2, 0, 2, 0), "착륙 2회 시도 · 성공 0 (0%) · 실패 2");
  check("실패 0 이면 실패를 안 적는다", LR(5, 5, 0, 5).includes("실패"), false);
  check("연속 0 이면 연속을 안 적는다", LR(2, 0, 2, 0).includes("연속"), false);
  // LL2 가 699 ≠ 671+29 로 주므로 실패를 유도하면 안 된다 — 받은 29 가 그대로 나와야 한다
  check("실패를 시도-성공 으로 유도하지 않는다", LR(699, 671, 29, 20).includes("실패 29"), true);
  check("유도했다면 28 이 나왔을 것이다", 699 - 671, 28);

  check("제원 블록에 착륙 줄이 붙는다",
    ctx.rocketSpecBlock({ rocket_spec: { total: 630, land_att: 620, land_ok: 615 } })
      .includes("착륙 620회 시도"), true);
  check("착륙 0 이면 제원에 줄이 없다",
    ctx.rocketSpecBlock({ rocket_spec: { total: 58, land_att: 0 } }).includes("착륙"), false);

  const PL = (att, ok, fail, streak) => ({ provider_landings: { att, ok, fail, streak } });
  // siteTotals 와 같은 수법 — LL2 는 각 발사 시점의 집계를 주므로 가장 최근 값이 통산이다
  check("가장 큰 시도를 고른다",
    ctx.providerLandings([PL(100, 90, 10, 5), PL(699, 671, 29, 20), PL(5, 5, 0, 5)]).att, 699);
  check("옛 발사 값을 쓰면 과소 집계가 된다",
    ctx.providerLandings([PL(100, 90, 10, 5), PL(699, 671, 29, 20)]).att !== 100, true);
  check("착륙 없는 기관은 null", ctx.providerLandings([{ provider_landings: null }, {}]), null);
  check("착륙 없는 기관은 빈 문자열", ctx.providerLandingsHtml([{}]), "");
  check("기관 착륙 HTML 에 기준을 밝힌다",
    ctx.providerLandingsHtml([PL(699, 671, 29, 20)]).includes("가장 최근 발사"), true);

  // ── 참여 기관 (P15-5) ─────────────────────────────────────────────────────
  const AG = (n, ab, t) => ({ name: n, abbrev: ab, type: t });
  check("긴 이름은 약어로",
    ctx.agencyLabel(AG("European Organisation for the Exploitation of Meteorological Satellites",
                       "EUMETSAT", "Multinational")), "EUMETSAT (다국적)");
  // 약어가 늘 나은 게 아니다 — 실측 18곳에 BlackSky→BS · HawkEye 360→he360 이 있었다
  check("짧은 이름은 약어가 있어도 그대로",
    ctx.agencyLabel(AG("BlackSky", "BS", "Private")), "BlackSky (민간)");
  check("HawkEye 360 도 그대로", ctx.agencyLabel(AG("HawkEye 360", "he360", "Private")), "HawkEye 360 (민간)");
  check("약어가 없으면 이름 그대로", ctx.agencyLabel(AG("Synspective", null, "Private")), "Synspective (민간)");
  check("유형을 모르면 이름만", ctx.agencyLabel(AG("Foo", null, null)), "Foo");
  check("모르는 유형은 지어내지 않는다", ctx.agencyLabel(AG("Foo", null, "Alien")), "Foo");
  check("이름이 없으면 null", [ctx.agencyLabel(AG(null, "X", "Private")), ctx.agencyLabel(null)], [null, null]);
  check("여럿이면 가운뎃점으로",
    ctx.missionAgenciesText([AG("SES", "SES", "Commercial"), AG("Synspective", null, "Private")]),
    "SES (상업) · Synspective (민간)");
  check("없으면 null", [ctx.missionAgenciesText([]), ctx.missionAgenciesText(null)], [null, null]);
  check("행 자체가 안 그려진다",
    ctx.row("참여 기관", ctx.missionAgenciesText([])), "");

  // ── GTO 탑재량 (P15-6) ────────────────────────────────────────────────────
  const spec = (o) => ctx.rocketSpecBlock({ rocket_spec: o });
  check("GTO 탑재량이 제원에 실린다", spec({ gto_capacity: 8300 }).includes("GTO 탑재량"), true);
  check("t 단위로 바뀐다", spec({ gto_capacity: 26700 }).includes("26.7 t"), true);
  check("1,000 kg 미만은 kg 로 남는다", spec({ gto_capacity: 900 }).includes("900 kg"), true);
  check("GTO 가 0 이면 안 뜬다(Long March 2D)", spec({ gto_capacity: 0 }).includes("GTO"), false);
  check("GTO 가 없으면 안 뜬다", spec({ gto_capacity: null, length: 50 }).includes("GTO"), false);
  // LEO 가 0 인데 GTO 는 있는 로켓이 셋 있다(GSLV Mk. II·H3-22·H3-24) — 한쪽으로 다른 쪽을 지우면 안 된다
  const only = spec({ leo_capacity: 0, gto_capacity: 5400 });
  check("LEO 가 0 이어도 GTO 는 살아남는다", only.includes("GTO 탑재량") && only.includes("5.4 t"), true);
  check("그때 LEO 줄은 없다", only.includes("LEO 탑재량"), false);

  // **"신조 · 2번째 비행"이 실제 캐시에서 나왔다(2026-09-13).** LL2 는 Pallas1 F1 을
  // `reused=false`·`flights=1` 로 준다 — 두 값을 따로 재는 테스트는 전부 통과했고,
  // 화면에 렌더해 보고서야 앞뒤가 안 맞는 문장인 걸 알았다.
  const tagOf = (b) => ctx.boostersBlock({ boosters: [Object.assign({ serial: "X" }, b)] });
  check("신조는 flights===0 일 때만", tagOf({ flights: 0, reused: false }).includes("신조"), true);
  check("reused=false 라도 이미 난 적 있으면 신조라 하지 않는다",
    [tagOf({ flights: 1, reused: false }).includes("신조"),
     tagOf({ flights: 1, reused: false }).includes("2번째 비행")], [false, true]);
  check("재사용 태그는 reused 를 따른다", tagOf({ flights: 5, reused: true }).includes("재사용"), true);
  check("부스터가 없으면 블록이 없다", ctx.boostersBlock({ boosters: [] }), "");
  check("필드가 아예 없어도 죽지 않는다", ctx.boostersBlock({}), "");

  group("제원·부스터 배선 (상세 패널)");
  state.map = map;
  map.stubSource("launches");
  map.stubSource("launch-track");
  const dSpec = { id: "14", name: "제원 발사", outcome: "success", net: "2026-01-01T00:00:00Z",
                  lat: 28.5, lng: -80.6,
                  rocket_spec: { length: 70, total: 401, success: 398, fail: 3, reusable: true },
                  boosters: [{ serial: "B1080", flights: 28, reused: true,
                               landing_attempt: true, landing_success: true, landing_name: "ASOG" }] };
  ctx.openPanel(dSpec);
  check("상세 패널에 제원이 실린다", el("panel-body").innerHTML.includes("로켓 제원"), true);
  // 순수 함수가 맞아도 템플릿에 끼우는 줄이 없으면 앱에서는 아무 일도 안 일어난다
  check("상세 패널에 발사장 현지 줄이 실린다",
    (ctx.openPanel(Object.assign({}, dSpec,
      { net: "2026-09-14T18:14:00Z", pad_timezone: "America/Chicago" })),
     el("panel-body").innerHTML.includes("발사장 현지")), true);
  check("시간대를 모르는 발사장에는 그 줄이 없다",
    (ctx.openPanel(Object.assign({}, dSpec, { pad_timezone: null })),
     el("panel-body").innerHTML.includes("발사장 현지")), false);
  check("상세 패널에 부스터가 실린다",
    [el("panel-body").innerHTML.includes("B1080"),
     el("panel-body").innerHTML.includes("29번째 비행")], [true, true]);
  // 순수 함수가 전부 맞아도 템플릿에 끼워 넣는 줄이 빠지면 앱에서는 아무 일도 안 일어난다
  check("제원·부스터가 없는 발사에는 블록이 없다",
    (ctx.openPanel(Object.assign({}, dSpec, { rocket_spec: null, boosters: [] })),
     [el("panel-body").innerHTML.includes("로켓 제원"),
      el("panel-body").innerHTML.includes("부스터")]), [false, false]);
  // 옛 캐시에는 두 필드가 아예 없다 — 없다고 패널이 죽으면 안 된다(하위 호환)
  check("필드가 아예 없는 옛 캐시에서도 패널이 뜬다",
    (ctx.openPanel({ id: "15", name: "옛 캐시", outcome: "success", net: "2026-01-01T00:00:00Z",
                     lat: 1, lng: 2 }),
     el("panel-body").innerHTML.includes("옛 캐시")), true);

  group("순서표 배선 (상세 패널 · 집중 화면)");
  state.map = map;
  map.stubSource("launches");
  map.stubSource("launch-track");
  const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();   // 30분 뒤 = 집중 화면 대상
  const d = { id: "9", name: "임박 발사", outcome: "upcoming", net: soon, net_precision: "Second",
              lat: 28.5, lng: -80.6, orbit: "Low Earth Orbit", timeline: TL };
  ctx.openPanel(d);
  check("상세 패널에 순서표가 실린다", el("panel-body").innerHTML.includes("발사 순서"), true);
  check("순서표가 없는 발사에는 블록이 없다",
    (ctx.openPanel(Object.assign({}, d, { timeline: [] })),
     el("panel-body").innerHTML.includes("발사 순서")), false);

  state.allLaunches = [d];
  state.focusDismissed = new Set();
  state.focusShownId = null;
  ctx.updateFocus();
  check("집중 화면이 뜬다", el("focus").hidden, false);
  check("집중 화면에 '지금 어느 단계'가 실린다",
    el("focus").innerHTML.includes("focus-phase-slot"), true);
  check("T-30분이면 첫 이벤트가 아직 안 지났다",
    el("focus").innerHTML.includes("추진제 주입 승인"), true);
  // 매초 갱신 경로 — 카운트다운만 갱신하면 리프토프 뒤 카드가 멈춘 것처럼 보인다
  const slot = el("focus-phase-slot");
  slot.innerHTML = "";
  ctx.updateFocus();
  check("두 번째 호출은 단계 줄만 갈아 끼운다(다시 그리지 않는다)",
    slot.innerHTML.includes("추진제 주입 승인"), true);
}

// ── 전 세계 궤도 발사 모수 (P13-2) ───────────────────────────────────────────
// P12-7 은 "불러온 N건"까지만 말할 수 있었다. 그 N 이 전체의 얼마인지는 우리 데이터 안에
// 답이 없고, LL2 의 연내 순번이 유일한 외부 기준값이다.
// 조용히 깨지는 자리: **예정 발사의 번호를 "지금까지 발사된 수"로 세는 것**.
// 2026-09-12 실측으로 일어난 것 215 · 예정 포함 356 — 141건을 부풀리게 된다.
{
  const { ctx } = loadApp();
  group("궤도 발사 모수 (orbitalYearStats)");
  const L = [
    { net: "2026-03-01T00:00:00Z", outcome: "success", orbit: "Low Earth Orbit", orbital_year_count: 100 },
    { net: "2026-06-01T00:00:00Z", outcome: "failure", orbit: "Low Earth Orbit", orbital_year_count: 215 },
    { net: "2026-12-01T00:00:00Z", outcome: "upcoming", orbit: "Low Earth Orbit", orbital_year_count: 356 },
    { net: "2026-04-01T00:00:00Z", outcome: "success", orbit: "Suborbital", orbital_year_count: null },
    { net: "2025-05-01T00:00:00Z", outcome: "success", orbit: "Low Earth Orbit", orbital_year_count: 263 },
  ];
  const rows = ctx.orbitalYearStats(L, 2026);
  const y26 = rows.find((r) => r.year === 2026);
  check("이미 일어난 발사만 '지금까지'로 센다(예정 번호는 연말 예상치다)", y26.done, 215);
  check("예정까지 포함한 수는 따로 든다", y26.planned, 356);
  check("우리 쪽은 궤도 발사만 센다(탄도 비행을 섞으면 분모와 기준이 달라진다)", y26.ours, 3);
  check("그중 이미 일어난 것", y26.oursDone, 2);
  check("올해인지 표시한다", [y26.current, rows.find((r) => r.year === 2025).current], [true, false]);
  check("최신 연도부터", rows.map((r) => r.year), [2026, 2025]);
  check("기준값이 없는 해는 아예 말하지 않는다",
    ctx.orbitalYearStats([{ net: "2024-01-01T00:00:00Z", outcome: "success", orbit: "Low Earth Orbit" }], 2026), []);
  check("빈 목록에서도 죽지 않는다", [ctx.orbitalYearStats([], 2026), ctx.orbitalYearStats(null, 2026)], [[], []]);

  group("모수 문장 (orbitalYearNoteHtml)");
  const html = ctx.orbitalYearNoteHtml(L, 2026);
  check("올해는 '지금까지'로 적는다", html.includes("2026년 전 세계 궤도 발사 지금까지 <b>215건</b>"), true);
  check("우리 몫과 비율을 적는다", html.includes("<b>2건</b>(1%)"), true);
  check("예정까지 포함한 연말 수도 함께", html.includes("연말 <b>356건</b>"), true);
  check("지난 해는 '총'으로 적는다", html.includes("2025년 전 세계 궤도 발사 총 <b>263건</b>"), true);
  check("지난 해에는 연말 예정을 안 붙인다",
    ctx.orbitalYearNoteHtml([L[4]], 2026).includes("연말"), false);
  check("기준이 무엇인지 밝힌다(가장 최근 발사까지의 집계다)",
    html.includes("가장 최근 발사"), true);
  check("기준값이 없으면 아무 말도 안 한다(없는 말을 지어내지 않는다)",
    ctx.orbitalYearNoteHtml([{ net: "2026-01-01T00:00:00Z", outcome: "success" }], 2026), "");

  group("모수 배선 (통계 패널 · 상세 패널)");
  const { ctx: c2, state, el, map } = loadApp();
  state.map = map;
  map.stubSource("launches");
  map.stubSource("launch-track");
  state.allLaunches = L;
  state.loadedYears = new Set();
  state.truncatedYears = new Set();
  c2.showStats();
  check("통계 패널에 전 세계 모수가 실린다",
    el("stats-body").innerHTML.includes("전 세계 궤도 발사"), true);
  check("기존 모수 안내(P12-7)도 그대로 남아 있다 — 이제 무엇을 센 것인지까지 밝힌다",
    el("stats-body").innerHTML.includes("전체 기준"), true);
  // ⚠ 예전에는 `net_precision` 없이 열었는데, P24-1 이후로는 **모르면 순번을 안 말한다**
  //   (`focus.js` 와 같은 처리). 배선을 재려면 날짜가 확정된 발사로 열어야 한다.
  c2.openPanel({ id: "1", name: "테스트", outcome: "upcoming", net: "2026-12-01T00:00:00Z",
                 net_precision: "Minute", lat: 28.5, lng: -80.6, orbital_year_count: 356 });
  check("상세 패널의 맥락 줄에도 올해 순번이 실린다",
    el("panel-body").innerHTML.includes("전 세계 올해 356번째"), true);
}

// ── 시간대 표기 (P13-5) ──────────────────────────────────────────────────────
// 이 앱은 시간이 핵심인데 어느 시간대인지 어디에도 안 적혀 있었다.
// 조용히 깨지는 자리: 포맷터가 **갈라지는 것**(한쪽은 현지, 한쪽은 UTC) —
// 표기가 없는 것보다 나쁘다. 그리고 열린 화면을 안 고치면 옛 시각이 남는다.
// **단언은 UTC 모드와 현지↔UTC 차이로만 한다** — 실행 PC 의 시간대에 기대면 CI 에서 갈린다.
{
  const { ctx, state, el, sel, map } = loadApp();
  group("시간대 전환 (fmtDate · fmtClock · fmtPassTime)");
  // 아래 단언들은 "현지 ≠ UTC" 를 전제한다. 그 전제부터 확인한다 —
  // 전제가 깨진 환경(UTC 러너)에서는 테스트가 **통과처럼 보이지 않고** 여기서 먼저 걸린다.
  check("테스트 시간대가 UTC 가 아닌 곳으로 고정돼 있다",
    new Date("2026-05-01T23:30:00Z").getHours() !== 23, true);
  // UTC 기준 23:30 — 현지(UTC+9)로는 **다음 날**이 되어 날짜까지 갈린다(경계를 일부러 만든다)
  const ISO = "2026-05-01T23:30:00Z";
  state.timeZoneMode = "utc";
  // **로캘 문자열에 기대지 않는다.** Node 의 ICU 는 ko-KR 을 "AM 12:30" 으로 찍고
  // 앱(WebView2)은 "오전 12:30" 으로 찍는다 — 같은 코드가 환경에 따라 다른 글자를 낸다.
  check("UTC 모드는 UTC 날짜·시각으로 찍는다",
    [ctx.fmtDate(ISO).includes("2026. 05. 01."), ctx.fmtDate(ISO).includes("11:30")], [true, true]);
  check("UTC 모드 이름", ctx.tzName(), "UTC");
  check("접미사는 앞에 공백 하나", ctx.tzSuffix(), " UTC");
  check("요청할 때만 접미사를 붙인다(모든 시각에 붙이면 화면이 지저분해진다)",
    [ctx.fmtDate(ISO).includes("UTC"), ctx.fmtDate(ISO, true).includes("UTC")], [false, true]);
  const utcDate = ctx.fmtDate(ISO), utcClock = ctx.fmtClock(Date.parse(ISO));
  const utcPass = ctx.fmtPassTime(Date.parse(ISO));

  state.timeZoneMode = "local";
  check("현지 모드는 다른 값을 낸다(같으면 전환이 안 된 것이다)",
    [ctx.fmtDate(ISO) !== utcDate, ctx.fmtClock(Date.parse(ISO)) !== utcClock,
     ctx.fmtPassTime(Date.parse(ISO)) !== utcPass], [true, true, true]);
  check("현지 모드 이름은 UTC 가 아니다", ctx.tzName() === "UTC", false);
  check("미정·이상한 값에도 죽지 않는다",
    [ctx.fmtDate(null), ctx.fmtDate("언젠가"), ctx.fmtClock(NaN)], ["미정", "언젠가", ""]);

  group("네 포맷터가 같은 스위치를 본다");
  // 갈라지면 화면의 한쪽은 현지, 한쪽은 UTC 가 된다 — 표기가 없는 것보다 나쁘다.
  state.timeZoneMode = "utc";
  const u = [ctx.fmtDate(ISO), ctx.fmtClock(Date.parse(ISO)), ctx.fmtPassTime(Date.parse(ISO)),
             ctx.tlLabelDate(Date.parse(ISO))];
  state.timeZoneMode = "local";
  const l = [ctx.fmtDate(ISO), ctx.fmtClock(Date.parse(ISO)), ctx.fmtPassTime(Date.parse(ISO)),
             ctx.tlLabelDate(Date.parse(ISO))];
  check("fmtDate · fmtClock · fmtPassTime · 타임라인 라벨이 모두 모드를 따른다",
    u.map((v, i) => v !== l[i]), [true, true, true, true]);
  // 발사 윈도우도 같은 스위치를 본다(따로 만든 포맷이라 빠뜨리기 쉽다)
  // 종료는 시작보다 **뒤**여야 한다 — 앞서면 windowText 가 양쪽 다 null 을 내고,
  // 그러면 "같지 않다"는 단언이 통과처럼 보이는 게 아니라 공허하게 실패한다.
  const win = { window_start: ISO, window_end: "2026-05-02T02:30:00Z" };
  state.timeZoneMode = "utc";
  const wu = ctx.windowText(win);
  state.timeZoneMode = "local";
  check("발사 윈도우도 따른다", ctx.windowText(win) !== wu, true);

  // ── 포매터 캐시 (P20-1) ────────────────────────────────────────────────────
  // **이건 성능 수정이라 결과로는 드러나지 않는다** — 캐시를 통째로 빼도 화면은 똑같고,
  // 위의 단언은 전부 통과한다(2026-09-17 변이로 확인). 시간으로 재면 실행 PC 에 따라
  // 흔들리므로, **같은 옵션이면 같은 포매터 객체가 온다**는 것으로 잰다.
  group("날짜 포매터를 돌려쓴다 (P20-1)");
  const f1 = ctx.dateFormatter({ year: "numeric", month: "2-digit" });
  const f2 = ctx.dateFormatter({ year: "numeric", month: "2-digit" });
  check("같은 옵션이면 포매터를 새로 만들지 않는다", f1 === f2, true);
  check("옵션이 다르면 다른 포매터다",
    ctx.dateFormatter({ year: "numeric" }) === f1, false);
  // 시간대 모드가 옵션에 섞여 들어가므로 **모드가 바뀌면 키도 갈라져야 한다**.
  // 한 포매터에 갇히면 화면이 옛 시간대로 굳는데, 그건 조용한 고장이다.
  check("시간대가 섞이면 다른 포매터다",
    ctx.dateFormatter({ year: "numeric", timeZone: "UTC" }) === ctx.dateFormatter({ year: "numeric" }), false);
  // 모르는 시간대는 null 이고, **두 번째 호출도 null 이어야 한다**(실패를 캐시하므로).
  check("모르는 시간대는 두 번 불러도 null",
    [ctx.dateFormatter({ timeZone: "Mars/Olympus" }), ctx.dateFormatter({ timeZone: "Mars/Olympus" })],
    [null, null]);
  // 실패를 캐시한 뒤에도 **정상 옵션은 정상 포매터**여야 한다(캐시가 오염되지 않는가)
  check("실패 캐시가 다른 키를 오염시키지 않는다",
    ctx.dateFormatter({ year: "numeric", month: "2-digit" }) === f1, true);

// ── 슬라이더를 끄는 동안 (P20-3) ────────────────────────────────────────────
// 한 틱 22ms 중 20ms 를 **끄는 동안 읽지도 않는 목록**이 썼다(2026-09-17 실측).
// 끄는 동안(input)은 지도만, 놓을 때(change)는 목록까지 — 그게 실제로 그렇게 되는지 잰다.
{
  const { ctx, state, el, map, sel } = loadApp();
  group("슬라이더를 끄는 동안은 목록을 그리지 않는다 (P20-3)");
  state.map = map;
  for (const s of ["launches", "launch-heat"]) map.stubSource(s);
  sel[".flt:checked"] = [{ value: "upcoming" }, { value: "success" }];
  state.sidebarTab = "launches";
  state.favLaunches = new Set();
  state.allLaunches = Array.from({ length: 40 }, (_, i) => ({
    id: "s" + i, name: "발사 " + i, outcome: i % 2 ? "upcoming" : "success",
    net: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
    lat: 28.5, lng: -80.5,   // launchesToFC 는 lat/lng 를 본다(hasCoords)
  }));
  state.tlMin = Date.UTC(2026, 0, 1);
  state.tlMax = Date.UTC(2026, 0, 1) + 40 * 86400000;
  el("search").value = "";

  ctx.applyFilters();                                   // 기준선: 목록이 차 있다
  const before = el("sidebar-list").innerHTML;
  const rowsOf = (h) => (h.match(/class="sb-row"/g) || []).length;
  check("기준선 — 목록이 그려져 있다", rowsOf(before) > 0, true);

  // 끄는 중: 슬라이더를 절반으로
  el("tl-range").value = "50";
  const mapBefore = map.data("launches").features.length;
  ctx.onTimeline(true);
  check("끄는 동안 지도는 갱신된다",
    map.data("launches").features.length !== mapBefore, true);
  check("끄는 동안 목록 행은 그대로다", el("sidebar-list").innerHTML === before, true);
  // **건수는 살아 있어야 한다** — 목록만 멈추고 숫자까지 멈추면 화면이 거짓말을 한다
  check("끄는 동안에도 건수는 따라간다",
    el("sidebar-count").textContent, map.data("launches").features.length + "건");

  // 놓을 때: 목록이 따라잡는다
  ctx.onTimeline(false);
  check("놓으면 목록이 다시 그려진다", el("sidebar-list").innerHTML !== before, true);
  check("놓은 뒤 목록 행 수가 지도와 맞는다",
    rowsOf(el("sidebar-list").innerHTML), map.data("launches").features.length);

  // 다른 탭이면 건수도 건드리지 않는다(renderSidebar 와 같은 규칙)
  state.sidebarTab = "sats";
  el("sidebar-count").textContent = "건드리지마";
  el("tl-range").value = "70";
  ctx.onTimeline(true);
  check("다른 탭이면 건수를 건드리지 않는다", el("sidebar-count").textContent, "건드리지마");
}

// ⚠ `applyFilters` 는 `search` 의 `input` 에 **그대로** 걸려 있어 Event 객체가 인자로 온다.
// `if (opts)` 로 갈랐다면 검색이 조용히 목록을 안 그렸을 것이다 — 그 자리를 못 박아 둔다.
{
  const { ctx, state, el, map, sel } = loadApp();
  group("검색은 이벤트 객체를 받아도 목록을 그린다 (P20-3 의 함정)");
  state.map = map;
  for (const s of ["launches", "launch-heat"]) map.stubSource(s);
  sel[".flt:checked"] = [{ value: "success" }];
  state.sidebarTab = "launches";
  state.favLaunches = new Set();
  state.allLaunches = [{ id: "a", name: "발사 A", outcome: "success", net: "2026-01-01T00:00:00Z" }];
  el("search").value = "";
  ctx.bindUI();
  el("sidebar-list").innerHTML = "";
  el("search").fire("input", { type: "input", target: el("search") });  // 진짜 이벤트처럼
  check("검색 input 은 목록을 그린다",
    (el("sidebar-list").innerHTML.match(/class="sb-row"/g) || []).length, 1);
  check("countOnly 가 아닌 인자는 전체 렌더다",
    (function () {
      el("sidebar-list").innerHTML = "";
      ctx.applyFilters({ countOnly: "true" });   // 문자열은 true 가 아니다
      return (el("sidebar-list").innerHTML.match(/class="sb-row"/g) || []).length;
    })(), 1);
}

  group("시간대 배선 (버튼 · 설정 · 단축키)");
  const { ctx: c2, state: s2, el: e2, map: m2, sel: sel2, doc } = loadApp({
    api: { save_settings: (p) => saved.push(p) },
  });
  var saved = [];
  s2.map = m2;
  m2.stubSource("launches");
  m2.stubSource("launch-heat");
  s2.allLaunches = [];
  s2.sidebarTab = "launches";
  sel2[".flt:checked"] = [];
  c2.bindUI();
  check("bindUI 가 버튼에 클릭을 붙인다", !!e2("tz-btn").handlers.click, true);
  c2.applySettings({});
  check("설정이 없으면 현지 시각", s2.timeZoneMode, "local");
  check("버튼이 현재 시간대를 상시 보여준다(이게 이 기능의 표기 자체다)",
    e2("tz-btn").textContent.startsWith("🕓"), true);
  e2("tz-btn").fire("click");
  check("눌러서 UTC 로", [s2.timeZoneMode, e2("tz-btn").textContent], ["utc", "🕓UTC"]);
  e2("tz-btn").fire("click");
  check("다시 눌러서 현지로", s2.timeZoneMode, "local");

  c2.applySettings({ timeZone: "utc" });
  check("저장된 설정이 복원된다", s2.timeZoneMode, "utc");
  check("복원하면 버튼 문구도 같이 선다", e2("tz-btn").textContent, "🕓UTC");
  c2.applySettings({ timeZone: "이상한 값" });
  check("모르는 설정값은 현지로 본다", s2.timeZoneMode, "local");
  // applySettings 가 미리 정규화하므로, 모드 함수 자체의 기본값도 따로 재야 한다
  c2.setTimeZoneMode("이상한 값");
  check("모드 함수도 모르는 값이면 현지", s2.timeZoneMode, "local");
  c2.setTimeZoneMode("utc");
  check("utc 만 UTC 다", s2.timeZoneMode, "utc");

  c2.setTimeZoneMode("local");   // 앞 단언이 남긴 상태에 기대지 않는다
  doc.fire("keydown", { key: "t", target: { tagName: "BODY" }, preventDefault() {} });
  check("T 로도 바뀐다", s2.timeZoneMode, "utc");
  check("바뀔 때마다 설정에 남긴다", saved.filter((p) => p.timeZone).length > 0, true);
  check("입력 중 t 는 글자다",
    ctx.keyAction({ key: "t", target: { tagName: "INPUT" } }), null);
}

// ── 관측 위치 지정 (P13-6) ───────────────────────────────────────────────────
// 통과 예측·오늘 밤은 관측 위치가 있어야 도는데 길이 지도 클릭 하나뿐이었고,
// 안내는 "위성 패널의 관측지 지정을 누르라"인데 **그 버튼은 위성을 골라야 나타난다** —
// 시작할 수 없는 안내였다. 조용히 깨지는 자리: 위도/경도 순서와 남/서 부호.
{
  const { ctx, state: st0 } = loadApp();
  group("좌표 입력 (parseLatLng)");
  const P = (t) => ctx.parseLatLng(t);
  check("쉼표 구분", P("37.5665, 126.978"), { lat: 37.5665, lng: 126.978 });
  check("공백 구분", P("37.5665 126.978"), { lat: 37.5665, lng: 126.978 });
  check("첫 숫자가 위도다(뒤집히면 엉뚱한 하늘을 계산한다)", P("35.0 139.0").lat, 35);
  check("음수", P("-33.87, 151.21"), { lat: -33.87, lng: 151.21 });
  check("남/서 표기를 음수로", P("S33.87 E151.21"), { lat: -33.87, lng: 151.21 });
  check("W 는 경도를 음수로", P("40.71 W74.01"), { lat: 40.71, lng: -74.01 });
  check("범위를 벗어나면 거부", [P("91, 0"), P("0, 181"), P("-91, 0")], [null, null, null]);
  check("숫자가 모자라면 거부", [P("37.5"), P("서울"), P(""), P(null)], [null, null, null, null]);

  group("장소 검색 (searchPlaces)");
  const LAUNCHES = [
    { location_name: "Kennedy Space Center, FL, USA", lat: 28.5, lng: -80.6 },
    { location_name: "Kennedy Space Center, FL, USA", lat: 28.5, lng: -80.6 },  // 중복
    { location_name: "좌표 없는 발사장", lat: null, lng: null },
  ];
  check("한글 도시", ctx.searchPlaces("서울", []).map((r) => r.name), ["서울"]);
  check("영문 이름으로도", ctx.searchPlaces("seoul", []).map((r) => r.name), ["서울"]);
  check("부분 일치", ctx.searchPlaces("san", []).length > 0, true);
  check("이미 가진 발사장도 함께 찾는다(데이터가 있으니 요청이 0이다)",
    ctx.searchPlaces("kennedy", LAUNCHES).map((r) => [r.name, r.sub]),
    [["Kennedy Space Center, FL, USA", "발사장"]]);
  check("같은 발사장은 한 번만", ctx.searchPlaces("kennedy", LAUNCHES).length, 1);
  check("좌표 없는 발사장은 후보가 아니다", ctx.searchPlaces("좌표 없는", LAUNCHES), []);
  check("빈 검색어는 아무것도 안 낸다", [ctx.searchPlaces("", LAUNCHES), ctx.searchPlaces("  ", [])], [[], []]);
  check("결과는 상한까지만", ctx.searchPlaces("a", []).length <= 8, true);

  group("도시 목록 불변식");
  // 손으로 적은 표라 오타가 조용히 섞인다 — 좌표가 지구 위인지, 한국 도시가 한국에 있는지 잰다.
  check("모든 좌표가 유효 범위", st0.CITIES.every((c) => ctx.validLatLng(c.lat, c.lng)), true);
  check("이름이 겹치지 않는다",
    new Set(st0.CITIES.map((c) => c.ko)).size, st0.CITIES.length);
  const KR = ["서울", "부산", "제주", "속초", "여수"];
  check("한국 도시는 한반도 범위 안에 있다",
    KR.every((n) => {
      const c = st0.CITIES.find((x) => x.ko === n);
      return c && c.lat > 33 && c.lat < 39 && c.lng > 124 && c.lng < 132;
    }), true);
  check("남반구 도시는 위도가 음수다",
    ["시드니", "산티아고", "케이프타운"].every((n) => st0.CITIES.find((x) => x.ko === n).lat < 0), true);
  check("서반구 도시는 경도가 음수다",
    ["뉴욕", "리마", "밴쿠버"].every((n) => st0.CITIES.find((x) => x.ko === n).lng < 0), true);

  group("관측 위치 세우기 (setObserver)");
  const { ctx: c2, state, el, map, sel } = loadApp({ api: { save_settings: (p) => saved.push(p) } });
  var saved = [];
  state.map = map;
  state.sidebarTab = "sats";
  state.allLaunches = [];
  c2.setObserver(37.5665, 126.9780, "서울");
  check("좌표를 세운다(소수 4자리로 맞춘다)", state.observer, { lat: 37.5665, lng: 126.978, label: "서울" });
  check("설정에 저장한다", saved.some((p) => p.observer && p.observer.label === "서울"), true);
  check("사람이 읽는 말로", c2.observerLabel(), "서울 (37.57°, 126.98°)");
  check("이름이 없으면 좌표만", (c2.setObserver(0, 0), c2.observerLabel()), "0.00°, 0.00°");
  check("범위 밖은 세우지 않는다(옛 위치가 남는다)",
    [c2.setObserver(999, 0), state.observer.lat], [false, 0]);

  group("관측 위치 배선 (팝오버 · 오늘 밤 · 지도 클릭)");
  var saved3 = [];
  const { ctx: c3, state: s3, el: e3, map: m3, doc } = loadApp({
    api: { save_settings: (p) => saved3.push(p) },
  });
  s3.map = m3;
  s3.allLaunches = [];
  s3.sidebarTab = "tonight";
  s3.satrecs = [];
  c3.bindUI();
  check("bindUI 가 관측 버튼에 클릭을 붙인다", !!e3("sat-obs-btn").handlers.click, true);
  check("처음엔 팝오버가 닫혀 있다", e3("obs-popover").hidden, true);
  e3("sat-obs-btn").fire("click");
  check("버튼이 팝오버를 연다(예전엔 곧바로 지도 클릭 모드였다)", e3("obs-popover").hidden, false);
  check("팝오버에 검색·좌표·지도 클릭이 다 있다",
    ["obs-search", "obs-coord", "obs-map-btn"].every((id) => e3("obs-popover").innerHTML.includes(id)), true);
  e3("sat-obs-btn").fire("click");
  check("다시 누르면 닫힌다", e3("obs-popover").hidden, true);

  // 오늘 밤 탭 — 위성을 고르지 않아도 여기서 관측지를 정할 수 있어야 한다
  s3.observer = null;
  c3.renderTonightList();
  check("관측지가 없으면 바로 정할 버튼을 준다(예전 안내는 시작할 수 없었다)",
    e3("sidebar-list").innerHTML.includes("tonight-obs-btn"), true);

  // 지도 클릭도 같은 한 곳(setObserver)을 탄다.
  // **핸들러를 다는 것은 setupSatelliteLayer 의 책임**이라 그 경로를 실제로 태운다 —
  // 직접 onMapClickForObserver 를 부르면 "지도에 붙었는가"는 못 재고 로직만 재게 된다.
  c3.setupSatelliteLayer();
  check("지도에 click 핸들러가 붙는다", m3.has("click"), true);
  s3.settingObserver = true;
  m3.fire("click", { lngLat: { lat: 35.1, lng: 129.0 } });
  check("지도 클릭도 같은 경로로 세운다", [s3.observer.lat, s3.observer.lng], [35.1, 129]);
  check("클릭 모드가 풀린다", s3.settingObserver, false);
  // setObserver 를 타야 하는 **이유**를 잰다 — 좌표만 보면 직접 대입해도 통과한다.
  check("지도 클릭도 설정에 저장한다", saved3.some((p) => p.observer && p.observer.lat === 35.1), true);
  check("지도 클릭도 통과 예측 버튼을 켠다", e3("sat-pass-btn").disabled, false);

  group("Esc 우선순위에 팝오버가 낀다");
  check("팝오버가 사이드바보다 먼저 닫힌다",
    ctx.escapeTarget({ obsPopover: true, sidebar: true }), "obsPopover");
  check("상세 패널이 팝오버보다 먼저", ctx.escapeTarget({ obsPopover: true, panel: true }), "panel");
}

// ── 발사대 재사용 간격·발사장 통산 (P13-3) ──────────────────────────────────
// 실측(라이브 100건): 재사용 간격 92/100(2.79일 ~ 1541일) · 발사장 통산 100/100.
// 조용히 깨지는 자리: 단위 선택(둘 다 "일"로 찍으면 어느 쪽도 안 읽힌다)과
// 예정 발사의 번호를 통산에 섞는 것(P13-2 에서 이미 141건을 부풀렸던 그 함정).
{
  const { ctx } = loadApp();
  group("재사용 간격 표기 (turnaroundText)");
  const T2 = (sec) => ctx.turnaroundText(sec);
  check("한 시간 미만은 분", T2(35 * 60), "35분");
  check("하루 미만은 시간", T2(7 * 3600), "7시간");
  check("열흘 미만은 소수 한 자리(2.79일이 실측 최단이다)", T2(2.79 * 86400), "2.8일");
  check("열흘 이상은 정수 일", T2(41 * 86400), "41일");
  check("두 달 넘으면 개월", T2(200 * 86400), "7개월");
  check("두 해 넘으면 년(1541일이 실측 최장이다)", T2(1541 * 86400), "4.2년");
  check("없거나 이상한 값은 말하지 않는다",
    [T2(0), T2(-5), T2(null), T2(undefined), T2(NaN), T2("63일")],
    [null, null, null, null, null, null]);

  group("발사장 통산 (siteTotals)");
  const L = [
    { outcome: "success", location_count: 1686 },
    { outcome: "failure", location_count: 1687 },
    { outcome: "upcoming", location_count: 1690 },   // 아직 일어나지 않았다
    { outcome: "success" },                          // 기준값 없음
  ];
  check("이미 일어난 발사만 통산으로 본다", ctx.siteTotals(L).total, 1687);
  check("우리 표본은 일어난 것만 센다", ctx.siteTotals(L).ours, 3);
  check("기준값이 없으면 말하지 않는다",
    [ctx.siteTotals([{ outcome: "success" }]), ctx.siteTotals([]), ctx.siteTotals(null)],
    [null, null, null]);
  check("예정뿐이면 말하지 않는다",
    ctx.siteTotals([{ outcome: "upcoming", location_count: 9 }]), null);
  const html = ctx.siteTotalsHtml(L);
  check("통산과 우리 몫을 적는다", html.includes("<b>1,687회</b>") && html.includes("<b>3건</b>"), true);
  check("기준이 무엇인지 밝힌다", html.includes("가장 최근 발사"), true);
  check("기준값이 없으면 빈 문자열", ctx.siteTotalsHtml([]), "");

  group("맥락 줄의 두 기준 (countPair · P15-1)");
  check("통산과 올해를 한 조각으로",
    ctx.countPair("이 발사대", 296, 58, "올해"), "이 발사대 296번째(올해 58)");
  check("올해와 통산도 같은 수법으로",
    ctx.countPair("SpaceX 올해", 108, 727, "통산"), "SpaceX 올해 108번째(통산 727)");
  // 새로 만든 발사대는 통산 1 · 올해 1 로 온다 — 괄호가 정보량 0이다(실측에서 나왔다)
  check("둘이 같으면 괄호를 안 붙인다", ctx.countPair("이 발사대", 1, 1, "올해"), "이 발사대 1번째");
  check("반쪽이 없으면 괄호를 안 붙인다", ctx.countPair("이 발사대", 120, null, "올해"), "이 발사대 120번째");
  // orbital_count 는 옛 발사에서 0 으로 온다(픽스처 실측) — null 과 같이 걸러야 한다
  check("반쪽이 0 이어도 안 붙인다", ctx.countPair("전 세계 올해", 207, 0, "통산"), "전 세계 올해 207번째");
  check("본체가 없으면 조각 자체가 없다", ctx.countPair("이 발사대", null, 58, "올해"), null);
  check("본체가 0 이어도 조각이 없다", ctx.countPair("이 발사대", 0, 58, "올해"), null);
  check("네 자리는 쉼표를 넣는다",
    ctx.countPair("전 세계 올해", 214, 7387, "통산"), "전 세계 올해 214번째(통산 7,387)");

  group("배선 (상세 패널 맥락 · 발사장 관점 화면)");
  const { ctx: c2, state, el, map } = loadApp();
  state.map = map;
  map.stubSource("launches");
  map.stubSource("launch-track");
  state.loadedYears = new Set();
  state.truncatedYears = new Set();
  const d = { id: "1", name: "테스트", outcome: "success", net: "2026-05-01T00:00:00Z",
              lat: 34.6, lng: -120.6, location_name: "Vandenberg SFB, CA, USA",
              pad_count: 120, location_count: 812, pad_turnaround_sec: 2.79 * 86400,
              pad_year_count: 9, location_year_count: 31, provider: "SpaceX",
              agency_year_count: 108, agency_count: 727,
              orbital_year_count: 214, orbital_count: 7387,
              rocket_spec: { cost: 52000000, leo_capacity: 22800, gto_capacity: 8300,
                             total: 500, fail: 0, land_att: 620, land_ok: 615, land_streak: 315 },
              provider_landings: { att: 699, ok: 671, fail: 29, streak: 20 },
              last_updated: new Date(Date.now() - 3 * 86400000).toISOString(),
              mission_agencies: [{ name: "United States Space Force", abbrev: "USSF", type: "Government" }] };
  c2.openPanel(d);
  const body = el("panel-body").innerHTML;
  check("맥락 줄에 재사용 간격이 실린다", body.includes("직전 발사로부터 2.8일 만"), true);
  check("맥락 줄에 발사장 통산이 실린다", body.includes("이 발사장 통산 812번째"), true);
  check("기존 항목(발사대 순번)도 그대로", body.includes("이 발사대 120번째"), true);
  // 네 축이 전부 두 기준을 말하는지 — 배선이 끊기면 순수 함수는 통과하고 화면만 반쪽이 된다
  check("발사대 — 올해가 붙는다", body.includes("이 발사대 120번째(올해 9)"), true);
  check("발사장 — 올해가 붙는다", body.includes("이 발사장 통산 812번째(올해 31)"), true);
  check("기관 — 통산이 붙는다", body.includes("SpaceX 올해 108번째(통산 727)"), true);
  check("전 세계 — 통산이 붙고 '궤도 발사'가 뒤에 온다",
    body.includes("전 세계 올해 214번째(통산 7,387) 궤도 발사"), true);
  // 제원 블록의 새 두 줄이 패널까지 실제로 오는가(P15-2) — 직접 부르는 단언만으로는 안 잡힌다
  check("패널에 공시 발사가가 실린다", body.includes("5,200만 달러"), true);
  check("패널에 kg 당이 실린다", body.includes("$2,281"), true);
  check("패널에 GTO 탑재량이 실린다", body.includes("GTO 탑재량") && body.includes("8.3 t"), true);
  check("패널에 참여 기관이 실린다", body.includes("참여 기관") && body.includes("USSF (정부)"), true);
  check("패널에 로켓 착륙 통산이 실린다", body.includes("착륙 620회 시도"), true);
  check("패널에 정보 갱신 시각이 실린다", body.includes("정보 갱신") && body.includes("3일 전"), true);
  // 반쪽이 없는 옛 캐시(스키마 3)로도 죽지 않고 예전 문장을 낸다
  c2.openPanel({ id: "2", name: "옛 캐시", outcome: "success", net: "2026-05-01T00:00:00Z",
                 pad_count: 120, location_count: 812 });
  const oldBody = el("panel-body").innerHTML;
  check("옛 캐시 — 괄호 없이 예전 그대로", oldBody.includes("이 발사대 120번째 ·"), true);
  check("옛 캐시 — 빈 괄호를 남기지 않는다", oldBody.includes("(올해"), false);
  c2.openPanel(d);

  state.allLaunches = [d];
  c2.showEntityStats("site", "Vandenberg SFB, CA, USA");
  check("발사장 관점 화면에 통산이 실린다",
    el("stats-body").innerHTML.includes("이 발사장은 통산"), true);
  // 기관 관점에만 착륙 성적이 붙는다 — 발사장 관점에 붙이면 의미가 다른 숫자가 된다
  check("발사장 관점에는 착륙 성적이 안 붙는다",
    el("stats-body").innerHTML.includes("착륙 699회"), false);
  state.allLaunches = [Object.assign({}, d, { provider: "SpaceX" })];
  c2.showEntityStats("provider", "SpaceX");
  check("기관 관점 화면에 착륙 성적이 실린다",
    el("stats-body").innerHTML.includes("착륙 699회 시도"), true);
  // 로켓·기관 관점에는 발사장 통산이 의미가 없다 — 붙이면 거짓말이 된다
  c2.showEntityStats("rocket", "없는 로켓");
  const before = el("stats-body").innerHTML;
  state.allLaunches = [Object.assign({}, d, { rocket: "Falcon 9" })];
  c2.showEntityStats("rocket", "Falcon 9");
  check("로켓 관점에는 붙지 않는다",
    el("stats-body").innerHTML.includes("이 발사장은 통산"), false);
}

// ── 오늘 밤 탭이 관측지가 있을 때 실제로 도는가 (2026-09-12 정기 점검) ─────────
// **도입(v1.7.0) 이래 줄곧 죽어 있었다**: `favSats` 는 Set 인데 `.includes()` 를 불러
// tonightTargets 에서 TypeError 가 났다. 탭이 안 바뀔 뿐 화면에는 오류가 안 보인다.
// 기존 테스트는 **관측지가 없는 경로만** 덮고 있었다 — 막힌 안내가 나오는 쪽이라 예외가 안 났다.
{
  const { ctx, state, el, map } = loadApp({ realSatellite: true });
  group("오늘 밤 탭 — 관측지가 있을 때");
  state.map = map;
  state.sidebarTab = "tonight";
  state.observer = { lat: 37.5665, lng: 126.978, label: "서울" };
  state.satrecs = [];
  ctx.renderTonightList();
  check("위성이 없으면 그 이유를 말한다(예외로 죽지 않는다)",
    el("sidebar-list").innerHTML.includes("위성 데이터"), true);

  // 관심 위성이 있는 상태 — 여기서 favSats 를 만진다(버그가 났던 자리)
  state.favSats = new Set(["25544"]);
  const tle1 = "1 25544U 98067A   26255.50000000  .00016717  00000-0  10270-3 0  9005";
  const tle2 = "2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.72125391563537";
  const rec = ctx.satellite.twoline2satrec(tle1, tle2);
  state.satrecs = [{ name: "ISS (ZARYA)", norad: 25544, rec: rec }];
  check("대상 목록이 나온다(Set 에 .includes 를 부르면 여기서 예외로 죽는다)",
    ctx.tonightTargets().map((t) => t.norad), [25544]);
  // rec 없는 항목은 통과 계산에서 죽으므로 걸러야 한다
  state.satrecs = [{ name: "ISS (ZARYA)", norad: 25544, rec: rec },
                   { name: "레코드 없음", norad: 40000, rec: null },
                   { name: "중복", norad: 25544, rec: rec }];
  check("rec 없는 항목은 빼고, 같은 NORAD 는 한 번만",
    ctx.tonightTargets().map((t) => t.norad), [25544]);
  state.satrecs = [{ name: "ISS (ZARYA)", norad: 25544, rec: rec }];

  // 전체 경로 — 예외 없이 목록이나 "없음" 안내 중 하나가 나와야 한다
  ctx.renderTonightList();
  const html = el("sidebar-list").innerHTML;
  check("관측지가 있으면 목록을 그리거나 '보이는 통과 없음'을 말한다(둘 다 아니면 죽은 것이다)",
    html.includes("sb-row") || html.includes("눈에 보이는 통과가 없습니다"), true);
  check("막힌 안내가 아니다", html.includes("관측 위치가 필요합니다"), false);
}
// ── "오늘 밤" 계산을 조각으로 나눈다 (2026-09-16) ────────────────────────────
// 전에는 한 번에 다 돌았다 — 실측 **위성당 약 50ms**, 1,000건 52.8초 · 2,925건 115초.
// 그동안 UI 스레드가 잡혀 **앱 전체가 얼어붙는다**. 기본 그룹(176건)으로도 9초라
// "큰 그룹을 켜야만 나는 문제"가 아니었다. 예외는 안 나고 **앱이 멈출 뿐**이라
// 도입(v1.7.0) 이래 테스트가 전부 초록이었다.
{
  const { ctx, state, map } = loadApp({ realSatellite: true });
  group("오늘 밤 대상 (저궤도만)");
  state.map = map;
  state.observer = { lat: 37.5665, lng: 126.978, label: "서울" };
  const rec = ctx.satellite.twoline2satrec(
    "1 25544U 98067A   26255.50000000  .00016717  00000-0  10270-3 0  9005",
    "2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.72125391563537");
  state.satrecs = [
    { name: "LEO", norad: 1, rec: rec, band: "leo" },
    { name: "GEO", norad: 2, rec: rec, band: "geo" },
    { name: "MEO", norad: 3, rec: rec, band: "meo" },
    { name: "대역 미상", norad: 4, rec: rec },
  ];
  // GEO 는 200건에 14.3초로 **가장 비싼데** 육안 대상이 아니다(등급 10 이상).
  // 이 탭의 이름이 곧 기준이다 — *눈으로 볼 만한* 통과.
  check("GEO·MEO 는 대상에서 뺀다", ctx.tonightTargets().map((t) => t.norad), [1, 4]);
  check("대역을 모르는 것은 남긴다(정보가 없다고 버리지 않는다)",
    ctx.tonightTargets().some((t) => t.norad === 4), true);

  group("오늘 밤 계산 조각 (tonightJob)");
  state.satrecs = [1, 2, 3, 4, 5].map((n) => ({ name: "S" + n, norad: n, rec: rec, band: "leo" }));
  // **시각을 고정한다.** 예전에는 둘 다 `Date.now()` 를 써서, 조각 계산과 한 번에 계산
  // 사이에 흐른 시간만큼 최대고도가 달라졌다 — 로컬에서는 빨라서 안 보이고 **CI 에서만
  // 반올림 경계를 넘어 빨개졌다**(2026-09-22 실측: `67` 대 `66`). 전역 규칙이 말하는
  // *"순수 함수는 고정 시각·합성 입력으로"* 가 정확히 이 자리다.
  const FIXED_NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
  const job = ctx.tonightJob(state.observer, undefined, undefined, FIXED_NOW);
  check("대상 수를 미리 안다(진행률을 말할 수 있다)", job.total, 5);
  check("시작 전에는 끝난 것이 아니다", job.done, false);
  check("한 조각만 돌 수 있다", (job.step(2), job.done), false);
  check("진행률이 는다", job.progress, 0.4);
  job.step(2);
  check("아직 남았다", job.done, false);
  check("마지막 조각에서 끝난다", job.step(2), true);
  check("끝나면 진행률은 1", job.progress, 1);

  // **쪼개서 돌아도 결과가 같아야 한다** — 이게 이 변경의 유일한 위험이다
  const chunked = job.result();
  const whole = ctx.computeTonight(state.observer, undefined, undefined, FIXED_NOW);
  check("조각으로 돈 결과가 한 번에 돈 것과 같다",
    chunked.map((r) => r.norad + ":" + Math.round(r.pass.maxEl)),
    whole.map((r) => r.norad + ":" + Math.round(r.pass.maxEl)));
  check("대상이 없으면 즉시 끝난다(빈 화면에서 헛돌지 않는다)",
    (state.satrecs = [], ctx.tonightJob(state.observer).done), true);

  // **고정 시각이 실제로 무엇을 막는지**를 한 줄로 못 박는다. 시각을 넘기지 않으면
  // 두 계산이 각자 "지금"을 쓰고, 그 사이에 흐른 시간만큼 결과가 갈린다 —
  // 로컬(0.3초)에서는 안 보이고 **느린 CI 에서만** 반올림 경계를 넘는다(실측: 8초 차이에서 67→63).
  // 같은 시각을 넘기면 **간격이 얼마든 같아야 한다.**
  state.satrecs = [1, 2, 3].map((n) => ({ name: "S" + n, norad: n, rec: rec, band: "leo" }));
  const A = ctx.computeTonight(state.observer, undefined, undefined, FIXED_NOW);
  const B = ctx.computeTonight(state.observer, undefined, undefined, FIXED_NOW + 8000);
  const C = ctx.computeTonight(state.observer, undefined, undefined, FIXED_NOW);
  const peak = (rows) => rows.map((r) => r.norad + ":" + Math.round(r.pass.maxEl)).join(",");
  check("같은 시각을 주면 언제 불러도 결과가 같다", peak(A), peak(C));
  check("시각이 8초만 달라도 결과가 달라진다(그래서 고정해야 한다)", peak(A) !== peak(B), true);
}
{
  // 렌더가 **실제로 쪼개 도는가.** setTimeout 을 테스트가 들고 있다가 직접 돌린다 —
  // 이걸 안 하면 "진행 표시가 뜬다"까지만 보고 이어지는지는 못 잰다.
  const { ctx, state, el, map } = loadApp({ realSatellite: true });
  group("오늘 밤 렌더 (조각 실행·취소)");
  state.map = map;
  state.sidebarTab = "tonight";
  state.observer = { lat: 37.5665, lng: 126.978, label: "서울" };
  const rec = ctx.satellite.twoline2satrec(
    "1 25544U 98067A   26255.50000000  .00016717  00000-0  10270-3 0  9005",
    "2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.72125391563537");
  state.satrecs = Array.from({ length: 30 },
    (_, i) => ({ name: "S" + i, norad: i + 1, rec: rec, band: "leo" }));

  const queue = [];
  ctx.setTimeout = (fn) => { queue.push(fn); return queue.length; };

  ctx.renderTonightList();
  check("첫 조각은 바로 돈다(누르자마자 반응이 있다)", queue.length, 1);
  check("아직 끝나지 않았으면 진행률을 보여준다",
    el("sidebar-list").innerHTML.includes("찾는 중"), true);
  check("몇 개를 보는지도 말한다", el("sidebar-list").innerHTML.includes("30개"), true);
  check("그동안 건수 자리는 계산 중이라고 적는다", el("sidebar-count").textContent, "계산 중");

  // 큐에서 꺼내 부를 때 **방어 없이 집지 않는다** — 예약이 빠지는 변이에서 단언이
  // 실패하는 대신 TypeError 로 죽어 뒤 테스트가 통째로 안 돈다(2026-09-16 에 실제로 그랬다).
  const next = queue.shift();
  check("다음 조각이 함수로 예약돼 있다", typeof next, "function");
  // **조각 크기에 기대지 않는다** — `TONIGHT_CHUNK` 를 조정하면 몇 조각인지가 달라진다
  // (25→10 으로 줄이자 이 테스트가 깨졌다). 예약된 것을 다 비울 때까지 돌린다.
  if (typeof next === "function") next();
  let guard = 0;
  while (queue.length && guard++ < 100) queue.shift()();
  check("이어 돌면 목록이 완성된다",
    el("sidebar-list").innerHTML.includes("찾는 중"), false);
  check("끝나면 건수가 숫자로 바뀐다", /^\d+건$/.test(el("sidebar-count").textContent), true);

  // **취소**: 계산 중에 탭이 바뀌면 뒤늦은 조각이 화면을 덮으면 안 된다
  queue.length = 0;
  ctx.renderTonightList();
  const pending = queue.shift();
  check("취소 실험을 할 조각이 예약돼 있다", typeof pending, "function");
  state.sidebarTab = "launches";
  ctx.renderSidebar([]);                       // 다른 탭이 화면을 차지한다
  state.tonightToken++;                        // 새 렌더가 일어난 것과 같은 상태
  const before = el("sidebar-list").innerHTML;
  if (typeof pending === "function") pending();   // 뒤늦은 조각이 도착
  check("취소된 계산은 화면을 덮지 않는다", el("sidebar-list").innerHTML, before);
}

// ── 동적 배선을 실제로 눌러 본다 (P39) ───────────────────────────────────────
// `bindUI()` 의 배선은 P23-1 이후 전수로 잰다(WIRING·PRESSES). 그런데 **화면을 그리면서
// 붙는 배선**(`innerHTML` 로 만든 버튼에 그 자리에서 `addEventListener`)은 한 번도 전수로
// 재지 않았다. 2026-09-23 에 25개를 하나씩 무력화해 봤더니 **22개가 전부 초록으로
// 통과**했다 — 관심 버튼 · 임박 발사 카드의 버튼 셋 · 관측 위치 팝오버 전부 · 위성
// 그룹/대역/종류/소유국 체크박스 · 통계의 발사 행 · 상세 패널의 링크 · 업데이트 배지 ·
// 오프라인 배지 · 오류 배너 닫기 · 발사대 목록 행이 **통째로 죽어도 아무 테스트도
// 실패하지 않았다.**
//
// 여기서는 그 배선들을 **실제로 눌러** 효과까지 단언한다. 누르는 것만으로는 모자라다
// (P12-23) — 무엇이 바뀌었는지를 본다.
(async () => {
  const mkLaunch = (over) => Object.assign({
    id: "L1", name: "테스트 발사", net: "2026-09-25T00:00:00Z", outcome: "upcoming",
    lat: 28.5, lng: -80.5, location_name: "Cape Canaveral", provider: "SpaceX",
    rocket: "Falcon 9", net_precision: "Second",
  }, over || {});

  // ── 임박 발사 카드 (focus.js) — 닫기 · 중계 · 발사장 보기 ───────────────────
  {
    const { ctx, state, el, map, api } = loadApp();
    group("동적 배선: 임박 발사 카드 (P39)");
    state.map = map; map.stubSource("launches");
    const d = mkLaunch({ vid_urls: [{ url: "https://example.com/live", title: "생중계" }] });
    state.allLaunches = [d];
    ctx.renderFocus(d);

    check("닫기 전에는 이 발사가 걸러지지 않는다", ctx.pickFocusLaunch([d], Date.parse(d.net) - 60000, state.focusDismissed) != null, true);
    el("focus-close").fire("click", {});
    check("✕ 를 누르면 그 발사를 다시 안 띄운다",
      ctx.pickFocusLaunch([d], Date.parse(d.net) - 60000, state.focusDismissed), null);

    ctx.renderFocus(d);
    let opened = null;
    api.open_url = (u) => { opened = u; return true; };
    const vb = el("focus-live-btn");
    if (vb.handlers.click) vb.fire("click", {});
    check("▶ 중계 버튼은 외부 브라우저로 보낸다", opened != null, true);

    el("focus-open").fire("click", {});
    check("`발사장 보기` 는 상세 패널을 연다", el("panel").classList.contains("hidden"), false);
  }

  // ── 관심 버튼 (favorites.js) ────────────────────────────────────────────────
  {
    const { ctx, state, el, map } = loadApp();
    group("동적 배선: 관심 버튼 (P39)");
    state.map = map;
    for (const src of ["launches", "launch-heat", "launch-track", "sats"]) map.stubSource(src);
    const host = el("panel-body");
    host.innerHTML = ctx.favBtnHtml("launch", "L1");
    ctx.bindFavBtn(host);
    check("처음에는 관심이 아니다", ctx.isFavLaunch("L1"), false);
    el("fav-btn").fire("click", {});
    check("누르면 관심에 들어간다", ctx.isFavLaunch("L1"), true);
    el("fav-btn").fire("click", {});
    check("다시 누르면 빠진다", ctx.isFavLaunch("L1"), false);

    // 위성 쪽도 같은 버튼을 쓴다 — 분기가 뒤바뀌면 발사가 위성 목록에 들어간다(P28-2)
    host.innerHTML = ctx.favBtnHtml("sat", "25544");
    ctx.bindFavBtn(host);
    el("fav-btn").fire("click", {});
    check("위성 버튼은 위성 관심으로 간다", ctx.isFavSat("25544"), true);
    check("발사 관심은 건드리지 않는다", ctx.isFavLaunch("25544"), false);

    // **관심 탭이 열려 있으면 그 자리에서 바뀐다** — 안 그리면 방금 별을 뗀 위성이
    // 목록에 그대로 남아 "안 지워졌다"로 보인다.
    state.sidebarTab = "favs";
    el("sidebar-list").innerHTML = "";
    ctx.toggleFavSat("25544");                  // 뗀다
    check("관심 탭이면 그 자리에서 다시 그린다",
      el("sidebar-list").innerHTML.length > 0, true);
    check("실제로 관심에서 빠졌다", ctx.isFavSat("25544"), false);

    // 다른 탭이면 건드리지 않는다 — 안 보이는 것을 그리지 않는다
    state.sidebarTab = "launches";
    el("sidebar-list").innerHTML = "손대지 않아야 한다";
    ctx.toggleFavSat("25544");
    check("다른 탭이면 관심 목록을 그리지 않는다",
      el("sidebar-list").innerHTML, "손대지 않아야 한다");
  }

  // ── 관측 위치 팝오버 (observer.js) — 검색 · 결과 행 · 좌표 · 지도 · 해제 ────
  {
    const { ctx, state, el, map } = loadApp();
    group("동적 배선: 관측 위치 팝오버 (P39)");
    state.map = map;
    state.allLaunches = [mkLaunch({ location_name: "Cape Canaveral" })];
    ctx.openObsPopover();

    // 검색창 입력 → 결과 목록이 그려진다
    const search = el("obs-search");
    search.value = "Cape";
    search.fire("input", {});
    check("검색창에 치면 결과가 그려진다", el("obs-results").innerHTML.includes("obs-row"), true);

    // 결과 행 클릭 → 관측지가 정해진다
    const rows = ctx.searchPlaces("Cape", state.allLaunches);
    check("검색이 실제로 한 곳을 찾았다", rows.length > 0, true);
    const rowStub = el("obs-row-stub");
    rowStub.dataset.i = "0";
    el("obs-results").sel[".obs-row"] = [rowStub];
    ctx.renderObsResults("Cape");            // 다시 그려 배선을 건다
    rowStub.fire("click", {});
    check("결과를 누르면 관측지가 정해진다", state.observer != null, true);
    check("고르면 팝오버가 닫힌다", el("obs-popover").classList.contains("hidden"), true);

    // 좌표 직접 입력
    ctx.openObsPopover();
    const coord = el("obs-coord");
    coord.value = "37.5665, 126.978";
    coord.fire("change", {});
    check("좌표를 넣으면 그 자리로 정해진다",
      state.observer && Math.round(state.observer.lat), 38);

    // 잘못된 좌표는 사람 말로 되돌려준다(설정은 그대로)
    ctx.openObsPopover();
    const before = state.observer;
    el("obs-coord").value = "여기요";
    el("obs-coord").fire("change", {});
    check("못 읽는 좌표는 안내만 한다", el("obs-coord-msg").textContent.includes("두 숫자"), true);
    check("못 읽었으면 관측지를 바꾸지 않는다", state.observer, before);

    // 지도에서 클릭 — 팝오버를 닫고 지도 선택 모드로
    ctx.openObsPopover();
    el("obs-map-btn").fire("click", {});
    check("`지도에서 클릭` 은 팝오버를 닫는다", el("obs-popover").classList.contains("hidden"), true);

    // 해제 — 관측지가 있을 때만 버튼이 그려진다
    ctx.openObsPopover();
    check("관측지가 있으면 해제 버튼이 그려진다",
      el("obs-popover").innerHTML.includes("obs-clear-btn"), true);
    el("obs-clear-btn").fire("click", {});
    check("해제를 누르면 관측지가 사라진다", state.observer, null);
  }

  // ── 위성 필터 체크박스 (satfilter.js) — 그룹 · 대역 · 종류 · 소유국 ─────────
  await (async () => {
    const { ctx, state, el, map, api, sel } = loadApp();
    group("동적 배선: 위성 필터 체크박스 (P39)");
    state.map = map; map.stubSource("sats");

    // **배선은 `initSatGroups()` 가 건다** — 핸들러를 직접 부르면 그 줄이 죽어도 안 잡힌다.
    let saved = null;
    api.save_settings = (patch) => { saved = patch; return {}; };
    api.get_satellite_groups = async () => ([
      { key: "stations", label: "우주정거장", cap: 0 },
      { key: "visual", label: "눈에 띄는 것", cap: 0 },
    ]);
    const grp = el("satg-stations");
    grp.value = "stations"; grp.checked = true;
    const band = el("satb-leo");
    band.value = "leo"; band.checked = false;
    el("sat-groups").sel[".satg"] = [grp];
    el("sat-groups").sel[".satb"] = [band];
    el("sat-facets").sel[".satt"] = [];
    el("sat-facets").sel[".sato"] = [];
    sel[".satg:checked"] = [grp];   // onSatGroupChange 가 document 에서 찾는다
    await ctx.initSatGroups();
    check("그룹 체크박스에 change 가 붙는다", !!grp.handlers.change, true);
    check("대역 체크박스에도 붙는다", !!band.handlers.change, true);

    grp.fire("change", {});
    check("그룹을 바꾸면 선택이 상태로 들어간다", state.satGroups, ["stations"]);
    check("그룹 변경은 설정으로 저장된다", !!(saved && saved.satellites), true);

    band.fire("change", {});
    check("대역을 끄면 상태에 반영된다", state.satBands.leo, false);

    // 종류(satt)·소유국(sato) — renderFacetFilters 가 배선을 건다
    const t = el("satt-1");
    t.value = "PAYLOAD"; t.checked = false; t.dataset.facet = "type";
    el("sat-facets").sel[".satt"] = [t];
    const o = el("sato-1");
    o.value = "US"; o.checked = false; o.dataset.facet = "owner";
    el("sat-facets").sel[".sato"] = [o];
    ctx.renderFacetFilters();
    check("종류 체크박스에 change 가 붙는다", !!t.handlers.change, true);
    check("소유국 체크박스에도 붙는다", !!o.handlers.change, true);
    let threw = null;
    try { t.fire("change", {}); o.fire("change", {}); } catch (e) { threw = String(e); }
    check("눌러도 예외가 나지 않는다", threw, null);
  })();

  // ── 통계 패널의 링크 (stats.js) · 상세 패널의 링크 (panels.js) ──────────────
  {
    const { ctx, state, el, map, api } = loadApp();
    group("동적 배선: 패널 안의 링크 (P39)");
    state.map = map; map.stubSource("launches");
    const d = mkLaunch({ vid_urls: [{ url: "https://example.com/v", title: "생중계" }] });
    state.allLaunches = [d];

    // **배선을 거는 것은 `showStats()` 가 아니라 `showEntityStats()`** 다(관점 화면).
    // 처음에는 `showStats()` 를 불러 놓고 단언했는데, 배선이 안 붙으니 클릭이 아무 일도
    // 안 하고 — 그런데도 한 줄은 **통과했다**(이미 화면에 그 글자가 있었다). 거짓 통과다.
    const row = el("site-row-1");
    row.dataset.id = "L1";
    el("stats-panel").sel[".site-row"] = [row];
    el("stats-panel").sel[".site-link"] = [];
    ctx.showEntityStats("provider", "SpaceX");
    check("관점 화면이 배선을 건다", !!row.handlers.click, true);
    row.fire("click", {});
    check("관점 화면의 발사 행은 상세를 연다", el("panel").classList.contains("hidden"), false);
    check("그 패널은 닫힌다(한 번에 하나 · P36-1)",
      el("stats-panel").classList.contains("hidden"), true);

    // 계열로 올라가는 링크 — 같은 패널을 다시 그린다(닫지 않는다)
    const link = el("site-link-1");
    link.dataset.kind = "rocket"; link.dataset.val = "Falcon 9";
    el("stats-panel").sel[".site-row"] = [];
    el("stats-panel").sel[".site-link"] = [link];
    ctx.showEntityStats("provider", "SpaceX");
    check("계열 링크에도 배선이 붙는다", !!link.handlers.click, true);
    el("stats-body").innerHTML = "";
    link.fire("click", {});
    check("누르면 그 계열의 관점 화면을 다시 그린다",
      el("stats-body").innerHTML.includes("Falcon 9"), true);

    // 상세 패널 → 중계 링크는 외부 브라우저로
    let opened = null;
    api.open_url = (u) => { opened = u; return true; };
    const vid = el("vid-btn-1");
    vid.dataset.url = "https://example.com/v";
    el("panel-body").sel[".vid-btn, .up-link"] = [vid];
    el("panel-body").sel[".site-link"] = [];
    ctx.openPanel(d);
    vid.fire("click", {});
    check("상세의 중계 버튼은 외부 브라우저로 보낸다", opened, "https://example.com/v");

    // 상세 패널 → 관점 진입 링크
    const plink = el("panel-site-link");
    plink.dataset.kind = "provider"; plink.dataset.val = "SpaceX";
    el("panel-body").sel[".vid-btn, .up-link"] = [];
    el("panel-body").sel[".site-link"] = [plink];
    ctx.openPanel(d);
    plink.fire("click", {});
    check("상세의 기관 링크는 관점 화면을 연다",
      el("stats-body").innerHTML.includes("SpaceX"), true);
  }

  // ── 발사대 목록 행 (launches.js) ────────────────────────────────────────────
  {
    const { ctx, state, el, map } = loadApp();
    group("동적 배선: 발사대 목록 행 (P39)");
    state.map = map; map.stubSource("launches");
    state.allLaunches = [mkLaunch(), mkLaunch({ id: "L2", name: "두 번째" })];
    const row = el("pad-row-1");
    row.dataset.id = "L2";
    el("panel-body").sel[".pad-row"] = [row];
    const n = ctx.openPadList(28.5, -80.5);
    check("같은 발사장의 발사를 모은다", n >= 2, true);
    row.fire("click", {});
    check("행을 누르면 그 발사의 상세로 간다",
      el("panel-body").innerHTML.includes("두 번째"), true);
  }

  // ── 배지·배너 닫기 (map.js · update.js · errors.js) ─────────────────────────
  {
    const { ctx, state, el, map, api } = loadApp();
    group("동적 배선: 배지·배너 (P39)");
    state.map = map;
    ctx.setupOfflineBadge();
    ctx.setOfflineBadge(true);
    check("오프라인 배지가 떴다", el("offline-badge").classList.contains("hidden"), false);
    el("offline-badge").fire("click", {});
    check("누르면 닫힌다", el("offline-badge").classList.contains("hidden"), true);
    ctx.setOfflineBadge(true);
    check("닫은 뒤에는 다시 안 뜬다", el("offline-badge").classList.contains("hidden"), true);

    // 업데이트 배지 — 본문을 누르면 릴리스 페이지, ✕ 는 그 버전만 접는다
    let opened = null;
    api.open_url = (u) => { opened = u; return true; };
    ctx.bindUpdateBadge();
    const info = { latest: "v9.9.9", current: "1.0.0", update_available: true,
                   url: "https://example.com/release" };
    // 클릭 핸들러가 읽는 것은 **배지에 넘긴 값이 아니라 전역** `latestUpdateInfo` 다
    // (평소에는 `initUpdateCheck` 가 세운다) — 그걸 안 세우면 눌러도 아무 일이 없다.
    state.latestUpdateInfo = info;
    ctx.setUpdateBadge(info);
    el("update-badge").fire("click", { target: { classList: { contains: () => false } } });
    check("배지 본문을 누르면 릴리스 페이지를 연다", opened, "https://example.com/release");
    el("update-badge").fire("click", { target: { classList: { contains: (c) => c === "ub-close" } } });
    check("✕ 는 배지를 접는다", el("update-badge").classList.contains("hidden"), true);

    // 오류 배너 닫기
    ctx.reportError("테스트", "무언가 잘못됐습니다");
    check("오류 배너가 떴다", el("app-error").classList.contains("hidden"), false);
    el("app-error-close").fire("click", {});
    check("배너 닫기가 듣는다", el("app-error").classList.contains("hidden"), true);
  }

  // ── "오늘 밤" 탭의 관측지 지정 버튼 (sidebar.js) ────────────────────────────
  {
    const { ctx, state, el, map } = loadApp();
    group("동적 배선: 오늘 밤 탭의 관측지 버튼 (P39)");
    state.map = map;
    state.observer = null;                 // 관측지가 없어야 안내와 버튼이 그려진다
    ctx.renderTonightList();
    check("관측지가 없으면 지정 버튼을 그린다",
      el("sidebar-list").innerHTML.includes("tonight-obs-btn"), true);
    el("tonight-obs-btn").fire("click", {});
    check("그 버튼은 관측 위치 팝오버를 연다",
      el("obs-popover").classList.contains("hidden"), false);
  }
})();

// ── 지도 배선을 실제로 발생시켜 본다 (P40) ───────────────────────────────────
// P39 에서 동적 배선(`addEventListener`)을 전수화하면서 **`map.on(...)` 은 일부러 뺐다.**
// 재 보니 17개 중 **9개가 지워도 전부 초록**이었다(2026-09-23): 위성을 눌러 고르는 것 ·
// 지도를 옮긴 뒤 위치를 저장하는 것 · 끌면 추적이 풀리는 것 · 커서 모양 넷.
// 커서는 사소해 보이지만 **"여기를 누를 수 있다"는 유일한 신호**다.
(async () => {
  const mkSat = (norad, name) => ({ norad, name, rec: null, lat: 1, lng: 2, alt: 400 });

  // ── 위성을 눌러 고른다 (sats.js `click:sat-hit`) ────────────────────────────
  {
    const { ctx, state, el, map } = loadApp({ realSatellite: true });
    group("지도 배선: 위성 선택 (P40)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);
    const rec = ctx.satellite.twoline2satrec(
      "1 25544U 98067A   26265.50000000  .00016717  00000-0  10270-3 0  9006",
      "2 25544  51.6400 208.9163 0006317  69.9862 290.1591 15.49468300 10000");
    state.satrecs = [{ norad: "25544", name: "ISS (ZARYA)", rec }];
    ctx.setupSatelliteLayer();

    check("sat-hit 에 클릭 배선이 붙는다", map.has("click:sat-hit"), true);
    map.fire("click:sat-hit", { features: [{ properties: { norad: "25544" } }] });
    check("누른 위성이 선택된다", state.selectedSat && state.selectedSat.norad, "25544");
    check("상세 패널이 열린다", el("panel").classList.contains("hidden"), false);

    // 관측 위치를 찍는 중에는 위성을 고르지 않는다 — 그 클릭은 관측지용이다
    state.selectedSat = null;
    state.settingObserver = true;
    map.fire("click:sat-hit", { features: [{ properties: { norad: "25544" } }] });
    check("관측지를 찍는 중에는 위성을 고르지 않는다", state.selectedSat, null);
    state.settingObserver = false;

    // 없는 위성을 눌러도 죽지 않는다(목록이 갈린 순간에 실제로 일어난다)
    let threw = null;
    try { map.fire("click:sat-hit", { features: [{ properties: { norad: "99999" } }] }); }
    catch (e) { threw = String(e); }
    check("모르는 위성이면 조용히 지나간다", threw, null);
  }

  // ── 커서 모양 (sats.js · launches.js) ───────────────────────────────────────
  {
    const { ctx, state, map } = loadApp({ realSatellite: true });
    group("지도 배선: 커서 모양 (P40)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "launches", "launch-heat", "launch-track"]) map.stubSource(s);
    ctx.setupSatelliteLayer();
    ctx.setupLaunchLayers();

    map.fire("mouseenter:sat-hit", {});
    check("위성 위에서는 십자 커서", map.cursor(), "crosshair");
    map.fire("mouseleave:sat-hit", {});
    check("벗어나면 되돌아온다", map.cursor(), "");

    map.fire("mouseenter:launch-point", {
      features: [{ properties: { id: "L1" }, geometry: { coordinates: [0, 0] } }],
      lngLat: { lng: 0, lat: 0 },
      originalEvent: { clientX: 100, clientY: 200 },
    });
    check("발사 점 위에서는 손 모양", map.cursor(), "pointer");
    map.fire("mouseleave:launch-point", {});
    check("벗어나면 되돌아온다(발사 점)", map.cursor(), "");

    map.fire("mouseenter:clusters", {
      features: [{ properties: { point_count: 3, cluster_id: 1 },
                   geometry: { coordinates: [0, 0] } }],
      lngLat: { lng: 0, lat: 0 },
      originalEvent: { clientX: 100, clientY: 200 },
    });
    check("클러스터 위에서도 손 모양", map.cursor(), "pointer");
    map.fire("mouseleave:clusters", {});
    check("벗어나면 되돌아온다(클러스터)", map.cursor(), "");
  }

  // ── 지도를 끌면 추적이 풀린다 (sats.js `dragstart`) ─────────────────────────
  {
    const { ctx, state, el, map } = loadApp({ realSatellite: true });
    group("지도 배선: 끌면 추적 해제 (P40)");
    state.map = map;
    for (const s of ["satellites", "sat-track"]) map.stubSource(s);
    ctx.setupSatelliteLayer();
    state.tracking = true;
    check("추적 중 상태를 만들었다", state.tracking, true);
    map.fire("dragstart", {});
    check("지도를 끌면 추적이 풀린다", state.tracking, false);
    // `easeTo` 는 dragstart 를 내지 않는다 — 추적이 스스로를 끄면 안 된다(주석의 전제)
    state.tracking = true;
    map.easeTo({ center: [1, 2] });
    check("추적이 스스로 지도를 옮긴 것은 해제하지 않는다", state.tracking, true);
  }

  // ── 지도를 옮기면 그 위치를 저장한다 (map.js `moveend` · P11-4) ─────────────
  {
    const { ctx, state, map, api } = loadApp();
    group("지도 배선: 카메라 위치 저장 (P40)");
    state.map = map;
    let saved = null;
    api.save_settings = (patch) => { saved = patch; return {}; };
    // `scheduleCameraSave` 는 1초 뒤에 저장한다 — 스텁 setTimeout 은 즉시 부르지 않으므로
    // 타이머를 직접 붙잡아 호출한다.
    const timers = [];
    ctx.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    ctx.clearTimeout = () => {};
    map.setCamera(127.5, 37.5, 6);

    // **`initMap()` 이 배선을 건다.** 처음에는 `scheduleCameraSave()` 를 직접 불렀는데,
    // 그러면 `map.on("moveend", …)` 한 줄이 죽어도 안 잡힌다 — P39 에서 똑같이 당한 자리다.
    ctx.initMap();
    check("moveend 에 배선이 붙는다", map.has("moveend"), true);
    map.fire("moveend", {});
    check("지도를 옮기면 저장을 예약한다", timers.length, 1);
    timers.pop()();
    check("예약이 지나면 지금 보던 자리를 저장한다",
      saved && Math.round(saved.camera.lng), 128);
    check("줌도 같이 저장한다", saved && saved.camera.zoom, 6);

    // 추적 중에는 저장하지 않는다 — 매 초 지도를 옮기므로 그 위치를 남길 이유가 없다
    saved = null;
    state.tracking = true;
    map.fire("moveend", {});
    check("추적 중에는 예약조차 하지 않는다", timers.length, 0);
  }
})();

// ── 주기 타이머가 실제로 걸리는가 (P41) ──────────────────────────────────────
// 이 앱은 **켜 두는 앱**이라 화면의 절반이 타이머로 돈다: 위성 위치(1초) · 임박 카드
// 카운트다운(1초) · 지상궤적(30초) · "N분 전 갱신"(30초) · 터미네이터(60초) · 속보 띠.
// 2026-09-23 실측에서 **`setInterval` 여섯 줄이 죽어도 1,296건이 전부 초록**이었다 —
// 화면은 **멈춘 채로 아무 말도 하지 않는다**(위성이 그 자리에 굳고, 카운트다운이 선다).
// 등록됐는지만이 아니라 **주기**까지 잰다: 1초를 60초로 바꿔도 "등록됨"은 참이다.
(async () => {
  // ── 위성 위치 1초 (sats.js) ────────────────────────────────────────────────
  {
    const { ctx, state, map, timers } = loadApp({ realSatellite: true });
    group("타이머: 위성 위치 갱신 (P41)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);
    const rec = ctx.satellite.twoline2satrec(
      "1 25544U 98067A   26265.50000000  .00016717  00000-0  10270-3 0  9006",
      "2 25544  51.6400 208.9163 0006317  69.9862 290.1591 15.49468300 10000");
    state.satrecs = [{ norad: "25544", name: "ISS (ZARYA)", rec }];

    check("시작 전에는 1초 타이머가 없다", timers.every(1000).length, 0);
    ctx.startSatelliteLoop();
    check("위성 위치는 1초마다 돈다", timers.every(1000).length >= 1, true);
    map.stubSource("satellites");
    timers.run(1000);
    const data = map.data("satellites");
    check("타이머가 돌면 위성 위치가 지도로 간다",
      !!(data && data.features && data.features.length), true);
  }

  // ── 지상궤적 30초 (sattrack.js) ────────────────────────────────────────────
  {
    const { ctx, state, map, timers } = loadApp({ realSatellite: true });
    group("타이머: 지상궤적 갱신 (P41)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);
    const rec = ctx.satellite.twoline2satrec(
      "1 25544U 98067A   26265.50000000  .00016717  00000-0  10270-3 0  9006",
      "2 25544  51.6400 208.9163 0006317  69.9862 290.1591 15.49468300 10000");
    ctx.selectSatellite({ norad: "25544", name: "ISS (ZARYA)", rec });
    check("위성을 고르면 30초 타이머가 선다", timers.every(30000).length >= 1, true);
    map.stubSource("sat-track");
    timers.run(30000);
    check("돌면 궤적이 다시 그려진다", map.data("sat-track") != null, true);
  }

  // ── 터미네이터 60초 (map.js) ───────────────────────────────────────────────
  {
    const { ctx, state, map, timers } = loadApp();
    group("타이머: 낮/밤 경계 갱신 (P41)");
    state.map = map;
    map.stubSource("terminator");
    ctx.setupTerminator();
    check("낮/밤 경계는 60초마다 돈다", timers.every(60000).length >= 1, true);
    map.stubSource("terminator");
    timers.run(60000);
    check("돌면 경계가 다시 그려진다", map.data("terminator") != null, true);
  }

  // ── "N분 전 갱신" 30초 (boot.js) ───────────────────────────────────────────
  {
    const { ctx, state, el, map, api, win, timers } = loadApp({
      api: { get_launches: async () => ({ launches: [], age: 0 }) },
    });
    group("타이머: 갱신 시각 표시 (P41)");
    state.map = map;
    await win.fire("pywebviewready");   // 부트 경로 전체가 이 타이머를 건다
    check("부트가 30초 타이머를 건다", timers.every(30000).length >= 1, true);
    // 돌려도 죽지 않는다(데이터가 아직 없을 때가 실제로 있다)
    let threw = null;
    try { timers.run(30000); } catch (e) { threw = String(e); }
    check("데이터가 없어도 예외 없이 돈다", threw, null);
  }

  // ── 임박 카드 1초 · 속보 띠 (focus.js · launches.js) ───────────────────────
  {
    const { ctx, state, el, map, timers } = loadApp();
    group("타이머: 임박 카드와 속보 띠 (P41)");
    state.map = map; map.stubSource("launches");
    const near = {
      id: "L1", name: "곧 발사", net: new Date(Date.now() + 5 * 60000).toISOString(),
      outcome: "upcoming", lat: 28, lng: -80, net_precision: "Second",
      location_name: "Cape Canaveral", rocket: "Falcon 9",
    };
    state.allLaunches = [near];

    ctx.startFocusTimer();
    check("임박 카드는 1초마다 돈다", timers.every(1000).length >= 1, true);
    timers.run(1000);
    check("돌면 카드가 그려진다", el("focus").classList.contains("hidden"), false);
    check("카운트다운이 채워진다", el("focus-cd").textContent.length > 0, true);

  }

  // ── 속보 띠 1초 (launches.js) ──────────────────────────────────────────────
  {
    const { ctx, state, el, map, timers } = loadApp();
    group("타이머: 속보 띠 (P41)");
    state.map = map; map.stubSource("launches");
    const list = [
      { id: "L1", name: "곧 발사", net: new Date(Date.now() + 5 * 60000).toISOString(),
        outcome: "upcoming", lat: 28, lng: -80, net_precision: "Second",
        location_name: "Cape Canaveral", rocket: "Falcon 9" },
      { id: "L2", name: "다음 발사", net: new Date(Date.now() + 9 * 60000).toISOString(),
        outcome: "upcoming", lat: 5, lng: 6, net_precision: "Second",
        location_name: "Kourou", rocket: "Ariane 6" },
      { id: "L3", name: "지난 발사", net: new Date(Date.now() - 86400000).toISOString(),
        outcome: "success", lat: 1, lng: 2, net_precision: "Second",
        location_name: "Baikonur", rocket: "Soyuz" },
    ];
    state.allLaunches = list;
    // 띠가 보는 것은 `allLaunches` 가 아니라 **화면에 남은 것**(`launches`)이다 —
    // 필터가 좁히면 띠도 같이 좁아진다.
    state.launches = list;
    ctx.startTicker();
    check("속보 띠는 1초마다 돈다", timers.every(1000).length >= 1, true);
    const first = el("ticker-text").innerHTML;
    check("시작하자마자 한 번 그린다", first.length > 0, true);
    // 5초가 지나야 다음 항목으로 넘어간다 — 그 규칙까지 잰다
    for (let i = 0; i < 5; i++) timers.run(1000);
    check("5초 뒤에는 다음 항목으로 넘어간다", el("ticker-text").innerHTML !== first, true);
  }
})();

// ── 조건을 뒤집어도 아무도 못 잡던 자리 (P43) ────────────────────────────────
// JS `if` 조건 166개를 하나씩 뒤집어 봤더니 **25개가 전부 초록**이었다(2026-09-23).
// 아래는 그중 **뒤집히면 화면이 실제로 틀려지는** 것들이다 — 나머지는 동치 변이이거나
// (포매터 실패 시 빈 문자열) 가드(`if (timer) clearInterval(timer)`)라 잡을 것이 없다.
(async () => {
  const mkLaunch = (over) => Object.assign({
    id: "L1", name: "테스트 발사", net: "2026-09-25T00:00:00Z", outcome: "upcoming",
    lat: 28.5, lng: -80.5, location_name: "Cape Canaveral", provider: "SpaceX",
    rocket: "Falcon 9", net_precision: "Second",
  }, over || {});

  // ── 시간대를 바꾸면 **열려 있는 화면**이 따라온다 (utils.js `refreshTimeViews`) ──
  // 다섯 줄이 전부 비어 있었다: 타임라인 라벨 · 상세 패널 · 통과 예측표 · "오늘 밤" 탭.
  // 시간대 버튼을 눌러도 **이미 떠 있는 화면은 옛 시간대로 굳는다** — 숫자만 안 맞을 뿐
  // 아무 오류도 안 난다(P13-5 가 겨눈 자리인데 배선만 있고 후속 갱신이 안 덮여 있었다).
  {
    const { ctx, state, el, map, api } = loadApp({ realSatellite: true });
    group("시간대를 바꾸면 열린 화면이 따라온다 (P43)");
    state.map = map;
    for (const s of ["launches", "launch-heat", "launch-track", "sats", "sat-track"]) map.stubSource(s);
    const d = mkLaunch();
    state.allLaunches = [d];
    state.launches = [d];

    // 상세 패널을 연 상태에서 시간대를 바꾼다
    ctx.openPanel(d);
    const beforePanel = el("panel-body").innerHTML;
    check("패널이 열렸고 그 발사를 기억한다", state.panelLaunchId, "L1");
    ctx.toggleTimeZone();
    check("시간대가 UTC 로 바뀌었다", state.timeZoneMode, "utc");
    check("열려 있던 상세 패널을 다시 그린다",
      el("panel-body").innerHTML !== beforePanel, true);

    // 타임라인 라벨도 같이 간다
    let timelineRan = false;
    ctx.onTimeline = () => { timelineRan = true; };
    ctx.refreshTimeViews();
    check("타임라인 라벨도 다시 계산한다", timelineRan, true);

    // 통과 예측표도 시각이 찍혀 있다 — 열려 있으면 그것도 다시 그린다.
    // **이 줄은 P43 에서 못 채운 자리다**(공용 변이 도구가 `utils.js:132` 로 잡아냈다).
    // 재려면 `showPasses()` 가 **실제로 도는 상태**를 만들어야 한다 — 위성과 관측지가
    // 둘 다 있어야 하고, 없으면 함수가 맨 앞에서 그냥 돌아가 이 분기를 못 탄다(P12-23).
    const rec = ctx.satellite.twoline2satrec(
      "1 25544U 98067A   26265.50000000  .00016717  00000-0  10270-3 0  9006",
      "2 25544  51.6400 208.9163 0006317  69.9862 290.1591 15.49468300 10000");
    state.selectedSat = { norad: "25544", name: "ISS (ZARYA)", rec, band: "leo" };
    state.observer = { lat: 37.5665, lng: 126.978, label: "서울" };
    ctx.openRightPanel("pass-panel");
    el("pass-body").innerHTML = "";
    ctx.refreshTimeViews();
    check("열려 있는 통과 예측표도 다시 그린다",
      el("pass-body").innerHTML.length > 0, true);

    // 닫혀 있으면 건드리지 않는다 — 닫힌 패널을 다시 그리는 것은 낭비이고,
    // 그 계산은 위성 하나당 수십 ms 다(P19 에서 잰 값).
    ctx.openRightPanel("panel");          // 통과 패널을 닫는다
    el("pass-body").innerHTML = "";
    ctx.refreshTimeViews();
    check("닫혀 있는 통과 예측표는 건드리지 않는다", el("pass-body").innerHTML, "");

    // "오늘 밤" 탭이 열려 있으면 그것도
    state.sidebarTab = "tonight";
    state.observer = null;
    el("sidebar-list").innerHTML = "";
    ctx.refreshTimeViews();
    check("오늘 밤 탭도 다시 그린다", el("sidebar-list").innerHTML.length > 0, true);
  }

  // ── 위성 필터가 바뀐 뒤의 뒷정리 (satfilter.js `applySatFilter`) ────────────
  {
    const { ctx, state, el, map } = loadApp({ realSatellite: true });
    group("위성 필터를 바꾼 뒤 화면을 맞춘다 (P43)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);
    const rec = ctx.satellite.twoline2satrec(
      "1 25544U 98067A   26265.50000000  .00016717  00000-0  10270-3 0  9006",
      "2 25544  51.6400 208.9163 0006317  69.9862 290.1591 15.49468300 10000");
    // `visibleSats()` 는 **미리 계산해 둔 `s.band`** 를 본다(매번 궤도를 풀지 않는다).
    const iss = { norad: "25544", name: "ISS (ZARYA)", rec, band: "leo", satcat: {} };
    state.satrecs = [iss];
    ctx.selectSatellite(iss);
    check("위성이 선택됐다", state.selectedSat && state.selectedSat.norad, "25544");

    // 그 위성을 숨기는 필터를 켠다 → 선택이 풀려야 한다
    // (지도에 점이 없는데 패널만 떠 있으면 혼란스럽다 — 그게 이 조건의 이유다)
    state.satBands = { leo: false, meo: true, geo: true };
    ctx.applySatFilter();
    check("안 보이게 된 위성은 선택이 풀린다", state.selectedSat, null);

    // 보이는 위성이면 선택을 유지한다 — 반대 방향도 잰다
    state.satBands = { leo: true, meo: true, geo: true };
    ctx.selectSatellite(iss);
    ctx.applySatFilter();
    check("보이는 위성은 선택을 지킨다", state.selectedSat && state.selectedSat.norad, "25544");

    // 위성 탭이 열려 있으면 목록도 다시 그린다
    state.sidebarTab = "sats";
    el("sidebar-list").innerHTML = "";
    ctx.applySatFilter();
    check("위성 탭이면 목록을 다시 그린다", el("sidebar-list").innerHTML.length > 0, true);
  }

  // ── 그룹을 바꾸면 **다시 받는다** (satfilter.js `onSatGroupChange`) ─────────
  {
    const { ctx, state, el, map, api, sel } = loadApp();
    group("그룹을 바꾸면 위성을 다시 받는다 (P43)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);
    let asked = 0;
    api.get_satellites = async () => { asked++; return { satellites: [], groups: [] }; };
    const grp = el("satg-x"); grp.value = "visual"; grp.checked = true;
    sel[".satg:checked"] = [grp];
    state.satrecs = [{ norad: "1", name: "옛 위성" }];

    // 위성이 꺼져 있으면 받지 않는다 — 켤 때 받으면 된다
    el("toggle-sat").checked = false;
    ctx.onSatGroupChange();
    check("위성이 꺼져 있으면 다시 받지 않는다", asked, 0);
    check("꺼져 있으면 기존 목록도 그대로", state.satrecs.length, 1);

    // 켜져 있으면 목록을 비우고 다시 받는다
    el("toggle-sat").checked = true;
    ctx.onSatGroupChange();
    check("켜져 있으면 다시 받는다", asked, 1);
  }

  // ── 자동 갱신은 조용히, 사용자 갱신은 말한다 (launches.js `loadLaunches`) ──
  // `silent` 분기 넷이 비어 있었다. 자동 갱신(5분마다)이 **버튼을 비활성화하고
  // 오류 문구를 띄우면**, 앱이 제멋대로 깜빡이는 것처럼 보인다.
  {
    const { ctx, state, el, map, api } = loadApp();
    group("자동 갱신은 조용히 (P43)");
    state.map = map;
    for (const s of ["launches", "launch-heat", "launch-track"]) map.stubSource(s);
    api.get_launches = async () => { throw new Error("끊김"); };

    el("status").textContent = "";
    await ctx.loadLaunches(false, true);        // silent = 자동 갱신
    check("자동 갱신 실패는 화면에 말하지 않는다", el("status").textContent, "");
    check("자동 갱신은 갱신 버튼을 건드리지 않는다", el("refresh").disabled, false);

    await ctx.loadLaunches(false, false);       // 사용자가 누른 갱신
    check("사용자 갱신 실패는 말한다",
      el("status").textContent.includes("불러오지 못했습니다"), true);
    check("사용자 갱신이 끝나면 버튼이 돌아온다", el("refresh").disabled, false);
  }

  // ── 받아 온 결과에 경고가 실려 오면 그대로 말한다 (launches.js) ────────────
  // 파이썬이 `error` 를 주는 경우는 **성공 경로**다(오래된 캐시로 채운 화면 등).
  // 예외 경로만 재면 이쪽이 통째로 빈다 — 실제로 비어 있었다.
  {
    const { ctx, state, el, map, api } = loadApp();
    group("결과에 실려 온 경고 (P43)");
    state.map = map;
    for (const s of ["launches", "launch-heat", "launch-track"]) map.stubSource(s);

    api.get_launches = async () => ({
      launches: [mkLaunch()], error: "요청이 많아 잠시 뒤 다시 시도해 주세요.",
      stale: true, age: 0,
    });
    await ctx.loadLaunches();
    check("경고를 화면에 그대로 옮긴다",
      el("status").textContent.includes("요청이 많아"), true);
    check("오래된 캐시로 채웠다는 사실도 말한다",
      el("status").textContent.includes("저장된 데이터"), true);

    // stale 이 아니면 그 꼬리말은 붙지 않는다
    api.get_launches = async () => ({
      launches: [mkLaunch()], error: "무언가 잘못됐습니다.", stale: false, age: 0,
    });
    await ctx.loadLaunches();
    check("stale 이 아니면 꼬리말이 없다",
      el("status").textContent.includes("저장된 데이터"), false);

    // 경고가 없으면 상태줄을 비운다(앞선 경고가 남아 있으면 안 된다)
    api.get_launches = async () => ({ launches: [mkLaunch()], error: null, stale: false, age: 0 });
    await ctx.loadLaunches();
    // `showStatus(null)` 은 **텍스트를 지우지 않고 숨긴다** — 그래서 남은 글자가 아니라
    // 숨었는지로 재야 한다(글자로 재면 직전 경고가 남아 있어 영원히 실패한다).
    check("경고가 없으면 상태줄을 숨긴다", el("status").classList.contains("hidden"), true);
  }

  // ── 자동 갱신만 "무엇이 달라졌는지" 알린다 (launches.js `announceChanges`) ──
  // 사용자가 직접 누른 갱신은 **자기가 누른 것**이라 알릴 이유가 없다.
  {
    const { ctx, state, el, map, api } = loadApp();
    group("자동 갱신만 변화를 알린다 (P43)");
    state.map = map;
    for (const s of ["launches", "launch-heat", "launch-track"]) map.stubSource(s);
    const before = mkLaunch({ id: "A", name: "먼저 있던 발사" });
    const after = mkLaunch({ id: "B", name: "새로 들어온 발사",
      net: new Date(Date.now() + 3600000).toISOString() });

    api.get_launches = async () => ({ launches: [before], error: null, age: 0 });
    await ctx.loadLaunches();
    el("status").textContent = "";

    api.get_launches = async () => ({ launches: [before, after], error: null, age: 0 });
    // **상태줄을 비우고 잰다** — 앞 단계의 문구가 남아 있으면 "길이가 0보다 크다"는
    // 단언이 언제나 참이 되어, 조건을 뒤집어도 안 잡힌다(실제로 그렇게 한 번 놓쳤다).
    el("status").textContent = "";
    await ctx.loadLaunches(false, false);      // 사용자 갱신 — 조용해야 한다
    check("사용자 갱신은 변화를 떠들지 않는다",
      el("status").textContent.includes("새 발사"), false);

    state.launches = [before];
    el("status").textContent = "";
    await ctx.loadLaunches(false, true);       // 자동 갱신 — 알려야 한다
    check("자동 갱신은 무엇이 늘었는지 알린다",
      el("status").textContent.includes("새 발사 1건"), true);
  }

  // ── 속보 띠: 끝난 예정 항목은 건너뛴다 (launches.js) ────────────────────────
  {
    const { ctx, state, el, map, timers } = loadApp();
    group("속보 띠는 끝난 예정 항목을 건너뛴다 (P43)");
    state.map = map; map.stubSource("launches");
    const past = mkLaunch({ id: "P1", name: "이미 지난 예정",
      net: new Date(Date.now() - 60000).toISOString() });
    const soon = mkLaunch({ id: "N1", name: "아직 안 온 예정",
      net: new Date(Date.now() + 600000).toISOString() });
    state.allLaunches = [past, soon];
    state.launches = [past, soon];
    ctx.startTicker();
    check("띠는 지나간 예정을 건너뛴다",
      el("ticker-text").innerHTML.includes("이미 지난 예정"), false);
    check("아직 안 온 예정을 보여준다",
      el("ticker-text").innerHTML.includes("아직 안 온 예정"), true);
  }

  // ── 다국적 코드 (utils.js) ─────────────────────────────────────────────────
  {
    const { ctx } = loadApp();
    group("소유국 표기 (P43)");
    // SATCAT 의 나라 코드는 **세 글자**다(`USA`·`CIS`) — 두 글자로 쓰면 표에 없어
    // 코드가 그대로 나온다. 이 테스트가 그 사실도 같이 붙잡는다.
    check("쉼표가 있으면 다국적", ctx.countryKo("USA,FR,JPN"), "다국적");
    check("하나면 그 나라 이름", ctx.countryKo("USA"), "미국");
    check("모르는 코드는 코드 그대로", ctx.countryKo("ZZZ"), "ZZZ");
    check("빈 값은 빈 문자열", ctx.countryKo(""), "");
  }
})();

// ── 관측지를 정하고 해제할 때의 뒷정리 (P45) ────────────────────────────────
// 공용 변이 도구가 `observer.js` 에서 네 줄을 집어냈다 — 전부 **정하거나 해제한 뒤에
// 화면을 맞추는** 줄이다. 죽으면 *"오늘 밤 목록이 안 바뀐다"* · *"지도가 안 움직인다"* ·
// *"관측지를 지웠는데 표시가 남는다"* 로 보이는데, 오류는 하나도 안 난다.
(async () => {
  const ISS = [
    "1 25544U 98067A   26265.50000000  .00016717  00000-0  10270-3 0  9006",
    "2 25544  51.6400 208.9163 0006317  69.9862 290.1591 15.49468300 10000",
  ];

  // ── 관측지를 정하면: 오늘 밤 목록이 채워지고 지도가 그리로 간다 ─────────────
  {
    const { ctx, state, el, map } = loadApp({ realSatellite: true });
    group("관측지를 정한 뒤의 뒷정리 (P45)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);

    // "오늘 밤" 탭이 열려 있고 **관측지가 없어 막혀 있는** 상태가 출발점이다.
    state.sidebarTab = "tonight";
    state.observer = null;
    ctx.renderTonightList();
    const blocked = el("sidebar-list").innerHTML;
    check("관측지가 없으면 막힌 안내가 떠 있다", blocked.includes("tonight-obs-btn"), true);

    const moves = map.moves().length;
    const ok = ctx.setObserver(37.5665, 126.978, "서울");
    check("관측지가 정해졌다", ok, true);
    check("막혀 있던 목록이 그 자리에서 바뀐다",
      el("sidebar-list").innerHTML !== blocked, true);
    check("지도가 그 자리로 움직인다", map.moves().length > moves, true);

    // 다른 탭이 열려 있으면 목록을 건드리지 않는다 — 안 보이는 것을 계산하지 않는다
    state.sidebarTab = "launches";
    el("sidebar-list").innerHTML = "손대지 않아야 한다";
    ctx.setObserver(35.1, 129.0, "부산");
    check("다른 탭이면 목록을 건드리지 않는다",
      el("sidebar-list").innerHTML, "손대지 않아야 한다");
  }

  // ── 관측지를 해제하면: 마커가 사라지고 목록이 되돌아간다 ────────────────────
  {
    const { ctx, state, el, map } = loadApp({ realSatellite: true });
    group("관측지를 해제한 뒤의 뒷정리 (P45)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);

    let removed = false;
    state.observerMarker = { remove: () => { removed = true; } };
    state.observer = { lat: 37.5665, lng: 126.978, label: "서울" };
    state.sidebarTab = "tonight";
    el("sidebar-list").innerHTML = "";

    ctx.clearObserver();
    check("관측지가 지워졌다", state.observer, null);
    check("지도의 관측지 표시도 지운다", removed, true);
    check("오늘 밤 목록이 막힌 안내로 되돌아간다",
      el("sidebar-list").innerHTML.includes("tonight-obs-btn"), true);
    check("통과 예측표도 같이 닫는다",
      el("pass-panel").classList.contains("hidden"), true);
  }

  // ── 위성을 놓으면: 궤적이 지워지고 그 위성의 상세도 닫힌다 ──────────────────
  {
    const { ctx, state, el, map } = loadApp({ realSatellite: true });
    group("위성 선택을 놓은 뒤의 뒷정리 (P45)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);
    const rec = ctx.satellite.twoline2satrec(ISS[0], ISS[1]);
    const iss = { norad: "25544", name: "ISS (ZARYA)", rec, band: "leo" };

    ctx.selectSatellite(iss);
    ctx.openSatPanel(iss);
    check("위성 상세가 열렸고 그 위성을 기억한다", String(state.satPanelId), "25544");
    check("지상궤적이 그려져 있다", map.data("sat-track") != null, true);

    ctx.deselectSatellite();
    check("선택이 풀렸다", state.selectedSat, null);
    // **지도에 궤적선이 남으면 "왜 안 지워지지"가 된다** — 빈 것으로 덮는다.
    const track = map.data("sat-track");
    check("지상궤적을 빈 것으로 덮는다",
      !!(track && Array.isArray(track.features) && track.features.length === 0), true);
    check("그 위성의 상세 패널도 닫는다", el("panel").classList.contains("hidden"), true);
    check("상세가 누구 것이었는지도 잊는다", state.satPanelId, null);
  }

  // ── 위성 목록 탭은 값이 바뀔 때마다 다시 그린다 (sats.js 세 곳) ─────────────
  {
    const { ctx, state, el, map, api } = loadApp({ realSatellite: true });
    group("위성 목록 탭 재렌더 (P45)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);
    api.get_satellites = async () => ({
      satellites: [{ norad_id: 25544, name: "ISS (ZARYA)", tle1: ISS[0], tle2: ISS[1] }],
      groups: ["stations"], stale: false, error: null,
    });
    api.get_satcat = async () => ({ satcat: {}, stale: false, error: null });

    state.sidebarTab = "sats";
    el("sidebar-list").innerHTML = "";
    el("toggle-sat").checked = true;
    await ctx.loadSatellites();
    check("위성을 받으면 목록 탭이 즉시 채워진다",
      el("sidebar-list").innerHTML.length > 0, true);
    check("토글이 켜져 있으면 계산 루프가 선다", state.satTimer != null, true);

    // 다른 탭이면 건드리지 않는다
    state.sidebarTab = "launches";
    el("sidebar-list").innerHTML = "손대지 않아야 한다";
    await ctx.loadSatellites();
    check("다른 탭이면 위성 목록을 그리지 않는다",
      el("sidebar-list").innerHTML, "손대지 않아야 한다");
  }
})();

// ── 추적 모드와 좌표 유효성 (P45-4) ─────────────────────────────────────────
// 공용 변이 도구가 남긴 일곱 줄 중 **가드가 아닌 것**들이다.
// 특히 좌표 유효성 둘은 **NaN 이 지도로 가는 길**을 막는다 — 막히지 않으면 위성이
// 화면에서 사라지거나 지도가 엉뚱한 곳으로 간다(P12-1 에서 실제로 NaN 좌표에 당했다).
(async () => {
  const ISS = [
    "1 25544U 98067A   26265.50000000  .00016717  00000-0  10270-3 0  9006",
    "2 25544  51.6400 208.9163 0006317  69.9862 290.1591 15.49468300 10000",
  ];

  // ── 추적을 켜면 그 자리에서 지도가 따라간다 (sattrack.js) ───────────────────
  {
    const { ctx, state, el, map } = loadApp({ realSatellite: true });
    group("추적 모드 (P45-4)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);
    const rec = ctx.satellite.twoline2satrec(ISS[0], ISS[1]);
    const iss = { norad: "25544", name: "ISS (ZARYA)", rec, band: "leo" };
    ctx.selectSatellite(iss);

    const before = map.moves().length;
    ctx.toggleTracking();
    check("추적이 켜졌다", state.tracking, true);
    // **켠 순간 한 번 움직여야 한다** — 다음 초를 기다리면 "눌렀는데 아무 일도 안 난다".
    check("켜는 즉시 그 위성으로 지도를 옮긴다", map.moves().length > before, true);

    const afterOn = map.moves().length;
    ctx.toggleTracking();
    check("다시 누르면 꺼진다", state.tracking, false);
    check("끄는 것만으로는 지도를 옮기지 않는다", map.moves().length, afterOn);

    // 고른 위성이 없으면 토글 자체가 안 된다(켜 봤자 따라갈 대상이 없다)
    ctx.deselectSatellite();
    ctx.toggleTracking();
    check("고른 위성이 없으면 추적이 켜지지 않는다", state.tracking, false);
  }

  // ── 매 초 갱신에서도 추적 중이면 따라간다 (sats.js) ─────────────────────────
  {
    const { ctx, state, map, timers } = loadApp({ realSatellite: true });
    group("추적 중에는 매 초 따라간다 (P45-4)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);
    const rec = ctx.satellite.twoline2satrec(ISS[0], ISS[1]);
    const iss = { norad: "25544", name: "ISS (ZARYA)", rec, band: "leo" };
    state.satrecs = [iss];
    state.selectedSat = iss;

    state.tracking = false;
    let n = map.moves().length;
    ctx.updateSatellitePositions();
    check("추적이 꺼져 있으면 지도를 건드리지 않는다", map.moves().length, n);

    state.tracking = true;
    n = map.moves().length;
    ctx.updateSatellitePositions();
    check("추적 중이면 매 초 중심을 옮긴다", map.moves().length > n, true);
  }

  // ── 좌표가 이상하면 지도를 옮기지 않는다 (sattrack.js) ──────────────────────
  // **예외가 아니라 값이 틀어지는 길**이다. `satellite.js` 는 궤도가 붕괴한 물체에
  // NaN 을 돌려준다 — 그걸 그대로 `easeTo` 에 넘기면 지도가 엉뚱해진다.
  {
    const { ctx, state, map } = loadApp();
    group("좌표가 이상하면 옮기지 않는다 (P45-4)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);

    // satellite.js 를 **거짓 값으로 갈아끼운다** — 실제로 NaN 을 내는 TLE 를 찾는 것보다
    // 확실하고, 무엇이 판정에 쓰이는지도 드러난다.
    const fake = (position) => ({
      propagate: () => ({ position, velocity: { x: 0, y: 0, z: 0 } }),
      gstime: () => 0,
      eciToGeodetic: () => ({ longitude: NaN, latitude: NaN, height: NaN }),
      degreesLong: (v) => v,
      degreesLat: (v) => v,
      twoline2satrec: () => ({}),
    });

    state.selectedSat = { norad: "1", name: "붕괴한 물체", rec: {} };

    ctx.satellite = fake({ x: 1, y: 2, z: 3 });
    let n = map.moves().length;
    ctx.centerOnSelected();
    check("좌표가 NaN 이면 지도를 옮기지 않는다", map.moves().length, n);

    // 위치 자체가 없을 때(propagate 실패)도 마찬가지다
    ctx.satellite = Object.assign({}, fake(null), { propagate: () => ({ position: null }) });
    n = map.moves().length;
    ctx.centerOnSelected();
    check("위치를 못 구하면 지도를 옮기지 않는다", map.moves().length, n);

    // 정상 좌표면 옮긴다 — **막는 것만 재면 "늘 안 옮긴다"도 통과한다**
    ctx.satellite = Object.assign({}, fake({ x: 1, y: 2, z: 3 }), {
      eciToGeodetic: () => ({ longitude: 0.5, latitude: 0.6, height: 400 }),
      degreesLong: () => 28.6,
      degreesLat: () => 34.4,
    });
    n = map.moves().length;
    ctx.centerOnSelected();
    check("정상 좌표면 그리로 옮긴다", map.moves().length > n, true);
  }

  // ── 위성 레이어를 껐다 켜면 목록 안내도 따라간다 (sats.js) ─────────────────
  {
    const { ctx, state, el, map, api } = loadApp({ realSatellite: true });
    group("위성 표시 토글과 목록 (P45-4)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);
    map.setLayerExists && map.setLayerExists(true);
    const rec = ctx.satellite.twoline2satrec(ISS[0], ISS[1]);
    state.satrecs = [{ norad: "25544", name: "ISS (ZARYA)", rec, band: "leo" }];
    state.sidebarTab = "sats";

    el("sidebar-list").innerHTML = "";
    ctx.setSatelliteVisible(false);
    check("끄면 목록의 안내도 다시 그린다", el("sidebar-list").innerHTML.length > 0, true);

    // **실패 경로의 목록 재렌더.** 위성 계산이 예외로 죽어도 목록 탭은 "왜 비었는지"를
    // 말해야 한다 — 안 그리면 앞서 그린 목록이 그대로 남아 **있지도 않은 위성이 떠 있다.**
    {
      // **엉터리 TLE 는 예외가 아니라 0건으로 끝난다** — 그 길로는 `catch` 를 못 탄다.
      // 실제로 이 블록을 타는 것은 **브릿지가 던지는** 경우다(파이썬 쪽 예외).
      const bad = loadApp({ api: {
        get_satellites: async () => { throw new Error("브릿지가 끊겼다"); },
      } });
      bad.state.map = bad.map;
      for (const s of ["satellites", "sat-track", "sats"]) bad.map.stubSource(s);
      bad.state.sidebarTab = "sats";
      bad.el("sidebar-list").innerHTML = "이전 목록이 남아 있으면 안 된다";
      await bad.ctx.loadSatellites();
      check("위성 계산이 실패해도 목록 탭을 다시 그린다",
        bad.el("sidebar-list").innerHTML !== "이전 목록이 남아 있으면 안 된다", true);
      check("왜 비었는지도 말한다", bad.state.satLoadError != null, true);
    }

    // 끄면 계산 루프도 멈춘다 — 안 보이는 것을 매 초 계산하지 않는다
    check("끄면 계산 루프가 멈춘다", state.satTimer, null);
  }
})();

// ── 껐다 켜면 그대로 돌아오는가 (P46) ───────────────────────────────────────
// 설정 **저장**은 P22 에서 쟀다(동시 저장의 lost update 까지). 그런데 **복원**은
// `satellites` 몇 줄 말고는 비어 있었다 — 공용 변이 도구가 `settings.js` 에서
// **아홉 줄**을 집어냈다. 죽어도 오류는 없다: 그냥 **어제 켜 둔 것이 오늘 꺼져 있다.**
//
// 여기서 재는 것은 두 방향이다 — **저장된 값이 반영되는가** 와
// **없는 값은 건드리지 않는가**(한쪽만 재면 "늘 켠다"도 통과한다).
{
  const { ctx, state, el } = loadApp();
  group("설정 복원 — 저장된 값이 반영된다 (P46)");

  // **기본값과 다른 값으로 잰다.** 처음에는 `visibleOnly: false` 로 쟀는데 스텁의
  // 기본값도 `false` 라, 복원이 끊겨도 단언이 참이었다(변이로 드러났다 — 거짓 통과).
  check("가시 전용의 기본값은 꺼짐이다", el("toggle-visible-only").checked, false);
  ctx.applySettings({
    filters: { upcoming: false, success: true },
    terminator: false,
    visibleOnly: true,
    heatmap: true,
    satellites: { enabled: true, groups: ["visual"],
                  typesOff: { "로켓 몸체": true }, ownersOff: { CIS: true } },
    observer: { lat: 37.5665, lng: 126.978, label: "서울" },
    basemap: "satellite",
    timeZone: "utc",
  });

  check("낮/밤 음영 끔이 복원된다", el("toggle-terminator").checked, false);
  check("가시 전용 켬이 복원된다", el("toggle-visible-only").checked, true);
  check("히트맵 켬이 복원된다", state.heatOn, true);
  check("히트맵 체크박스도 같이 선다", el("toggle-heat").checked, true);
  check("위성 켬이 복원된다", el("toggle-sat").checked, true);
  check("위성 그룹이 복원된다", state.satGroups, ["visual"]);
  check("꺼 둔 종류가 복원된다", state.satTypesOff, { "로켓 몸체": true });
  check("꺼 둔 소유국이 복원된다", state.satOwnersOff, { CIS: true });
  check("관측 위치가 복원된다", state.observer && state.observer.label, "서울");
  check("배경 지도가 복원된다", state.basemap, "satellite");
  check("시간대가 복원된다", state.timeZoneMode, "utc");
}

{
  const { ctx, state, el } = loadApp();
  group("설정 복원 — 없는 값은 건드리지 않는다 (P46)");

  // 앱 기본값을 일부러 바꿔 두고, **빈 설정**을 먹인다. 아무것도 안 바뀌어야 한다.
  el("toggle-terminator").checked = true;
  el("toggle-sat").checked = false;
  state.basemap = "dark";
  ctx.applySettings({});

  check("낮/밤 음영은 그대로", el("toggle-terminator").checked, true);
  check("위성 토글도 그대로", el("toggle-sat").checked, false);
  check("배경 지도도 그대로", state.basemap, "dark");

  // 타입이 틀린 값은 **무시한다** — 손상된 설정이 앱 상태를 망가뜨리면 안 된다.
  ctx.applySettings({ terminator: "네", basemap: "우주", observer: { lat: "서울", lng: 1 } });
  check("불리언이 아닌 값은 무시한다", el("toggle-terminator").checked, true);
  check("모르는 배경 이름은 무시한다", state.basemap, "dark");
  check("좌표가 숫자가 아니면 관측지를 세우지 않는다", state.observer, null);

  // 위성을 **끈 채로 저장한 것**은 켜지 않는다(설정에 `enabled: false` 가 있는 경우)
  ctx.applySettings({ satellites: { enabled: false } });
  check("꺼 둔 위성은 켜지 않는다", el("toggle-sat").checked, false);
}

{
  const { ctx, state, el, sel } = loadApp();
  group("설정 복원 — 결과 필터 (P46)");

  // 필터는 체크박스 넷이 각각 `value` 를 갖는다 — 스텁에 그 넷을 심어 둔다.
  const boxes = ["upcoming", "success", "failure", "partial"].map((v) => {
    const b = el("flt-" + v);
    b.value = v; b.checked = true;
    return b;
  });
  sel[".flt"] = boxes;

  ctx.applySettings({ filters: { upcoming: false, failure: false } });
  check("꺼 둔 필터가 복원된다", boxes.map((b) => b.checked), [false, true, false, true]);

  // **설정에 없는 키는 건드리지 않는다** — 새 필터가 생겨도 옛 설정이 그걸 끄면 안 된다.
  const before = boxes.map((b) => b.checked);
  ctx.applySettings({ filters: {} });
  check("설정에 없는 필터는 그대로", boxes.map((b) => b.checked), before);
}

// ── 복원의 나머지 절반 — 지도가 뜰 때 (P46-2) ──────────────────────────────
// `applySettings` 는 **상태만** 세운다(P46-1). 지도 레이어는 그때 아직 없어서,
// 실제 반영은 `map.on("load")` 안에서 일어난다 — 배경 지도 · 히트맵 · 관측 위치 · 위성.
// 그 세 줄이 비어 있었다: 죽으면 **설정에는 켜져 있는데 화면에는 안 켜진다.**
{
  const { ctx, state, el, map } = loadApp();
  group("지도가 뜰 때 저장된 상태를 반영한다 (P46-2)");
  for (const s of ["launches", "launch-heat", "launch-track", "terminator", "sats", "sat-track", "satellites"]) {
    map.stubSource(s);
  }

  // 설정을 먼저 복원한 상태에서 지도를 띄운다 — 실제 부트 순서와 같다.
  ctx.applySettings({ basemap: "satellite", heatmap: true, satellites: { enabled: true } });
  state.observer = { lat: 37.5665, lng: 126.978, label: "서울" };
  check("배경 지도 상태가 먼저 선다", state.basemap, "satellite");

  ctx.initMap();
  state.map = map;
  map.fire("load", {});

  // **상태만 재면 절반이다** — 지도 레이어가 실제로 갈렸는지까지 본다.
  // `applySettings` 는 지도가 없을 때 도니까 상태만 세우고, 반영은 `load` 안에서 한다.
  check("저장된 배경 지도가 지도에도 반영된다",
    map.layout("esri", "visibility"), "visible");
  check("그때 다크 배경은 꺼진다", map.layout("darkbase", "visibility"), "none");
  check("툴바 버튼 문구도 따라간다",
    el("basemap-btn").textContent.includes("위성사진"), true);

  // 히트맵: 상태만이 아니라 **레이어가 실제로 보이게** 됐는지
  check("저장된 히트맵이 지도에도 켜진다", map.layout("launch-heat", "visibility"), "visible");
  // 관측 위치: 지도에 마커가 선다
  check("저장된 관측 위치가 지도에 선다", state.observerMarker != null, true);
  // 위성: 설정에 켜져 있었으면 레이어가 보인다
  check("설정에 켜 둔 위성이 지도에도 켜진다", map.layout("sat-layer", "visibility"), "visible");
}

{
  const { ctx, state, el, map } = loadApp();
  group("저장된 것이 없으면 켜지 않는다 (P46-2)");
  for (const s of ["launches", "launch-heat", "launch-track", "terminator", "sats", "sat-track", "satellites"]) {
    map.stubSource(s);
  }

  // **아무것도 저장돼 있지 않은 첫 실행**이 출발점이다.
  ctx.applySettings({});
  ctx.initMap();
  state.map = map;
  map.fire("load", {});

  check("배경 지도는 다크로 둔다", map.layout("esri", "visibility") !== "visible", true);
  check("히트맵은 꺼진 채로 둔다", map.layout("launch-heat", "visibility") !== "visible", true);
  check("관측 위치 마커를 세우지 않는다", state.observerMarker, null);
  check("위성도 켜지 않는다", map.layout("sat-layer", "visibility") !== "visible", true);
}

// ── 사이드바에서 한 줄을 누르면 (P46-3) ────────────────────────────────────
// 목록의 한 행은 **발사일 수도 위성일 수도 있다**(탭에 따라). 같은 배선이 `data-norad`
// 유무로 갈리는데, 그 분기가 비어 있었다 — 뒤집히면 **위성을 눌렀는데 발사를 찾는다.**
(async () => {
  const ISS = [
    "1 25544U 98067A   26265.50000000  .00016717  00000-0  10270-3 0  9006",
    "2 25544  51.6400 208.9163 0006317  69.9862 290.1591 15.49468300 10000",
  ];

  {
    const { ctx, state, el, map } = loadApp({ realSatellite: true });
    group("사이드바 행 클릭 — 발사와 위성이 갈린다 (P46-3)");
    state.map = map;
    for (const s of ["launches", "launch-heat", "launch-track", "satellites", "sat-track", "sats"]) {
      map.stubSource(s);
    }
    const rec = ctx.satellite.twoline2satrec(ISS[0], ISS[1]);
    state.satrecs = [{ norad: "25544", name: "ISS (ZARYA)", rec, band: "leo" }];
    state.allLaunches = [{
      id: "L1", name: "테스트 발사", net: "2026-09-25T00:00:00Z", outcome: "upcoming",
      lat: 28.5, lng: -80.5, net_precision: "Second",
    }];
    ctx.bindUI();

    // 행 스텁 — 실제 목록은 `innerHTML` 로 만들어지므로 `closest` 를 흉내 낸다.
    const row = (data) => ({ dataset: data, closest: () => ({ dataset: data }) });

    // ① 위성 행: `data-norad` 가 있다
    el("sidebar-list").fire("click", { target: row({ norad: "25544" }) });
    check("위성 행을 누르면 그 위성이 선택된다",
      state.selectedSat && String(state.selectedSat.norad), "25544");
    check("위성 상세가 열린다", el("panel").classList.contains("hidden"), false);

    // ② 발사 행: `data-id` 만 있다 — **위성 쪽으로 새면 안 된다**
    state.selectedSat = null;
    el("sidebar-list").fire("click", { target: row({ id: "L1" }) });
    check("발사 행은 발사 상세를 연다",
      el("panel-body").innerHTML.includes("테스트 발사"), true);
    check("발사 행이 위성을 고르지는 않는다", state.selectedSat, null);

    // ③ 행이 아닌 곳(빈 여백)을 눌러도 죽지 않는다
    let threw = null;
    try { el("sidebar-list").fire("click", { target: { closest: () => null } }); }
    catch (e) { threw = String(e); }
    check("행이 아닌 곳을 눌러도 조용하다", threw, null);

    // ④ 없는 위성 번호면 아무 일도 안 한다(목록이 갈린 순간에 실제로 일어난다)
    const before = state.selectedSat;
    ctx.pickSatellite("99999");
    check("모르는 위성 번호는 무시한다", state.selectedSat, before);

    // ⑤ 고른 위성으로 **지도가 따라간다** — 목록에서 골랐는데 화면이 그대로면
    //    "눌렀는데 아무 일도 안 난다"가 된다.
    const moves = map.moves().length;
    ctx.pickSatellite("25544");
    check("목록에서 고르면 지도가 그 위성으로 간다", map.moves().length > moves, true);
  }

  // ── 빈 목록은 **왜 비었는지** 말한다 (sidebar.js · P18 축) ──────────────────
  // "0건"만 찍으면 고장인지 조건 문제인지 알 수 없다. 두 목록 다 기준을 함께 보여준다.
  {
    const { ctx, state, el, map } = loadApp({ realSatellite: true });
    group("빈 목록은 이유를 말한다 (P46-3)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);

    // "오늘 밤": 관측지는 있는데 조건을 채운 통과가 없는 경우
    state.observer = { lat: 37.5665, lng: 126.978, label: "서울" };
    state.tonightRows = [];
    ctx.renderTonightRows([]);
    const tonight = el("sidebar-list").innerHTML;
    check("오늘 밤이 비면 기준을 함께 말한다", tonight.includes("눈에 보이는 통과가 없습니다"), true);
    check("무엇을 세는지도 적는다", tonight.includes("태양고도"), true);
    check("건수는 0건으로 찍는다", el("sidebar-count").textContent, "0건");

    // 위성 목록: 받은 위성이 하나도 없는 경우
    state.satrecs = [];
    state.sidebarTab = "sats";
    ctx.renderSatList();
    check("위성 목록이 비면 안내가 뜬다", el("sidebar-list").innerHTML.includes("sb-empty"), true);
    check("위성 수도 0개로 찍는다", el("sidebar-count").textContent, "0개");

    // **빈 경우만 재면 절반이다** — 있을 때 실제로 행이 그려지는지도 본다
    // (변이가 그것만 못 잡아서 드러났다: 조건을 뒤집어도 "빈 안내"쪽 단언은 통과한다).
    const rec2 = ctx.satellite.twoline2satrec(ISS[0], ISS[1]);
    state.satrecs = [{ norad: "25544", name: "ISS (ZARYA)", rec: rec2, band: "leo" }];
    ctx.renderSatList();
    check("위성이 있으면 목록 행을 그린다",
      el("sidebar-list").innerHTML.includes("ISS (ZARYA)"), true);
    check("빈 안내는 사라진다", el("sidebar-list").innerHTML.includes("sb-empty"), false);
    check("위성 수가 실제 수로 찍힌다", el("sidebar-count").textContent, "1개");
  }

  // ── 강제 갱신은 위성도 같이 받는다 (boot.js) ───────────────────────────────
  // 위성을 켜 둔 채 `↻ 갱신` 을 누르면 발사만 새로 받고 **위성은 낡은 채로 남으면**
  // 화면의 점이 옛 궤도로 그려진다 — 그런데 아무 말도 안 한다.
  {
    const { ctx, state, el, map, api } = loadApp();
    group("강제 갱신은 위성도 받는다 (P46-3)");
    state.map = map;
    for (const s of ["launches", "launch-heat", "launch-track", "satellites", "sat-track", "sats"]) {
      map.stubSource(s);
    }
    let sats = 0;
    api.get_launches = async () => ({ launches: [], error: null, age: 0 });
    api.get_satellites = async () => { sats++; return { satellites: [], groups: [] }; };

    el("toggle-sat").checked = false;
    await ctx.forceRefresh();
    check("위성이 꺼져 있으면 위성은 받지 않는다", sats, 0);

    el("toggle-sat").checked = true;
    await ctx.forceRefresh();
    check("켜져 있으면 위성도 같이 받는다", sats, 1);
  }

  // ── 가시 전용 토글의 후속 (boot.js) ────────────────────────────────────────
  // 켜고 끌 때 **열려 있는 화면**이 따라와야 한다 — 통과 예측표와 "오늘 밤" 탭.
  {
    const { ctx, state, el, map, api } = loadApp({ realSatellite: true });
    group("가시 전용 토글의 후속 (P46-3)");
    state.map = map;
    for (const s of ["satellites", "sat-track", "sats"]) map.stubSource(s);
    const rec = ctx.satellite.twoline2satrec(ISS[0], ISS[1]);
    state.selectedSat = { norad: "25544", name: "ISS (ZARYA)", rec, band: "leo" };
    state.observer = { lat: 37.5665, lng: 126.978, label: "서울" };
    ctx.bindUI();

    // 통과 예측표를 열어 둔 상태에서 토글한다
    ctx.openRightPanel("pass-panel");
    el("pass-body").innerHTML = "";
    el("toggle-visible-only").checked = true;
    el("toggle-visible-only").fire("change", { target: { checked: true } });
    check("열려 있는 통과 예측표를 다시 그린다", el("pass-body").innerHTML.length > 0, true);

    // "오늘 밤" 탭이 열려 있으면 그것도
    ctx.openRightPanel("");                 // 통과 패널을 닫는다
    state.sidebarTab = "tonight";
    el("sidebar-list").innerHTML = "";
    el("toggle-visible-only").fire("change", { target: { checked: false } });
    check("오늘 밤 탭도 다시 그린다", el("sidebar-list").innerHTML.length > 0, true);
  }
})();

// ── 오른쪽 패널은 한 번에 하나 (P36-1) ───────────────────────────────────────
// 상세·통과 예측·통계는 같은 클래스(`.panel`)라 **자리가 완전히 같다**(겹침 320x394).
// 여는 쪽이 나머지를 안 닫아서, **통계를 연 채 발사를 클릭하면** 상세가 열리는데도
// 통계가 그 위에 덮여 **아무 일도 안 일어난 것처럼 보였다.** 화면으로는 "클릭이
// 안 먹는다"로만 보이고, 패널 각각의 테스트는 전부 통과한다.
{
  const { ctx, el, state, map } = loadApp({ realSatellite: true });
  group("오른쪽 패널은 한 번에 하나 (P36-1)");
  state.map = map;
  const open = () => ["panel", "pass-panel", "stats-panel"]
    .filter((id) => !el(id).classList.contains("hidden"));

  const d = {
    id: "1", name: "테스트 발사", net: "2026-09-25T00:00:00Z", outcome: "upcoming",
    pad: { lat: 28, lng: -80, name: "LC-39A" }, provider: "SpaceX", rocket: "Falcon 9",
  };
  state.allLaunches = [d];

  check("처음에는 셋 다 닫혀 있다", open(), []);
  ctx.showStats();
  check("통계를 열면 통계만", open(), ["stats-panel"]);
  ctx.openPanel(d);
  check("그 상태에서 발사를 열면 상세만 — 통계는 닫힌다", open(), ["panel"]);
  ctx.showStats();
  check("다시 통계를 열면 상세가 닫힌다", open(), ["stats-panel"]);

  // 위성 상세도 같은 `panel` 을 쓴다(satpanel.js) — 통계가 위에 남아 있으면 안 보인다.
  const rec = ctx.satellite.twoline2satrec(
    "1 25544U 98067A   26265.50000000  .00016717  00000-0  10270-3 0  9006",
    "2 25544  51.6400 208.9163 0006317  69.9862 290.1591 15.49468300 10000");
  ctx.openSatPanel({ name: "ISS (ZARYA)", norad: "25544", rec: rec });
  check("위성 상세를 열어도 통계는 닫힌다", open(), ["panel"]);

  // 직접 부르는 경로도 같은 규칙을 지킨다(순수하게 토글만 하는 함수다).
  ctx.openRightPanel("pass-panel");
  check("통과 예측을 열면 나머지가 닫힌다", open(), ["pass-panel"]);
  ctx.openRightPanel("없는-패널");
  check("이름이 틀리면 전부 닫힌다(둘이 남지 않는다)", open(), []);
}

// ── 사이드바를 열면 좌하단 배지를 비켜 세운다 (P35-1) ────────────────────────
// 배지 셋(히트맵 범례·업데이트·오프라인)은 사이드바와 **같은 자리**에 있었고 z-index 도
// 같아, 사이드바가 열려 있으면 셋 다 그 뒤로 완전히 숨었다 — 오프라인 배지는 눌러야
// 닫히고 업데이트 배지는 눌러야 받는데, **있는 줄도 모르게 된다.**
// 여기서는 **클래스가 붙는가**만 잰다. 실제로 안 겹치는지는 `tests/test_layout.js`.
{
  const { ctx, el } = loadApp();
  group("사이드바를 열면 배지를 비켜 세운다 (P35-1)");
  const body = el("body");

  check("처음에는 sidebar-open 이 없다", body.classList.contains("sidebar-open"), false);
  ctx.toggleSidebar();
  check("사이드바를 열면 body 에 sidebar-open 이 붙는다",
    body.classList.contains("sidebar-open"), true);
  check("사이드바가 실제로 열렸다", el("sidebar").classList.contains("hidden"), false);
  ctx.toggleSidebar();
  check("닫으면 클래스도 같이 떨어진다", body.classList.contains("sidebar-open"), false);
  check("사이드바도 닫혔다", el("sidebar").classList.contains("hidden"), true);
}

// ── 오버레이 상단 기준선 (P34-2) ─────────────────────────────────────────────
// 툴바 높이는 창 폭에 따라 변한다(자연 폭 1,065px — 창이 그보다 좁으면 두 줄).
// CSS 는 한 줄일 때의 값 92px 을 박아 두고 있었고, 그래서 좁은 창에서 사이드바 탭이
// 툴바 뒤로 들어갔다. 여기서는 **계산과 배선**을, 실제 기하는 `test_layout.js` 가 잰다.
{
  const { ctx, el, win, cssVars } = loadApp();
  group("오버레이 상단 기준선 (P34-2)");

  check("한 줄 툴바(아래 86px)면 기존 값 92 를 지킨다", ctx.uiTopFromToolbar(86), 92);
  check("두 줄 툴바(아래 130px)면 그 아래로 민다", ctx.uiTopFromToolbar(130), 136);
  check("툴바를 못 재면(숫자가 아니면) 92 로 둔다", ctx.uiTopFromToolbar(undefined), 92);
  check("NaN 도 92 로 둔다", ctx.uiTopFromToolbar(NaN), 92);

  // 배선: 창이 좁아 툴바가 두 줄이 된 상태를 만들고 resize 를 쏜다.
  ctx.bindUI();
  el("toolbar").rect = { bottom: 130 };
  win.fire("resize");
  check("resize 를 받으면 --ui-top 을 툴바 아래로 옮긴다", cssVars["--ui-top"], "136px");

  el("toolbar").rect = { bottom: 86 };
  win.fire("resize");
  check("창을 다시 넓히면 되돌아온다", cssVars["--ui-top"], "92px");

  // 툴바를 잴 수 없는 환경(스텁·아직 없는 요소)에서 죽지 않는다 — 이게 없으면
  // 부트가 여기서 멈춰 지도까지 안 뜬다(P23-1 이 지키려는 경로다).
  el("toolbar").rect = null;
  const before = cssVars["--ui-top"];
  let threw = null;
  try { ctx.syncUiTop(); } catch (e) { threw = String(e); }
  check("툴바를 못 재면 예외 없이 지나간다", threw, null);
  check("못 쟀을 때 옛 값을 뭉개지 않는다", cssVars["--ui-top"], before);
}

// ── bindUI 가 거는 배선 전부 (2026-09-14 정기 점검) ───────────────────────────
// **배선 18개를 지워도 688건이 전부 통과했다.** 검색창·패널 닫기·탭 전환·타임라인
// 슬라이더·새로고침·아카이브 불러오기가 통째로 죽어도 테스트가 초록이었다는 뜻이다.
// 이 리포가 반복해 당한 갈래고(2026-09-11 하루 세 번 · 2026-09-12 `tab-tonight`),
// 그때마다 개별 테스트를 하나씩 더했지만 **나머지는 그대로 비어 있었다.**
//
// ⚠ 목록을 `boot.js` 에서 긁어 오지 않고 **여기 손으로 적는다.** 긁어 오면 배선을 지울 때
//   기대 목록에서도 같이 사라져 **검사가 공허하게 통과한다** — 이 파일이 정답지다.
{
  const { ctx, el, map, doc, win, sel, state } = loadApp();
  group("bindUI 배선 전수 (정기 점검)");
  state.map = map;
  map.stubSource("launches");
  map.stubSource("launch-heat");
  map.stubSource("launch-track");
  map.stubSource("terminator");
  state.allLaunches = [];
  const flt = { value: "success", handlers: {}, addEventListener(e, f) { this.handlers[e] = f; } };
  sel[".flt"] = [flt];

  // [엘리먼트 id, 이벤트] — 하나라도 빠지면 그 기능은 앱에서 죽어 있는 것이다.
  const WIRING = [
    ["search", "input"], ["panel-close", "click"],
    ["toggle-terminator", "change"], ["toggle-sat", "change"], ["toggle-heat", "change"],
    ["sat-groups-btn", "click"], ["tz-btn", "click"], ["more-btn", "click"],
    ["basemap-btn", "click"],
    ["stats-btn", "click"], ["stats-close", "click"],
    ["sat-track-btn", "click"], ["sat-obs-btn", "click"], ["sat-pass-btn", "click"],
    ["sat-ctrl-close", "click"], ["sat-ahead", "input"], ["pass-close", "click"],
    ["toggle-list", "click"], ["sidebar-list", "click"],
    ["tab-launches", "click"], ["tab-sats", "click"], ["tab-favs", "click"],
    ["tab-tonight", "click"],
    ["toggle-visible-only", "change"], ["sat-search", "input"],
    ["tl-range", "input"], ["tl-range", "change"],
    ["arch-load", "click"], ["refresh", "click"],
  ];

  let before = 0;
  for (const [id, ev] of WIRING) if (el(id).handlers[ev]) before++;
  check("bindUI 전에는 아무 배선도 없다", before, 0);
  check("bindUI 전에는 document keydown 이 없다", doc.has("keydown"), false);

  ctx.bindUI();

  const missing = [];
  for (const [id, ev] of WIRING) if (!el(id).handlers[ev]) missing.push(id + "(" + ev + ")");
  check("bindUI 가 " + WIRING.length + "개 배선을 전부 건다", missing, []);
  check("결과 필터(.flt)에도 change 를 건다", !!flt.handlers.change, true);
  check("document 에 keydown 을 건다", doc.has("keydown"), true);
  // 창 폭이 바뀌면 툴바가 두 줄이 된다(P34-2). 이 한 줄이 없으면 사이드바 탭이 툴바
  // 뒤로 들어가는데, **좌표가 없는 스텁에서는 아무 단언도 안 깨진다** — 그래서 여기서는
  // "붙었는가"만 재고, 실제 기하는 `tests/test_layout.js` 가 Edge 로 잰다.
  check("window 에 resize 를 건다", win.has("resize"), true);
}

// ── 배선을 실제로 눌러 본다 (2026-09-14 정기 점검 2단) ────────────────────────
// 위 전수 테스트는 **붙었는지만** 본다. 그런데 2026-09-12 에 죽어 있던 `tab-tonight` 은
// **배선이 빠진 게 아니었다** — 핸들러는 붙어 있었고, 누르면 `Set` 에 `.includes()` 를
// 불러 `TypeError` 로 죽었다. 즉 붙었는지만 재는 테스트로는 **그 버그가 안 잡힌다.**
// 그래서 눌러 보고 **예외가 안 나는지**까지 잰다. 화면에 무엇이 나오는지는 각 기능의
// 테스트가 따로 재고, 여기서는 "눌렀더니 죽더라"만 막는다.
{
  const { ctx, state, el, map, doc, sel, api } = loadApp({ realSatellite: true });
  group("배선을 눌러 본다 — 예외 없이 도는가");
  state.map = map;
  for (const s of ["launches", "launch-heat", "launch-track", "terminator", "sats", "sat-track"])
    map.stubSource(s);

  // 죽은 경로를 실제로 태우려면 **막힌 안내로 빠지지 않는 상태**여야 한다(2026-09-12 의 교훈).
  state.observer = { lat: 37.5665, lng: 126.978, label: "서울" };
  state.favSats = new Set(["25544"]);
  state.favLaunches = new Set(["1"]);
  const rec = ctx.satellite.twoline2satrec(
    "1 25544U 98067A   26255.50000000  .00016717  00000-0  10270-3 0  9005",
    "2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.72125391563537");
  state.satrecs = [{ name: "ISS (ZARYA)", norad: 25544, rec: rec }];
  state.allLaunches = [{ id: "1", name: "테스트", outcome: "success", lat: 28.5, lng: -80.5,
                         net: "2026-05-01T00:00:00Z", rocket: "Falcon 9 Block 5",
                         rocket_family: "Falcon", provider: "SpaceX",
                         location_name: "Cape Canaveral" }];
  state.launches = state.allLaunches;
  state.loadedYears = new Set();
  state.truncatedYears = new Set();
  const flt2 = { value: "success", checked: true, handlers: {},
                 addEventListener(e, f) { this.handlers[e] = f; },
                 fire(e, a) { if (this.handlers[e]) this.handlers[e](a); } };
  sel[".flt"] = [flt2];
  sel[".flt:checked"] = [flt2];
  api.get_archive = async () => ({ launches: [] });

  ctx.bindUI();
  el("arch-year").value = "2025";
  el("sat-ahead").value = "30";
  el("tl-range").value = "50";

  const CHECKBOX = { target: { checked: true } };
  const ROW = { target: { closest: () => ({ dataset: { id: "1" } }) } };
  // [id, 이벤트, 넘길 값] — 체크박스는 `e.target.checked` 를 읽고, 목록은 `e.target.closest` 를 쓴다
  const PRESSES = [
    ["search", "input", {}], ["panel-close", "click", {}],
    ["toggle-terminator", "change", CHECKBOX], ["toggle-sat", "change", CHECKBOX],
    ["toggle-heat", "change", CHECKBOX],
    ["sat-groups-btn", "click", {}], ["tz-btn", "click", {}], ["more-btn", "click", {}],
    ["basemap-btn", "click", {}],
    ["stats-btn", "click", {}], ["stats-close", "click", {}],
    ["sat-track-btn", "click", {}], ["sat-obs-btn", "click", {}], ["sat-pass-btn", "click", {}],
    ["sat-ctrl-close", "click", {}], ["sat-ahead", "input", {}], ["pass-close", "click", {}],
    ["toggle-list", "click", {}],
    ["sidebar-list", "click", { target: { closest: () => null } }],
    ["sidebar-list", "click", ROW],
    ["tab-launches", "click", {}], ["tab-sats", "click", {}],
    ["tab-favs", "click", {}], ["tab-tonight", "click", {}],
    ["toggle-visible-only", "change", CHECKBOX], ["sat-search", "input", {}],
    ["tl-range", "input", {}], ["arch-load", "click", {}], ["refresh", "click", {}],
  ];

  const threw = [];
  for (const [id, ev, arg] of PRESSES) {
    try { el(id).fire(ev, arg); }
    catch (e) { threw.push(id + "(" + ev + "): " + e.message); }
  }
  try { flt2.fire("change", CHECKBOX); } catch (e) { threw.push(".flt: " + e.message); }
  // 단축키도 같은 경로다 — `/`·`Esc`·`S`·숫자키를 눌러 본다
  for (const key of ["/", "Escape", "s", "1", "6", "7", "t", "?", "b", "c", "g", "a"]) {
    try { doc.fire("keydown", { key: key, target: { tagName: "BODY" }, preventDefault() {} }); }
    catch (e) { threw.push("keydown " + key + ": " + e.message); }
  }
  check("눌러도 예외가 나지 않는다", threw, []);

  // 탭 전환이 **실제로 일어났는지**까지 본다 — 예외 없이 아무 일도 안 하는 경우가 있다
  el("tab-tonight").fire("click", {});
  check("오늘 밤 탭을 누르면 탭이 바뀐다(2026-09-12 에 여기가 죽어 있었다)",
    state.sidebarTab, "tonight");
  el("tab-launches").fire("click", {});
  check("발사 탭으로 되돌아온다", state.sidebarTab, "launches");

  // ⋯ 도 같다 — 예외가 안 나는 것과 **실제로 열리는 것**은 다르다(P17-1).
  el("toolbar-more").classList.add("hidden");   // 위 PRESSES 에서 한 번 눌렸으므로 되돌린다
  el("more-btn").fire("click", {});
  check("⋯ 를 누르면 툴바 팝오버가 열린다", el("toolbar-more").hidden, false);
  el("more-btn").fire("click", {});
  check("다시 누르면 닫힌다", el("toolbar-more").hidden, true);

  // 접힌 버튼의 단축키가 **같은 함수**를 부르는지 — 팝오버를 열지 않고도 되어야 한다.
  const basemapBefore = state.basemap;
  doc.fire("keydown", { key: "b", target: { tagName: "BODY" }, preventDefault() {} });
  check("B 는 팝오버를 열지 않고 배경을 바꾼다",
    [state.basemap !== basemapBefore, el("toolbar-more").hidden], [true, true]);
  doc.fire("keydown", { key: "c", target: { tagName: "BODY" }, preventDefault() {} });
  check("C 는 통계 패널을 연다", el("stats-panel").hidden, false);
  el("sat-groups").classList.add("hidden");
  doc.fire("keydown", { key: "g", target: { tagName: "BODY" }, preventDefault() {} });
  check("G 는 위성 그룹 팝오버를 연다", el("sat-groups").hidden, false);
}

// ── TLE 신선도 (S16-1) ───────────────────────────────────────────────────────
// 지도의 점이 **언제 관측된 궤도**로 그려졌는지 화면이 말한 적이 없었다. 실측(2026-09-14):
// 캐시에 49.8일 된 TLE 파일이 셋 있었고, 50일 된 TLE 로 계산한 위치는 최신 대비
// **중앙 1,250km** 어긋났다(저궤도 HXMT 2,880km · 고궤도 SDO 73km).
{
  const { ctx, state, el, map, api } = loadApp({ realSatellite: true });
  group("TLE 나이 (tleAgeDays · tleAgeText)");

  // 에포크가 **확정된** TLE — `26255.50000000` = 2026년 255일째 12:00 UTC = 2026-09-12 12:00Z.
  // 시각에 기대는 단언은 그 자리를 덮는지가 우연이다 → 고정 시각을 주입해 잰다.
  const rec = ctx.satellite.twoline2satrec(
    "1 25544U 98067A   26255.50000000  .00016717  00000-0  10270-3 0  9005",
    "2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.72125391563537");
  const at = (iso) => Date.parse(iso);
  check("에포크로부터 3일", Math.round(ctx.tleAgeDays(rec, at("2026-09-15T12:00:00Z")) * 100) / 100, 3);
  check("에포크 당일이면 0", Math.round(ctx.tleAgeDays(rec, at("2026-09-12T12:00:00Z")) * 100) / 100, 0);
  check("반나절", Math.round(ctx.tleAgeDays(rec, at("2026-09-13T00:00:00Z")) * 100) / 100, 0.5);
  check("rec 가 없으면 null", ctx.tleAgeDays(null, at("2026-09-15T12:00:00Z")), null);
  check("에포크가 없으면 null", ctx.tleAgeDays({}, at("2026-09-15T12:00:00Z")), null);
  check("에포크가 0 이면 null", ctx.tleAgeDays({ jdsatepoch: 0 }, at("2026-09-15T12:00:00Z")), null);

  check("한 시간 안이면 '방금'", ctx.tleAgeText(0.02), "방금 관측");
  check("하루 안이면 시간 단위", ctx.tleAgeText(0.5), "12시간 전 관측");
  // 실측에서 나온 값들 — gps-ops 3.84일 · 낡은 파일 49.8일
  check("열흘 안이면 소수 한 자리", ctx.tleAgeText(3.84), "3.8일 전 관측");
  check("열흘 넘으면 반올림", ctx.tleAgeText(49.8), "50일 전 관측");
  check("없으면 null", ctx.tleAgeText(null), null);

  group("낡은 TLE 알림 (staleTleNote)");
  const now = at("2026-09-15T12:00:00Z");
  const recAt = (days) => ({ rec: { jdsatepoch: (now - days * 86400000) / 86400000 + 2440587.5 } });
  check("전부 신선하면 알리지 않는다",
    ctx.staleTleNote([recAt(0.2), recAt(1), recAt(2.9)], now), null);
  check("빈 목록도 null", ctx.staleTleNote([], now), null);
  check("null 도 null", ctx.staleTleNote(null, now), null);
  const note = ctx.staleTleNote([recAt(0.2), recAt(5), recAt(49.8)], now);
  check("낡은 개수를 센다", note.includes("위성 2개"), true);
  // **가장 낡은 것**을 말한다 — 평균을 내면 그룹마다 신선도가 갈려 양쪽 다 거짓이 된다
  check("가장 오래된 것을 말한다", note.includes("50일 전 관측"), true);
  check("왜 문제인지도 말한다", note.includes("위치가 실제와 다를 수 있습니다"), true);
  check("경계값(3일)은 낡은 것이 아니다", ctx.staleTleNote([recAt(3)], now), null);
  check("경계 바로 위는 낡은 것", ctx.staleTleNote([recAt(3.01)], now).includes("위성 1개"), true);
  check("rec 없는 항목은 세지 않는다", ctx.staleTleNote([{ rec: null }, {}], now), null);

  // **대역마다 임계가 다르다.** 하나(3일)로 뒀더니 실제 캐시에서 `gps-ops` 32개가 전부
  // 걸렸다(중앙 3.84일) — MEO 는 대기가 없어 나흘 된 TLE 도 정확하다. 실측 50일 어긋남이
  // 저궤도 2,880km 대 고궤도 73km 라 20~40배 차이다.
  const meoAt = (days) => ({ rec: { no: 0.008726,        // 12시간 주기 → MEO(고도 ~20,200km)
    jdsatepoch: (now - days * 86400000) / 86400000 + 2440587.5 } });
  check("대역 판정 — MEO 로 잡힌다", ctx.orbitBand(meoAt(1).rec), "meo");
  check("MEO 는 10일이어도 안 낡았다", ctx.staleTleNote([meoAt(10)], now), null);
  check("같은 10일이라도 LEO 는 낡았다", ctx.staleTleNote([recAt(10)], now).includes("위성 1개"), true);
  check("MEO 도 30일을 넘으면 낡았다", ctx.staleTleNote([meoAt(31)], now).includes("위성 1개"), true);
  check("상세 패널도 같은 기준 — MEO 10일은 경고 없음",
    ctx.tleAgeRow({ no: 0.008726, jdsatepoch: (Date.now() - 10 * 86400000) / 86400000 + 2440587.5 })
      .includes("tle-old"), false);

  group("위성 상세의 궤도 데이터 줄 (tleAgeRow)");
  // 이 줄만 `Date.now()` 를 쓴다(화면은 지금을 말한다) → 나이를 만들어 상대로 잰다
  const fresh = { jdsatepoch: (Date.now() - 0.5 * 86400000) / 86400000 + 2440587.5 };
  const old = { jdsatepoch: (Date.now() - 40 * 86400000) / 86400000 + 2440587.5 };
  check("신선하면 경고 색이 없다", ctx.tleAgeRow(fresh).includes("tle-old"), false);
  check("신선해도 줄은 있다", ctx.tleAgeRow(fresh).includes("궤도 데이터"), true);
  check("낡으면 경고 색이 붙는다", ctx.tleAgeRow(old).includes("tle-old"), true);
  check("낡으면 ⚠ 도 붙는다", ctx.tleAgeRow(old).includes("⚠"), true);
  check("에포크가 없으면 줄 자체가 없다", ctx.tleAgeRow({}), "");
  // **줄을 만드는 것과 패널에 실리는 것은 다르다.** 위 단언은 전부 통과하는데 `satRowsHtml`
  // 에서 호출 한 줄을 빼면 화면에서 사라진다 — 변이 실험이 이 구멍을 잡았다(2026-09-14).
  ctx.openSatPanel({ name: "ISS (ZARYA)", norad: "25544", rec: rec });
  check("위성 상세 패널에 실린다", el("panel-body").innerHTML.includes("궤도 데이터"), true);
  ctx.openSatPanel({ name: "낡은 위성", norad: "40000", rec: old });
  check("낡은 위성은 패널에서도 경고 색", el("panel-body").innerHTML.includes("tle-old"), true);

  group("배선 — 오래된 캐시를 쓸 때 알리는가");
  state.map = map;
  map.stubSource("satellites");
  map.stubSource("sat-track");
  // **예전에는 `res.error && !res.stale` 이라 stale 이면 경고를 껐다** — 알려야 할 때 침묵했다.
  api.get_satellites = async () => ({ satellites: [], stale: true, error: "요청이 한도를 넘었습니다" });
  await ctx.loadSatellites();
  check("stale 이면 상태줄로 알린다", el("status").textContent.includes("이전 데이터"), true);
  check("원인도 같이 말한다", el("status").textContent.includes("한도"), true);

  el("status").textContent = "";
  api.get_satellites = async () => ({ satellites: [], stale: false, error: null });
  await ctx.loadSatellites();
  check("정상이면 아무 말도 안 한다", el("status").textContent, "");
}

// ── 재진입 예보 (S16-2) ──────────────────────────────────────────────────────
// SGP4 는 대기권에 들어가면 값을 못 낸다 — 그 첫 시점을 이진 탐색으로 찾으면 **새 저장
// 구조 없이**(P12-8 이 보류된 이유였다) 예보가 나온다. 실측 2,926건 중 190건(6.5%).
//
// ⚠ **시각을 반드시 주입한다.** 아래 TLE 는 2026-09-14 에 받은 실제 값이라, 실행 시각이
//    흐르면 같은 위성이 "이미 재진입"으로 바뀐다 — 오전엔 통과하고 저녁엔 실패하는
//    그 갈래다(CLAUDE.md). 에포크에 가까운 고정 시각으로 잰다.
{
  const { ctx, el, map, state } = loadApp({ realSatellite: true });
  group("재진입 예보 (decayForecastDays · decayText)");
  const rec = (l1, l2) => ctx.satellite.twoline2satrec(l1, l2);

  // 실측 당시 1.0일 뒤 재진입으로 나온 것 (근지점 154km)
  const soon = rec("1 46383U 20062BL  26256.96594251  .09241640  12468-4  44863-3 0  9995",
                   "2 46383  53.0145  88.1861 0009957 285.0606  74.9339 16.42207054334964");
  // 3.4일 뒤 (근지점 175km)
  const soon2 = rec("1 45190U 20012N   26256.87736215  .04570326  12224-4  59879-3 0  9997",
                    "2 45190  53.0136  99.6063 0008149 279.5062  80.5060 16.34760025365642");
  // 14일 뒤 — 로켓 몸체(기동을 안 하는 물체라 예보가 가장 정직하게 성립한다)
  const body = rec("1 28222U 04012C   26256.97942557  .02618761  26726-5  61072-3 0  9990",
                   "2 28222  97.6978 344.9808 0011927 264.1056  95.8877 16.29651440234038");
  // 86일 뒤 — **30일 밖** 예제(과학위성 SWIFT). 경고 색·배지가 여기엔 붙으면 안 된다
  const far = rec("1 28485U 04047A   26257.20538003  .00141533  00000+0  68693-3 0  9996",
                  "2 28485  20.5506 213.1233 0002475 196.8100 163.2267 15.80652070200907");
  // ISS — 기동으로 유지하므로 예보가 안 나와야 한다(실측에서도 안 나왔다)
  const iss = rec("1 25544U 98067A   26257.14321681  .00004666  00000+0  92466-4 0  9990",
                  "2 25544  51.6309 219.8284 0004930 139.3822 220.7535 15.49107075585544");

  const NOW = Date.parse("2026-09-14T12:00:00Z");   // TLE 에포크 근처로 고정
  const fc = (r) => ctx.decayForecastDays(r, NOW);

  check("ISS 는 예보가 없다(기동으로 유지한다)", fc(iss), null);
  check("근지점 154km 는 예보가 나온다", fc(soon) != null, true);
  check("근지점 175km 도 나온다", fc(soon2) != null, true);
  check("로켓 몸체도 나온다", fc(body) != null, true);
  // **순서가 물리와 맞아야 한다** — 절대값은 모델 몫이지만 순서는 우리가 단언할 수 있다
  check("더 낮은 것이 더 빨리 떨어진다", fc(soon) < fc(soon2), true);
  check("로켓 몸체는 그보다 늦다", fc(soon2) < fc(body), true);
  check("전부 상한(365일) 안이다", fc(body) < 365, true);
  check("rec 이 없으면 null", fc(null), null);
  check("궤도요소가 없으면 null", fc({}), null);
  check("평균운동이 0 이면 null", fc({ no: 0 }), null);
  // **같은 rec 을 두 번 불러도 같은 답이 나와야 한다.** 처음엔 `rec.error` 로 걸렀는데
  // 그건 직전 전파가 남긴 찌꺼기라(재진입 너머로 전파하면 6이 박힌다) 두 번째부터 null 이
  // 됐다. 테스트가 그걸 잡았다 — 한 번만 부르는 단언이었으면 영영 안 보였다.
  check("두 번 불러도 같은 값", fc(body), fc(body));
  check("예보를 낸 뒤에도 실시간 위치는 멀쩡하다",
    ctx.satDetails(body) != null, true);
  // 상한을 좁히면 그 밖의 예보는 안 낸다
  check("상한 밖이면 null", ctx.decayForecastDays(body, NOW, 1), null);
  check("상한을 넓히면 다시 나온다", ctx.decayForecastDays(body, NOW, 365) != null, true);

  check("하루 안", ctx.decayText(0.4), "이대로면 하루 안에 재진입");
  check("일 단위", ctx.decayText(14.3), "이대로면 약 14일 뒤 재진입");
  // 300일 뒤를 "약 300일"로 적으면 없는 정밀도를 지어내는 셈이다
  check("먼 예보는 개월로", ctx.decayText(300), "이대로면 약 10개월 뒤 재진입");
  check("없으면 null", ctx.decayText(null), null);

  group("재진입 예보 — 화면에 실리는가");
  check("예보가 있으면 블록이 나온다", ctx.decayBlock(body).includes("재진입"), true);
  check("가정을 같이 적는다", ctx.decayBlock(body).includes("기동은 계산에 없습니다"), true);
  check("30일 안이면 붉은 표시", ctx.decayBlock(soon).includes("decay-soon"), true);
  // 1년 뒤 예보까지 붉으면 경고가 값을 잃는다 → 30일 밖은 순한 색.
  // **로켓 몸체(13일)를 '먼 예제'로 잡았다가 여기서 틀렸다** — 30일 안쪽이었다.
  check("30일 밖이면 순한 색", ctx.decayBlock(far).includes("decay-soon"), false);
  check("30일 밖에도 예보 자체는 나온다", ctx.decayBlock(far).includes("재진입"), true);
  check("ISS 는 블록 자체가 없다", ctx.decayBlock(iss), "");
  check("rec 이 없으면 블록이 없다", ctx.decayBlock(null), "");

  state.map = map;
  map.stubSource("satellites");
  map.stubSource("sat-track");
  // **블록을 만드는 것과 패널에 실리는 것은 다르다**(S16-1 에서 변이가 이 구멍을 잡았다)
  ctx.openSatPanel({ name: "SWIFT", norad: "28485", rec: far });
  check("위성 상세 패널에 실린다", el("panel-body").innerHTML.includes("기동은 계산에 없습니다"), true);
  check("임박하지 않으면 배지가 없다", el("panel-body").innerHTML.includes("재진입 임박"), false);
  ctx.openSatPanel({ name: "STARLINK-1770", norad: "46383", rec: soon });
  check("임박하면 배지가 붙는다", el("panel-body").innerHTML.includes("재진입 임박"), true);
  ctx.openSatPanel({ name: "ISS (ZARYA)", norad: "25544", rec: iss });
  check("ISS 패널에는 예보도 배지도 없다",
    el("panel-body").innerHTML.includes("재진입"), false);
}

// ── 로켓 계열 (P15-4) ─────────────────────────────────────────────────────────
// 실측 라이브 100건: `family` 는 계열이 없을 때 **빈 문자열**로 오고(14/100), 21개 계열 중
// **2종 이상을 묶는 것은 7개뿐**이다. 나머지 14개는 계열 화면의 목록이 로켓 화면과 같아
// 버튼이 거짓말이 된다 — 그래서 "보일지 말지"가 이 기능의 핵심 판정이다.
{
  const { ctx, state, el, map } = loadApp();
  state.map = map;
  map.stubSource("launches");
  map.stubSource("launch-track");
  state.loadedYears = new Set();
  state.truncatedYears = new Set();

  const L = (id, rocket, family) => ({
    id: String(id), name: "L" + id, outcome: "success", net: "2026-05-01T00:00:00Z",
    lat: 28.5, lng: -80.5, rocket: rocket, rocket_family: family,
    provider: "SpaceX", location_name: "Cape Canaveral",
  });
  const fleet = [L(1, "Falcon 9 Block 5", "Falcon"), L(2, "Falcon 9 Block 5", "Falcon"),
                 L(3, "Falcon Heavy", "Falcon"), L(4, "Starship V3", "Starship"),
                 L(5, "Electron", null)];
  state.allLaunches = fleet;

  group("계열 변형 세기 (familyVariants · P15-4)");
  check("같은 변형은 한 번만 센다",
    ctx.familyVariants("Falcon"), ["Falcon 9 Block 5", "Falcon Heavy"]);
  check("변형이 하나뿐인 계열", ctx.familyVariants("Starship"), ["Starship V3"]);
  check("계열이 없으면 빈 목록", ctx.familyVariants(null), []);
  // LL2 는 `null` 이 아니라 `""` 로 준다 — 파싱이 None 으로 바꾸지만 화면도 막아 둔다
  check("빈 문자열도 빈 목록", ctx.familyVariants(""), []);
  check("모르는 계열은 빈 목록", ctx.familyVariants("없는 계열"), []);
  check("목록을 넘기면 그걸로 센다(아카이브를 불러오면 늘어난다)",
    ctx.familyVariants("Falcon", [L(9, "Falcon 9 Block 5", "Falcon")]), ["Falcon 9 Block 5"]);

  group("계열 행은 변형이 2종 이상일 때만 (familyRow)");
  const famRow = ctx.familyRow(L(1, "Falcon 9 Block 5", "Falcon"));
  check("2종이면 행이 나온다", famRow.includes("Falcon"), true);
  check("변형 개수를 덧말로 붙인다", famRow.includes("변형 2종"), true);
  // 덧말이 조회 키에 섞이면 관점 화면이 아무것도 못 찾는다 — 표시와 키를 갈라 둔 이유
  check("data-val 은 계열 이름만", famRow.includes(`data-val="Falcon"`), true);
  check("1종이면 행이 없다(로켓 관점과 목록이 같다)",
    ctx.familyRow(L(4, "Starship V3", "Starship")), "");
  check("계열이 없으면 행이 없다", ctx.familyRow(L(5, "Electron", null)), "");
  check("옛 캐시(필드 자체가 없음)에서도 죽지 않는다", ctx.familyRow({ rocket: "Electron" }), "");

  group("계열 관점 화면 (entityBars · 제목)");
  const falcons = fleet.filter((d) => d.rocket_family === "Falcon");
  const bars = ctx.entityBars("family", falcons, ctx.computeStats(falcons));
  check("첫 막대가 변형별이다(이 화면의 존재 이유)", bars[0][0], "변형별");
  check("변형별 막대가 실제로 두 변형을 센다",
    bars[0][1], [["Falcon 9 Block 5", 2], ["Falcon Heavy", 1]]);
  check("계열 화면에도 연도별이 남는다", bars.map((b) => b[0]).includes("연도별"), true);
  // 상세 패널이 "변형 10종"이라고 말한 뒤 막대가 6개만 보이면 화면이 스스로와 어긋난다.
  // 실측 렌더에서 `Long March`(10종)가 정확히 그 상태였다 — 다른 막대의 상한 6과 다르다.
  const lm = [];
  for (let i = 0; i < 9; i++) lm.push(L(100 + i, "Long March " + i, "Long March"));
  check("변형별은 상위 6종으로 자르지 않는다",
    ctx.entityBars("family", lm, ctx.computeStats(lm))[0][1].length, 9);
  check("계열 화면의 다른 막대는 상한을 지킨다(발사장 6)",
    ctx.entityBars("family", lm, ctx.computeStats(lm))[2][1].length <= 6, true);
  // 로켓 관점은 건드리지 않았다 — 바뀌면 기존 화면이 조용히 달라진다
  check("로켓 관점 막대는 그대로", ctx.entityBars("rocket", falcons, ctx.computeStats(falcons))
    .map((b) => b[0]), ["기관", "발사장", "연도별"]);

  ctx.showEntityStats("family", "Falcon");
  check("제목이 '계열'로 끝난다", el("stats-body").innerHTML.includes("Falcon 계열"), true);
  check("계열 화면에 변형별 막대가 실린다",
    el("stats-body").innerHTML.includes("변형별"), true);
  ctx.showEntityStats("rocket", "Falcon 9 Block 5");
  check("로켓 화면 제목에는 '계열'이 안 붙는다",
    el("stats-body").innerHTML.includes("Falcon 9 Block 5 계열"), false);

  group("배선 (상세 패널 · 관점 화면 · 클릭)");
  ctx.openPanel(L(1, "Falcon 9 Block 5", "Falcon"));
  check("상세 패널에 계열 행이 실린다",
    el("panel-body").innerHTML.includes("변형 2종"), true);
  ctx.openPanel(L(5, "Electron", null));
  check("계열 없는 로켓의 패널에는 안 실린다",
    el("panel-body").innerHTML.includes("계열"), false);

  ctx.showEntityStats("rocket", "Falcon 9 Block 5");
  check("로켓 관점 화면에 계열로 올라가는 줄이 있다",
    el("stats-body").innerHTML.includes("Falcon 계열 전체 · 변형 2종"), true);
  ctx.showEntityStats("rocket", "Starship V3");
  check("변형이 하나면 그 줄이 없다",
    el("stats-body").innerHTML.includes("계열 전체"), false);
  ctx.showEntityStats("family", "Falcon");
  check("계열 화면에서 또 계열로 올라가지 않는다",
    el("stats-body").innerHTML.includes("계열 전체"), false);

  // 렌더가 맞아도 `addEventListener` 한 줄이 없으면 눌러도 아무 일이 안 일어난다.
  // 스텁 버튼을 패널에 심어 **실제 클릭 경로**를 태운다(마우스 자동화 없이).
  const btn = { dataset: { kind: "family", val: "Falcon" }, handlers: {},
                addEventListener(ev, fn) { this.handlers[ev] = fn; },
                fire(ev) { if (this.handlers[ev]) this.handlers[ev](); } };
  el("stats-panel").sel[".site-link"] = [btn];
  ctx.showEntityStats("rocket", "Falcon 9 Block 5");
  // **클릭 전에 거짓임을 먼저 못 박는다.** 처음 쓴 단언은 `includes("Falcon 계열")` 이었는데,
  // 로켓 화면에도 `Falcon 계열 전체 ›` 줄이 있어 **클릭 전에 이미 참**이었다 —
  // 배선을 통째로 뜯은 변이가 통과했다(2026-09-14 변이 실험에서 잡았다).
  const famTitle = "<h2>🚀 Falcon 계열</h2>";
  check("클릭 전에는 로켓 화면이다", el("stats-body").innerHTML.includes(famTitle), false);
  btn.fire("click");
  check("계열 줄을 누르면 계열 화면이 열린다",
    el("stats-body").innerHTML.includes(famTitle), true);
  el("stats-panel").sel[".site-link"] = undefined;
}

// ── 첫 실행 안내 (P17-4) ─────────────────────────────────────────────────────
// 첫 실행은 **일부러 얇다**(요청 절약). 문제는 화면이 그 사실을 말한 적이 없다는 것이었다 —
// 모수 안내는 통계 패널 안쪽에만 있었고 처음 여는 사람은 그걸 열지 않는다.
// 조용히 깨지는 자리 셋: ① 판정(한 번 닫았는데 또 뜬다) ② 버튼이 기존 경로를 안 탄다
// (예외 없이 아무 일도 안 일어난다) ③ 발사가 들어오기 **전에** 떠서 "0건"이라고 말한다.
{
  const { ctx } = loadApp();
  group("첫 실행 판정 (shouldShowFirstRun)");
  check("설정이 없으면 띄운다", ctx.shouldShowFirstRun(null), true);
  check("빈 설정도 첫 실행이다", ctx.shouldShowFirstRun({}), true);
  check("한 번 닫았으면 안 띄운다", ctx.shouldShowFirstRun({ firstRunSeen: true }), false);
  check("다른 설정이 있어도 판정은 그 키만 본다",
    ctx.shouldShowFirstRun({ heatmap: true, camera: { zoom: 3 } }), true);

  group("첫 실행 집계 (firstRunCounts)");
  // 시각은 **주입한다** — Date.now() 에 걸면 오전엔 통과하고 저녁엔 실패한다
  const NOW = Date.parse("2026-09-16T00:00:00Z");
  const LIST = [
    { id: "1", net: "2026-09-20T00:00:00Z", outcome: "upcoming" },
    { id: "2", net: "2026-09-01T00:00:00Z", outcome: "success" },
    { id: "3", net: "2026-08-01T00:00:00Z", outcome: "failure" },
    { id: "4", net: "2025-12-01T00:00:00Z", outcome: "success" },
  ];
  const c = ctx.firstRunCounts(LIST, NOW);
  check("총 건수", c.total, 4);
  check("예정·지난을 outcome 으로 가른다", [c.upcoming, c.past], [1, 3]);
  check("연도를 오름차순으로 모은다", c.years, [2025, 2026]);
  // **시각이 아니라 outcome 으로 가르는 이유**: 오늘 발사했는데 결과가 아직 미정인 건이
  // 시각 기준으로는 "지난 것"으로 새는데, 화면에는 예정 색으로 그려져 있다.
  const today = ctx.firstRunCounts(
    [{ id: "5", net: "2026-09-15T23:00:00Z", outcome: "upcoming" }], NOW);
  check("시각이 지났어도 outcome 이 upcoming 이면 예정으로 센다", today.upcoming, 1);
  check("빈 목록도 죽지 않는다", ctx.firstRunCounts([], NOW).total, 0);
  check("목록이 없어도 죽지 않는다", ctx.firstRunCounts(null, NOW).total, 0);

  group("첫 실행 문구 (firstRunHtml)");
  const html = ctx.firstRunHtml(c, 2025);
  check("지금 보이는 건수를 말한다", html.includes("4건"), true);
  check("예정·지난 내역도 적는다", html.includes("예정 1 · 지난 3"), true);
  check("연도 범위를 적는다", html.includes("2025~2026년"), true);
  check("한 해뿐이면 범위로 적지 않는다",
    ctx.firstRunHtml({ total: 9, upcoming: 4, past: 5, years: [2026] }, 2025).includes("2026년"), true);
  check("연도를 모르면 빈 자리를 남기지 않는다",
    ctx.firstRunHtml({ total: 0, upcoming: 0, past: 0, years: [] }, 2025).includes("undefined"), false);
  // 단축키를 같이 적는 것이 P17-3 의 발견 경로다 — 아무 데서도 안 가리키는 단축키는 없는 것과 같다
  check("위성·아카이브 단축키를 함께 보여준다",
    [html.includes("<kbd>5</kbd>"), html.includes("<kbd>A</kbd>")], [true, true]);
  check("권하는 연도를 버튼에 적는다", html.includes("2025년"), true);
  check("세 버튼이 모두 있다",
    ["fr-sat", "fr-arch", "fr-close"].filter((id) => !html.includes(id)), []);
}
{
  // 배선: **부트 → 발사 로드 → 안내** 가 실제로 이어지는가.
  // 순수 함수만 재면 `loadLaunches` 안의 호출 한 줄이 빠져도 전부 통과한다.
  const saved = [];
  const { ctx, el, map, state, win } = loadApp({ api: {
    get_settings: async () => ({}),
    save_settings: (p) => saved.push(p),
    get_launches: async () => ({ launches: [
      { id: "1", net: "2026-09-20T00:00:00Z", outcome: "upcoming", lat: 1, lng: 1 },
      { id: "2", net: "2026-09-01T00:00:00Z", outcome: "success", lat: 2, lng: 2 },
    ] }),
  } });
  group("첫 실행 배선 (부트 → 로드 → 안내)");
  for (const s of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(s);

  check("부트 전에는 안내가 숨어 있다", el("firstrun").hidden, true);
  await win.fire("pywebviewready");
  await new Promise((r) => setImmediate(r));
  check("설정을 읽고 첫 실행으로 판정한다", state.firstRun, true);
  check("아직 발사가 안 왔으면 띄우지 않는다(0건이라고 말하면 안 된다)",
    el("firstrun").hidden, true);

  map.fire("load");
  await new Promise((r) => setImmediate(r));
  check("발사가 들어온 뒤 안내가 뜬다", el("firstrun").hidden, false);
  check("실제 건수를 말한다", el("firstrun").innerHTML.includes("2건"), true);
  check("한 번 띄우면 플래그를 내린다(갱신마다 다시 뜨면 방해다)", state.firstRun, false);

  // 닫기 → 저장까지. 저장이 빠지면 **다음 실행에 또 뜬다**(예외는 안 난다)
  el("fr-close").fire("click", {});
  check("닫으면 사라진다", el("firstrun").hidden, true);
  check("닫았다는 사실을 저장한다", saved.some((p) => p.firstRunSeen === true), true);
}
{
  // 버튼이 **기존 경로를 그대로 타는가.** 여기서 따로 구현하면 저장·필터 갱신이 갈라진다.
  const asked = [];
  const saved = [];
  const { ctx, el, map, state, win } = loadApp({ api: {
    get_settings: async () => ({}),
    save_settings: (p) => saved.push(p),
    get_launches: async () => ({ launches: [
      { id: "1", net: "2026-09-20T00:00:00Z", outcome: "upcoming", lat: 1, lng: 1 }] }),
    get_satellites: async () => { asked.push("sats"); return { satellites: [] }; },
    get_archive: async (y) => { asked.push("archive:" + y); return { launches: [] }; },
  } });
  group("첫 실행 버튼 (기존 경로를 탄다)");
  for (const s of ["launches", "launch-heat", "launch-track", "terminator", "sats", "sat-track"])
    map.stubSource(s);
  await win.fire("pywebviewready");
  await new Promise((r) => setImmediate(r));
  map.fire("load");
  await new Promise((r) => setImmediate(r));

  check("위성은 아직 꺼져 있다", el("toggle-sat").checked, false);
  el("fr-sat").fire("click", {});
  await new Promise((r) => setImmediate(r));
  check("[켜기] 가 위성 체크박스를 켠다", el("toggle-sat").checked, true);
  check("체크박스의 change 경로를 그대로 타 위성을 부른다", asked.includes("sats"), true);
  check("누르면 안내는 닫힌다", el("firstrun").hidden, true);

  // 아카이브 버튼 — 같은 부트를 다시 세워 잰다(위에서 이미 닫혔으므로)
  const asked2 = [];
  const a2 = loadApp({ api: {
    get_settings: async () => ({}),
    save_settings: () => {},
    get_launches: async () => ({ launches: [
      { id: "1", net: "2026-09-20T00:00:00Z", outcome: "upcoming", lat: 1, lng: 1 }] }),
    get_archive: async (y) => { asked2.push(y); return { launches: [] }; },
  } });
  for (const s of ["launches", "launch-heat", "launch-track", "terminator"]) a2.map.stubSource(s);
  await a2.win.fire("pywebviewready");
  await new Promise((r) => setImmediate(r));
  a2.map.fire("load");
  await new Promise((r) => setImmediate(r));
  a2.el("fr-arch").fire("click", {});
  await new Promise((r) => setImmediate(r));
  const lastYear = new Date().getUTCFullYear() - 1;
  check("[작년] 이 그 해 아카이브를 부른다(요청은 누를 때만 나간다)", asked2, [lastYear]);
  check("툴바의 연도 선택도 같이 맞춘다", a2.el("arch-year").value, String(lastYear));
}

// ── 0건 통계 (P18-4) ─────────────────────────────────────────────────────────
// 0 건에서도 숫자판을 그리면 `0 총 발사 · 확정 0건 중` 이 나온다. **틀린 숫자는 아니지만
// 아무것도 알려주지 않는다** — 그리고 통계가 고장난 것처럼도 보인다.
{
  const { ctx, el, state } = loadApp();
  group("0건 통계");
  state.allLaunches = [];
  ctx.showStats();
  const empty = el("stats-body").innerHTML;
  check("패널은 열린다(누르면 반응은 해야 한다)", el("stats-panel").hidden, false);
  check("숫자판을 그리지 않는다", empty.includes("st-tile"), false);
  check("'확정 0건 중' 같은 말을 하지 않는다", empty.includes("확정 0건"), false);
  check("제목은 그대로 둔다", empty.includes("발사 통계"), true);
  check("이유와 갈 길을 말한다",
    [empty.includes("갱신"), empty.includes("불러오기")], [true, true]);

  // 한 건이라도 있으면 **평소 화면**이어야 한다 — 빈 상태가 남으면 그게 더 나쁘다
  state.allLaunches = [{ id: "1", net: "2026-09-01T00:00:00Z", outcome: "success",
                         provider: "SpaceX", country: "미국", rocket: "Falcon 9" }];
  ctx.showStats();
  const one = el("stats-body").innerHTML;
  check("1건이면 숫자판을 그린다", one.includes("st-tile"), true);
  check("그때는 빈 상태 문구가 없다", one.includes("st-empty"), false);
  // P24-2 로 문구가 갈렸다 — 통계는 "불러온 N건 전체 기준"이다.
  check("모수 안내도 평소대로 붙는다", one.includes("불러온 1건 전체 기준"), true);
}

// ── 실패·빈 상태를 화면이 말하는가 (P18-1·2·3) ───────────────────────────────
// 셋 다 **예외가 안 나고 화면만 침묵하거나 거짓말하는** 갈래다. 2026-09-16 에 실패를
// 주입해 재 보고서야 나왔다 — 그때까지 테스트는 전부 초록이었다.
{
  const { ctx } = loadApp();
  group("발사 목록 빈 상태 (launchListEmptyNote)");
  // 원인이 둘이고 **할 말이 다르다**: 못 받은 것(→ 갱신) 대 걸러진 것(→ 조건 풀기).
  const none = ctx.launchListEmptyNote(0, "");
  check("한 건도 못 받았으면 갱신을 가리킨다", none.includes("갱신"), true);
  check("그때는 필터 얘기를 하지 않는다(틀린 안내다)", none.includes("필터"), false);

  const q = ctx.launchListEmptyNote(98, "팰컨");
  check("검색으로 걸러졌으면 검색어를 되비춘다", q.includes("팰컨"), true);
  check("지우면 몇 건이 돌아오는지 말한다", q.includes("98건"), true);
  check("검색어를 이스케이프한다(XSS)",
    ctx.launchListEmptyNote(3, "<img src=x onerror=alert(1)>").includes("<img"), false);

  const f = ctx.launchListEmptyNote(98, "");
  check("검색어가 없으면 필터·타임라인을 가리킨다",
    [f.includes("필터"), f.includes("타임라인")], [true, true]);
  check("그때도 전체 건수를 말한다", f.includes("98건"), true);
  check("세 갈래가 서로 다른 문구다", new Set([none, q, f]).size, 3);
}
{
  const { ctx, el, state, map } = loadApp();
  group("발사 목록 빈 상태 (렌더까지)");
  state.map = map;
  map.stubSource("launches");
  state.sidebarTab = "launches";
  state.allLaunches = [
    { id: "1", net: "2026-09-20T00:00:00Z", outcome: "upcoming", name: "A" },
    { id: "2", net: "2026-09-01T00:00:00Z", outcome: "success", name: "B" },
  ];
  ctx.renderSidebar([]);
  check("빈 목록을 **빈 칸으로 두지 않는다**(2026-09-16 에 여기가 통째로 비어 있었다)",
    el("sidebar-list").innerHTML.trim().length > 0, true);
  check("건수는 그대로 0건", el("sidebar-count").textContent, "0건");
  check("받은 것이 있으므로 '걸러졌다' 쪽으로 말한다",
    el("sidebar-list").innerHTML.includes("필터"), true);

  state.allLaunches = [];
  ctx.renderSidebar([]);
  check("받은 것이 없으면 갱신 쪽으로 말한다",
    el("sidebar-list").innerHTML.includes("갱신"), true);

  // 목록이 있으면 안내가 아니라 행을 그린다 — 안내가 남아 있으면 그게 더 나쁘다
  ctx.renderSidebar(state.allLaunches = [
    { id: "1", net: "2026-09-20T00:00:00Z", outcome: "upcoming", name: "A" }]);
  check("목록이 있으면 안내를 그리지 않는다",
    el("sidebar-list").innerHTML.includes("sb-empty"), false);
}
{
  const { ctx, el, state } = loadApp();
  group("갱신 시각 표기 (updateFreshness)");
  // **분 고정이면 오래된 캐시에서 안 읽힌다** — 실측 `🕒 1800분 전 갱신`(30시간 + 429).
  const at = (mins) => {
    state.lastLaunchLoad = Date.now() - mins * 60000;
    ctx.updateFreshness();
    return el("freshness").textContent;
  };
  check("방금 받았으면 방금", at(0), "🕒 방금 갱신");
  check("한 시간 안쪽은 분", at(30), "🕒 30분 전 갱신");
  check("한 시간을 넘으면 시간으로 바뀐다", at(90), "🕒 1시간 전 갱신");
  check("하루를 넘으면 일로 바뀐다(1800분 이라고 하지 않는다)", at(1800), "🕒 1일 전 갱신");
  check("한 달도 일로 읽힌다", at(43200), "🕒 30일 전 갱신");
  check("받은 적이 없으면 아무 말도 안 한다",
    (state.lastLaunchLoad = null, ctx.updateFreshness(), el("freshness").textContent), "");
  // 표기를 두 벌로 두지 않았다는 확인 — 티커와 같은 함수를 쓴다
  check("티커의 표기와 같은 계단을 쓴다",
    at(1800).includes(ctx.agoText(new Date(Date.now() - 1800 * 60000).toISOString())), true);
}
{
  const { ctx, el, state } = loadApp();
  group("위성 조회 실패를 목록도 말한다 (P18-3)");
  state.satrecs = [];
  state.sidebarTab = "sats";

  el("toggle-sat").checked = false;
  state.satLoadError = null;
  ctx.renderSatList();
  check("꺼져 있으면 켜라고 안내한다", el("sidebar-list").innerHTML.includes("꺼져 있습니다"), true);

  el("toggle-sat").checked = true;
  ctx.renderSatList();
  check("켜져 있고 실패는 없으면 불러오는 중", el("sidebar-list").innerHTML.includes("불러오는 중"), true);

  state.satLoadError = "서버가 접근을 거부했습니다(403).";
  ctx.renderSatList();
  const html = el("sidebar-list").innerHTML;
  check("실패했으면 **불러오는 중이라고 말하지 않는다**", html.includes("불러오는 중"), false);
  check("실패 사유를 그대로 보여준다", html.includes("403"), true);
  check("다시 시도할 길을 가리킨다", html.includes("갱신"), true);
  // 한 상자 안에서 같은 말을 두 번 하지 않는다 — 브릿지 실패 경로에서 실제로 겹쳤다
  state.satLoadError = "앱에서 위성 계산을 시작하지 못했습니다.";
  ctx.renderSatList();
  const dup = el("sidebar-list").innerHTML.match(/받지 못했습니다|불러오지 못했습니다/g) || [];
  check("실패 문구가 한 번만 나온다", dup.length, 1);
}
{
  // 실패 기록이 **실제 로드 경로에서** 세워지는가 — 순수 렌더만 재면 이 배선이 빠져도 통과한다
  const { ctx, el, map, state, win } = loadApp({ realSatellite: true, api: {
    get_settings: async () => ({ firstRunSeen: true }),
    get_launches: async () => ({ launches: [] }),
    get_satellites: async () => ({ satellites: [], error: "서버가 접근을 거부했습니다(403)." }),
  } });
  group("위성 실패 기록 (로드 경로)");
  for (const s of ["launches", "launch-heat", "launch-track", "terminator", "sats", "sat-track"])
    map.stubSource(s);
  await win.fire("pywebviewready");
  await new Promise((r) => setImmediate(r));
  map.fire("load");
  await new Promise((r) => setImmediate(r));
  check("실패 전에는 기록이 없다", state.satLoadError, null);

  await ctx.loadSatellites();
  check("조회가 실패하면 기록한다", state.satLoadError, "서버가 접근을 거부했습니다(403).");
  check("상태줄도 함께 말한다", el("status").textContent.includes("403"), true);

  // 다시 성공하면 기록이 **지워져야** 한다 — 안 지우면 영영 실패 문구가 남는다
  ctx.window.pywebview.api.get_satellites = async () => ({ satellites: [
    { name: "ISS (ZARYA)", norad_id: 25544,
      tle1: "1 25544U 98067A   26255.50000000  .00016717  00000-0  10270-3 0  9005",
      tle2: "2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.72125391563537" }] });
  await ctx.loadSatellites();
  check("다시 성공하면 기록을 지운다", state.satLoadError, null);
  check("위성이 실제로 들어왔다", state.satrecs.length, 1);
}

// ── 켜 둔 채로도 갱신된다 (P19-1·2·3) ────────────────────────────────────────
// 자동 갱신은 **발사만** 다시 받았다 — 켜 둔 시간만큼 TLE 이 늙고, 열어 둔 통과 목록은
// 멈춰 있고, 새 버전도 모른다. 셋 다 **예외 없이 조용히** 낡는다.
{
  const asked = [];
  const { ctx, el, map, state, win } = loadApp({ realSatellite: true, api: {
    get_settings: async () => ({ firstRunSeen: true }),
    get_launches: async () => { asked.push("launches"); return { launches: [] }; },
    get_satellites: async () => { asked.push("satellites"); return { satellites: [
      { name: "ISS (ZARYA)", norad_id: 25544,
        tle1: "1 25544U 98067A   26255.50000000  .00016717  00000-0  10270-3 0  9005",
        tle2: "2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.72125391563537" },
      { name: "TIANGONG", norad_id: 48274,
        tle1: "1 48274U 21035A   26255.50000000  .00020000  00000-0  20000-3 0  9990",
        tle2: "2 48274  41.4700 100.0000 0005000  90.0000 270.0000 15.60000000 10000" }] }; },
  } });
  group("주기 갱신이 위성도 태운다 (P19-1)");
  for (const s of ["launches", "launch-heat", "launch-track", "terminator", "sats", "sat-track"])
    map.stubSource(s);
  // 주기 콜백을 테스트가 들고 있다가 직접 돌린다
  let tick = null;
  ctx.setInterval = (fn, ms) => { if (ms === 5 * 60 * 1000) tick = fn; return 1; };
  await win.fire("pywebviewready");
  await new Promise((r) => setImmediate(r));
  map.fire("load");
  await new Promise((r) => setImmediate(r));
  check("주기 콜백이 걸린다", typeof tick, "function");

  el("toggle-sat").checked = true;
  await ctx.loadSatellites();
  await new Promise((r) => setImmediate(r));
  asked.length = 0;
  if (tick) tick();
  await new Promise((r) => setImmediate(r));
  check("한 주기에 발사와 위성을 **둘 다** 부른다", asked.sort(), ["launches", "satellites"]);

  // 레이어가 꺼져 있으면 부르지 않는다 — 안 보이는 것에 쓸 예산이 없다
  el("toggle-sat").checked = false;
  asked.length = 0;
  if (tick) tick();
  await new Promise((r) => setImmediate(r));
  check("위성이 꺼져 있으면 위성은 안 부른다", asked, ["launches"]);

  // **주기가 통과 목록 정리도 부르는가**(P19-2 의 배선). 순수 함수와 `tickTonightFreshness`
  // 자체는 따로 재지만, 주기에 연결하는 한 줄이 빠지면 그 둘은 전부 통과한다 —
  // 이 리포가 반복해 당한 구멍이라 여기서 실제로 눌러 본다.
  // 시각을 주입할 수 없는 자리이므로 **실제로 지나간** 통과를 만든다.
  state.sidebarTab = "tonight";
  const past = Date.now() - 60000, future = Date.now() + 3600000;
  state.tonightRows = [
    { name: "지난 것", norad: 1, pass: { start: past - 600000, end: past, maxEl: 40, startAz: 0, endAz: 180 } },
    { name: "남은 것", norad: 2, pass: { start: future, end: future + 600000, maxEl: 30, startAz: 0, endAz: 90 } },
  ];
  if (tick) tick();
  await new Promise((r) => setImmediate(r));
  check("주기가 지나간 통과 줄도 걷어낸다", state.tonightRows.map((r) => r.norad), [2]);
}
{
  // **이 변경의 진짜 위험**: 재로드가 보던 위성을 풀어 버리는 것.
  // 가만히 두었는데 2시간마다 선택이 풀리면 기능이 아니라 고장으로 읽힌다.
  const { ctx, el, map, state, win } = loadApp({ realSatellite: true, api: {
    get_settings: async () => ({ firstRunSeen: true }),
    get_launches: async () => ({ launches: [] }),
    get_satellites: async () => ({ satellites: [
      { name: "ISS (ZARYA)", norad_id: 25544,
        tle1: "1 25544U 98067A   26255.50000000  .00016717  00000-0  10270-3 0  9005",
        tle2: "2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.72125391563537" }] }),
  } });
  group("재로드가 보던 위성을 풀지 않는다 (P19-1)");
  for (const s of ["launches", "launch-heat", "launch-track", "terminator", "sats", "sat-track"])
    map.stubSource(s);
  await win.fire("pywebviewready");
  await new Promise((r) => setImmediate(r));
  map.fire("load");
  await new Promise((r) => setImmediate(r));
  el("toggle-sat").checked = true;
  await ctx.loadSatellites();
  await new Promise((r) => setImmediate(r));

  ctx.selectSatellite(state.satrecs[0]);
  state.tracking = true;
  check("위성을 골랐다", state.selectedSat && String(state.selectedSat.norad), "25544");

  await ctx.loadSatellites(true);          // 주기 재로드
  await new Promise((r) => setImmediate(r));
  check("재로드 뒤에도 같은 위성이 선택돼 있다",
    state.selectedSat && String(state.selectedSat.norad), "25544");
  check("추적 모드도 살아남는다", state.tracking, true);
  check("**새** satrec 으로 붙는다(옛 객체를 들고 있으면 낡은 궤도로 그린다)",
    state.selectedSat === state.satrecs[0], true);

  // 평소 경로(그룹 변경 등)는 지금처럼 선택을 푼다 — 사라진 위성을 붙들면 안 된다
  await ctx.loadSatellites();
  await new Promise((r) => setImmediate(r));
  check("유지하라고 하지 않으면 선택을 푼다", state.selectedSat, null);

  // 목록에서 사라졌으면 조용히 포기한다
  ctx.selectSatellite(state.satrecs[0]);
  ctx.window.pywebview.api.get_satellites = async () => ({ satellites: [] });
  await ctx.loadSatellites(true);
  await new Promise((r) => setImmediate(r));
  check("사라진 위성은 되살리지 않는다", state.selectedSat, null);
}
{
  const { ctx, state, el, map } = loadApp();
  group("지나간 통과를 계산 없이 걷어낸다 (P19-2)");
  const NOW = Date.parse("2026-09-16T22:00:00Z");
  const row = (norad, endMs, visEnd) => ({ name: "S" + norad, norad,
    pass: Object.assign({ start: endMs - 600000, end: endMs, maxEl: 40, startAz: 0, endAz: 180 },
                        visEnd === undefined ? {} : { visEnd: visEnd }) });
  const rows = [row(1, NOW - 60000), row(2, NOW + 60000), row(3, NOW + 3600000)];
  check("끝난 통과만 뺀다", ctx.dropPastPasses(rows, NOW).map((r) => r.norad), [2, 3]);
  check("가시 종료(visEnd)가 있으면 그것을 본다",
    ctx.dropPastPasses([row(4, NOW + 600000, NOW - 1000)], NOW).map((r) => r.norad), []);
  check("딱 지금 끝나는 것은 지난 것으로 본다",
    ctx.dropPastPasses([row(5, NOW)], NOW).length, 0);
  check("빈 목록·없는 목록에도 죽지 않는다",
    [ctx.dropPastPasses([], NOW).length, ctx.dropPastPasses(null, NOW).length], [0, 0]);
  check("pass 가 없는 줄은 버린다", ctx.dropPastPasses([{ name: "깨짐" }], NOW).length, 0);

  // 주기 정리가 화면까지 닿는가
  state.map = map;
  state.sidebarTab = "tonight";
  state.tonightRows = rows;
  ctx.tickTonightFreshness(NOW);
  check("지난 줄이 빠진 채 다시 그려진다", state.tonightRows.map((r) => r.norad), [2, 3]);
  check("건수도 함께 준다", el("sidebar-count").textContent, "2건");

  // 바뀐 게 없으면 다시 그리지 않는다 — 5분마다 목록이 깜빡이면 그게 더 방해다
  el("sidebar-list").innerHTML = "표시";
  ctx.tickTonightFreshness(NOW);
  check("바뀐 게 없으면 화면을 건드리지 않는다", el("sidebar-list").innerHTML, "표시");

  // 다른 탭이면 아무 일도 하지 않는다
  state.sidebarTab = "launches";
  state.tonightRows = rows;
  ctx.tickTonightFreshness(NOW);
  check("다른 탭이면 손대지 않는다", el("sidebar-list").innerHTML, "표시");
}
{
  let asked = 0;
  const { ctx, state, win, map } = loadApp({ api: {
    get_settings: async () => ({ firstRunSeen: true }),
    get_launches: async () => ({ launches: [] }),
    check_update: async () => { asked++; return { update_available: false, latest: "v1.40.0" }; },
  } });
  group("업데이트를 켜 둔 채로도 확인한다 (P19-3)");
  for (const s of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(s);
  let recheck = null;
  ctx.setInterval = (fn, ms) => { if (ms === 6 * 60 * 60 * 1000) recheck = fn; return 1; };
  await win.fire("pywebviewready");
  await new Promise((r) => setImmediate(r));
  check("부트에서 한 번 확인한다", asked, 1);
  check("재확인 타이머가 걸린다(부트 때 한 번으로 끝나지 않는다)", typeof recheck, "function");
  if (typeof recheck === "function") recheck();
  await new Promise((r) => setImmediate(r));
  check("주기가 되면 다시 확인한다", asked, 2);
}

// ── 물리 기준 회귀 (P21-1) ────────────────────────────────────────────────────
// **이 앱이 존재하는 이유가 이 숫자들이다.** 그런데 2026-09-17 까지 여기에 회귀가 없었다 —
// 변이로 재니 큰 오류는 잡혔지만(부호 반전·2배) **실제로 생길 법한 작은 오류는 전부
// 놓쳤다**: 황도경사 0.44° 오차 · 태양 황경 0.5° 편향(시각 약 12분) · 율리우스일 1분
// 오프셋 — 셋 다 914개가 전부 통과했다. 틀린 값은 맞는 값과 화면상 똑같이 생긴다.
//
// 단언은 **물리·정의가 정한 값**에 댄다(우리 예전 출력이 아니다 — 그건 골든이지 기준이 아니다).
// 시각은 전부 **고정**이고 입력은 픽스처다 — 실행 시각·캐시·네트워크에 기대지 않는다.
{
  const { ctx, date } = loadApp({ realSatellite: true });
  group("물리 기준 — 시각 계산 (P21-1)");
  const D = (iso) => date(Date.parse(iso));
  /** |got-want| <= tol 인가. 실패하면 얼마나 벗어났는지 보여 준다. */
  const near = (name, got, want, tol) =>
    check(`${name} (허용 ±${tol})`,
      Math.abs(got - want) <= tol
        ? true
        : `${got.toFixed(4)} (기준 ${want}, 차이 ${Math.abs(got - want).toFixed(4)})`,
      true);

  // 율리우스일은 **정의**다 — J2000.0 = 2000-01-01 12:00 UTC.
  near("J2000.0 = JD 2451545.0", ctx.julianDay(D("2000-01-01T12:00:00Z")), 2451545.0, 1e-6);
  near("Unix epoch = JD 2440587.5", ctx.julianDay(D("1970-01-01T00:00:00Z")), 2440587.5, 1e-6);

  // 그리니치 평균 항성시: J2000.0 에서 18h 41m 50.5s = 18.697374h (정의상 기준값)
  near("J2000.0 의 GMST = 18.697374h", ctx.gmstHours(2451545.0), 18.697374, 1e-4);

  // **독립 구현과 대조** — satellite.js 의 gstime 은 우리와 다른 코드다.
  // ⚠ Date 는 반드시 realm 것(`date()`)이어야 한다. Node 쪽 Date 를 넘기면 satellite.js 안의
  //   `instanceof Date` 가 false 가 되어 **예외 없이** 엉뚱한 값이 나온다(harness.js 주석 참조).
  //   2026-09-17 에 실제로 이걸로 11.5시간 어긋난 값을 보고 앱을 의심했다.
  for (const iso of ["2026-09-17T12:00:00Z", "2026-01-01T00:00:00Z", "1999-12-31T23:59:00Z"]) {
    const ours = ctx.gmstHours(ctx.julianDay(D(iso)));
    const theirs = ctx.satellite.gstime(D(iso)) * 12 / Math.PI;
    let d = Math.abs(ours - theirs);
    if (d > 12) d = 24 - d;                       // 0/24 경계
    near(`GMST 가 satellite.js 와 같다 ${iso.slice(0, 10)}`, d, 0, 0.01);  // 0.01h = 36초
  }
}

{
  const { ctx, date } = loadApp({ realSatellite: true });
  group("물리 기준 — 태양 (P21-1)");
  const D = (iso) => date(Date.parse(iso));
  const near = (name, got, want, tol) =>
    check(`${name} (허용 ±${tol})`,
      Math.abs(got - want) <= tol
        ? true
        : `${got.toFixed(4)} (기준 ${want}, 차이 ${Math.abs(got - want).toFixed(4)})`,
      true);

  // 분점·지점의 태양 적위는 물리가 정한다. 2026년 실제 시각(UTC).
  const dec = (iso) => ctx.sunEquatorial(ctx.julianDay(D(iso))).delta;
  near("춘분 적위 = 0", dec("2026-03-20T14:46:00Z"), 0, 0.1);
  near("하지 적위 = +23.44", dec("2026-06-21T08:25:00Z"), 23.44, 0.1);
  near("추분 적위 = 0", dec("2026-09-23T00:06:00Z"), 0, 0.1);
  near("동지 적위 = -23.44", dec("2026-12-21T20:50:00Z"), -23.44, 0.1);

  // 분점에서 황경은 정의상 0°/180° 다. 실측 오차 0.008° — **0.05° 면 0.5° 편향을 잡는다.**
  // ⚠ 0.02° 규모(중심차 2차항)는 **일부러 안 잡는다** — 코드가 스스로 "저정밀 근사"라고
  //   밝힌 정밀도 안쪽이라, 더 좁히면 모델을 손댈 때마다 테스트가 헛되이 빨개진다.
  const lam = (iso) => ((ctx.sunEclipticLongitude(ctx.julianDay(D(iso))) % 360) + 360) % 360;
  const spring = lam("2026-03-20T14:46:00Z");
  near("춘분 황경 = 0", Math.min(spring, 360 - spring), 0, 0.05);
  near("추분 황경 = 180", lam("2026-09-23T00:06:00Z"), 180, 0.05);

  // 남중고도 = 90 - |위도| + 적위 — 위도와 계절이 정하는 값이다.
  const noonElev = (lat, lng, dayIso) => {
    const base = Date.parse(dayIso);
    let best = -90;
    for (let m = 0; m < 1440; m += 1) {
      const e = ctx.observerSunElev({ lat, lng }, date(base + m * 60000));
      if (e > best) best = e;
    }
    return best;
  };
  near("적도 춘분 남중고도 = 90", noonElev(0, 0, "2026-03-20T00:00:00Z"), 90, 0.5);
  near("서울 춘분 남중고도 = 52.43", noonElev(37.5665, 126.978, "2026-03-20T00:00:00Z"), 90 - 37.5665, 0.5);
  near("서울 하지 남중고도 = 75.87", noonElev(37.5665, 126.978, "2026-06-21T00:00:00Z"), 90 - 37.5665 + 23.44, 0.5);
  near("서울 동지 남중고도 = 28.99", noonElev(37.5665, 126.978, "2026-12-21T00:00:00Z"), 90 - 37.5665 - 23.44, 0.5);
  near("북극 하지 남중고도 = 23.44", noonElev(90, 0, "2026-06-21T00:00:00Z"), 23.44, 0.5);

  // 일출·일몰(태양 고도 0 통과). 기상청 2026-03-20 서울 일출 06:35 · 일몰 18:43(KST).
  // 우리는 대기굴절을 일부러 무시하므로 **늦게 뜨고 일찍 진다** — 그 방향까지 단언한다.
  // ⚠ 허용 15분은 **황경 0.5° 편향(시각 약 12분)을 잡는 폭**이다. 더 넓히면 그 변이를 놓친다.
  const crossings = (dayIso, obs) => {
    const base = Date.parse(dayIso);
    const out = {};
    let prev = ctx.observerSunElev(obs, date(base));
    for (let m = 1; m < 1440; m += 1) {
      const e = ctx.observerSunElev(obs, date(base + m * 60000));
      if (prev < 0 && e >= 0) out.rise = (m + 540) % 1440;   // UTC 분 → KST
      if (prev >= 0 && e < 0) out.set = (m + 540) % 1440;
      prev = e;
    }
    return out;
  };
  const seoul = crossings("2026-03-20T00:00:00Z", { lat: 37.5665, lng: 126.978 });
  near("서울 춘분 일출 = 06:35(KST)", seoul.rise, 6 * 60 + 35, 15);
  near("서울 춘분 일몰 = 18:43(KST)", seoul.set, 18 * 60 + 43, 15);
  check("굴절을 무시하므로 낮이 실제보다 짧다",
    (seoul.set - seoul.rise) < (18 * 60 + 43) - (6 * 60 + 35), true);

  // 그림자(원통 근사)가 기하와 맞는가 — 태양 쪽 / 반대쪽 / 원통 밖 셋.
  const sun = ctx.sunEciUnit(D("2026-03-20T12:00:00Z"));
  const R = 6371 + 420;
  const scale = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });
  check("태양 쪽 저궤도 점은 조명", ctx.isSunlit(scale(sun, R), sun), true);
  check("반태양 쪽 저궤도 점은 그림자", ctx.isSunlit(scale(sun, -R), sun), false);
  // 반태양 쪽이라도 태양축에서 지구 반지름보다 멀면 조명이다(원통 밖).
  const ax = Math.abs(sun.x) > 0.5 ? { x: -sun.y, y: sun.x, z: 0 } : { x: 0, y: -sun.z, z: sun.y };
  const n = Math.hypot(ax.x, ax.y, ax.z);
  const perp = 6371 + 50;
  check("반태양 쪽이라도 원통 밖이면 조명",
    ctx.isSunlit({
      x: -sun.x * 1000 + ax.x / n * perp,
      y: -sun.y * 1000 + ax.y / n * perp,
      z: -sun.z * 1000 + ax.z / n * perp,
    }, sun), true);
}

{
  const { ctx, date } = loadApp({ realSatellite: true });
  group("물리 기준 — 궤도와 관측 기하 (P21-1)");
  const S = ctx.satellite;
  const near = (name, got, want, tol) =>
    check(`${name} (허용 ±${tol})`,
      Math.abs(got - want) <= tol
        ? true
        : `${got.toFixed(4)} (기준 ${want}, 차이 ${Math.abs(got - want).toFixed(4)})`,
      true);
  const nfs = require("fs"), npath = require("path");
  const tle = (f) => nfs.readFileSync(npath.join(__dirname, "fixtures", f), "utf8").trim().split(/\r?\n/);

  // ISS — 픽스처(epoch 2026-07-24)
  const iss = tle("celestrak_stations.txt").slice(0, 3);
  const issRec = S.twoline2satrec(iss[1], iss[2]);
  const nIss = parseFloat(iss[2].slice(52, 63));          // 평균운동(회/일)
  const incIss = parseFloat(iss[2].slice(8, 16));         // 궤도경사(도)
  near("ISS 주기 = 1440/평균운동", ctx.orbitPeriodMin(issRec), 1440 / nIss, 0.1);
  near("ISS 주기가 알려진 값 92.9분", ctx.orbitPeriodMin(issRec), 92.9, 1.0);

  const T0 = Date.parse("2026-07-25T00:00:00Z");   // 픽스처 epoch 다음날 — 고정
  const geoOf = (rec, ms) => {
    const d = date(ms);
    const g = S.eciToGeodetic(S.propagate(rec, d).position, S.gstime(d));
    return { lat: S.degreesLat(g.latitude), lng: S.degreesLong(g.longitude), alt: g.height };
  };

  // 한 주기 뒤 같은 위도로 돌아온다 — 주기의 정의다.
  const per = ctx.orbitPeriodMin(issRec);
  near("ISS 한 주기 뒤 위도가 돌아온다",
    geoOf(issRec, T0 + per * 60000).lat, geoOf(issRec, T0).lat, 0.5);

  // 위도는 궤도경사를 못 넘는다 — 물리다. (측지 위도라 약간의 여유를 둔다)
  let maxLat = 0;
  for (let m = 0; m < per; m += 1) maxLat = Math.max(maxLat, Math.abs(geoOf(issRec, T0 + m * 60000).lat));
  check(`ISS 위도가 궤도경사 ${incIss}° 를 넘지 않는다 (실측 최대 ${maxLat.toFixed(2)}°)`,
    maxLat <= incIss + 0.6, true);
  near("ISS 고도가 저궤도 범위", geoOf(issRec, T0).alt, 415, 60);

  // 정지위성 — 경사 0.02° 짜리를 골라 픽스처로 뒀다.
  // ⚠ `tle_geo` 를 아무거나 쓰면 안 된다. 첫 항목(TDRS 3)은 위도가 ±12° 흔들리는
  //   **경사 정지궤도**라 경도가 움직이는 게 정상이고, 그걸로는 기준이 안 된다(2026-09-17 실수).
  const geo = tle("celestrak_geo.txt");
  const geoRec = S.twoline2satrec(geo[1], geo[2]);
  near("정지궤도 주기 = 항성일 1436.07분", ctx.orbitPeriodMin(geoRec), 1436.07, 2.0);
  const G0 = Date.parse("2026-09-15T00:00:00Z");   // 고정
  const samples = [0, 6, 12, 18, 24].map((hrs) => geoOf(geoRec, G0 + hrs * 3600000));
  near("정지위성 고도 = 35,786km", samples[0].alt, 35786, 120);
  const lngs = samples.map((p) => p.lng);
  check(`정지위성은 24시간 경도가 안 변한다 (폭 ${(Math.max(...lngs) - Math.min(...lngs)).toFixed(3)}°)`,
    Math.max(...lngs) - Math.min(...lngs) <= 0.2, true);
  check("정지위성은 적도에 머문다", samples.every((p) => Math.abs(p.lat) <= 0.2), true);

  // 관측 기하 — 바로 아래에서 보면 천정(90°), 남/북에서 보면 정남/정북.
  const look = (rec, obs, ms) => {
    const d = date(ms);
    const ecf = S.eciToEcf(S.propagate(rec, d).position, S.gstime(d));
    const la = S.ecfToLookAngles(
      { latitude: obs.lat * Math.PI / 180, longitude: obs.lng * Math.PI / 180, height: 0 }, ecf);
    return { el: la.elevation * 180 / Math.PI, az: la.azimuth * 180 / Math.PI, rng: la.rangeSat };
  };
  const subLng = samples[0].lng;
  const zen = look(geoRec, { lat: 0, lng: subLng }, G0);
  near("바로 아래 관측지에서 고도 = 90", zen.el, 90, 0.3);
  near("그때 거리 = 위성 고도", zen.rng, samples[0].alt, 5);
  near("같은 경도 북쪽에서 방위 = 180(정남)", look(geoRec, { lat: 35, lng: subLng }, G0).az, 180, 0.5);
  const southAz = look(geoRec, { lat: -35, lng: subLng }, G0).az;
  near("같은 경도 남쪽에서 방위 = 0(정북)", Math.min(southAz, 360 - southAz), 0, 0.5);
  check("azToCompass 가 방위를 한글로", [180, 0, 90, 270].map(ctx.azToCompass), ["남", "북", "동", "서"]);
}

// ── 통과 계산의 시간축 (P21-2) ────────────────────────────────────────────────
// "오늘 밤" 탭은 태양표를 **한 번** 만들어 위성마다 돌려쓴다. 그런데 `computePasses` 가
// 안에서 `Date.now()` 를 다시 불러, 조각 처리가 진행될수록 `table[i]` 가 어긋났다
// (2026-09-17 실측: 61초 경과 → 2칸 = 60초. 1,441개 중 '어둠' 판정이 달라지는 지점 4개).
// **작다. 그래서 고친 이유는 크기가 아니라 구조다** — 안에서 시각을 만들면 테스트가 못 잰다.
// 이제 **표가 시간축을 정한다.**
{
  const { ctx, date } = loadApp({ realSatellite: true });
  group("통과 계산의 시간축은 태양표가 정한다 (P21-2)");
  const nfs2 = require("fs"), npath2 = require("path");
  const lines = nfs2.readFileSync(npath2.join(__dirname, "fixtures", "celestrak_stations.txt"), "utf8")
    .trim().split(/\r?\n/);
  const rec = ctx.satellite.twoline2satrec(lines[1], lines[2]);
  const SEOUL = { lat: 37.5665, lng: 126.978 };

  // 픽스처 epoch(2026-07-24) 다음날 — **지금보다 한참 과거인 고정 시각**.
  // 표가 시간축을 정한다면 결과도 그 과거 창 안에 있어야 한다.
  const T0 = Date.parse("2026-07-25T00:00:00Z");
  const HOURS = 24, STEP = 30;
  const table = ctx.sunTable(SEOUL, T0, T0 + HOURS * 3600 * 1000, STEP * 1000);
  const passes = ctx.computePasses(rec, SEOUL, HOURS, STEP, 10, table);

  check("표를 넘기면 통과가 나온다(경로가 살아 있다)", passes.length > 0, true);
  check("모든 통과가 표의 창 안에 있다",
    passes.every((p) => p.start >= T0 && p.end <= T0 + HOURS * 3600 * 1000), true);
  // 이게 핵심 단언이다 — 안에서 `Date.now()` 를 부르면 결과가 **지금** 근처로 나온다.
  check("표의 시각을 쓴다(호출 시각이 아니다)",
    passes[0].start < Date.now() - 24 * 3600 * 1000, true);

  // 같은 표로 여러 번 불러도 같은 답이어야 한다 — 조각 처리가 그렇게 부른다.
  const again = ctx.computePasses(rec, SEOUL, HOURS, STEP, 10, table);
  check("같은 표면 몇 번을 불러도 같은 결과",
    JSON.stringify(again.map((p) => [p.start, p.end])),
    JSON.stringify(passes.map((p) => [p.start, p.end])));

  // 표 안의 '어둠'과 통과의 가시 판정이 **같은 시각**을 보는가.
  // 어긋나 있으면 여기서 드러난다(표의 인덱스와 루프의 t 가 짝이 맞는지).
  const idxOf = (t) => Math.round((t - T0) / (STEP * 1000));
  const visible = passes.filter((p) => p.visible && p.visStart !== undefined);
  check("가시 구간의 시작 시각에 표도 '어둠'이라고 말한다",
    visible.length === 0 || visible.every((p) => {
      const e = table[idxOf(p.visStart)];
      return !!e && e.dark === true;
    }), true);

  // ⚠ 위 단언들로는 **표를 통째로 1분 밀어도 안 잡힌다**(2026-09-17 변이로 확인).
  //    `dark` 가 길게 이어지는 값이라, 몇 칸 어긋나도 같은 true 를 읽기 때문이다 —
  //    실제 영향이 작았던 이유가 그대로 **테스트의 눈을 가린다.**
  //    그래서 통계가 아니라 **짝을 직접 잰다**: 루프가 시각 t 에서 읽은 표 항목의 t 가 같은가.
  //    표 항목의 `dark` 를 getter 로 바꿔 **읽힌 순서와 그 항목의 t** 를 기록한다.
  {
    const reads = [];
    const probed = table.map((e, i) => ({
      t: e.t,
      unit: e.unit,
      get dark() { reads.push({ i, t: e.t }); return e.dark; },
    }));
    const probedPasses = ctx.computePasses(rec, SEOUL, HOURS, STEP, 10, probed);
    check("표를 읽기는 한다(경로 확인)", reads.length > 0, true);
    // 첫 통과가 시작된 루프 시각과, 그 순간 읽힌 표 항목의 시각이 같아야 한다.
    check("루프의 시각과 그때 읽은 표 항목의 시각이 같다",
      reads.length > 0 && probedPasses.length > 0
        ? reads[0].t === probedPasses[0].start
        : "읽기 또는 통과가 없음",
      true);
    // 인덱스도 시각과 짝이 맞아야 한다 — table[i].t === start + i*stepMs
    check("읽힌 인덱스가 시각과 짝이 맞는다",
      reads.every((r) => r.t === T0 + r.i * STEP * 1000), true);
  }

  // 표 없이 startMs 를 주면 그 시각부터 — 시각을 주입할 수 있어야 테스트가 이 함수를 잰다.
  const injected = ctx.computePasses(rec, SEOUL, 6, STEP, 10, null, T0);
  check("표가 없어도 startMs 로 시각을 주입할 수 있다",
    injected.length > 0 && injected.every((p) => p.start >= T0 && p.end <= T0 + 6 * 3600 * 1000),
    true);

  // 아무것도 안 주면 예전처럼 지금부터다(기존 호출부 `showPasses` 가 그 경로다).
  const nowPasses = ctx.computePasses(rec, SEOUL, 6, STEP, 10);
  check("표도 startMs 도 없으면 지금부터다",
    nowPasses.every((p) => p.start >= Date.now() - 60000), true);

  // `t` 없는 표(조명 조건만 바꿔 끼우는 테스트용)를 넘겨도 죽지 않는다 —
  // 그때는 표가 시간축을 못 정하므로 startMs/지금으로 물러난다.
  const noT = table.map((e) => ({ unit: e.unit, dark: e.dark }));
  const fallback = ctx.computePasses(rec, SEOUL, 6, STEP, 10, noT, T0);
  check("t 없는 표를 넘기면 startMs 로 물러난다",
    fallback.every((p) => p.start >= T0 && p.end <= T0 + 6 * 3600 * 1000), true);
}

// ── 프론트 예외가 로그와 화면으로 나간다 (P23-1) ──────────────────────────────
// 여기가 이 기능의 진짜 주장이다: **예외가 나면 어딘가에 남는다.** 그전에는
// window.onerror·unhandledrejection 이 0건이고 브릿지에 로그 통로가 없어서,
// 앱이 조용히 죽으면 화면에도 로그에도 아무것도 남지 않았다.
{
  const { ctx } = loadApp();
  group("오류 억제 판정 (shouldReport — 시각 주입)");

  const fresh = () => ({ seen: new Map(), logged: 0, suppressed: 0, capNoted: false,
    bannerShown: false, queue: [] });

  const st = fresh();
  check("처음 보는 오류는 남긴다", ctx.shouldReport(st, "a", 1000), "log");
  check("같은 오류를 곧바로 다시 보면 접는다", ctx.shouldReport(st, "a", 2000), "cooldown");
  check("접어도 기록 건수는 안 는다", st.logged, 1);
  check("접은 건수는 센다", st.suppressed, 1);
  check("다른 오류는 따로 센다", ctx.shouldReport(st, "b", 2000), "log");
  check("쿨다운(60초)이 지나면 다시 남긴다", ctx.shouldReport(st, "a", 1000 + 60000), "log");
  check("쿨다운 경계 직전은 아직 접는다",
    ctx.shouldReport(fresh2(ctx, "a", 0), "a", 59999), "cooldown");

  // 세션 상한 — 매초 도는 틱에서 예외가 나면 로그가 116분 만에 백업까지 덮인다(실측 근거).
  const cap = fresh();
  for (let i = 0; i < 50; i++) ctx.shouldReport(cap, "k" + i, i * 100000);
  check("상한(50건)까지는 남긴다", cap.logged, 50);
  check("상한을 넘으면 마지막 한 줄만", ctx.shouldReport(cap, "z", 9e9), "cap-final");
  check("그 뒤로는 아무것도 안 남긴다", ctx.shouldReport(cap, "z2", 9e9), "cap");
  check("상한 안내는 한 번뿐", ctx.shouldReport(cap, "z3", 9e9), "cap");

  // ⚠ 상한이 없으면 무슨 일이 일어나는가 — **막지 않았을 때를 먼저 단언한다**(CLAUDE.md).
  // 이게 없으면 상한을 통째로 뜯어내도 위 단언들이 그대로 통과한다.
  const nocap = fresh();
  for (let i = 0; i < 200; i++) ctx.shouldReport(nocap, "u" + i, i * 100000);
  check("서로 다른 오류 200건이 와도 기록은 상한에서 멈춘다", nocap.logged, 50);
}

/** 쿨다운 경계용 — 키 하나를 시각 `t` 에 기록해 둔 상태를 만든다. */
function fresh2(ctx, key, t) {
  const st = { seen: new Map(), logged: 0, suppressed: 0, capNoted: false,
    bannerShown: false, queue: [] };
  ctx.shouldReport(st, key, t);
  return st;
}

{
  const { ctx } = loadApp();
  group("오류 문장 만들기 (formatError·shortSource — 순수 함수)");
  check("경로에서 파일 이름만 남긴다",
    ctx.shortSource("file:///C:/Users/x/RL3D/web/js/sats.js"), "sats.js");
  check("쿼리·해시를 떼어낸다", ctx.shortSource("a/b/c.js?v=2#x"), "c.js");
  check("없으면 빈 문자열(지어내지 않는다)", ctx.shortSource(null), "");
  check("파일과 줄번호를 붙인다",
    ctx.formatError("오류", "boom", "file:///x/web/js/sats.js", 42, null),
    "[오류] boom @ sats.js:42");
  check("메시지가 없어도 무언가는 남긴다",
    ctx.formatError("오류", "", null, null, null), "[오류] (메시지 없음)");
  check("스택은 앞 6줄만",
    ctx.formatError("오류", "b", null, null,
      "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8").split("\n").length, 7);  // 첫 줄 + 스택 6줄
  const long = ctx.formatError("오류", "x".repeat(5000), null, null, null);
  check("한 건의 길이를 자른다", long.length <= 1800, true);
}

{
  group("오류가 실제로 브릿지로 나간다 (배선)");
  const sent = [];
  const { ctx, win, el } = loadApp({ api: { log: (lvl, msg) => { sent.push([lvl, msg]); } } });

  // ⚠ 배선을 재는 것이지 판정을 재는 게 아니다 — window 에 실제로 붙었는지부터.
  check("window 에 error 를 건다", win.has("error"), true);
  check("window 에 unhandledrejection 을 건다", win.has("unhandledrejection"), true);

  win.fire("error", { message: "터짐", filename: "file:///x/web/js/sats.js", lineno: 7,
    error: { stack: "at foo\nat bar" } });
  check("오류 1건이 브릿지로 갔다", sent.length, 1);
  check("레벨은 error", (sent[0] || [])[0], "error");
  check("문장에 파일·줄이 들어 있다", ((sent[0] || [])[1] || "").includes("sats.js:7"), true);
  check("배너가 떴다", el("app-error").hidden, false);
  check("배너 문구가 로그 경로를 알려 준다",
    el("app-error-text").textContent.includes("rl3d.log"), true);

  // 같은 자리에서 매초 반복돼도 로그는 한 줄이다(억제가 실제로 배선돼 있는가).
  for (let i = 0; i < 100; i++) {
    win.fire("error", { message: "터짐", filename: "file:///x/web/js/sats.js", lineno: 7,
      error: { stack: "at foo" } });
  }
  check("같은 오류 100건이 더 와도 로그는 그대로", sent.length, 1);

  // 거부(Promise)도 같은 통로를 탄다.
  win.fire("unhandledrejection", { reason: { message: "거부됨", stack: "at baz" } });
  check("처리되지 않은 거부도 보낸다", sent.length, 2);
  check("거부는 종류를 밝힌다", ((sent[1] || [])[1] || "").includes("처리되지 않은 거부"), true);

  // 배너는 세션당 한 번 — 오류가 초당 나도 다시 뜨지 않는다.
  el("app-error").classList.add("hidden");
  win.fire("error", { message: "또 다른 것", filename: "x.js", lineno: 1 });
  check("닫은 배너는 다시 뜨지 않는다", el("app-error").hidden, true);
}

{
  group("브릿지가 아직 없을 때 난 오류는 쌓였다가 나간다");
  const { ctx, win } = loadApp();
  ctx.window.pywebview = {};        // 브릿지가 아직 준비되지 않은 상태
  win.fire("error", { message: "부트 전 오류", filename: "state.js", lineno: 3 });

  const sent = [];
  ctx.window.pywebview = { api: { log: (lvl, msg) => { sent.push(msg); } } };
  check("브릿지가 없을 땐 안 보낸다", sent.length, 0);
  check("생긴 뒤 flush 하면 나간다", ctx.flushErrorQueue(), 1);
  check("그 내용이 그대로 갔다", (sent[0] || "").includes("부트 전 오류"), true);
  check("두 번 flush 해도 중복되지 않는다", ctx.flushErrorQueue(), 0);
}

{
  group("보고 경로가 또 죽어도 재귀하지 않는다");
  const { ctx, win } = loadApp({ api: { log: () => { throw new Error("브릿지 고장"); } } });
  let threw = false;
  try {
    win.fire("error", { message: "원래 오류", filename: "x.js", lineno: 1 });
  } catch (e) { threw = true; }
  check("브릿지가 던져도 밖으로 새지 않는다", threw, false);

  // 브릿지가 거부된 Promise 를 돌려줘도 unhandledrejection 으로 되돌아오면 안 된다.
  const { ctx: c2, win: w2 } = loadApp({
    api: { log: () => Promise.reject(new Error("거부")) } });
  let threw2 = false;
  try { w2.fire("error", { message: "o", filename: "x.js", lineno: 1 }); }
  catch (e) { threw2 = true; }
  check("거부하는 Promise 를 돌려줘도 안전하다", threw2, false);
}

// ── 배선 한 줄이 죽어도 나머지와 initMap 이 산다 (P23-1) ─────────────────────
// **이게 없으면 P23-1 의 절반이 공허하다.** 오류를 로그로 보내는 것만으로는
// 지도가 안 뜨는 상태가 그대로다. 예전 boot.js 는 27줄을 늘어놓은 구조라
// 첫 줄이 던지면 initMap 까지 통째로 안 돌았다.
{
  group("wire/step — 한 줄이 죽어도 나머지가 산다");
  const sent = [];
  // `missing` 으로 **없는 요소**를 만든다 — 스텁이 묻는 id 마다 요소를 지어내므로
  // 그게 없으면 이 경로를 영영 못 잰다(하네스를 그래서 고쳤다).
  const { ctx, el } = loadApp({
    api: { log: (lvl, msg) => { sent.push(msg); } },
    missing: ["없는-아이디"],
  });

  check("없는 요소에 걸면 false 를 돌려준다", ctx.wire("없는-아이디", "click", () => {}), false);
  check("그 사실이 사람이 읽는 말로 로그에 나간다",
    sent.some((m) => m.includes("요소를 찾지 못했습니다") && m.includes("없는-아이디")), true);
  check("있는 요소는 정상 배선", ctx.wire("search", "input", () => {}), true);
  check("정말 걸렸다", !!el("search").handlers.input, true);

  // step 은 던지는 덩어리를 삼키고 다음으로 보낸다.
  let after = false;
  ctx.step("터지는 단계", () => { throw new Error("퍽"); });
  ctx.step("다음 단계", () => { after = true; });
  check("앞 단계가 던져도 다음 단계가 돈다", after, true);
  check("던진 단계가 로그에 남는다",
    sent.some((m) => m.includes("터지는 단계") && m.includes("퍽")), true);
}

{
  group("bindUI 한 줄이 죽어도 initMap 이 뜬다 (변이 실험의 자리)");
  // `.flt` 루프에서 일부러 던지게 만들어, 그 뒤 배선과 부트가 계속되는지 본다.
  const sent = [];
  const { ctx, el, map, sel, state, win, api } = loadApp({
    api: { log: (lvl, msg) => { sent.push(msg); } },
  });
  state.map = map;
  sel[".flt"] = { forEach() { throw new Error("필터 배선 폭발"); } };

  let bindThrew = false;
  try { ctx.bindUI(); } catch (e) { bindThrew = true; }
  check("bindUI 는 무슨 일이 있어도 밖으로 던지지 않는다", bindThrew, false);
  check("던진 자리는 로그에 남는다",
    sent.some((m) => m.includes("결과 필터") && m.includes("필터 배선 폭발")), true);
  // 그 **뒤쪽** 배선들이 살아 있는가 — 예전 구조라면 전부 죽었다.
  check("뒤쪽 배선이 산다 (panel-close)", !!el("panel-close").handlers.click, true);
  check("뒤쪽 배선이 산다 (refresh)", !!el("refresh").handlers.click, true);
  check("맨 끝 배선도 산다 (tl-range change)", !!el("tl-range").handlers.change, true);
}

{
  group("부트 한 단계가 던져도 지도는 뜬다 (P23-1 의 핵심)");
  // ⚠ 위 bindUI 테스트만으로는 **절반이다.** `pywebviewready` 핸들러의 단계 감싸기를
  //   통째로 지워도 bindUI 테스트는 전부 초록이다 — 2026-09-11·P19 에서 반복해 당한
  //   "순수 함수는 맞는데 배선 한 줄이 없는" 구멍과 같은 자리라 여기서 직접 잰다.
  const sent = [];
  const { ctx, win, map, state } = loadApp({ api: { log: (lvl, msg) => { sent.push(msg); } } });
  for (const src of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(src);

  // 부트 **앞쪽** 단계를 터뜨린다. 예전 구조라면 여기서 멈춰 initMap 이 안 돌았다.
  ctx.applySettings = () => { throw new Error("설정 복원 폭발"); };

  check("부트 전에는 지도가 없다", state.map, null);
  let bootThrew = false;
  try {
    await win.fire("pywebviewready");
    await new Promise((r) => setImmediate(r));
  } catch (e) { bootThrew = true; }
  check("부트 핸들러가 밖으로 던지지 않는다", bootThrew, false);

  check("터진 단계가 로그에 남는다",
    sent.some((m) => m.includes("applySettings") && m.includes("설정 복원 폭발")), true);
  check("그래도 지도는 떴다 (initMap 이 돌았다)", !!state.map, true);
}

// ── 한 점에 포개진 발사 (P23-2) ──────────────────────────────────────────────
// 실측(2026-09-18, 실제 캐시 437건): 서로 다른 발사장 좌표는 55개뿐이고 한 점에
// 최대 86건 · 425건(97%)이 겹치는 점 위에 있다. 줌 7 이상에서 클러스터가 풀려도
// 좌표가 같으면 안 갈라지므로, 예전에는 맨 위 하나만 열리고 나머지는 열 길이 없었다.
{
  const { ctx } = loadApp();
  group("좌표 키와 그 점의 발사 (순수 함수)");

  check("소수 4자리로 묶는다", ctx.coordKey(28.56190001, -80.5774), "28.5619,-80.5774");
  check("좌표가 없으면 null", ctx.coordKey(null, 1), null);
  check("범위 밖도 null", ctx.coordKey(91, 0), null);

  const L = (id, lat, lng, outcome, net) => ({ id, name: "L" + id, lat, lng, outcome, net,
    rocket: "R", pad_name: "SLC-40", location_name: "Cape" });
  const list = [
    L("a", 28.5619, -80.5774, "success", "2026-01-01T00:00:00Z"),
    L("b", 28.5619, -80.5774, "success", "2026-03-01T00:00:00Z"),
    L("c", 28.5619, -80.5774, "upcoming", "2026-12-01T00:00:00Z"),
    L("d", 28.5619, -80.5774, "upcoming", "2026-11-01T00:00:00Z"),
    L("z", 34.6320, -120.6110, "success", "2026-02-01T00:00:00Z"),
  ];
  const at = ctx.launchesAtPoint(list, 28.5619, -80.5774);
  check("그 점의 발사만 모은다", at.length, 4);
  check("다른 점은 안 섞인다", at.every((d) => d.id !== "z"), true);
  check("예정이 먼저, 가까운 순", at.slice(0, 2).map((d) => d.id), ["d", "c"]);
  check("지난 것은 최근 순", at.slice(2).map((d) => d.id), ["b", "a"]);
  check("없는 점은 빈 목록", ctx.launchesAtPoint(list, 0, 0), []);
  check("좌표가 깨진 발사는 무시한다",
    ctx.launchesAtPoint([{ id: "x", lat: null, lng: null }], null, null), []);

  // ⚠ **막지 않았으면 무슨 일이 났을 것인가** — 예전 동작(맨 위 하나)이 실제로
  //   나머지를 못 보여줬다는 것부터 단언한다. 이게 없으면 목록을 뜯어내도 통과한다.
  check("이 점에는 1건이 아니라 4건이 있다(예전엔 1건만 열렸다)", at.length > 1, true);

  group("확대하면 갈라지는 클러스터인가 (순수 함수)");
  check("전부 한 좌표면 안 갈라진다",
    ctx.clusterSplits(list, 28.5619, -80.5774, 4), false);
  check("다른 좌표가 섞여 있으면 갈라진다",
    ctx.clusterSplits(list, 28.5619, -80.5774, 5), true);
}

{
  const { ctx, el } = loadApp();
  group("포개진 목록 화면 (padListHtml — 순수 함수)");
  const rows = [
    { id: "1", name: "예정 <b>주의</b>", outcome: "upcoming", net: "2030-01-01T00:00:00Z",
      rocket: "Falcon 9", pad_name: "SLC-40 & <악성>", location_name: "Cape <script>" },
    { id: '2" onclick="x', name: "지난 것", outcome: "success",
      net: "2020-01-01T00:00:00Z", rocket: "R" },
  ];
  const html = ctx.padListHtml(rows);
  check("건수를 말한다", html.includes("<b>2건</b>"), true);
  check("예정 건수도 말한다", html.includes("예정 1건"), true);
  check("겹친다는 사실을 말한다", html.includes("한 점으로 겹칩니다"), true);
  check("발사대 이름을 머리에 쓴다", html.includes("SLC-40"), true);
  // XSS — 이름·발사대는 API 문자열이다(CLAUDE.md 프론트 규칙 2).
  check("발사명을 이스케이프한다", html.includes("<b>주의</b>"), false);
  check("발사대 이름도 이스케이프한다", html.includes("<악성>"), false);
  // ⚠ 아래 둘은 변이 실험에서 **안 재지고 있던 자리**다(2026-09-18). 픽스처의 값이
  //   순한 문자열이라 이스케이프를 뜯어도 결과가 같았다 — 적대적인 값으로 바꿔서야 잡혔다.
  check("발사장 이름도 이스케이프한다", html.includes("Cape <script>"), false);
  check("행의 id 도 이스케이프한다(속성 탈출 금지)",
    html.includes('onclick="x'), false);
  check("행마다 id 를 싣는다", (html.match(/data-id=/g) || []).length, 2);
  check("빈 목록은 비었다고 말한다(조용히 빈 화면 금지)",
    ctx.padListHtml([]).includes("찾지 못했습니다"), true);

  // ⚠ 이건 **실제 캐시로 렌더해 읽고서야 보였다** — 각 함수를 따로 재는 단언은 전부
  //   통과했는데, 합친 문장이 `Falcon 9 Block 5 | Dragon CRS-2` / `T-42일 · Falcon 9 Block 5`
  //   로 **로켓을 두 번** 말하고 있었다(실측: name 이 `<로켓> | <미션>` 꼴인 것 441/441).
  group("행 제목에서 로켓 중복을 없앤다 (missionTitle — 순수 함수)");
  check("구분자 뒤쪽만 쓴다",
    ctx.missionTitle("Falcon 9 Block 5 | Dragon CRS-2 SpX-35"), "Dragon CRS-2 SpX-35");
  check("구분자가 없으면 그대로", ctx.missionTitle("Starship"), "Starship");
  check("미션명 안의 구분자는 살린다",
    ctx.missionTitle("R | A | B"), "A | B");
  check("빈 값도 죽지 않는다", ctx.missionTitle(null), "");
  const dup = ctx.padListHtml([{ id: "1", name: "Falcon 9 Block 5 | Dragon CRS-2",
    outcome: "success", net: "2026-01-01T00:00:00Z", rocket: "Falcon 9 Block 5",
    pad_name: "SLC-40", location_name: "Cape" }]);
  check("한 행에 로켓 이름이 한 번만 나온다",
    (dup.match(/Falcon 9 Block 5/g) || []).length, 1);
  check("미션명은 남아 있다", dup.includes("Dragon CRS-2"), true);
}

{
  group("지도 클릭 배선 — 혼자면 상세, 포개져 있으면 목록 (P23-2)");
  const { ctx, el, map, state } = loadApp();
  state.map = map;
  for (const s of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(s);
  ctx.setupLaunchLayers();

  const mk = (id, lat, lng) => ({ id, name: "L" + id, lat, lng, outcome: "success",
    net: "2026-01-0" + id + "T00:00:00Z", rocket: "R", pad_name: "P", location_name: "S" });
  state.allLaunches = [mk("1", 10, 20), mk("2", 10, 20), mk("3", 10, 20), mk("4", 55, 66)];

  // ── 혼자 있는 점: 예전 그대로 상세가 열려야 한다(회귀를 만들지 않는다)
  map.fire("click:launch-point", { features: [{ properties: { id: "4" } }] });
  check("혼자면 상세가 열린다", el("panel-body").innerHTML.includes("L4"), true);
  check("그때는 목록 문구가 없다",
    el("panel-body").innerHTML.includes("한 점으로 겹칩니다"), false);
  check("상세는 panelLaunchId 를 남긴다", String(state.panelLaunchId), "4");

  // ── 포개진 점: 목록이 열려야 한다
  map.fire("click:launch-point", { features: [{ properties: { id: "1" } }] });
  const body = el("panel-body").innerHTML;
  check("포개져 있으면 목록이 열린다", body.includes("한 점으로 겹칩니다"), true);
  check("그 점의 3건이 전부 있다",
    ["L1", "L2", "L3"].every((n) => body.includes(n)), true);
  check("다른 점의 발사는 없다", body.includes("L4"), false);
  check("패널이 보인다", el("panel").hidden, false);
  check("목록은 panelLaunchId 를 비운다(카운트다운이 엉뚱한 걸 집지 않게)",
    state.panelLaunchId, null);
}

{
  group("목록의 행을 눌러 상세로 간다");
  const { ctx, el, map, state } = loadApp();
  state.map = map;
  const mk = (id) => ({ id, name: "L" + id, lat: 10, lng: 20, outcome: "success",
    net: "2026-01-0" + id + "T00:00:00Z", rocket: "R", pad_name: "P", location_name: "S" });
  state.allLaunches = [mk("1"), mk("2")];

  // 실제 DOM 은 innerHTML 안의 버튼을 querySelectorAll 로 준다 — 스텁은 테스트가 채운다.
  const row = { dataset: { id: "2" }, handlers: {},
    addEventListener(e, f) { this.handlers[e] = f; },
    fire(e) { if (this.handlers[e]) this.handlers[e](); } };
  el("panel-body").sel[".pad-row"] = [row];

  check("목록이 2건을 세었다", ctx.openPadList(10, 20), 2);
  check("행에 click 이 걸렸다", !!row.handlers.click, true);
  row.fire("click");
  check("누르면 그 발사의 상세로 바뀐다", el("panel-body").innerHTML.includes("L2"), true);
  check("상세로 바뀌면 목록 문구는 사라진다",
    el("panel-body").innerHTML.includes("한 점으로 겹칩니다"), false);
}

{
  group("클러스터 클릭 — 안 갈라지면 확대하지 않고 목록을 연다");
  const { ctx, el, map, state } = loadApp();
  state.map = map;
  for (const s of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(s);
  ctx.setupLaunchLayers();
  const mk = (id, lat, lng) => ({ id, name: "L" + id, lat, lng, outcome: "success",
    net: "2026-01-01T00:00:00Z", rocket: "R", pad_name: "P", location_name: "S" });
  state.allLaunches = [mk("1", 10, 20), mk("2", 10, 20), mk("3", 10, 20)];

  // 전부 한 좌표인 클러스터 — 확대해도 갈라질 것이 없다.
  map.fire("click:clusters", {
    features: [{ properties: { cluster_id: 7, point_count: 3 }, geometry: { coordinates: [20, 10] } }],
  });
  check("카메라가 움직이지 않는다", map.moves().length, 0);
  check("대신 목록이 열린다",
    el("panel-body").innerHTML.includes("한 점으로 겹칩니다"), true);

  // 좌표가 섞인 클러스터 — 예전처럼 확대한다.
  state.allLaunches.push(mk("4", 11, 21));
  map.fire("click:clusters", {
    features: [{ properties: { cluster_id: 8, point_count: 4 }, geometry: { coordinates: [20, 10] } }],
  });
  await new Promise((r) => setImmediate(r));
  check("갈라지는 클러스터는 확대한다", map.moves().length, 1);
  check("확대 종류는 easeTo", (map.moves()[0] || [])[0], "easeTo");
}

{
  group("툴팁이 참말을 한다 (P23-2 — 예전 문구는 거짓말이었다)");
  const { ctx, el, map, state } = loadApp();
  state.map = map;
  for (const s of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(s);
  ctx.setupLaunchLayers();
  const mk = (id, lat, lng) => ({ id, name: "L" + id, lat, lng, outcome: "success",
    status: "Launch Successful", net: "2026-01-01T00:00:00Z", rocket: "R",
    pad_name: "P", location_name: "S" });
  state.allLaunches = [mk("1", 10, 20), mk("2", 10, 20), mk("9", 55, 66)];
  const ev = (extra) => Object.assign({ originalEvent: { clientX: 1, clientY: 2 } }, extra);

  // 개별 점 — 겹쳐 있으면 그 사실을 말한다.
  map.fire("mousemove:launch-point", ev({ features: [{ properties: { id: "1" } }] }));
  const tip = ctx.document.body.children[0];
  check("포개진 점은 건수를 말한다", tip.innerHTML.includes("이 지점 2건"), true);

  map.fire("mousemove:launch-point", ev({ features: [{ properties: { id: "9" } }] }));
  check("혼자인 점은 건수를 말하지 않는다", tip.innerHTML.includes("이 지점"), false);

  // 클러스터 — "펼쳐집니다"는 동일 좌표에서 거짓말이다.
  map.fire("mousemove:clusters", ev({
    features: [{ properties: { point_count: 2 }, geometry: { coordinates: [20, 10] } }] }));
  check("안 갈라지는 무리에 '펼쳐집니다'라고 하지 않는다",
    tip.innerHTML.includes("펼쳐집니다"), false);
  check("대신 목록이라고 말한다", tip.innerHTML.includes("클릭하면 목록"), true);

  map.fire("mousemove:clusters", ev({
    features: [{ properties: { point_count: 3 }, geometry: { coordinates: [20, 10] } }] }));
  check("갈라지는 무리에는 예전 문구 그대로", tip.innerHTML.includes("펼쳐집니다"), true);
}

// ── 순번은 날짜가 확정된 발사에만 (P24-1) ────────────────────────────────────
// **LL2 는 날짜가 미정인 예정 발사에 같은 누적치를 복사해 준다.** 실측(실제 캐시 441건):
// Cape Canaveral 예정 7건이 전부 `1170` · SpaceX 통산 `778` 을 9건 · 전 세계 `7530` 을
// **23건**이 공유한다. 화면은 그 23건에 전부 "전 세계 올해 7,530번째"라고 말하고 있었다.
{
  const { ctx } = loadApp();
  group("순번을 말해도 되는가 (canShowOrdinal — 순수 함수)");

  const L = (outcome, prec) => ({ outcome, net_precision: prec });
  check("이미 일어난 일은 정밀도와 무관하게 순번이 사실이다",
    ["Year", "Month", undefined, "Second"].map((p) => ctx.canShowOrdinal(L("success", p))),
    [true, true, true, true]);
  check("예정 + 시각 확정(Second·Minute·Hour·Day)은 말한다",
    ["Second", "Minute", "Hour", "Day"].map((p) => ctx.canShowOrdinal(L("upcoming", p))),
    [true, true, true, true]);
  check("예정 + 날짜 미정(Month·Quarter·Year)은 말하지 않는다",
    ["Month", "Quarter 3", "Quarter 4", "Year", "Year Half 2"]
      .map((p) => ctx.canShowOrdinal(L("upcoming", p))),
    [false, false, false, false, false]);
  check("정밀도를 모르면 말하지 않는다(모르면 안 띄운다)",
    ctx.canShowOrdinal(L("upcoming", undefined)), false);
  check("발사가 없으면 false", ctx.canShowOrdinal(null), false);

  group("맥락 줄 — 순번과 시제 (contextText)");
  const full = {
    outcome: "success", net_precision: "Second", provider: "SpaceX",
    pad_count: 296, pad_year_count: 58, location_count: 1129, location_year_count: 60,
    agency_count: 778, agency_year_count: 120, orbital_count: 7530, orbital_year_count: 223,
    pad_turnaround_sec: 86400 * 3,
  };
  const done = ctx.contextText(full);
  check("완료 발사는 순번을 그대로 말한다", done.includes("이 발사장 통산 1,129번째"), true);
  check("완료 발사는 미래형이 아니다", done.includes("번째가 됩니다"), false);

  // ⚠ **막지 않았으면 무슨 일이 났을 것인가** — 이게 없으면 규칙을 뜯어내도 위가 통과한다.
  const vague = ctx.contextText(Object.assign({}, full,
    { outcome: "upcoming", net_precision: "Year" }));
  check("날짜 미정 예정은 발사장 순번을 말하지 않는다",
    /이 발사장 통산/.test(vague || ""), false);
  check("날짜 미정 예정은 발사대 순번도 말하지 않는다", /이 발사대 /.test(vague || ""), false);
  check("날짜 미정 예정은 기관 순번도 말하지 않는다", /SpaceX 올해/.test(vague || ""), false);
  check("날짜 미정 예정은 전 세계 순번도 말하지 않는다", /전 세계 올해/.test(vague || ""), false);
  // 순번이 아닌 것은 남는다 — 재사용 간격은 "직전 발사와의 간격"이라 미정과 무관하다.
  check("그래도 발사대 재사용 간격은 남는다", /직전 발사로부터/.test(vague || ""), true);

  const soon = ctx.contextText(Object.assign({}, full,
    { outcome: "upcoming", net_precision: "Minute" }));
  check("날짜 확정 예정은 순번을 말한다", /이 발사장 통산 1,129번째/.test(soon), true);
  // ⚠ 시제는 **앞머리에 한 번만**이다. 조각마다 붙였더니 실제 캐시로 렌더한 한 줄에
  //   "됩니다"가 네 번 나왔다 — 조각을 따로 재는 단언은 전부 통과했었다.
  check("그때는 시제를 앞머리에 밝힌다(아직 안 일어났다)",
    soon.startsWith("예정 기준 — "), true);
  check("조각마다 반복하지 않는다", (soon.match(/됩니다/g) || []).length, 0);
  check("완료 발사에는 그 표시가 없다", done.startsWith("예정 기준"), false);
  check("순번을 안 말하는 예정에는 표시도 없다(말할 순번이 없다)",
    (vague || "").startsWith("예정 기준"), false);

  // 네 축이 전부 같은 판정을 쓰는가 — 하나만 빠뜨리면 한 줄에서 섞여 나온다.
  check("날짜 미정이면 네 축이 모두 조용하다",
    ["이 발사대", "이 발사장 통산", "SpaceX 올해", "전 세계 올해"]
      .filter((k) => (vague || "").includes(k)), []);
  check("줄이 통째로 사라지지는 않는다(재사용 간격이 있으면)", !!vague, true);

  // 아무 정보가 없으면 줄 자체가 없다(없는 말을 지어내지 않는다).
  check("말할 것이 없으면 null",
    ctx.contextText({ outcome: "upcoming", net_precision: "Year", location_count: 5 }), null);
}

// ── 같은 문장이 다른 것을 세던 것을 가른다 (P24-2) ───────────────────────────
// 통계 패널과 히트맵 범례가 **글자 그대로 같은 문장**(`현재 불러온 N건 기준`)을 썼는데
// 통계는 필터 전(441), 범례는 필터 후(378)를 넘겼다. 즉 "불러온"이 한쪽에서 "필터된"을
// 가리켰다. 어느 동작이 옳은지가 아니라 **같은 말로 다른 것을 센 것**이 결함이다.
{
  const { ctx } = loadApp();
  group("모수 문구가 무엇을 센 것인지 밝힌다 (scopeNoteHtml)");

  const sc = (n) => ({ total: n, from: null, to: null, full: [], partial: [], nowYear: 2026 });

  check("범위를 안 밝히면 예전 문구 그대로(호출부를 놓쳐도 뜻이 안 바뀐다)",
    ctx.scopeNoteHtml(sc(441)).includes("현재 불러온 441건 기준"), true);

  const shown = ctx.scopeNoteHtml(sc(378), "shown", 441);
  check("보이는 것은 '지금 보이는 N건'", shown.includes("지금 보이는 378건 기준"), true);
  check("그게 전체가 아니라는 것도 말한다", shown.includes("불러온 441건 중"), true);
  check("무엇이 걸렀는지도 말한다", shown.includes("검색·필터·타임라인"), true);

  const loaded = ctx.scopeNoteHtml(sc(441), "loaded", 378);
  check("전체는 '불러온 N건 전체'", loaded.includes("불러온 441건 전체 기준"), true);
  check("지금 화면에는 몇 건인지도 말한다", loaded.includes("378건만 보입니다"), true);
  check("통계가 필터와 무관하다는 것을 밝힌다",
    loaded.includes("검색·필터와 무관하게 전체를 셉니다"), true);

  // ⚠ 필터가 없을 때는 군더더기를 안 붙인다 — 늘 붙이면 안 읽힌다.
  const same = ctx.scopeNoteHtml(sc(441), "loaded", 441);
  check("필터가 없으면 덧말이 없다", same.includes("만 보입니다"), false);
  check("그래도 무엇을 센 것인지는 밝힌다", same.includes("전체 기준"), true);
  const same2 = ctx.scopeNoteHtml(sc(441), "shown", 441);
  check("보이는 쪽도 필터가 없으면 덧말이 없다", same2.includes("중 ·"), false);

  // 관점 화면(발사장·기관·로켓)은 **세 번째 모수**다 — 화면 필터와도, 불러온 전체와도 다르다.
  const ent = ctx.scopeNoteHtml(sc(14), "entity");
  check("관점 화면은 '이 화면 대상의 N건'", ent.includes("이 화면 대상의 14건 기준"), true);
  check("관점 화면은 다른 둘의 문장을 쓰지 않는다",
    [ent.includes("불러온"), ent.includes("지금 보이는")], [false, false]);

  // ⚠ 세 문장이 서로 달라야 한다 — 같으면 이 항목이 통째로 공허하다.
  const three = [ctx.scopeNoteHtml(sc(9), "loaded"), ctx.scopeNoteHtml(sc(9), "shown"),
    ctx.scopeNoteHtml(sc(9), "entity")];
  check("셋이 서로 다른 문장이다", new Set(three).size, 3);

  check("filterNarrows 는 좁아졌을 때만 참",
    [ctx.filterNarrows(441, 378), ctx.filterNarrows(441, 441), ctx.filterNarrows(378, 441),
     ctx.filterNarrows(null, 3), ctx.filterNarrows(3, undefined)],
    [true, false, false, false, false]);
}

{
  group("두 화면이 같은 상태에서 서로 다른 말을 하지 않는다 (P24-2 배선)");
  const { ctx, state, el, map, sel } = loadApp();
  state.map = map;
  for (const s of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(s);
  const mk = (id, outcome) => ({ id, name: "L" + id, outcome, lat: 10 + (+id), lng: 20,
    net: "2026-0" + ((+id % 9) + 1) + "-01T00:00:00Z", rocket: "R" });
  state.allLaunches = [mk("1", "success"), mk("2", "success"), mk("3", "failure")];
  state.loadedYears = new Set();
  state.truncatedYears = new Set();

  // 결과 필터를 '성공'만 남긴다 → 보이는 것 2 / 불러온 것 3
  sel[".flt:checked"] = [{ value: "success" }];
  el("search").value = "";
  ctx.setHeatVisible(true);
  ctx.applyFilters();

  const legend = el("heat-legend").innerHTML;
  check("범례는 보이는 수(2)를 말한다", legend.includes("지금 보이는 2건"), true);
  check("범례가 전체(3)도 밝힌다", legend.includes("불러온 3건 중"), true);

  ctx.showStats();
  const stats = el("stats-body").innerHTML;
  check("통계는 전체(3)를 말한다", stats.includes("불러온 3건 전체 기준"), true);
  check("통계가 지금 보이는 수(2)도 밝힌다", stats.includes("2건만 보입니다"), true);

  // ⚠ **막지 않았으면 무슨 일이 났을 것인가** — 두 화면이 같은 숫자를 주장하면 안 된다.
  check("둘이 같은 문장을 쓰지 않는다",
    legend.includes("불러온 2건 전체 기준"), false);

  // 필터를 풀면 둘이 같은 수를 말한다.
  sel[".flt:checked"] = [{ value: "success" }, { value: "failure" },
    { value: "upcoming" }, { value: "partial" }];
  ctx.applyFilters();
  ctx.showStats();
  check("필터를 풀면 범례도 3건", el("heat-legend").innerHTML.includes("지금 보이는 3건"), true);
  check("그때는 덧말이 없다", el("heat-legend").innerHTML.includes("중 ·"), false);
  check("통계도 3건", el("stats-body").innerHTML.includes("불러온 3건 전체 기준"), true);
  check("통계에도 덧말이 없다", el("stats-body").innerHTML.includes("만 보입니다"), false);
}

{
  group("관점 화면도 제 모수를 밝힌다 (P24-2 배선)");
  // ⚠ 순수 함수만 재면 **호출부가 어느 범위를 넘기는지**는 안 보인다 — 변이 실험에서
  //   `showEntityStats` 가 "loaded" 를 넘기게 바꿔도 전부 초록이었다.
  const { ctx, state, el, map } = loadApp();
  state.map = map;
  for (const s of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(s);
  const mk = (id, site) => ({ id, name: "L" + id, outcome: "success", lat: 10, lng: 20,
    net: "2026-01-01T00:00:00Z", rocket: "R", provider: "P", location_name: site });
  state.allLaunches = [mk("1", "가"), mk("2", "가"), mk("3", "나")];
  state.loadedYears = new Set();
  state.truncatedYears = new Set();

  ctx.showEntityStats("site", "가");
  const body = el("stats-body").innerHTML;
  check("관점 화면은 '이 화면 대상의 2건'", body.includes("이 화면 대상의 2건 기준"), true);
  check("통계 패널의 문장을 쓰지 않는다", body.includes("전체 기준"), false);
  check("범례의 문장도 쓰지 않는다", body.includes("지금 보이는"), false);
}

{
  group("속보 띠가 필터를 안 받는다는 것을 말한다 (P24-3)");
  // 실측(2026-09-18): 결과=실패만으로 좁혀 지도에 **13건**만 남아도 티커는 **58항목 그대로**
  // 성공 발사를 흘렸다. `buildTickerItems` 가 `allLaunches` 가 아니라 `launches`(라이브)를
  // 읽고 필터도 안 받기 때문이다. 동작은 그대로 두고 **그 사실을 말하게** 한다.
  const { ctx, state, el, map, sel } = loadApp();
  state.map = map;
  for (const s of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(s);
  const mk = (id, o) => ({ id, name: "L" + id, outcome: o, lat: 10 + (+id), lng: 20,
    net: "2026-01-01T00:00:00Z", rocket: "R" });
  // ⚠ 티커는 `allLaunches` 가 아니라 **`launches`(라이브)** 를 읽는다 — 그게 이 항목의
  //   절반이다. 둘을 따로 채워 두 변수가 다르다는 것까지 잰다.
  state.launches = [mk("1", "success"), mk("2", "success"), mk("3", "failure")];
  state.allLaunches = state.launches.slice();
  el("search").value = "";

  sel[".flt:checked"] = [{ value: "success" }, { value: "failure" },
    { value: "upcoming" }, { value: "partial" }];
  ctx.applyFilters();
  check("필터가 없으면 표시가 숨어 있다", el("ticker-scope").hidden, true);
  const tickerAll = ctx.buildTickerItems().length;
  check("속보에 항목이 있다(기준선)", tickerAll > 0, true);

  sel[".flt:checked"] = [{ value: "failure" }];
  ctx.applyFilters();
  check("필터가 좁히면 표시가 뜬다", el("ticker-scope").hidden, false);

  el("search").value = "";
  sel[".flt:checked"] = [{ value: "success" }, { value: "failure" },
    { value: "upcoming" }, { value: "partial" }];
  ctx.applyFilters();
  check("필터를 풀면 다시 숨는다", el("ticker-scope").hidden, true);

  // 검색으로 좁혀도 마찬가지 — 세 조건(필터·검색·타임라인)이 한 판정을 쓴다.
  el("search").value = "L1";
  ctx.applyFilters();
  check("검색으로 좁혀도 뜬다", el("ticker-scope").hidden, false);

  // ⚠ **막지 않았으면 무슨 일이 났을 것인가** — 그 상태에서 속보는 여전히 전체를 본다.
  check("그때도 속보 항목 수는 안 줄어든다(동작은 그대로다)",
    ctx.buildTickerItems().length, tickerAll);
}

{
  group("필터 경로가 하나다 (currentFilteredLaunches)");
  // 갈라지면 통계가 말하는 "지금 보이는 N건"과 지도가 그린 수가 어긋난다.
  const { ctx, state, el, map, sel } = loadApp();
  state.map = map;
  for (const s of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(s);
  const mk = (id, outcome) => ({ id, name: "L" + id, outcome, lat: 10 + (+id), lng: 20,
    net: "2026-01-01T00:00:00Z", rocket: "R" });
  state.allLaunches = [mk("1", "success"), mk("2", "failure"), mk("3", "success")];
  sel[".flt:checked"] = [{ value: "success" }];
  el("search").value = "";
  ctx.applyFilters();
  const drawn = (map.data("launches").features || []).length;
  check("지도에 그린 수와 currentFilteredLaunches 가 같다",
    ctx.currentFilteredLaunches().length, drawn);
  el("search").value = "L3";
  ctx.applyFilters();
  check("검색을 걸어도 같다",
    ctx.currentFilteredLaunches().length, (map.data("launches").features || []).length);
}

// ── 사라진 대상을 가리키는 화면 (P25-1 · P25-2) ───────────────────────────────
// 이 축의 버그는 **예외가 안 난다.** 필터로 걸러진 발사의 상세가 그대로 떠 있고
// 마커 0건인 지도에 점선만 남아도 앱은 정상으로 보인다 — 값으로만 잴 수 있다.
{
  const { ctx } = loadApp();
  group("화면 밖 발사 안내 (panelScopeNote · 순수)");
  const shown = new Set(["1", "2"]);
  check("보이는 발사면 아무 말도 안 한다", ctx.panelScopeNote("1", shown, true), null);
  check("패널이 안 열려 있으면 null", ctx.panelScopeNote(null, shown, true), null);
  check("걸러진 발사는 화면 조건을 말한다",
    ctx.panelScopeNote("9", shown, true).includes("화면 조건"), true);
  // 본문에는 "🚀 상승 궤적(근사) 가정: …" 블록이 그대로 남는다. 선을 지운 사실을 안 적으면
  // **없는 선을 설명하는 문장**이 된다 — 렌더해 읽고서야 보인 자리다.
  check("선이 있었으면 내렸다고 말한다",
    ctx.panelScopeNote("9", shown, true, true).includes("함께 내렸습니다"), true);
  check("선이 없던 발사(탄도 등)에는 그 말을 안 붙인다",
    ctx.panelScopeNote("9", shown, true, false).includes("내렸습니다"), false);
  // 갱신으로 데이터에서 빠진 것과 필터로 가려진 것은 **다른 사실**이다. 같은 문구로
  // 뭉뚱그리면 "검색을 지우면 다시 보인다"는 틀린 기대를 준다.
  check("데이터에서 빠졌으면 다른 말을 한다",
    ctx.panelScopeNote("9", shown, false).includes("최신 목록에서 빠졌"), true);
  check("데이터에서 빠진 쪽이 필터 탓으로 읽히지 않는다",
    ctx.panelScopeNote("9", shown, false).includes("화면 조건"), false);
  check("id 는 숫자로 와도 문자열 집합과 맞춘다", ctx.panelScopeNote(1, shown, true), null);
}
{
  // 배선 — **applyFilters 가 실제로 부르는가.** 순수 함수만 재면 판정이 전부 맞아도
  // 호출 한 줄이 없어 화면에는 아무 일도 안 일어난다(2026-09-11 이후 같은 자리에서 반복).
  const { ctx, state, el, map, sel } = loadApp();
  group("화면 밖 발사 안내 배선 (applyFilters → 패널·점선)");
  state.map = map;
  for (const s of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(s);
  const mk = (id, outcome) => ({ id, name: "L" + id, outcome, lat: 34.7, lng: -120.6,
    net: "2026-12-01T00:00:00Z", orbit: "Sun-Synchronous Orbit", rocket: "R" });
  state.launches = [mk("1", "success"), mk("2", "failure")];
  ctx.rebuildAll();
  sel[".flt:checked"] = [{ value: "success" }, { value: "failure" }];
  el("search").value = "";
  ctx.openPanel(state.allLaunches[0]);
  const line = () => JSON.stringify((map.data("launch-track") || {}).geometry || null);
  check("보이는 동안은 안내가 없다", el("panel-scope").hidden, true);
  check("보이는 동안은 점선이 있다", line() !== "null", true);

  sel[".flt:checked"] = [{ value: "failure" }];   // 연 발사(success)를 걸러낸다
  ctx.applyFilters();
  check("걸러지면 안내가 뜬다", el("panel-scope").hidden, false);
  check("문구에 ⚠ 를 달아 본문과 구분한다", el("panel-scope").textContent.startsWith("⚠"), true);
  // 마커가 한 건도 없는 지도에 점선만 남으면 무엇의 선인지 알 수 없다 — closePanel 과 같은 규칙.
  check("걸러지면 지도 점선도 지운다", line(), "null");

  sel[".flt:checked"] = [{ value: "success" }, { value: "failure" }];
  ctx.applyFilters();
  check("다시 보이면 안내가 사라진다", el("panel-scope").hidden, true);
  check("다시 보이면 점선도 돌아온다", line() !== "null", true);

  // 갱신으로 데이터에서 빠지는 경로 — findLaunch 가 undefined 를 주는 상태
  state.launches = [mk("2", "failure")];
  ctx.rebuildAll();
  ctx.applyFilters();
  check("데이터에서 빠져도 예외 없이 안내로 말한다",
    [el("panel-scope").hidden, el("panel-scope").textContent.includes("최신 목록에서 빠졌")],
    [false, true]);

  ctx.closePanel();
  check("패널을 닫으면 안내도 내린다", [el("panel-scope").hidden, el("panel-scope").textContent],
    [true, ""]);
}
{
  // P25-2 — 관측지 해제. **버튼을 실제로 눌러** 잰다(붙었는지만 보면 이 버그는 안 잡힌다:
  // 배선은 처음부터 있었고 통과 패널을 안 닫았을 뿐이다).
  const { ctx, el, state, map } = loadApp();
  group("관측지 해제 (P25-2)");
  state.map = map;
  ctx.setObserver(37.5665, 126.978, "서울");
  el("pass-panel").classList.remove("hidden");   // 통과 예측을 열어 둔 상태
  check("해제 전: 관측지가 있고 통과표가 떠 있다",
    [!!state.observer, el("pass-panel").hidden], [true, false]);
  ctx.openObsPopover();
  const clear = el("obs-clear-btn");
  check("해제 버튼이 배선돼 있다", !!(clear && clear.handlers.click), true);
  clear.fire("click", {});
  check("해제하면 관측지가 없어진다", state.observer, null);
  // 통과표의 **모든 행**이 없는 관측지 기준으로 계산된 값이다. 남기면 틀린 표를 보여주는 것.
  check("통과 예측표도 같이 닫는다", el("pass-panel").hidden, true);
  check("팝오버도 닫는다", el("obs-popover").hidden, true);
}

// ── 데이터가 오기 전의 첫 화면 (P31-1 · P31-2) ───────────────────────────────
// 실제 exe 로그에서 첫 발사 로드가 **8.5초** 였다(P30 이 그 숫자를 처음 남겼다).
// 그동안 화면은 `0건` 이라고 말했다 — 아직 못 받았는데 **없는 숫자**를 말한 것이다.
// 초기 문구는 `index.html` 이 정하므로, 하네스가 그걸 읽어 와야만 잴 수 있다(P31-2).
{
  const { el, ctx, map, state, sel } = loadApp();
  group("첫 화면 (P31-1)");
  const text = (id) => el(id).textContent || "";
  const body = (id) => (el(id).innerHTML || "").replace(/<[^>]*>/g, " ").trim();
  // 없는 숫자를 말하지 않는다. "0건"은 **틀린 사실**이다 — 0건인 것과 아직 모르는 것은 다르다.
  check("개수 자리가 0건으로 시작하지 않는다", text("sidebar-count").includes("0건"), false);
  check("개수 자리가 받는 중이라고 말한다", text("sidebar-count").includes("불러오는 중"), true);
  check("목록도 같은 말을 한다", body("sidebar-list").includes("불러오는 중"), true);
  check("티커도 말한다(원래부터 말하던 한 곳)", text("ticker-text").includes("불러오는 중"), true);

  // 데이터가 오면 **숫자가 된다** — 안내가 남아 있으면 그게 더 나쁘다.
  state.map = map;
  for (const sname of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(sname);
  const mk = (id) => ({ id, name: "L" + id, outcome: "success", lat: 1, lng: 2,
    net: "2026-01-01T00:00:00Z", net_precision: "Minute", rocket: "R" });
  state.launches = [mk("1"), mk("2")];
  ctx.rebuildAll();
  sel[".flt:checked"] = [{ value: "success" }];
  el("search").value = "";
  ctx.applyFilters();
  check("데이터가 오면 숫자가 된다", text("sidebar-count"), "2건");
  check("목록에서 안내가 사라진다", body("sidebar-list").includes("불러오는 중"), false);

  // 진짜로 0건일 때는 **P18-4 의 안내**로 간다 — "불러오는 중"으로 남으면 안 된다.
  state.launches = [];
  ctx.rebuildAll();
  ctx.applyFilters();
  check("정말 0건이면 0건이라고 말한다", text("sidebar-count"), "0건");
  check("0건 안내는 불러오는 중이 아니다",
    [body("sidebar-list").includes("불러오는 중"), body("sidebar-list").includes("갱신")],
    [false, true]);
}
{
  // P31-2 — 장치 자체를 잰다. 하네스가 `index.html` 을 안 읽으면 위 검사는 **전부 공허하게**
  // 통과한다(빈 문자열은 "0건"을 포함하지 않으니까). 그래서 **읽었다는 사실**을 따로 못 박는다.
  const { el } = loadApp();
  group("하네스가 index.html 초기 상태를 읽는다 (P31-2)");
  check("빈 문자열로 시작하지 않는다", el("sidebar-count").textContent.length > 0, true);
  check("정적 버튼 라벨도 읽는다", el("basemap-btn").textContent.includes("다크"), true);
  check("자식 요소 안의 문구도 읽는다", el("sidebar-list").textContent.includes("불러오는 중"), true);
  check("정말로 비어 있는 요소는 빈 채로 둔다", el("panel-body").textContent, "");
}

// ── 화면이 약속한 것을 하는가 (P28-1 · P28-2) ────────────────────────────────
{
  const { ctx, el } = loadApp();
  group("도움말은 안내대로 닫힌다 (P28-1)");
  // 도움말 아래에 "아무 키나 누르면 닫힙니다" 가 적혀 있다. 예전에는 **등록된 단축키만**
  // 닫았고, 실측으로 q·Enter·Space·←·F5·x 여섯 개 중 **0개**가 닫았다.
  check("안내 문구가 그렇게 적혀 있다", (() => {
    ctx.toggleKeyHelp(true);
    return el("keyhelp").innerHTML.includes("아무 키나 누르면 닫힙니다");
  })(), true);
  const closes = (key, target) => {
    ctx.toggleKeyHelp(true);
    ctx.handleKey({ key, target: target || {} });
    return el("keyhelp").hidden;
  };
  check("등록되지 않은 키로도 닫힌다",
    ["q", "Enter", " ", "ArrowLeft", "F5", "x"].map((k) => closes(k)),
    [true, true, true, true, true, true]);
  check("Esc 로도 닫힌다", closes("Escape"), true);
  check("? 는 토글이라 닫힌다", closes("?"), true);
  // 글자를 치는 중에는 비켜나야 한다 — 검색어에 글자가 들어가야 한다.
  check("입력창에 포커스가 있으면 닫지 않는다", closes("q", { tagName: "INPUT" }), false);
  // 단축키는 **닫으면서 그 동작도** 한다(예전부터 그랬다 — 여기서 잃지 않았는지 못 박는다).
  ctx.toggleKeyHelp(true);
  const before = el("sidebar").hidden;
  ctx.handleKey({ key: "s", target: {} });
  check("단축키는 닫으면서 제 동작도 한다",
    [el("keyhelp").hidden, el("sidebar").hidden !== before], [true, true]);
}
{
  // P28-2 — 패널 안쪽 버튼. 하네스의 `querySelector` 가 **항상 null 이라 한 번도 잰 적이
  // 없던 자리**다(배선이 죽어도 전부 초록이었다). 이제 잴 수 있으니 못 박는다.
  const { ctx, el, map, state, sel } = loadApp();
  group("상세 패널의 ☆ 관심 (P28-2)");
  state.map = map;
  for (const sname of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(sname);
  const d = { id: "L1", name: "테스트", outcome: "success", net: "2026-01-01T00:00:00Z",
    net_precision: "Minute", lat: 1, lng: 2, rocket: "R", provider: "P", pad_name: "PAD", location: "LOC" };
  state.launches = [d];
  ctx.rebuildAll();
  sel[".flt:checked"] = [{ value: "success" }];
  el("search").value = "";
  ctx.applyFilters();
  ctx.openPanel(d);
  const b = el("fav-btn");
  check("버튼이 그려지고 배선된다", !!(b && b.handlers.click), true);
  // **`data-kind` 로 분기한다** — 비어 있으면 발사를 위성 쪽 함수로 보낸다(실제로 그랬다).
  check("발사임을 data 로 싣는다", [b.dataset.kind, b.dataset.key], ["launch", "L1"]);
  b.fire("click", {});
  check("누르면 관심 목록에 담긴다", [...state.favLaunches], ["L1"]);
  check("버튼 표시도 바뀐다", el("fav-btn").textContent, "★ 관심");
  b.fire("click", {});
  check("다시 누르면 빠진다", [[...state.favLaunches], el("fav-btn").textContent], [[], "☆ 관심"]);
}

// ── 발사 시각의 정밀도 (P27-1 · P27-2) ───────────────────────────────────────
// 예정 발사의 78%가 "언제인지 모르는" 값인데 화면은 초까지 셌다(28건이 같은 문자열).
// **틀린 숫자가 아니라 없는 정확도를 꾸며 내는 것**이라 눈으로는 알아채기 어렵다.
{
  const { ctx } = loadApp();
  group("정밀도 등급 (netRank · 순수)");
  check("시·분은 3등급", [ctx.netRank("Second"), ctx.netRank("Minute")], [3, 3]);
  check("시간은 2등급", ctx.netRank("Hour"), 2);
  check("날짜는 1등급", ctx.netRank("Day"), 1);
  check("달·분기·반기·연은 0등급",
    ["Month", "Quarter 4", "Year Half 2", "Year"].map((p) => ctx.netRank(p)), [0, 0, 0, 0]);
  // LL2 가 새 표기를 내놓아도 "모른다" 쪽으로 떨어져야 한다. 반대로 떨어지면
  // 모르는 값에 초 단위 시계를 붙이게 된다.
  check("모르는 값과 빈 값은 0등급", [ctx.netRank("Decade"), ctx.netRank(undefined)], [0, 0]);

  group("세 규칙이 같은 표를 본다 (P27-2)");
  // 표로 합치기 전과 **같은 판정**이어야 한다 — 합치면서 조용히 넓어지면
  // 시계를 보여선 안 되는 발사에 시계가 붙는다.
  check("순서표 시계: Second·Minute 만",
    ["Second", "Minute", "Hour", "Day", "Month", "Year"].map((p) => ctx.canShowClock(p)),
    [true, true, false, false, false, false]);
  check("발사장 순번: Day 까지",
    ["Second", "Minute", "Hour", "Day", "Month", "Year"]
      .map((p) => ctx.canShowOrdinal({ outcome: "upcoming", net_precision: p })),
    [true, true, true, true, false, false]);
  check("포커스 카드: 3등급만 고른다",
    ctx.pickFocusLaunch([{ id: "1", outcome: "upcoming", net: new Date(Date.now() + 3600e3).toISOString(),
      net_precision: "Month" }], Date.now(), new Set()), null);
}
{
  const { ctx } = loadApp();
  group("카운트다운 문구 (countdownText · 순수)");
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  check("시·분 확정이면 초까지 센다",
    /^T-\d+일 \d\d:\d\d:\d\d$/.test(ctx.countdownText({ net: iso(3 * 86400e3 + 5000), net_precision: "Minute" })), true);
  check("날짜만 확정이면 초를 세지 않는다",
    ctx.countdownText({ net: iso(3 * 86400e3 + 5000), net_precision: "Day" }), "T-3일");
  check("시간 단위도 초를 세지 않는다",
    ctx.countdownText({ net: iso(3 * 86400e3 + 5000), net_precision: "Hour" }), "T-3일");
  check("오늘·내일은 그렇게 말한다",
    [ctx.countdownText({ net: iso(3600e3), net_precision: "Day" }),
     ctx.countdownText({ net: iso(30 * 3600e3), net_precision: "Day" })], ["오늘 중", "내일 중"]);
  check("연 단위는 그 해를 말한다",
    ctx.countdownText({ net: "2026-12-31T00:00:00Z", net_precision: "Year" }), "2026년 중");
  check("달 단위는 그 달을 말한다",
    ctx.countdownText({ net: "2026-10-31T00:00:00Z", net_precision: "Month" }), "2026년 10월 중");
  // **UTC 로 읽는다.** 지금 데이터는 전부 `00:00:00Z` 라 현지로 읽어도 같지만(실측 37건 중
  // 0건 차이), `…T23:00:00Z` 가 한 번이라도 오면 현지(KST)로는 **다음 해**가 된다.
  // 그때 화면에는 `2027년 중` 이라고 적힐 뿐 아무 경고도 안 난다 — 그래서 여기서 못 박는다.
  check("UTC 자정을 넘는 값도 UTC 기준 연도로 말한다",
    ctx.countdownText({ net: "2026-12-31T23:00:00Z", net_precision: "Year" }), "2026년 중");
  check("UTC 월말 늦은 시각도 그 달로 말한다",
    ctx.countdownText({ net: "2026-10-31T23:00:00Z", net_precision: "Month" }), "2026년 10월 중");
  check("분기·반기", [ctx.countdownText({ net: "2026-12-31T00:00:00Z", net_precision: "Quarter 4" }),
    ctx.countdownText({ net: "2026-12-31T00:00:00Z", net_precision: "Year Half 2" })],
    ["2026년 4분기 중", "2026년 하반기 중"]);
  check("모르는 표기도 연도까지는 참이므로 그만큼 말한다",
    ctx.countdownText({ net: "2026-12-31T00:00:00Z", net_precision: "Decade" }), "2026년 중");
  check("net 이 깨졌으면 시기 미정",
    ctx.countdownText({ net: "이상한값", net_precision: "Year" }), "시기 미정");
  check("net 이 없으면 빈 문자열", ctx.countdownText({ net: null }), "");
}
{
  // 배선 — **여덟 화면이 같은 창구를 쓰는가.** 순수 함수만 재면 한 화면이 옛 `countdown()`
  // 을 그대로 써도 전부 통과한다(실제로 그래서 일곱 곳이 초를 세고 있었다).
  const { ctx, el, map, state, sel } = loadApp();
  group("정밀도 배선 — 여덟 화면이 같은 말을 한다 (P27-1)");
  state.map = map;
  for (const sname of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(sname);
  const vague = { id: "v", name: "미정 발사", outcome: "upcoming", net: "2026-12-31T00:00:00Z",
    net_precision: "Year", lat: 28.5, lng: -80.5, rocket: "R", provider: "P",
    pad_name: "PAD", location: "LOC" };
  state.launches = [vague];
  ctx.rebuildAll();
  sel[".flt:checked"] = [{ value: "upcoming" }];
  el("search").value = "";
  ctx.applyFilters();
  const txt = (id) => (el(id).innerHTML || "").replace(/<[^>]*>/g, " ");
  check("사이드바 목록", txt("sidebar-list").includes("2026년 중"), true);
  check("사이드바에 초 단위가 남아 있지 않다", /\d\d:\d\d:\d\d/.test(txt("sidebar-list")), false);
  ctx.startTicker();
  check("속보 티커", txt("ticker-text").includes("2026년 중"), true);
  ctx.toggleFavLaunch("v");
  ctx.setSidebarTab("favs");
  check("관심 목록", txt("sidebar-list").includes("2026년 중"), true);
  ctx.openPanel(vague);
  check("상세 패널", txt("panel-body").includes("2026년 중"), true);
  // 같은 사실을 두 번 말하면 안 된다 — 카운트다운 자리가 이미 "2026년 중" 이다.
  check("상세 패널이 '연 단위로만 확정'을 또 적지 않는다",
    txt("panel-body").includes("연 단위로만 확정"), false);
  // 날짜까지 확정된 발사에서는 그 경고가 여전히 필요하다(그 자리는 "T-3일" 뿐이다).
  ctx.openPanel(Object.assign({}, vague, { net_precision: "Day", net: "2026-12-31T00:00:00Z" }));
  check("날짜 단위 발사에는 경고가 남는다", txt("panel-body").includes("날짜만 확정"), true);
  check("날짜 단위 발사의 카운트다운은 일 단위다", /T-\d+일(?! \d)/.test(txt("panel-body")), true);
  check("패드 목록", ctx.padListHtml([vague], "").includes("2026년 중"), true);
}

// ── 겹치는 요청 (P26-1 · P26-2) ───────────────────────────────────────────────
// 이 축의 버그도 예외가 안 난다. **요청 수만 조용히 늘고**(429 가 뜨고 나서야 안다),
// 화면은 늦게 온 옛 응답으로 소리 없이 되돌아간다.
{
  const { ctx } = loadApp();
  group("겹침 헬퍼 (beginLoad · nextSeq · 순수)");
  check("처음 부르면 보낸다", ctx.beginLoad("x"), true);
  check("진행 중이면 안 보낸다", ctx.beginLoad("x"), false);
  check("키가 다르면 막지 않는다", ctx.beginLoad("y"), true);
  ctx.endLoad("x");
  check("끝나면 다시 보낼 수 있다", ctx.beginLoad("x"), true);
  const t1 = ctx.nextSeq("launches");
  check("받아 둔 번호는 최신이다", ctx.isLatest("launches", t1), true);
  const t2 = ctx.nextSeq("launches");
  check("더 새 요청이 나가면 옛 번호는 최신이 아니다", ctx.isLatest("launches", t1), false);
  check("마지막으로 받은 번호는 최신이다", ctx.isLatest("launches", t2), true);
  // 위성에는 토큰이 없다(가드가 직렬화해 늦게 온 옛 응답이 생길 수 없다) — 그래서
  // 없는 종류를 물으면 **아무것도 최신이 아니다**. 조용히 true 를 주면 안 쓰는 종류에
  // 토큰을 걸어 두고 통과한 줄 알게 된다.
  check("없는 종류는 최신이 아니다", ctx.isLatest("satellites", 0), false);
}
{
  // 배선 — **단축키 경로**로 잰다. 버튼은 `disabled` 로 이미 막히고 있었고,
  // 새는 곳은 버튼을 거치지 않는 `keys.js` 였다(실측에서 R 3연타 = 3회).
  const later = [];
  let calls = 0;
  const { ctx, el, map, state, win, doc } = loadApp({ api: {
    get_settings: async () => ({}), save_settings: () => {},
    get_launches: async () => { calls++; return new Promise((r) => later.push(() => r({ launches: [] }))); },
    get_archive: async () => ({ launches: [] }),
    get_satellites: async () => ({ satellites: [] }),
  } });
  group("겹침 배선 — 단축키 연타 (P26-1)");
  for (const sname of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(sname);
  state.map = map;
  // **실제 부트를 거쳐야 단축키가 붙는다** — `bindUI()` 가 document 에 keydown 을 단다.
  // 함수를 직접 부르면 판정은 보이지만 이 경로(버튼을 거치지 않는 길)를 못 잰다.
  await win.fire("pywebviewready");
  await new Promise((r) => setImmediate(r));
  later.forEach((f) => f());   // 부트가 띄운 첫 요청을 끝내 둔다
  later.length = 0;
  await new Promise((r) => setImmediate(r));
  calls = 0;
  doc.fire("keydown", { key: "r", target: {} });
  doc.fire("keydown", { key: "r", target: {} });
  doc.fire("keydown", { key: "r", target: {} });
  check("R 3연타에 요청은 한 번만 나간다", calls, 1);
  check("두 번째부터는 이미 갱신 중이라고 말한다",
    el("status").textContent.includes("이미 갱신 중"), true);
  later.forEach((f) => f());
}
{
  const { ctx, el, map, state } = loadApp({ api: {
    get_settings: async () => ({}), save_settings: () => {},
    get_launches: async () => ({ launches: [] }),
    get_archive: async () => new Promise(() => {}),   // 영원히 안 오는 응답
    get_satellites: async () => ({ satellites: [] }),
  } });
  group("겹침 배선 — 아카이브 (P26-1)");
  for (const sname of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(sname);
  state.map = map;
  let asked = 0;
  const orig = ctx.window.pywebview.api.get_archive;
  ctx.window.pywebview.api.get_archive = (y) => { asked++; return orig(y); };
  ctx.loadArchive(2025);
  ctx.loadArchive(2025);
  check("같은 연도를 연달아 불러도 한 번만 나간다 (연도당 최대 5페이지짜리 요청이다)", asked, 1);
  check("두 번째는 불러오는 중이라고 말한다",
    el("status").textContent.includes("이미 불러오는 중"), true);
  // 이미 받아 둔 연도로 빠지는 길이 **가드를 잠근 채 빠져나가면** 그 연도는 영영 막힌다.
  state.loadedYears = new Set([2024]);
  ctx.loadArchive(2024);
  ctx.loadArchive(2024);
  check("이미 불러온 연도는 가드를 잠그지 않는다(두 번 다 같은 안내)",
    el("status").textContent.includes("이미 불러왔습니다"), true);
}
{
  // 실패해도 가드가 풀려야 한다 — `finally` 가 빠지면 **그 뒤로 영영 못 부른다**.
  let calls = 0, fail = true;
  const { ctx, map, state } = loadApp({ api: {
    get_settings: async () => ({}), save_settings: () => {},
    get_launches: async () => { calls++; if (fail) throw new Error("끊김"); return { launches: [] }; },
    get_archive: async () => ({ launches: [] }),
    get_satellites: async () => ({ satellites: [] }),
  } });
  group("겹침 배선 — 실패해도 잠기지 않는다");
  for (const sname of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(sname);
  state.map = map;
  await (async () => {
    await ctx.loadLaunches(true);
    fail = false;
    await ctx.loadLaunches(true);
    check("첫 요청이 실패해도 다음 요청은 나간다", calls, 2);
  })();
}
{
  // 위성도 같은 경로다 — 체크박스를 켬-끔-켬 하면 두 벌이 나갔다(실측 2회).
  const pending = [];
  let calls = 0;
  const { ctx, el, map, state, win } = loadApp({ api: {
    get_settings: async () => ({}), save_settings: () => {},
    get_launches: async () => ({ launches: [] }),
    get_archive: async () => ({ launches: [] }),
    get_satellites: async () => { calls++; return new Promise((r) => pending.push(r)); },
    get_satellite_groups: async () => [],
  } });
  group("겹침 배선 — 위성 (P26-1)");
  for (const sname of ["launches", "launch-heat", "launch-track", "terminator", "satellites", "sat-track"])
    map.stubSource(sname);
  state.map = map;
  await (async () => {
    await win.fire("pywebviewready");
    await new Promise((r) => setImmediate(r));
    map.fire("load");
    await new Promise((r) => setImmediate(r));
    calls = 0;
    const t = el("toggle-sat");
    t.checked = true; t.fire("change", { target: t });
    t.checked = false; t.fire("change", { target: t });
    t.checked = true; t.fire("change", { target: t });
    check("켬-끔-켬 에도 위성 요청은 한 번만 나간다", calls, 1);
    pending.forEach((r) => r({ satellites: [] }));
  })();
}
{
  // ── 조건 18줄 — 뒤집어도 1,443건이 전부 초록이던 자리 (전면 감사 F-019) ──────────
  // 한 줄씩 동치 변이인지 따졌고 **동치는 없었다**: 뒤집으면 정상 입력에서 결과가 바뀐다
  // (중계 링크가 있을 때 오히려 사라진다 · 시간대 이름이 빈 문자열이 된다 · 소유국 통계가
  // 빈다 · 속보 띠가 5초가 아니라 매초 넘어간다 …). 각 단언은 **정상 입력**에서 잰다.
  group("조건 분기 — 뒤집으면 바뀌는 값 (F-019)");
  const future = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
  const past = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  { // keys.js — closeOverlay("help") 는 도움말을 닫는다
    const { ctx, el } = loadApp();
    ctx.toggleKeyHelp(true);
    ctx.closeOverlay("help");
    check("Esc 로 단축키 도움말을 닫는다", el("keyhelp").hidden, true);
  }
  { // launches.js — 속보 띠: 예정 2건마다 결과 1건 · 지난 예정은 건너뜀 · 5초마다 넘김
    const { ctx, state, el, timers } = loadApp();
    const up = (n, h) => ({ id: n, name: n, outcome: "upcoming", net: future(h) });
    const res = (n, h) => ({ id: n, name: n, outcome: "success", net: past(h) });
    state.launches = [up("u1", 1), up("u2", 2), up("u3", 3), up("u4", 4),
                      res("r1", 1), res("r2", 2), res("r3", 3)];
    check("속보 띠 순서 — 예정 둘마다 결과 하나, 남은 결과는 뒤에",
      ctx.buildTickerItems().map((x) => x.d.id), ["u1", "u2", "r1", "u3", "u4", "r2", "r3"]);

    const a = up("알파호", 1), b = up("베타호", 2);
    state.launches = [a, b];
    ctx.startTicker();
    const text = () => el("ticker-text").innerHTML;
    for (let i = 0; i < 4; i++) timers.run(1000);
    check("속보 띠 — 4초까지는 첫 항목에 머문다", text().includes("알파호"), true);
    timers.run(1000);
    check("속보 띠 — 5초째에 다음 항목으로 넘어간다", text().includes("베타호"), true);
    for (let i = 0; i < 5; i++) timers.run(1000);   // 한 바퀴 돌아 다시 알파호
    a.net = past(0.1);                               // 카운트다운이 끝났다
    timers.run(1000);
    check("속보 띠 — 카운트다운이 끝난 예정 항목은 건너뛴다", text().includes("베타호"), true);
  }
  { // panels.js — 제원 통산 · 중계 · 소식 · 지도 이동
    const { ctx, state, map } = loadApp();
    const rec = (sp) => ctx.rocketSpecBlock({ rocket_spec: sp });
    check("통산 — 성공 수가 있으면 적는다", rec({ total: 10, success: 9, fail: 1 }).includes("성공 9"), true);
    check("통산 — 성공 수가 없으면 적지 않는다", rec({ total: 3 }).includes("성공"), false);
    check("중계 링크가 있으면 버튼을 그린다",
      ctx.vidLinksBlock({ vid_urls: [{ url: "https://x.test/v", title: "생중계" }] }).includes("vid-btn"), true);
    check("중계 링크가 없으면 아무것도 안 그린다", ctx.vidLinksBlock({}), "");
    check("발사 소식이 있으면 그린다",
      ctx.updatesBlock({ updates: [{ comment: "연기됨", created_on: past(1) }] }).includes("연기됨"), true);
    check("발사 소식이 없으면 아무것도 안 그린다", ctx.updatesBlock({ updates: [] }), "");
    state.map = map;
    ctx.openPanel({ id: "g1", name: "좌표 있음", outcome: "upcoming", net: future(5), lat: 28.5, lng: -80.6 });
    const flew = map.moves().filter((m) => m[0] === "flyTo");
    check("상세를 열면 그 발사장으로 이동한다", flew.length === 1 && flew[0][1].center, [-80.6, 28.5]);
    ctx.openPanel({ id: "g2", name: "좌표 없음", outcome: "upcoming", net: future(5) });
    check("좌표 없는 발사는 이동하지 않는다", map.moves().filter((m) => m[0] === "flyTo").length, 1);
  }
  { // satfilter.js — 종류·소유국 구역 · 필터 뒤 즉시 위치 갱신
    const { ctx, state, el } = loadApp();
    state.satrecs = [{ norad: "1", name: "A", band: "leo" }];
    state.satcat = { 1: { type: "PAYLOAD" } };   // 소유국 없음
    ctx.renderFacetFilters();
    const h = el("sat-facets").innerHTML;
    check("메타가 있는 구역은 체크박스를 그린다", h.includes('class="satt"'), true);
    check("메타가 없는 구역은 제목도 남기지 않는다", h.includes("소유국"), false);

    let redraws = 0;
    ctx.updateSatellitePositions = () => { redraws++; };
    state.sidebarTab = "launches";
    // 두 경우를 **따로** 센다 — 합쳐 세면 뒤집어도 합이 1로 같아 못 잡는다(처음에 그렇게 썼다).
    state.satTimer = 7;
    ctx.applySatFilter();
    const whileRunning = redraws;
    state.satTimer = null;
    ctx.applySatFilter();
    check("필터를 바꾸면 루프가 돌 때만 위치를 바로 다시 그린다", [whileRunning, redraws - whileRunning], [1, 0]);
  }
  { // satpanel.js — 매초 갱신은 값 줄만 바꾼다
    const app = loadApp();
    let opened = 0;
    app.ctx.openSatPanel = () => { opened++; };
    app.ctx.satRowsHtml = () => "값줄";
    app.ctx.refreshSatPanel({ norad: "1" });
    check("위성 상세 갱신 — 값 줄이 있으면 그것만 갈아끼운다",
      [app.el("sat-rows").innerHTML, opened], ["값줄", 0]);
    const gone = loadApp({ missing: ["sat-rows"] });
    let reopened = 0;
    gone.ctx.openSatPanel = () => { reopened++; };
    gone.ctx.refreshSatPanel({ norad: "1" });
    check("위성 상세 갱신 — 값 줄이 없으면 패널을 새로 연다", reopened, 1);
  }
  { // satpass.js — 빈 결과 안내 · "오늘 밤"은 보이는 통과만
    const { ctx, state, el } = loadApp();
    const t0 = Date.now() + 3600 * 1000;
    const pass = (vis) => ({ visible: vis, start: t0, end: t0 + 300000, startAz: 0, endAz: 90, maxEl: 40 });
    state.selectedSat = { norad: "1", name: "A", rec: {} };
    state.observer = { lat: 37.5, lng: 127 };
    ctx.computePasses = () => [];
    ctx.showPasses();
    check("통과가 없으면 없다고 말한다", el("pass-body").innerHTML.includes("pass-empty"), true);
    ctx.computePasses = () => [pass(true)];
    ctx.showPasses();
    check("통과가 있으면 빈 안내를 내지 않는다",
      [el("pass-body").innerHTML.includes("pass-empty"), el("pass-body").innerHTML.includes("pass-row")], [false, true]);

    ctx.sunTable = () => [];
    ctx.tonightTargets = () => [{ name: "A", norad: "1", rec: {} }];
    ctx.computePasses = () => [pass(true), pass(false), pass(false)];
    const job = ctx.tonightJob(state.observer);
    job.step();
    check("오늘 밤 — 눈에 보이는 통과만 담는다", job.result().length, 1);
  }
  { // sats.js — 위성을 끄면 위치 루프를 멈춘다
    const { ctx, state, map, timers } = loadApp();
    state.map = map;
    state.sidebarTab = "launches";
    state.satTimer = ctx.setInterval(() => {}, 1000);
    ctx.setSatelliteVisible(false);
    check("위성을 끄면 위치 루프를 멈춘다", [timers.every(1000).length, state.satTimer], [0, null]);
  }
  { // stats.js — 국가별 집계
    const { ctx } = loadApp();
    const s = ctx.computeStats([
      { outcome: "success", provider_country: "USA" },
      { outcome: "success", provider_country: "USA" },
      { outcome: "success", provider_country: "" },
    ]);
    check("국가별 집계(빈 값 제외)", s.byCountry, { [ctx.countryKo("USA")]: 2 });
  }
  { // utils.js — 시간대 이름
    const { ctx, state } = loadApp();
    state.timeZoneMode = "local";
    check("현지 모드 이름이 비어 있지 않다(TZ=Asia/Seoul)", ctx.tzName().length > 0, true);
    check("발사장 시간대의 짧은 이름", ctx.zoneShortName("2026-01-01T00:00:00Z", "Asia/Shanghai"), "GMT+8");
    check("시간대가 없으면 빈 문자열", ctx.zoneShortName("2026-01-01T00:00:00Z", ""), "");
  }
}
{
  // ── 경계 — `<` 와 `<=` 한 칸 차이 (2026-09-24, 공용 도구의 boundary 프리셋) ──────
  // 121줄 중 77줄이 한 칸 옮겨도 초록이었다. 대부분은 실수(시각·고도·각도) 비교라 정확히
  // 같은 값에서만 갈리는 **동치**다. 여기 잰 것은 **정수이고 경계값이 실제로 나오는** 자리다 —
  // 연도 선택지 개수, 슬라이더 끝(100), 정확히 60분짜리 윈도우, 목록이 정확히 상한만큼일 때.
  group("경계 — 한 칸 차이로 바뀌는 값 (boundary 변이)");
  const { ctx, state, el } = loadApp();
  const agoMin = (m) => new Date(Date.now() - m * 60000 - 1000).toISOString();

  ctx.populateArchiveYears();
  check("아카이브 연도는 올해 포함 5년", el("arch-year").children.length, 5);

  state.tlMin = Date.UTC(2026, 0, 1);
  state.tlMax = Date.UTC(2026, 0, 1) + 40 * 86400000;
  el("tl-range").value = "100";
  ctx.applyFilters = () => {};   // 여기선 기준(timelineMax)만 잰다 — 지도 반영은 위 P12-16 이 잰다
  ctx.onTimeline(true);
  check("슬라이더 끝(100)은 '전체 기간' — 먼 미래 발사를 자르지 않는다",
    [state.timelineMax, el("tl-label").textContent], [null, "전체 기간"]);

  check("딱 60분·24시간 전은 한 단위 위로",
    [ctx.agoText(agoMin(60)), ctx.agoText(agoMin(24 * 60))], ["1시간 전", "1일 전"]);
  check("정확히 1,000 은 t·MN 으로", [ctx.fmtQty(1000, "kg"), ctx.fmtQty(1000, "kN")], ["1 t", "1 MN"]);
  check("정확히 60분짜리 윈도우는 '1시간'",
    /\(1시간\)$/.test(ctx.windowText({ window_start: "2026-05-01T10:00:00Z", window_end: "2026-05-01T11:00:00Z" })), true);
  check("하루가 안 남은 카운트다운에는 '0일' 이 붙지 않는다",
    /^T-\d\d:\d\d:\d\d$/.test(ctx.countdown(new Date(Date.now() + 3600 * 1000).toISOString())), true);
  check("극점·날짜변경선 좌표는 유효하다",
    [ctx.validLatLng(-90, 180), ctx.validLatLng(90, -180)], [true, true]);

  const cap = state.SIDEBAR_CAP;
  state.satrecs = Array.from({ length: cap }, (_, i) => ({ norad: String(i + 1), name: "S" + i, band: "leo" }));
  el("sat-search").value = "";
  ctx.renderSatList();
  check("목록이 정확히 상한만큼이면 '…외 N개' 를 내지 않는다", el("sidebar-list").innerHTML.includes("…외"), false);
  state.satrecs = state.satrecs.concat([{ norad: "99999", name: "넘침", band: "leo" }]);
  ctx.renderSatList();
  check("상한을 넘으면 '…외 1개'", el("sidebar-list").innerHTML.includes("…외 1개"), true);
}
{
  // P26-2 — 늦게 온 옛 응답이 화면을 되돌리면 안 된다. `renderTonightList()` 는 이미
  // 같은 규칙을 갖고 있었고 발사 로더에만 없었다.
  const pending = [];
  const { ctx, map, state, el, sel } = loadApp({ api: {
    get_settings: async () => ({}), save_settings: () => {},
    get_launches: async () => new Promise((r) => pending.push(r)),
    get_archive: async () => ({ launches: [] }),
    get_satellites: async () => ({ satellites: [] }),
  } });
  group("늦게 온 옛 응답 (P26-2)");
  for (const sname of ["launches", "launch-heat", "launch-track", "terminator"]) map.stubSource(sname);
  state.map = map;
  const mk = (id) => ({ id, name: "L" + id, outcome: "success", lat: 1, lng: 2,
    net: "2026-01-01T00:00:00Z", rocket: "R" });
  sel[".flt:checked"] = [{ value: "success" }];
  await (async () => {
    const p1 = ctx.loadLaunches(false, true);   // 자동 폴링
    const p2 = ctx.loadLaunches(true);          // 사용자의 강제 갱신 — 나중 요청
    pending[1]({ launches: [mk("a"), mk("b")] });   // 새 요청이 먼저 도착
    await p2;
    pending[0]({ launches: [mk("z")] });            // 옛 요청이 늦게 도착
    await p1;
    check("늦게 온 옛 응답은 버린다(화면이 되돌아가지 않는다)",
      state.allLaunches.map((d) => d.id), ["a", "b"]);
    check("사이드바 수도 새 응답 기준이다", el("sidebar-count").textContent, "2건");

    // ── 타이머를 다시 걸 때 이전 것을 지우는가 (전면 감사 F-018) ──────────────
    // `if (timer) clearInterval(timer)` 여덟 줄을 뒤집어도 1,427건이 전부 초록이었다.
    // 지워지지 않으면 같은 타이머가 겹쳐 돈다 — 카운트다운 2배속·위성 계산 2배, 오래 켜 둘수록 무겁다.
    // 첫 호출이 **정말 타이머를 만들었는지**도 잰다 — 안 만들었으면 "안 늘었다"가 공허하다.
    group("타이머 재무장 — 이전 것을 지운다 (F-018)");
    const rearm = (label, prep, call, kind = "all") => {
      const app = loadApp();
      app.state.map = app.map;
      prep(app);
      const live = () => (kind === "timeouts" ? app.timers.timeouts() : app.timers.all()).length;
      const before = live();
      call(app);
      const once = live();
      call(app);
      check(`${label}: 첫 호출이 타이머를 만든다`, once > before, true);
      check(`${label}: 두 번 불러도 살아 있는 타이머가 늘지 않는다`, live(), once);
    };
    const upcoming = { id: "u", name: "곧", outcome: "upcoming", lat: 0, lng: 0,
      net: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
    rearm("집중 화면", () => {}, (a) => a.ctx.startFocusTimer());
    rearm("자동 갱신", () => {}, (a) => a.ctx.startAutoRefresh());
    rearm("티커", (a) => { a.state.launches = [upcoming]; a.state.allLaunches = [upcoming]; },
      (a) => a.ctx.startTicker());
    rearm("위성 위치 루프", () => {}, (a) => a.ctx.startSatelliteLoop());
    rearm("업데이트 재확인", () => {}, (a) => a.ctx.startUpdateRecheck());
    rearm("위성 궤적", () => {}, (a) => a.ctx.selectSatellite({ norad: "1", name: "x" }));
    rearm("지도 위치 저장(디바운스)", () => {}, (a) => a.ctx.scheduleCameraSave(), "timeouts");
    {
      const app = loadApp();
      app.state.map = app.map;
      app.ctx.selectSatellite({ norad: "1", name: "x" });
      const withTrack = app.timers.every(30000).length;
      app.ctx.deselectSatellite();
      check("위성 선택 해제: 궤적 타이머가 있었다", withTrack, 1);
      check("위성 선택 해제: 궤적 타이머를 지운다", app.timers.every(30000).length, 0);
    }
    done(1478);   // 건수 하한 — 2026-09-24 실측(1427 + F-018 의 16 + F-019 의 26 + 경계 9)
  })();
}

})();
