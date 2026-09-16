/* RL3D — 사이드바(발사/위성/관심 탭)와 목록 렌더. panels.js 에서 분리(P14-4). */

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
  const rows = computeTonight(observer);
  countEl.textContent = `${rows.length}건`;
  if (!rows.length) {
    // 조건을 못 채운 것이지 고장이 아니다 — 기준을 함께 보여준다.
    cont.innerHTML = `<div class="sb-empty">향후 24시간 안에 <b>눈에 보이는 통과가 없습니다.</b><br />` +
      `(관측지가 어둡고 = 태양고도 −6° 미만, 위성이 햇빛을 받는 통과만 셉니다)</div>`;
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
  cont.innerHTML = list.slice(0, 400).map((s) =>
    `<button class="sb-row" data-norad="${escapeHtml(String(s.norad))}">` +
    `<span class="dot d-sat"></span>` +
    `<span class="sb-main"><span class="sb-name">${escapeHtml(s.name)}</span>` +
    `<span class="sb-sub">NORAD ${escapeHtml(String(s.norad))} · ${bandLabel(s.band)}</span></span></button>`).join("") +
    (list.length > 400 ? `<div class="sb-empty">…외 ${list.length - 400}개. 검색으로 좁혀보세요.</div>` : "");
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
  cont.innerHTML = upcoming.concat(rest).map((d) => {
    const loc = d.location_name ? " · " + escapeHtml(d.location_name) : "";
    const sub = d.outcome === "upcoming"
      ? escapeHtml(countdown(d.net)) + loc
      : escapeHtml(fmtDate(d.net)) + loc;
    const star = isFavLaunch(d.id) ? "★ " : "";
    return `<button class="sb-row" data-id="${escapeHtml(String(d.id))}">` +
      `<span class="dot d-${d.outcome}"></span>` +
      `<span class="sb-main"><span class="sb-name">${star}${escapeHtml(d.name)}</span>` +
      `<span class="sb-sub">${sub}</span></span></button>`;
  }).join("");
}

function toggleSidebar() {
  const sb = document.getElementById("sidebar");
  const show = sb.classList.contains("hidden");
  sb.classList.toggle("hidden", !show);
  document.getElementById("toggle-list").classList.toggle("active", show);
}
