/* RL3D — 발사 데이터 로드·레이어·필터/검색/타임라인·아카이브·툴팁·자동 갱신·속보 티커. */

// ── 발사 데이터 로드 ──────────────────────────────────────────────────────────
async function loadLaunches(force = false, silent = false) {
  const btn = document.getElementById("refresh");
  if (!silent) btn.disabled = true;
  try {
    const prev = launches;  // 변화 감지용 직전 스냅샷
    const res = await window.pywebview.api.get_launches(force);
    launches = res.launches || [];
    rebuildAll();
    if (res.age != null) { lastLaunchLoad = Date.now() - res.age * 1000; updateFreshness(); }
    if (res.error) showStatus(res.stale ? `⚠ ${res.error} (저장된 데이터 표시)` : `⚠ ${res.error}`);
    else if (!silent) showStatus(null);
    recomputeTimeline();  // 아카이브가 붙으면 범위가 과거로 늘어날 수 있어 매번 재계산
    applyFilters();
    startTicker();
    if (silent) announceChanges(prev, launches);  // 자동 갱신 때만 변화 알림
  } catch (e) {
    if (!silent) showStatus("데이터를 불러오지 못했습니다.");
    console.error(e);
  } finally {
    if (!silent) btn.disabled = false;
  }
}

/** 자동 갱신 시 직전↔현재 비교 → 새 발사·상태 변화를 잠깐 알린다. */
function announceChanges(prev, curr) {
  if (!prev || prev.length === 0) return;
  const prevMap = new Map(prev.map((d) => [d.id, d]));
  let added = 0;
  const changed = [];
  for (const d of curr) {
    const old = prevMap.get(d.id);
    if (!old) { added++; continue; }
    // 결과가 확정된 경우(예정→성공/실패)만 의미 있는 변화로 취급
    if (old.outcome !== d.outcome && d.outcome !== "upcoming") changed.push(d);
  }
  const msgs = [];
  if (added > 0) msgs.push(`새 발사 ${added}건 추가`);
  for (const d of changed.slice(0, 2)) {
    msgs.push(`${d.name} → ${tr(STATUS_KO, d.status) || OUTCOME_LABEL[d.outcome]}`);
  }
  if (msgs.length === 0) return;
  showStatus("🔔 " + msgs.join(" · "));
  setTimeout(() => showStatus(null), 8000);
}

// ── 발사 레이어 (GeoJSON 클러스터 + circle) ──────────────────────────────────
// 예정은 밝은 하늘색 + 큰 원으로 강조.
const LAUNCH_COLORS = {
  upcoming: "#7dd3fc", success: "#22c55e", failure: "#ef4444", partial: "#f59e0b",
};
const FAV_COLOR = "#fbbf24";  // 관심 항목 강조(금색) — 발사 마커·위성 점 공통

function setupLaunchLayers() {
  map.addSource("launches", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    cluster: true,
    clusterRadius: 44,
    clusterMaxZoom: 6,  // 이 줌 이상에선 클러스터를 풀어 개별 발사로
  });
  // 클러스터 원 (개수에 따라 크기 단계)
  map.addLayer({
    id: "clusters", type: "circle", source: "launches", filter: ["has", "point_count"],
    paint: {
      "circle-color": "#12314f",
      "circle-stroke-color": "#4da3ff",
      "circle-stroke-width": 1.5,
      "circle-radius": ["step", ["get", "point_count"], 13, 5, 17, 15, 22],
      "circle-opacity": 0.92,
    },
  });
  // 개별 발사 — 예정만 밝은색·큰 원·두꺼운 테두리
  map.addLayer({
    id: "launch-point", type: "circle", source: "launches", filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": ["match", ["get", "outcome"],
        "upcoming", LAUNCH_COLORS.upcoming, "success", LAUNCH_COLORS.success,
        "failure", LAUNCH_COLORS.failure, "partial", LAUNCH_COLORS.partial, "#94a3b8"],
      // 관심 발사(P11-2)는 금색 테두리를 굵게 둘러 색 구분(결과)을 잃지 않고 눈에 띄게 한다
      "circle-radius": ["case",
        ["==", ["get", "fav"], true], 9,
        ["==", ["get", "outcome"], "upcoming"], 8, 5],
      "circle-stroke-width": ["case",
        ["==", ["get", "fav"], true], 3.2,
        ["==", ["get", "outcome"], "upcoming"], 2.5, 1.2],
      "circle-stroke-color": ["case", ["==", ["get", "fav"], true], FAV_COLOR, "#ffffff"],
    },
  });

  // 클러스터 클릭 → 네이티브 확대(뭉친 발사장이 갈라짐)
  map.on("click", "clusters", (e) => {
    if (settingObserver) return;
    const f = e.features[0];
    map.getSource("launches").getClusterExpansionZoom(f.properties.cluster_id)
      .then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: z }))
      .catch(() => {});
  });
  // 개별 발사 클릭 → 상세 패널
  map.on("click", "launch-point", (e) => {
    if (settingObserver) return;
    const id = e.features[0].properties.id;
    const d = findLaunch(id);
    if (d) openPanel(d);
  });
  // 호버 툴팁 + 커서
  map.on("mouseenter", "launch-point", (e) => { map.getCanvas().style.cursor = "pointer"; showLaunchTooltip(e); });
  map.on("mousemove", "launch-point", showLaunchTooltip);
  map.on("mouseleave", "launch-point", () => { map.getCanvas().style.cursor = ""; hideTooltip(); });
  map.on("mouseenter", "clusters", (e) => { map.getCanvas().style.cursor = "pointer"; showClusterTooltip(e); });
  map.on("mousemove", "clusters", showClusterTooltip);
  map.on("mouseleave", "clusters", () => { map.getCanvas().style.cursor = ""; hideTooltip(); });
}

