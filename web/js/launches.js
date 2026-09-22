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
    // 첫 실행 안내(P17-4)는 **건수를 말해야 하므로** 데이터가 들어온 뒤에 띄운다.
    // 한 번 띄우면 플래그를 내린다 — 강제 갱신·자동 갱신마다 다시 뜨면 안내가 아니라 방해다.
    if (firstRun) { firstRun = false; showFirstRun(); }
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
    const [lng, lat] = f.geometry.coordinates;
    // **확대해도 안 갈라지는 무리가 있다**(P23-2). 통째로 한 좌표면 확대는 아무 일도
    // 하지 않으므로 바로 목록을 연다 — 예전에는 여기서 무한히 확대만 됐다.
    if (!clusterSplits(allLaunches, lat, lng, f.properties.point_count)) {
      openPadList(lat, lng);
      return;
    }
    map.getSource("launches").getClusterExpansionZoom(f.properties.cluster_id)
      .then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: z }))
      .catch(() => {});
  });
  // 개별 발사 클릭 → 상세 패널
  map.on("click", "launch-point", (e) => {
    if (settingObserver) return;
    const id = e.features[0].properties.id;
    const d = findLaunch(id);
    // 같은 좌표에 여러 건이면 상세가 아니라 **목록**을 연다(P23-2) — 예전에는
    // 맨 위 하나만 열리고 나머지 85건은 지도에서 열 길이 없었다.
    if (d) openLaunchAt(d);
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
    // 범례는 **지금 보이는 것**을 센다 — 통계 패널과 같은 문장을 쓰면 안 된다(P24-2).
    scopeNoteHtml(sc, "shown", (allLaunches || []).length);
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

/**
 * 필터 결과를 지도와 목록에 반영한다.
 *
 * `opts.countOnly` 면 **목록 행을 다시 그리지 않고 건수만** 고친다 — 슬라이더를 끄는
 * 동안 쓰는 싼 경로(P20-3). 2026-09-17 실측(아카이브 5년 1,801건), 한 틱 기준:
 * 지도 갱신 **0.69ms** vs 목록 다시 그리기 **7.7ms + DOM 12.3ms**. 끄는 동안 사람이 보는
 * 것은 지도인데 비용의 **97%** 를 목록이 쓰고 있었다. 빼면 **22ms → 0.7ms** 로,
 * 이 PC 의 240Hz 프레임 예산(4.17ms) 안에 든다.
 *
 * ⚠ `opts` 로 **이벤트 객체가 들어올 수 있다** — `search` 의 `input` 에 이 함수가 그대로
 * 걸려 있다. 그래서 `opts.countOnly === true` 로만 판정한다(Event 에는 그 필드가 없어
 * 자동으로 전체 렌더가 된다). `if (opts)` 로 갈랐다면 검색이 조용히 목록을 안 그렸을 것이다.
 */
/**
 * 지금 화면 조건(결과 필터·검색어·타임라인)을 통과하는 발사 — **한 경로만 둔다**(P24-2).
 *
 * 통계 패널이 *"지금 지도에는 N건만 보입니다"* 라고 말하려면 이 수가 필요한데,
 * 지도 소스를 세면 안 된다 — 히트맵을 켜면 다른 레이어를 세게 되고, 좌표 없는 발사도
 * 빠져 사이드바와 어긋난다. **같은 함수를 다시 태우는 것**이 두 화면이 갈라지지 않는
 * 유일한 방법이다(전에는 이 필터가 `applyFilters` 안에 인라인으로만 있었다).
 */
function currentFilteredLaunches() {
  const active = new Set(
    Array.from(document.querySelectorAll(".flt:checked")).map((c) => c.value)
  );
  const q = document.getElementById("search").value.trim().toLowerCase();
  return allLaunches.filter((d) => launchPasses(d, active, q));
}

function applyFilters(opts) {
  const countOnly = !!(opts && opts.countOnly === true);
  const filtered = currentFilteredLaunches();
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
  // **속보 띠는 필터를 받지 않는다**(P24-3) — `buildTickerItems` 는 라이브 목록을 읽는다.
  // 그 자체는 설계지만, 필터를 걸어 지도에 13건만 남았는데 속보가 성공 발사를 흘리면
  // 화면 둘이 서로 다른 말을 하는 것처럼 보인다. **그럴 때만 그렇다고 말한다.**
  updateTickerScope(filtered.length);
  if (countOnly) setLaunchCount(filtered.length);
  else renderSidebar(filtered);  // 같은 필터 결과를 좌측 목록에도 반영
  // 열어 둔 상세가 이 결과에서 빠졌으면 그 사실을 말한다(P25-1). 지도 점선도 여기서 정리한다.
  updatePanelScope(filtered);
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
  // 이 점에 몇 건이 포개져 있는지 **먼저 말한다**(P23-2). 안 말하면 나머지가
  // 있다는 것 자체를 알 수 없다 — 화면상 1건과 86건이 똑같이 생겼다.
  const stacked = launchesAtPoint(allLaunches, d.lat, d.lng).length;
  const more = stacked > 1
    ? `<br><span class="tt-sub">이 지점 ${stacked}건 · 클릭하면 목록</span>` : "";
  tooltipEl.innerHTML = `<b>${escapeHtml(d.name)}</b><br><span class="tt-sub">${escapeHtml(tr(STATUS_KO, d.status) || OUTCOME_LABEL[d.outcome])}${cd}</span>${more}`;
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
  // ⚠ 예전 문구 "클릭하면 펼쳐집니다"는 **동일 좌표 무리에서 거짓말**이었다(P23-2).
  // 확대해도 안 갈라지는 무리가 실제로 있다(실측: 한 점에 최대 86건).
  const [clng, clat] = f.geometry.coordinates;
  const splits = clusterSplits(allLaunches, clat, clng, f.properties.point_count);
  tooltipEl.innerHTML = `<b>${f.properties.point_count}건의 발사</b><br>`
    + `<span class="tt-sub">${splits ? "클릭하면 펼쳐집니다" : "같은 지점 · 클릭하면 목록"}</span>`;
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
  const f = dateFormatter(
    Object.assign({ year: "numeric", month: "long", day: "numeric" }, tzOpts()));
  return f ? f.format(new Date(ms)) : "";
}

/**
 * 슬라이더가 움직일 때(P12-16). `dragging` 이면 목록을 건드리지 않는다 — `input` 은
 * 끄는 내내(240Hz 화면이면 최대 초당 240회) 나는데, 목록은 놓고 나서 읽는 것이다.
 * 놓을 때 나는 `change` 가 목록을 한 번 맞춘다.
 */
function onTimeline(dragging) {
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
  applyFilters(dragging === true ? { countOnly: true } : undefined);
}

// ── 발사 자동 갱신 ────────────────────────────────────────────────────────────
/**
 * 주기 갱신(P7-7 · P19-1).
 *
 * **위성도 같은 주기에 태운다.** 전에는 발사만 다시 받아, 켜 둔 시간만큼 TLE 이 늙었다 —
 * 캐시 TTL 2시간이 있어도 **앱이 요청을 안 하면 TTL 은 할 일이 없다**. 실제 호출은
 * 파이썬 캐시가 막으므로 요청은 **+0.5회/시간**, 재파싱 비용은 **194ms/5분**(실측)이다.
 */
function startAutoRefresh() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(() => {
    loadLaunches(false, true);
    // 레이어가 꺼져 있으면 부르지 않는다 — 안 보이는 것을 위해 쓸 예산이 없다
    if (document.getElementById("toggle-sat").checked) loadSatellites(true);
    tickTonightFreshness();   // 지나간 통과 줄 정리(P19-2) — 계산 없이 시각 비교만
  }, AUTO_REFRESH_MS);
}

// ── 속보 티커 (임박한 예정 발사 + 최근 발사 결과 순환) ────────────────────────
const TICKER_RESULT_MAX = 8;   // 티커에 섞을 최근 결과 개수 상한

/**
 * "3시간 전" / "2일 전" / "3.2년 전" — 티커의 결과 항목이 언제 일인지 알려준다.
 *
 * **연 단위는 P15-7 에서 붙였다.** 정보 갱신 시각에 같이 쓰는데, 실측 예정 발사에
 * **1,164일 전** 갱신된 것이 있었다(H3-24 · 예정일이 `12-31` 인 자리표시자). 날짜 수로는
 * 안 읽힌다. 티커는 최근 결과만 다뤄 이 가지에 닿지 않는다.
 */
function agoText(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!isFinite(diff)) return "";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}일 전`;
  return `${(days / 365).toFixed(1)}년 전`;
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

/**
 * 속보 띠 옆의 "전체 기준" 표시 — 필터가 좁히고 있을 때만 보인다 (P24-3).
 * `shown` 은 지금 화면에 보이는 발사 수. 판정은 `filterNarrows` 한 곳에만 둔다.
 */
function updateTickerScope(shown) {
  const el = document.getElementById("ticker-scope");
  if (!el) return false;
  const narrowed = filterNarrows((allLaunches || []).length, shown);
  el.classList.toggle("hidden", !narrowed);
  return narrowed;
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

// ── 한 점에 포개진 발사들 (P23-2) ────────────────────────────────────────────
// **클러스터를 풀어도 안 갈라지는 점이 있다.** 실측(2026-09-18, 실제 캐시 437건):
// 서로 다른 발사장 좌표는 **55개**뿐이고, `(34.632, -120.611)` 한 점에 **86건** ·
// 다음이 85건 · **425건(97%)** 이 겹치는 점 위에 있다. `clusterMaxZoom: 6` 이라
// 줌 7 이상에서 클러스터가 풀리는데 좌표가 **동일**하므로 갈라지지 않고 전부 같은
// 픽셀에 그려진다 — 클릭하면 `e.features[0]` 하나만 열리고 나머지 85건은
// **지도에서 열 길이 없었다.** 히트맵(P12-15)은 "몇 번"만 답하고 "그게 뭔지"는 답하지 않는다.
//
// 좌표 하나는 사실상 발사대 하나다(실측: 55곳 중 54곳이 pad 1개) — 그래서 이 목록의
// 이름이 "발사대"다.

/** 지도 좌표를 묶는 자릿수. 마커는 이 자리까지 같으면 같은 픽셀에 그려진다. */
const PAD_COORD_DIGITS = 4;

/** 좌표 키 — 순수 함수. 클러스터 판정과 목록이 **같은 기준**을 써야 한다. */
function coordKey(lat, lng) {
  if (!validLatLng(lat, lng)) return null;
  return Number(lat).toFixed(PAD_COORD_DIGITS) + "," + Number(lng).toFixed(PAD_COORD_DIGITS);
}

/**
 * 그 점에 있는 발사들 — 순수 함수. 예정은 가까운 순, 지난 것은 최근 순
 * (사이드바와 같은 정렬이라 두 목록이 서로 다른 말을 하지 않는다).
 */
function launchesAtPoint(list, lat, lng) {
  const key = coordKey(lat, lng);
  if (!key) return [];
  const hit = (list || []).filter((d) => coordKey(d.lat, d.lng) === key);
  const upcoming = hit.filter((d) => d.outcome === "upcoming")
    .sort((a, b) => new Date(a.net) - new Date(b.net));
  const rest = hit.filter((d) => d.outcome !== "upcoming")
    .sort((a, b) => new Date(b.net) - new Date(a.net));
  return upcoming.concat(rest);
}

/**
 * 이 클러스터는 확대해도 갈라지는가 — 순수 함수.
 *
 * 클러스터가 **통째로 한 좌표**면 `getClusterExpansionZoom` 이 갈라 줄 것이 없다.
 * 그때 "클릭하면 펼쳐집니다"라고 말하면 **거짓말**이고(P18 갈래), 확대는 아무 일도
 * 하지 않는다. 클러스터 좌표에 있는 발사 수가 `point_count` 와 같으면 전부 한 점이다.
 */
function clusterSplits(list, lat, lng, pointCount) {
  return launchesAtPoint(list, lat, lng).length < pointCount;
}

/**
 * 발사명에서 **미션 쪽만** — 순수 함수 (P23-2).
 *
 * LL2 의 `name` 은 `<로켓> | <미션>` 꼴이다(실측 441/441 = 100%). 이 목록은 한 발사대의
 * 발사만 모은 것이라 로켓이 거의 늘 같고, 이름과 아래 줄에 **로켓이 두 번** 찍혔다:
 *   `Falcon 9 Block 5 | Dragon CRS-2 SpX-35` / `T-42일 · Falcon 9 Block 5`
 * 각 함수를 따로 재는 단언은 전부 통과했고 **실제 캐시로 렌더해 읽고서야 보였다**
 * (CLAUDE.md: 합쳐진 문장이 앞뒤가 안 맞을 수 있다).
 *
 * 로켓을 아래 줄에 남기는 이유: 이름의 로켓과 `rocket` 이 **다른 경우가 7%** 있고
 * (`Starship | Flight 13` 대 `Starship V3`), 그때는 변형 이름이 새 정보다.
 */
function missionTitle(name) {
  const s = String(name || "");
  const cut = s.indexOf(" | ");
  return cut === -1 ? s : s.slice(cut + 3);
}

/** 목록 한 줄 — 사이드바 행과 같은 모양을 쓴다(두 곳이 다르게 생기면 같은 것으로 안 읽힌다). */
function padRowHtml(d) {
  const sub = d.outcome === "upcoming"
    ? escapeHtml(countdown(d.net)) : escapeHtml(fmtDate(d.net));
  const star = isFavLaunch(d.id) ? "★ " : "";
  return `<button class="sb-row pad-row" data-id="${escapeHtml(String(d.id))}">` +
    `<span class="dot d-${d.outcome}"></span>` +
    `<span class="sb-main"><span class="sb-name">${star}${escapeHtml(missionTitle(d.name))}</span>` +
    `<span class="sb-sub">${sub} · ${escapeHtml(d.rocket || "")}</span></span></button>`;
}

/** 목록 화면의 HTML — 순수 함수라 문자열로 직접 잰다. */
function padListHtml(rows) {
  if (!rows.length) return `<div class="sb-empty">이 지점의 발사를 찾지 못했습니다.</div>`;
  const first = rows[0];
  const pad = first.pad_name ? escapeHtml(first.pad_name) : "발사대";
  const site = first.location_name ? `<div class="pad-site">${escapeHtml(first.location_name)}</div>` : "";
  const up = rows.filter((d) => d.outcome === "upcoming").length;
  const note = up ? ` · 예정 ${up}건` : "";
  return `<h2>🛫 ${pad}</h2>${site}` +
    `<div class="pad-count">이 지점에 포개진 발사 <b>${rows.length}건</b>${note}` +
    ` — 지도에서는 한 점으로 겹칩니다</div>` +
    `<div class="pad-list">${rows.map(padRowHtml).join("")}</div>`;
}

/**
 * 한 점에 포개진 발사 목록을 상세 패널 자리에 연다.
 * 행을 누르면 그 발사의 상세로 넘어간다(같은 패널을 갈아 끼운다).
 */
function openPadList(lat, lng) {
  const rows = launchesAtPoint(allLaunches, lat, lng);
  const panel = document.getElementById("panel");
  const body = document.getElementById("panel-body");
  if (!panel || !body) return 0;
  body.innerHTML = padListHtml(rows);
  panel.classList.remove("hidden");
  panelLaunchId = null;   // 상세가 아니라 목록이다 — 카운트다운 갱신이 엉뚱한 걸 집지 않게
  body.querySelectorAll(".pad-row").forEach((b) =>
    b.addEventListener("click", () => {
      const d = findLaunch(b.dataset.id);
      if (d) openPanel(d);
    }));
  return rows.length;
}

/**
 * 지도에서 발사 하나를 집었을 때 — 혼자면 상세, 포개져 있으면 목록.
 * **1건일 때의 동작은 예전 그대로다**(회귀를 만들지 않는다).
 */
function openLaunchAt(d) {
  const rows = launchesAtPoint(allLaunches, d.lat, d.lng);
  if (rows.length > 1) return openPadList(d.lat, d.lng);
  openPanel(d);
  return 1;
}
