/* RL3D — 사이드바(발사/위성/관심 탭)와 목록 렌더. panels.js 에서 분리(P14-4). */

/**
 * 목록 한 번에 그릴 최대 행 수 (P20-2).
 *
 * **행을 DOM 에 넣는 값이 비싸다** — 2026-09-17 실측(Chromium 153, 실제 파싱+레이아웃):
 * 400행 **12.3ms** · 1,803행 **56.9ms** (행당 약 30µs). HTML **문자열 조립**은 2,925행에
 * 0.3ms 라 싼데, 그걸 화면에 넣는 쪽이 비용의 전부다 — 조립만 재고 "싸다"고 판단하면
 * 틀린다(실제로 한 번 틀렸다).
 *
 * 값은 **읽기 쉬움에도 있다**: 1,803행을 끝까지 스크롤하는 사람은 없다. 넘치면 잘라내는
 * 대신 **몇 건이 더 있는지와 좁히는 방법**을 말한다.
 *
 * 발사 목록은 예정(가까운 순) → 지난 것(최신순) 으로 정렬한 **뒤** 자르므로,
 * 잘리는 것은 **항상 가장 오래된 발사**다. 예정 발사는 LL2 가 한 번에 50건쯤 주므로
 * 이 캡에 걸리지 않는다.
 */
const SIDEBAR_CAP = 400;

// ── 사이드바 탭 (발사 / 위성 / 오늘 밤 / 관심) ────────────────────────────────
let basemap = "dark";       // 배경 지도: dark(CARTO) | satellite(Esri)
let sidebarTab = "launches";

function setSidebarTab(tab) {
  sidebarTab = tab;
  document.getElementById("tab-launches").classList.toggle("active", tab === "launches");
  document.getElementById("tab-sats").classList.toggle("active", tab === "sats");
  document.getElementById("tab-favs").classList.toggle("active", tab === "favs");
  document.getElementById("tab-tonight").classList.toggle("active", tab === "tonight");
  document.getElementById("sat-search").classList.toggle("hidden", tab !== "sats");
  if (tab === "sats") renderSatList();
  else if (tab === "favs") renderFavList();
  else if (tab === "tonight") renderTonightList();
  else applyFilters();   // 발사 탭은 현재 필터 결과를 다시 그린다
}

// ── 오늘 밤 볼 만한 통과 (P12-2) ──────────────────────────────────────────────
/** 계산 전제가 갖춰지지 않았을 때의 안내. 갖춰졌으면 null. */
function tonightBlocker() {
  if (!observer) {
    // 예전 안내는 "위성 패널의 관측지 지정을 누르라"였는데, **그 버튼은 위성을 골라야 나타난다** —
    // 시작할 수 없는 안내였다(P13-6). 여기서 바로 정하게 한다.
    return `관측 위치가 필요합니다.<br /><button id="tonight-obs-btn" class="btn sm">📍 관측 위치 정하기</button>`;
  }
  if (!satrecs.length) {
    return "위성 데이터가 아직 없습니다.<br />위성 레이어를 켜면 목록이 채워집니다.";
  }
  return null;
}

function renderTonightList() {
  const cont = document.getElementById("sidebar-list");
  const countEl = document.getElementById("sidebar-count");
  const blocked = tonightBlocker();
  if (blocked) {
    countEl.textContent = "—";
    cont.innerHTML = `<div class="sb-empty">${blocked}</div>`;
    const b = document.getElementById("tonight-obs-btn");
    if (b) b.addEventListener("click", openObsPopover);
    return;
  }
  // 계산을 **조각으로 나눠** 돈다 — 한 번에 돌면 위성당 50ms 씩 UI 스레드를 잡아
  // 기본 그룹(176건)에서도 9초간 앱이 얼어붙는다(2026-09-16 실측).
  const job = tonightJob(observer);
  const token = ++tonightToken;
  const run = () => {
    if (token !== tonightToken) return;   // 그 사이 탭이 바뀌었거나 다시 그려졌다
    job.step();
    if (job.done) { tonightRows = job.result(); renderTonightRows(tonightRows); return; }
    countEl.textContent = "계산 중";
    cont.innerHTML = `<div class="sb-empty">눈에 보이는 통과를 찾는 중… ` +
      `<b>${Math.round(job.progress * 100)}%</b><br />저궤도 위성 ${job.total}개를 봅니다.</div>`;
    setTimeout(run, 0);
  };
  run();
}

