/* RL3D — 사이드바(발사/위성/관심)와 상세 패널, 통계, 관점 화면. */

// ── 관심 목록 (P11-2) ─────────────────────────────────────────────────────────
function isFavLaunch(id) { return favLaunches.has(String(id)); }
function isFavSat(norad) { return favSats.has(String(norad)); }

function saveFavorites() {
  saveSettings({ favorites: { launches: [...favLaunches], sats: [...favSats] } });
}

/** 관심 토글 후 영향받는 화면을 모두 갱신한다(지도 강조·목록·별 버튼). */
function toggleFavLaunch(id) {
  const k = String(id);
  if (favLaunches.has(k)) favLaunches.delete(k); else favLaunches.add(k);
  saveFavorites();
  applyFilters();  // 지도 강조 + 목록(발사/관심 탭) 반영
  updateFavBtn(isFavLaunch(k));
}

function toggleFavSat(norad) {
  const k = String(norad);
  if (favSats.has(k)) favSats.delete(k); else favSats.add(k);
  saveFavorites();
  updateSatellitePositions();  // 강조가 바로 보이게(다음 초를 기다리지 않음)
  if (sidebarTab === "favs") renderFavList();
  updateFavBtn(isFavSat(k));
}

/** 상세 패널의 ⭐ 버튼 표시 갱신. */
function updateFavBtn(on) {
  const b = document.getElementById("fav-btn");
  if (!b) return;
  b.classList.toggle("active", on);
  b.textContent = on ? "★ 관심" : "☆ 관심";
  b.title = on ? "관심 목록에서 빼기" : "관심 목록에 넣기";
}

/** 상세 패널 헤더의 ⭐ 버튼 HTML. kind: launch | sat */
function favBtnHtml(kind, key) {
  const on = kind === "launch" ? isFavLaunch(key) : isFavSat(key);
  return `<button id="fav-btn" class="fav-btn${on ? " active" : ""}" ` +
    `data-kind="${kind}" data-key="${escapeHtml(String(key))}" ` +
    `title="${on ? "관심 목록에서 빼기" : "관심 목록에 넣기"}">${on ? "★" : "☆"} 관심</button>`;
}

function bindFavBtn(root) {
  const b = root.querySelector("#fav-btn");
  if (!b) return;
  b.addEventListener("click", () => {
    if (b.dataset.kind === "launch") toggleFavLaunch(b.dataset.key);
    else toggleFavSat(b.dataset.key);
  });
}

/** 관심 탭 — 발사와 위성을 함께 보여준다(발사 먼저). */
function renderFavList() {
  const cont = document.getElementById("sidebar-list");
  const countEl = document.getElementById("sidebar-count");
  const favL = allLaunches.filter((d) => isFavLaunch(d.id));
  const favS = satrecs.filter((s) => isFavSat(s.norad));
  countEl.textContent = `${favL.length + favS.length}개`;
  if (!favL.length && !favS.length) {
    // 저장은 돼 있는데 아직 데이터가 안 붙은 경우(위성 레이어 OFF 등)를 구분해 안내
    const pending = favLaunches.size + favSats.size;
    cont.innerHTML = `<div class="sb-empty">${pending
      ? "저장된 관심 항목이 아직 불러오지 않은 데이터입니다.<br />위성 레이어를 켜거나 과거 연도를 불러와 보세요."
      : "관심 항목이 없습니다.<br />상세 패널의 <b>☆ 관심</b>을 눌러 담아두면 여기 모입니다."}</div>`;
    return;
  }
  const launchRows = favL.map((d) =>
    `<button class="sb-row" data-id="${escapeHtml(String(d.id))}">` +
    `<span class="dot d-${d.outcome}"></span>` +
    `<span class="sb-main"><span class="sb-name">★ ${escapeHtml(d.name)}</span>` +
    `<span class="sb-sub">${escapeHtml(d.outcome === "upcoming" ? countdown(d.net) : fmtDate(d.net))}</span>` +
    `</span></button>`).join("");
  const satRows = favS.map((s) =>
    `<button class="sb-row" data-norad="${escapeHtml(String(s.norad))}">` +
    `<span class="dot d-sat"></span>` +
    `<span class="sb-main"><span class="sb-name">★ ${escapeHtml(s.name)}</span>` +
    `<span class="sb-sub">NORAD ${escapeHtml(String(s.norad))}</span></span></button>`).join("");
  cont.innerHTML =
    (launchRows ? `<div class="sb-group">🚀 발사 ${favL.length}</div>` + launchRows : "") +
    (satRows ? `<div class="sb-group">🛰 위성 ${favS.length}</div>` + satRows : "");
}