/** 발사 배열 → GeoJSON. 좌표 없는 발사는 제외. 상세는 id로 원본을 되찾는다. */
function launchesToFC(list) {
  return {
    type: "FeatureCollection",
    features: list
      .filter((d) => typeof d.lat === "number" && typeof d.lng === "number")
      .map((d) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [d.lng, d.lat] },
        properties: { id: d.id, outcome: d.outcome, fav: isFavLaunch(d.id) },
      })),
  };
}

// ── 필터 / 검색 / 타임라인 ────────────────────────────────────────────────────
function launchPasses(d, active, q) {
  if (!active.has(d.outcome)) return false;
  if (q) {
    const hay = `${d.name || ""} ${d.rocket || ""} ${d.provider || ""} ${d.mission_name || ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (timelineMax != null && d.net) {
    const t = new Date(d.net).getTime();
    if (!isNaN(t) && t > timelineMax) return false;
  }
  return true;
}

function applyFilters() {
  const active = new Set(
    Array.from(document.querySelectorAll(".flt:checked")).map((c) => c.value)
  );
  const q = document.getElementById("search").value.trim().toLowerCase();
  const filtered = allLaunches.filter((d) => launchPasses(d, active, q));
  const src = map.getSource("launches");
  if (src) src.setData(launchesToFC(filtered));  // 클러스터는 자동 재계산
  renderSidebar(filtered);  // 같은 필터 결과를 좌측 목록에도 반영
}

// ── 마커 호버 툴팁 ────────────────────────────────────────────────────────────
let tooltipEl = null;
function showLaunchTooltip(e) {
  const f = e.features && e.features[0];
  if (!f) return;
  const d = findLaunch(f.properties.id);
  if (!d) return;
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "tooltip";
    document.body.appendChild(tooltipEl);
  }
  const cd = d.outcome === "upcoming" ? ` · ${escapeHtml(countdown(d.net))}` : "";
  tooltipEl.innerHTML = `<b>${escapeHtml(d.name)}</b><br><span class="tt-sub">${escapeHtml(tr(STATUS_KO, d.status) || OUTCOME_LABEL[d.outcome])}${cd}</span>`;
  tooltipEl.style.left = `${e.originalEvent.clientX}px`;
  tooltipEl.style.top = `${e.originalEvent.clientY - 14}px`;
  tooltipEl.style.display = "block";
}
function showClusterTooltip(e) {
  const f = e.features && e.features[0];
  if (!f) return;
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "tooltip";
    document.body.appendChild(tooltipEl);
  }
  tooltipEl.innerHTML = `<b>${f.properties.point_count}건의 발사</b><br><span class="tt-sub">클릭하면 펼쳐집니다</span>`;
  tooltipEl.style.left = `${e.originalEvent.clientX}px`;
  tooltipEl.style.top = `${e.originalEvent.clientY - 14}px`;
  tooltipEl.style.display = "block";
}
function hideTooltip() { if (tooltipEl) tooltipEl.style.display = "none"; }

// ── 타임라인 슬라이더 ─────────────────────────────────────────────────────────
function recomputeTimeline() {
  const times = allLaunches
    .filter((d) => d.net).map((d) => new Date(d.net).getTime()).filter((t) => !isNaN(t));
  if (!times.length) return;
  tlMin = Math.min(...times);
  tlMax = Math.max(...times);
  timelineInited = true;
}

// ── 과거 발사 아카이브 (P7-5) ─────────────────────────────────────────────────
function populateArchiveYears() {
  const sel = document.getElementById("arch-year");
  const cur = new Date().getUTCFullYear();
  for (let y = cur; y >= cur - 4; y--) {  // 최근 5년(올해 포함)
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = y + "년";
    sel.appendChild(opt);
  }
}

async function loadArchive(year) {
  if (loadedYears.has(year)) {
    showStatus(`${year}년은 이미 불러왔습니다.`);
    setTimeout(() => showStatus(null), 3000);
    return;
  }
  const btn = document.getElementById("arch-load");
  btn.disabled = true;
  showStatus(`${year}년 발사 아카이브 불러오는 중… (최초 1회, 수 초 소요)`);
  try {
    const res = await window.pywebview.api.get_archive(year);
    const list = res.launches || [];
    const have = new Set(archiveLaunches.map((d) => d.id));
    for (const d of list) if (!have.has(d.id)) archiveLaunches.push(d);
    loadedYears.add(year);
    if (res.truncated) truncatedYears.add(year); else truncatedYears.delete(year);
    rebuildAll();
    recomputeTimeline();
    applyFilters();
    if (res.error) showStatus(res.stale ? `⚠ ${res.error} (저장된 데이터)` : `⚠ ${res.error}`);
    else if (res.truncated) {
      // 잘린 줄 모르면 "그 해는 이만큼뿐"으로 읽고, 통계의 모수까지 틀어진다(P12-6).
      showStatus(`⚠ ${year}년 ${list.length}건 추가됨 — 연도당 상한에 걸려 일부만 받았습니다`);
      setTimeout(() => showStatus(null), 8000);
    } else {
      showStatus(`${year}년 ${list.length}건 추가됨`);
      setTimeout(() => showStatus(null), 4000);
    }
  } catch (e) {
    showStatus("아카이브를 불러오지 못했습니다.");
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

function tlLabelDate(ms) {
  return new Date(ms).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
}

function onTimeline() {
  const v = +document.getElementById("tl-range").value;
  const label = document.getElementById("tl-label");
  // 최대(100)면 무제한 → 자동 갱신으로 들어온 더 먼 미래 발사도 안 잘림
  if (v >= 100 || tlMin == null) {
    timelineMax = null;
    label.textContent = "전체 기간";
  } else {
    timelineMax = tlMin + (v / 100) * (tlMax - tlMin);
    label.textContent = `${tlLabelDate(timelineMax)} 까지`;
  }
  applyFilters();
}

// ── 발사 자동 갱신 ────────────────────────────────────────────────────────────
function startAutoRefresh() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(() => loadLaunches(false, true), AUTO_REFRESH_MS);
}

// ── 속보 티커 (임박한 예정 발사 + 최근 발사 결과 순환) ────────────────────────
const TICKER_RESULT_MAX = 8;   // 티커에 섞을 최근 결과 개수 상한

/** "3시간 전" / "2일 전" — 티커의 결과 항목이 언제 일인지 알려준다. */
function agoText(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!isFinite(diff)) return "";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/** 예정 2건마다 최근 결과 1건을 끼운다 — 예정이 주(主)이되 결과도 계속 흐르게. */
function buildTickerItems() {
  const now = Date.now();
  const upcoming = launches
    .filter((d) => d.outcome === "upcoming" && d.net && new Date(d.net).getTime() >= now)
    .sort((a, b) => new Date(a.net) - new Date(b.net));
  const recent = launches
    .filter((d) => d.outcome !== "upcoming" && d.net && new Date(d.net).getTime() < now)
    .sort((a, b) => new Date(b.net) - new Date(a.net))
    .slice(0, TICKER_RESULT_MAX);

  const items = [];
  let ri = 0;
  upcoming.forEach((d, i) => {
    items.push({ kind: "upcoming", d });
    if (i % 2 === 1 && ri < recent.length) items.push({ kind: "result", d: recent[ri++] });
  });
  while (ri < recent.length) items.push({ kind: "result", d: recent[ri++] });  // 예정이 적어 남은 결과
  return items;
}

function tickerHtml(item) {
  const d = item.d;
  const where = d.location_name ? ` · ${escapeHtml(d.location_name)}` : "";
  if (item.kind === "upcoming") {
    return `<span class="tk-cd">${escapeHtml(countdown(d.net))}</span> · ${escapeHtml(d.name)}${where}`;
  }
  const label = OUTCOME_LABEL[d.outcome] || d.outcome;
  return `<span class="tk-res tk-${escapeHtml(d.outcome)}">${escapeHtml(label)}</span>` +
         ` · ${escapeHtml(d.name)}${where} · <span class="tk-ago">${escapeHtml(agoText(d.net))}</span>`;
}

function startTicker() {
  if (tickerTimer) clearInterval(tickerTimer);
  const items = buildTickerItems();
  const el = document.getElementById("ticker-text");
  if (items.length === 0) {
    el.textContent = "표시할 발사 정보가 없습니다.";
    return;
  }
  let idx = 0;
  let shown = -1;   // 마지막으로 그린 인덱스 — 결과 항목은 매초 다시 그릴 필요가 없다
  const tick = () => {
    // 카운트다운이 끝난 예정 항목은 건너뛴다(한 바퀴까지만 탐색)
    for (let n = 0; n < items.length; n++) {
      const it = items[idx];
      if (it.kind === "upcoming" && new Date(it.d.net).getTime() < Date.now()) {
        idx = (idx + 1) % items.length;
      } else break;
    }
    const item = items[idx];
    if (item.kind === "upcoming" || idx !== shown) {
      el.innerHTML = tickerHtml(item);
      shown = idx;
    }
    // 패널이 열려있으면 그 카운트다운도 갱신
    const cd = document.querySelector("#panel-body .cd");
    if (cd && cd.dataset.net) cd.textContent = countdown(cd.dataset.net);
  };
  tick();
  let secs = 0;
  tickerTimer = setInterval(() => {
    secs++;
    if (secs % 5 === 0) idx = (idx + 1) % items.length;  // 5초마다 다음 항목
    tick();
  }, 1000);
}