/**
 * 주기마다 불려 **지나간 통과 줄만** 걷어낸다 (P19-2). 계산은 하지 않는다.
 * 탭이 열려 있지 않거나 결과가 없으면 아무 일도 하지 않는다.
 */
function tickTonightFreshness(nowMs = Date.now()) {
  // 시각을 **주입받는다** — 안에서 `Date.now()` 만 부르면 테스트가 "지난 통과"를 만들 수
  // 없어 단언이 그냥 통과한다(이 리포가 반복해 당한 갈래다).
  if (sidebarTab !== "tonight" || !tonightRows) return;
  const left = dropPastPasses(tonightRows, nowMs);
  if (left.length === tonightRows.length) return;   // 바뀐 게 없으면 다시 그리지 않는다
  tonightRows = left;
  renderTonightRows(left);
}

/** 계산이 끝난 뒤의 목록 그리기 — 위 실행부와 나눠 둔다(테스트가 여기만 부를 수 있게). */
function renderTonightRows(rows) {
  const cont = document.getElementById("sidebar-list");
  const countEl = document.getElementById("sidebar-count");
  countEl.textContent = `${rows.length}건`;
  if (!rows.length) {
    // 조건을 못 채운 것이지 고장이 아니다 — 기준을 함께 보여준다.
    cont.innerHTML = `<div class="sb-empty">향후 24시간 안에 <b>눈에 보이는 통과가 없습니다.</b><br />` +
      `(관측지가 어둡고 = 태양고도 −6° 미만, 위성이 햇빛을 받는 통과만 셉니다. 저궤도만 셉니다)</div>`;
    return;
  }
  cont.innerHTML = rows.map((r) => {
    const p = r.pass;
    const when = p.visStart !== undefined ? p.visStart : p.start;
    const el = Math.round(p.visMaxEl !== undefined ? p.visMaxEl : p.maxEl);
    const dur = Math.max(1, Math.round((p.end - p.start) / 60000));
    const dir = `${azToCompass(p.startAz)}→${azToCompass(p.endAz)}`;
    return `<button class="sb-row" data-norad="${escapeHtml(String(r.norad))}">` +
      `<span class="dot d-sat"></span>` +
      `<span class="sb-main"><span class="sb-name">${escapeHtml(r.name)}</span>` +
      `<span class="sb-sub">${escapeHtml(fmtPassTime(when))} · 최대고도 ${el}° · ${escapeHtml(dir)} · ${dur}분</span>` +
      `</span></button>`;
  }).join("");
}

/** 위성 목록 — satrecs(로드된 TLE) 기준. 이름·NORAD 로 걸러 보여준다. */
function renderSatList() {
  const cont = document.getElementById("sidebar-list");
  const countEl = document.getElementById("sidebar-count");
  if (!satrecs.length) {
    countEl.textContent = "0개";
    const on = document.getElementById("toggle-sat").checked;
    // **실패했는데 "불러오는 중…"이라고 말하면 안 된다**(P18-3). 상태줄은 403 을 알리는데
    // 이쪽만 영원히 로딩 중이라, 같은 화면의 두 자리가 서로 다른 말을 하고 있었다.
    const note = satLoadError
      ? `위성 데이터를 받지 못했습니다.<br />${escapeHtml(satLoadError)}<br />툴바의 <b>↻ 갱신</b>으로 다시 시도할 수 있습니다.`
      : (on ? "위성을 불러오는 중…"
            : "위성 레이어가 꺼져 있습니다.<br />툴바의 <b>위성</b>을 켜면 목록이 채워집니다.");
    cont.innerHTML = `<div class="sb-empty">${note}</div>`;
    return;
  }
  const q = document.getElementById("sat-search").value.trim().toLowerCase();
  const list = visibleSats().filter((s) =>
    !q || s.name.toLowerCase().includes(q) || String(s.norad).includes(q));
  countEl.textContent = `${list.length}개`;
  if (!list.length) {
    const allBands = BANDS.every((b) => satBands[b.key] !== false);
    cont.innerHTML = `<div class="sb-empty">${allBands
      ? "검색 결과가 없습니다."
      : "조건에 맞는 위성이 없습니다.<br />툴바 <b>그룹 ▾</b>의 궤도 대역 필터를 확인해 보세요."}</div>`;
    return;
  }
  cont.innerHTML = list.slice(0, SIDEBAR_CAP).map((s) =>
    `<button class="sb-row" data-norad="${escapeHtml(String(s.norad))}">` +
    `<span class="dot d-sat"></span>` +
    `<span class="sb-main"><span class="sb-name">${escapeHtml(s.name)}</span>` +
    `<span class="sb-sub">NORAD ${escapeHtml(String(s.norad))} · ${bandLabel(s.band)}</span></span></button>`).join("") +
    (list.length > SIDEBAR_CAP
      ? `<div class="sb-empty">…외 ${list.length - SIDEBAR_CAP}개. 검색으로 좁혀보세요.</div>` : "");
}