// ── 발사 목록 사이드바 (P6-4) ─────────────────────────────────────────────────
// 임박한 예정 발사를 위로(오름차순), 지난 발사는 최근 순(내림차순)으로 정렬.
// ── 사이드바 탭 (발사 / 위성) ─────────────────────────────────────────────────
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
    return "관측 위치가 필요합니다.<br />🛰 위성 패널의 <b>관측지 지정</b>을 눌러 지도를 클릭하세요.";
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
    cont.innerHTML = `<div class="sb-empty">${on
      ? "위성을 불러오는 중…"
      : "위성 레이어가 꺼져 있습니다.<br />툴바의 <b>위성</b>을 켜면 목록이 채워집니다."}</div>`;
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

function renderSidebar(list) {
  if (sidebarTab === "favs") { renderFavList(); return; }  // 관심 탭도 발사 갱신에 따라 바뀐다
  if (sidebarTab !== "launches") return;  // 위성 탭이 열려 있으면 발사 목록으로 덮지 않는다
  const cont = document.getElementById("sidebar-list");
  document.getElementById("sidebar-count").textContent = `${list.length}건`;
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

// ── 상세 패널 ─────────────────────────────────────────────────────────────────
function row(k, v) {
  if (!v) return "";
  return `<div class="row"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`;
}

/** 클릭하면 그 대상(발사장·기관·로켓)만의 관점 화면으로 가는 행. */
function entityRow(k, v, kind) {
  if (!v) return "";
  return `<div class="row"><div class="k">${escapeHtml(k)}</div><div class="v">` +
    `<button class="site-link" data-kind="${kind}" data-val="${escapeHtml(v)}">` +
    `${escapeHtml(v)} ›</button></div></div>`;
}

/** 외부 링크는 파이썬 브릿지로 기본 브라우저에서 연다(http/https만 허용됨). */
function openExternal(url) {
  if (!url) return;
  try { window.pywebview.api.open_url(url); } catch (_) { /* 브릿지 없으면 무시 */ }
}

/** 실패/지연 사유처럼 강조가 필요한 긴 텍스트 블록. */
function reasonBlock(label, text, kind) {
  return `<div class="reason reason-${kind}">` +
    `<div class="reason-k">${escapeHtml(label)}</div>` +
    `<div class="reason-v">${escapeHtml(text)}</div></div>`;
}

/** net_precision 이 초 단위가 아니면 카운트다운을 곧이곧대로 믿으면 안 된다. */
const NET_PRECISION_KO = {
  Second: null, Minute: null,        // 확정에 가까움 — 따로 알리지 않음
  Hour: "시각이 시간 단위까지만 확정",
  Day: "날짜만 확정 (시각 미정)",
  Week: "주 단위로만 확정",
  Month: "월 단위로만 확정",
  Quarter: "분기 단위로만 확정",
  Year: "연 단위로만 확정",
};

/** 발사 윈도우가 net 과 다른 구간을 가질 때만 "22:45~00:15 (90분)" 로 보여준다. */
function windowText(d) {
  if (!d.window_start || !d.window_end) return null;
  const s = new Date(d.window_start), e = new Date(d.window_end);
  if (isNaN(s) || isNaN(e) || e <= s) return null;
  const mins = Math.round((e - s) / 60000);
  if (mins < 2) return null;  // 순간 발사(instantaneous)면 net 과 같아 의미 없음
  const hhmm = (dt) => dt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  const dur = mins >= 60 ? `${Math.floor(mins / 60)}시간 ${mins % 60 ? (mins % 60) + "분" : ""}`.trim() : `${mins}분`;
  return `${hhmm(s)} ~ ${hhmm(e)} (${dur})`;
}

/** 중계 링크 버튼들. 클릭 시 파이썬 브릿지로 기본 브라우저에서 연다. */
function vidLinksBlock(d) {
  const vids = d.vid_urls || [];
  if (!vids.length) return "";
  const live = d.webcast_live ? `<span class="live-badge">● 생중계 중</span>` : "";
  const btns = vids.map((v) =>
    `<button class="vid-btn" data-url="${escapeHtml(v.url)}" title="${escapeHtml(v.url)}">` +
    `▶ ${escapeHtml(v.title)}</button>`).join("");
  return `<div class="vid-block"><div class="vid-head">중계 ${live}</div>${btns}</div>`;
}

/** "이 발사대 285번째 · SpaceX 올해 90번째" — 숫자 하나로 맥락이 생긴다. */
function contextText(d) {
  const parts = [];
  if (d.pad_count) parts.push(`이 발사대 ${Number(d.pad_count).toLocaleString()}번째`);
  if (d.agency_year_count) parts.push(`${d.provider || "이 기관"} 올해 ${d.agency_year_count}번째`);
  return parts.length ? parts.join(" · ") : null;
}

function updatesBlock(d) {
  const ups = d.updates || [];
  if (!ups.length) return "";
  const rows = ups.map((u) => {
    const when = u.created_on ? fmtDate(u.created_on) : "";
    const link = u.info_url
      ? `<button class="up-link" data-url="${escapeHtml(u.info_url)}">원문</button>` : "";
    return `<div class="up-row"><div class="up-when">${escapeHtml(when)}${link}</div>` +
           `<div class="up-text">${escapeHtml(u.comment)}</div></div>`;
  }).join("");
  return `<div class="updates"><div class="updates-head">발사 소식</div>${rows}</div>`;
}

function openPanel(d) {
  const panel = document.getElementById("panel");
  const body = document.getElementById("panel-body");
  const cd = d.outcome === "upcoming"
    ? `<div class="cd" data-net="${escapeHtml(d.net)}">${escapeHtml(countdown(d.net))}</div>` : "";
  const precision = NET_PRECISION_KO[d.net_precision];
  const progs = (d.programs || []).map((p) =>
    `<span class="prog-tag">${escapeHtml(p)}</span>`).join("");
  body.innerHTML = `
    ${d.image ? `<img src="${escapeHtml(d.image)}" alt="" onerror="this.remove()" />` : ""}
    <h2>${escapeHtml(d.name)}</h2>
    ${d.patch ? `<img class="patch" src="${escapeHtml(d.patch)}" alt="" onerror="this.remove()" />` : ""}
    <span class="badge m-${d.outcome}">${escapeHtml(tr(STATUS_KO, d.status) || OUTCOME_LABEL[d.outcome])}</span>
    ${favBtnHtml("launch", d.id)}
    ${progs}
    ${cd}
    ${precision ? `<div class="net-precision">⚠ ${escapeHtml(precision)}</div>` : ""}
    ${vidLinksBlock(d)}
    ${d.fail_reason ? reasonBlock("실패 사유", d.fail_reason, "fail") : ""}
    ${d.hold_reason ? reasonBlock("지연·보류 사유", d.hold_reason, "warn") : ""}
    ${d.weather_concerns ? reasonBlock("기상 우려", d.weather_concerns, "warn") : ""}
    ${row("발사 시각", fmtDate(d.net))}
    ${row("발사 윈도우", windowText(d))}
    ${row("발사 확률", d.probability != null && d.probability >= 0 ? d.probability + "%" : null)}
    ${entityRow("로켓", d.rocket, "rocket")}
    ${entityRow("기관", d.provider, "provider")}
    ${row("국가", countryKo(d.provider_country))}
    ${row("미션", d.mission_name)}
    ${row("종류", tr(MISSION_TYPE_KO, d.mission_type))}
    ${row("궤도", tr(ORBIT_KO, d.orbit))}
    ${entityRow("발사장", d.location_name, "site")}
    ${row("패드", d.pad_name)}
    ${row("기록", contextText(d))}
    ${d.mission_desc ? `<div class="mission-desc">${escapeHtml(d.mission_desc)}</div>` : ""}
    ${updatesBlock(d)}
  `;
  // 링크는 파이썬 브릿지로만 연다(창 안에서 열리면 지도로 못 돌아온다)
  body.querySelectorAll(".vid-btn, .up-link").forEach((b) =>
    b.addEventListener("click", () => openExternal(b.dataset.url)));
  body.querySelectorAll(".site-link").forEach((b) =>
    b.addEventListener("click", () => showEntityStats(b.dataset.kind, b.dataset.val)));
  bindFavBtn(body);
  satPanelId = null;  // 발사 상세를 열면 위성 상세 라이브 갱신은 중지
  panel.classList.remove("hidden");
  // 좌표 없는 발사(목록에서 열 수 있음)는 flyTo가 NaN이 되므로 좌표가 있을 때만 이동
  if (typeof d.lng === "number" && typeof d.lat === "number")
    map.flyTo({ center: [d.lng, d.lat], zoom: 4.5, speed: 1.2 });
}

function closePanel() {
  document.getElementById("panel").classList.add("hidden");
  satPanelId = null;
}

// ── 위성 상세 패널 ────────────────────────────────────────────────────────────
/** satrec + 현재 시각으로 위성의 실시간 궤도 값을 계산. */
function satDetails(rec) {
  const now = new Date();
  let pv;
  try { pv = satellite.propagate(rec, now); } catch (_) { return null; }
  if (!pv || !pv.position) return null;
  const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(now));
  const v = pv.velocity;
  return {
    lat: satellite.degreesLat(geo.latitude),
    lng: satellite.degreesLong(geo.longitude),
    alt: geo.height,  // km
    vel: v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : null,  // km/s
    periodMin: rec.no > 0 ? (2 * Math.PI) / rec.no : null,
    incl: rec.inclo != null ? rec.inclo / DEG : null,   // 경사각(deg)
    ecc: rec.ecco,
  };
}

