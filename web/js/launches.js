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

// ── 발사 밀도 히트맵 (P12-15) ────────────────────────────────────────────────
// 마커·클러스터는 "어디서 몇 번"을 못 보여준다 — 클러스터는 줌에 따라 뭉치는 기준이 바뀌고,
// 개별 점은 같은 발사장에 완전히 겹쳐 1건과 300건이 똑같이 보인다.
//
// **소스를 따로 판다.** 기존 "launches" 소스는 cluster:true 라, 히트맵을 그 위에 얹으면
// 클러스터 하나가 점 하나로 세어져 밀도가 통째로 왜곡된다 — 오류 없이 조용히 틀리는 모양이다.

/** 지도에 찍을 수 있는 발사인가. 마커·히트맵·범례가 **같은 술어**를 써야
 *  "지도에 3개인데 범례는 4건"이 안 생긴다. */
function hasCoords(d) {
  return !!d && typeof d.lat === "number" && typeof d.lng === "number";
}

/** 발사 배열 → 히트맵용 GeoJSON(클러스터 없음). 좌표 없는 발사는 제외. 순수 함수. */
function launchesToHeatFC(list) {
  return {
    type: "FeatureCollection",
    features: (list || [])
      .filter(hasCoords)
      .map((d) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [d.lng, d.lat] },
        properties: {},
      })),
  };
}

function setupHeatLayer() {
  map.addSource("launch-heat", { type: "geojson", data: EMPTY_FC });
  map.addLayer({
    id: "launch-heat", type: "heatmap", source: "launch-heat",
    layout: { visibility: heatOn ? "visible" : "none" },
    paint: {
      // 발사 1건 = 1. 발사장이 겹친 만큼 자연히 쌓인다(가중치를 따로 주지 않는다).
      // 가중치는 데이터에 맞춰 applyFilters 가 매번 다시 잡는다(heatScale). 여기 값은 초기치.
      "heatmap-weight": 1,
      // **줌에 따라 바꾸지 않는다.** 강도가 줌마다 달라지면 같은 색이 줌마다 다른 건수를
      // 뜻하게 되어 범례의 "1건 ~ N건" 눈금이 거짓말이 된다.
      "heatmap-intensity": 1,
      // 저줌에서 반경이 작으면 발사장마다 작은 과녁이 되어 밀도 차가 안 읽힌다(2026-09-12 캡처).
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 14, 4, 26, 9, 36],
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(0,0,0,0)",        // 다크 배경에 묻히게 완전 투명에서 시작
        0.2, "rgba(37,99,235,0.55)",
        0.4, "rgba(14,165,233,0.7)",
        0.6, "rgba(34,197,94,0.78)",
        0.8, "rgba(250,204,21,0.85)",
        1, "rgba(239,68,68,0.9)"],
      // 고줌에선 개별 마커가 이미 정확하다 → 히트맵을 물려 마커를 가리지 않게 한다.
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.9, 9, 0.35],
    },
  });
}

/**
 * 히트맵 색 눈금 — **가장 붐비는 발사장이 색의 끝**이 되게 가중치를 맞춘다. 순수 함수.
 *
 * 가중치를 1 로 고정하면 점 하나로 이미 색이 포화해 **1건짜리와 30건짜리가 똑같이 빨강**이 된다
 * (2026-09-12 캡처에서 실제로 그랬다 — 예외도 없고 히트맵은 멀쩡히 그려진다).
 * 좌표는 소수 2자리(≈1km)로 묶는다: 같은 발사장의 패드끼리 갈라지면 건수가 쪼개진다.
 */
// MapLibre 히트맵 커널이 점마다 얹는 값은 weight 가 아니라 `weight × 이 계수`다
// (heatmap.vertex.glsl 의 GAUSS_COEF = 1/√(2π)). 이걸 빼면 최다 발사장이 램프의 40% 에서
// 멈춰 색이 끝까지 안 간다 — 2026-09-12 캡처에서 21건짜리가 파랑이었다.
const HEAT_GAUSS_COEF = 0.3989422804014327;