/** 목록에서 위성을 고르면 지도에서 클릭한 것과 같게 동작. */
function pickSatellite(norad) {
  const s = satrecs.find((x) => String(x.norad) === String(norad));
  if (!s) return;
  selectSatellite(s);
  openSatPanel(s);
  const d = satDetails(s.rec);
  if (d) map.flyTo({ center: [d.lng, d.lat], zoom: 3.5, speed: 1.2 });
}

/**
 * 발사 목록이 비었을 때 **왜 비었는지**. 순수 함수 (P18-1).
 *
 * 사이드바 네 탭 중 발사 탭만 빈 상태 문구가 없어 **빈 칸**이 남아 있었다(2026-09-16 실측).
 * 원인이 둘이고 **할 말이 다르다**: 데이터를 못 받은 것(할 수 있는 일은 갱신)과
 * 걸러진 것(할 수 있는 일은 조건 풀기). 둘을 한 문구로 뭉개면 둘 다 틀린 안내가 된다.
 *
 * `total` 은 걸러지기 **전** 건수다 — 0 이면 받은 것이 없다는 뜻이다.
 */
function launchListEmptyNote(total, query) {
  if (!total) {
    return "표시할 발사가 없습니다.<br />데이터를 아직 받지 못했습니다 — 툴바의 <b>↻ 갱신</b>을 눌러보세요.";
  }
  if (query) {
    return `<b>${escapeHtml(query)}</b> 와 맞는 발사가 없습니다.<br />검색어를 지우면 ${total}건이 다시 보입니다.`;
  }
  return `조건에 맞는 발사가 없습니다.<br />툴바의 결과 필터나 타임라인을 확인해 보세요 (전체 ${total}건).`;
}

function renderSidebar(list) {
  if (sidebarTab === "favs") { renderFavList(); return; }  // 관심 탭도 발사 갱신에 따라 바뀐다
  if (sidebarTab !== "launches") return;  // 위성 탭이 열려 있으면 발사 목록으로 덮지 않는다
  const cont = document.getElementById("sidebar-list");
  document.getElementById("sidebar-count").textContent = `${list.length}건`;
  if (!list.length) {
    const q = (document.getElementById("search").value || "").trim();
    cont.innerHTML = `<div class="sb-empty">${launchListEmptyNote(allLaunches.length, q)}</div>`;
    return;
  }
  const upcoming = list.filter((d) => d.outcome === "upcoming")
    .sort((a, b) => new Date(a.net) - new Date(b.net));
  const rest = list.filter((d) => d.outcome !== "upcoming")
    .sort((a, b) => new Date(b.net) - new Date(a.net));
  const ordered = upcoming.concat(rest);
  cont.innerHTML = ordered.slice(0, SIDEBAR_CAP).map((d) => {
    const loc = d.location_name ? " · " + escapeHtml(d.location_name) : "";
    const sub = d.outcome === "upcoming"
      ? escapeHtml(countdown(d.net)) + loc
      : escapeHtml(fmtDate(d.net)) + loc;
    const star = isFavLaunch(d.id) ? "★ " : "";
    return `<button class="sb-row" data-id="${escapeHtml(String(d.id))}">` +
      `<span class="dot d-${d.outcome}"></span>` +
      `<span class="sb-main"><span class="sb-name">${star}${escapeHtml(d.name)}</span>` +
      `<span class="sb-sub">${sub}</span></span></button>`;
  }).join("") +
    (ordered.length > SIDEBAR_CAP
      ? `<div class="sb-empty">…외 ${ordered.length - SIDEBAR_CAP}건. 검색·필터로 좁히거나 타임라인을 당겨 보세요.</div>` : "");
}

function toggleSidebar() {
  const sb = document.getElementById("sidebar");
  const show = sb.classList.contains("hidden");
  sb.classList.toggle("hidden", !show);
  document.getElementById("toggle-list").classList.toggle("active", show);
}