/** 매 초 바뀌는 값만 만든다 — 헤더·⭐ 버튼은 그대로 두고 이 부분만 교체한다. */
function satRowsHtml(s) {
  const d = satDetails(s.rec);
  return d
    ? row("NORAD ID", String(s.norad)) +
      row("고도", d.alt != null ? Math.round(d.alt).toLocaleString() + " km" : null) +
      row("속도", d.vel != null ? d.vel.toFixed(2) + " km/s" : null) +
      row("현재 위치", `${d.lat.toFixed(2)}°, ${d.lng.toFixed(2)}°`) +
      row("궤도 주기", d.periodMin != null ? d.periodMin.toFixed(1) + "분" : null) +
      row("경사각", d.incl != null ? d.incl.toFixed(2) + "°" : null) +
      row("이심률", d.ecc != null ? d.ecc.toFixed(4) : null)
    : `<div class="pass-empty">궤도 정보를 계산할 수 없습니다.</div>`;
}

function openSatPanel(s) {
  satPanelId = s.norad;  // 이 위성이 열려 있는 동안 매 초 값 갱신
  const body = document.getElementById("panel-body");
  body.innerHTML =
    `<h2>🛰 ${escapeHtml(s.name)}</h2>` +
    `<span class="badge m-upcoming">위성</span>` +
    favBtnHtml("sat", s.norad) +
    `<div class="st-note">값은 실시간으로 갱신됩니다.</div>` +
    `<div id="sat-rows">${satRowsHtml(s)}</div>`;
  bindFavBtn(body);
  document.getElementById("panel").classList.remove("hidden");
}