function heatScale(list) {
  const counts = new Map();
  let max = 0;
  for (const d of (list || []).filter(hasCoords)) {
    const k = `${d.lng.toFixed(2)},${d.lat.toFixed(2)}`;
    const n = (counts.get(k) || 0) + 1;
    counts.set(k, n);
    if (n > max) max = n;
  }
  return { max, weight: max > 0 ? 1 / (max * HEAT_GAUSS_COEF) : 1 };
}

/** 히트맵을 켜면 클러스터 원을 반투명하게 낮춘다.
 *  **숨기지 않는다** — 클러스터를 숨기면 그 안에 든 발사는 개별 점으로도 안 나오므로
 *  저줌에서 클릭할 대상이 통째로 사라진다(클러스터 소스의 성질). */
const CLUSTER_OPACITY = { on: 0.3, off: 0.92 };

function setHeatVisible(on) {
  heatOn = !!on;
  if (!map || !map.getLayer("launch-heat")) return;
  map.setLayoutProperty("launch-heat", "visibility", heatOn ? "visible" : "none");
  map.setPaintProperty("clusters", "circle-opacity", heatOn ? CLUSTER_OPACITY.on : CLUSTER_OPACITY.off);
  map.setPaintProperty("clusters", "circle-stroke-opacity", heatOn ? 0.45 : 1);
  applyFilters();   // 켠 순간 소스를 채우고 범례를 그린다
}

/** 범례 — 색 눈금과 **무엇을 세고 있는지**(모수).
 *  아카이브 없이 켜면 라이브 100건만 그려지는데 히트맵은 그걸 "여기가 발사 중심"으로
 *  보여준다. 통계 패널(P12-7)과 같은 조용한 거짓말이라 같은 모수 문구를 재사용한다. */
function renderHeatLegend(list, scale) {
  const el = document.getElementById("heat-legend");
  if (!el) return;
  el.classList.toggle("hidden", !heatOn);
  if (!heatOn) return;
  // **지도에 실제로 찍힌 것만** 센다 — 좌표 없는 발사까지 세면 범례 자체가 거짓말이 된다.
  const plotted = (list || []).filter(hasCoords);
  const sc = statsScope(plotted, completeYears(), new Date().getFullYear());
  const max = (scale && scale.max) || 0;
  // 눈금을 건수로 적는다 — "적음/많음"은 아무 말도 안 한 것과 같다.
  const ends = max > 1 ? `<span>1건</span><span>한 발사장 최다 ${max}건</span>`
                       : `<span>적음</span><span>많음</span>`;
  el.innerHTML =
    `<div class="hl-title">🔥 발사 밀도</div>` +
    `<div class="hl-bar"></div>` +
    `<div class="hl-ends">${ends}</div>` +
    scopeNoteHtml(sc);
}

/** 발사 배열 → GeoJSON. 좌표 없는 발사는 제외. 상세는 id로 원본을 되찾는다. */
function launchesToFC(list) {
  return {
    type: "FeatureCollection",
    features: list
      .filter(hasCoords)
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
  // 히트맵도 **같은** filtered 로 채운다 — 갈라지면 한 지도의 두 표현이 서로 다른 말을 한다.
  const hsrc = map.getSource("launch-heat");
  if (hsrc) hsrc.setData(heatOn ? launchesToHeatFC(filtered) : EMPTY_FC);
  // 색 눈금은 지금 보고 있는 집합에 맞춰 다시 잡는다(필터·아카이브로 최다 건수가 바뀐다).
  const scale = heatOn ? heatScale(filtered) : null;
  if (scale && map.getLayer && map.getLayer("launch-heat")) {
    map.setPaintProperty("launch-heat", "heatmap-weight", scale.weight);
  }
  renderHeatLegend(filtered, scale);
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