/** 매 초 호출 — 값만 갈아끼운다. 패널 전체를 다시 그리면 ⭐ 버튼 클릭이 씹힌다. */
function refreshSatPanel(s) {
  const el = document.getElementById("sat-rows");
  if (el) el.innerHTML = satRowsHtml(s);
  else openSatPanel(s);
}

// ── 발사 통계 패널 (P8-10) ────────────────────────────────────────────────────
function computeStats(list) {
  const byOutcome = { success: 0, failure: 0, partial: 0, upcoming: 0 };
  const byProvider = {}, byCountry = {}, byYear = {};
  for (const d of list) {
    if (byOutcome[d.outcome] != null) byOutcome[d.outcome]++;
    if (d.provider) byProvider[d.provider] = (byProvider[d.provider] || 0) + 1;
    const c = countryKo(d.provider_country);
    if (c) byCountry[c] = (byCountry[c] || 0) + 1;
    if (d.net) { const y = new Date(d.net).getFullYear(); if (!isNaN(y)) byYear[y] = (byYear[y] || 0) + 1; }
  }
  return { byOutcome, byProvider, byCountry, byYear, total: list.length };
}

/** {키:수} → 가로 막대 HTML. entries는 미리 정렬해 넘긴다. */
/** 패드 이름은 "Space Launch Complex 4E" 처럼 길어 좁은 라벨에서 잘린다 → 통용 약어로. */
const PAD_ABBREV = [
  [/^Space Launch Complex\s*/i, "SLC "],
  [/^Orbital Launch Pad\s*/i, "OLP "],
  [/^Launch Complex\s*/i, "LC "],
  [/^Launch Pad\s*/i, "LP "],
  [/^Launch Area\s*/i, "LA "],
  [/^Launch Vehicle Pad\s*/i, "LVP "],
];

function shortenPad(name) {
  let s = String(name);
  for (const [re, rep] of PAD_ABBREV) {
    if (re.test(s)) return s.replace(re, rep).trim();
  }
  return s;
}

function statBars(entries, color) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return entries.map(([k, v]) =>
    // 축약해도 잘릴 수 있으니 원문은 title 로 남긴다
    `<div class="st-row"><span class="st-k" title="${escapeHtml(String(k))}">${escapeHtml(String(k))}</span>` +
    `<span class="st-bar"><span style="width:${(v / max * 100).toFixed(1)}%;background:${color}"></span></span>` +
    `<span class="st-v">${v}</span></div>`
  ).join("");
}

// ── 관점 화면 (발사장 / 기관 / 로켓) — P10-3, P11-1 ───────────────────────────
// 셋 다 "특정 대상의 발사만 모아 성적을 본다"는 같은 화면이다.
// 뼈대(타일·결과별·예정/최근 목록)는 공유하고 중간 막대 구성만 관점별로 바꾼다.
const ENTITY_VIEWS = {
  site:     { icon: "🛫", field: "location_name" },
  provider: { icon: "🏢", field: "provider" },
  rocket:   { icon: "🚀", field: "rocket" },
};

function countBy(list, pick) {
  const o = {};
  for (const d of list) { const k = pick(d); if (k) o[k] = (o[k] || 0) + 1; }
  return o;
}

const topEntries = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

/** 관점별 막대 구성 → [제목, entries, 색, 최소개수] 목록. 최소개수 미만이면 그 절은 생략. */
function entityBars(kind, list, s) {
  const rockets = () => topEntries(countBy(list, (d) => d.rocket), 6);
  const providers = () => topEntries(countBy(list, (d) => d.provider), 6);
  const sites = () => topEntries(countBy(list, (d) => d.location_name), 6);
  const pads = () => topEntries(countBy(list, (d) => d.pad_name && shortenPad(d.pad_name)), 6);
  const years = () => Object.entries(s.byYear).sort((a, b) => a[0] - b[0]);
  if (kind === "site")
    // 패드가 하나뿐인 발사장에선 "패드별" 막대가 총합과 같아 의미 없다 → 2개 이상일 때만
    return [["주요 로켓", rockets(), "#f472b6"], ["기관", providers(), "#a78bfa"],
            ["패드별", pads(), "#7dd3fc", 2]];
  if (kind === "provider")
    return [["주요 로켓", rockets(), "#f472b6"], ["발사장", sites(), "#7dd3fc"],
            ["연도별", years(), "#34d399"]];
  return [["기관", providers(), "#a78bfa"], ["발사장", sites(), "#7dd3fc"],
          ["연도별", years(), "#34d399"]];
}

/** 발사장·기관·로켓 중 하나를 기준으로 그 대상만의 성적·목록을 낸다. */
function showEntityStats(kind, value) {
  const view = ENTITY_VIEWS[kind];
  if (!view || !value) return;
  const list = allLaunches.filter((d) => d[view.field] === value);
  if (!list.length) return;

  const s = computeStats(list);
  const decided = s.byOutcome.success + s.byOutcome.failure + s.byOutcome.partial;
  const rate = decided ? Math.round(s.byOutcome.success / decided * 100) : null;

  const dated = list.filter((d) => d.net && !isNaN(new Date(d.net)));
  const past = dated.filter((d) => d.outcome !== "upcoming")
    .sort((a, b) => new Date(b.net) - new Date(a.net));
  const upcoming = dated.filter((d) => d.outcome === "upcoming")
    .sort((a, b) => new Date(a.net) - new Date(b.net));
  const span = dated.length
    ? `${tlLabelDate(Math.min(...dated.map((d) => +new Date(d.net))))} ~ ` +
      `${tlLabelDate(Math.max(...dated.map((d) => +new Date(d.net))))}`
    : null;

  const rows = (arr, n) => arr.slice(0, n).map((d) =>
    `<button class="site-row" data-id="${escapeHtml(String(d.id))}">` +
    `<span class="dot d-${d.outcome}"></span>` +
    `<span class="site-row-main"><span class="site-row-name">${escapeHtml(d.name)}</span>` +
    `<span class="site-row-sub">${escapeHtml(d.outcome === "upcoming" ? countdown(d.net) : fmtDate(d.net))}</span>` +
    `</span></button>`).join("");

  const bars = entityBars(kind, list, s)
    .map(([label, entries, color, min]) =>
      entries.length >= (min || 1) ? `<div class="st-sec">${label}</div>` + statBars(entries, color) : "")
    .join("");

  document.getElementById("stats-body").innerHTML =
    `<h2>${view.icon} ${escapeHtml(value)}</h2>` +
    `<div class="st-note">현재 불러온 ${s.total}건 기준 · 과거 연도를 불러오면 더 정확해집니다.` +
      (span ? `<br />${escapeHtml(span)}` : "") + `</div>` +
    `<div class="st-tiles">` +
      `<div class="st-tile"><div class="st-num">${s.total}</div><div class="st-lab">총 발사</div></div>` +
      `<div class="st-tile"><div class="st-num">${rate == null ? "—" : rate + "%"}</div><div class="st-lab">성공률</div></div>` +
      `<div class="st-tile"><div class="st-num">${s.byOutcome.upcoming}</div><div class="st-lab">예정</div></div>` +
    `</div>` +
    `<div class="st-sec">결과별</div>` +
    statBars([["성공", s.byOutcome.success], ["실패", s.byOutcome.failure],
              ["부분 실패", s.byOutcome.partial], ["예정", s.byOutcome.upcoming]], "var(--accent)") +
    bars +
    (upcoming.length ? `<div class="st-sec">예정 발사</div>` + rows(upcoming, 5) : "") +
    (past.length ? `<div class="st-sec">최근 발사</div>` + rows(past, 5) : "");

  const panel = document.getElementById("stats-panel");
  panel.querySelectorAll(".site-row").forEach((b) => b.addEventListener("click", () => {
    const d = findLaunch(b.dataset.id);
    if (d) { panel.classList.add("hidden"); openPanel(d); }
  }));
  panel.classList.remove("hidden");
}

function showStats() {
  const s = computeStats(allLaunches);
  const decided = s.byOutcome.success + s.byOutcome.failure + s.byOutcome.partial;
  const rate = decided ? Math.round(s.byOutcome.success / decided * 100) : null;
  const providers = Object.entries(s.byProvider).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const countries = Object.entries(s.byCountry).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const years = Object.entries(s.byYear).sort((a, b) => a[0] - b[0]);

  document.getElementById("stats-body").innerHTML =
    `<h2>📊 발사 통계</h2>` +
    `<div class="st-note">현재 불러온 ${s.total}건 기준 · 과거 연도를 불러오면 더 정확해집니다.</div>` +
    `<div class="st-tiles">` +
      `<div class="st-tile"><div class="st-num">${s.total}</div><div class="st-lab">총 발사</div></div>` +
      `<div class="st-tile"><div class="st-num">${rate == null ? "—" : rate + "%"}</div><div class="st-lab">성공률</div></div>` +
      `<div class="st-tile"><div class="st-num">${s.byOutcome.upcoming}</div><div class="st-lab">예정</div></div>` +
    `</div>` +
    `<div class="st-sec">결과별</div>` +
    statBars([["성공", s.byOutcome.success], ["실패", s.byOutcome.failure],
              ["부분 실패", s.byOutcome.partial], ["예정", s.byOutcome.upcoming]], "var(--accent)") +
    (years.length ? `<div class="st-sec">연도별</div>` + statBars(years, "#7dd3fc") : "") +
    (providers.length ? `<div class="st-sec">기관 (상위 8)</div>` + statBars(providers, "#a78bfa") : "") +
    (countries.length ? `<div class="st-sec">국가 (상위 8)</div>` + statBars(countries, "#34d399") : "");
  document.getElementById("stats-panel").classList.remove("hidden");
}
