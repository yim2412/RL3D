/* RL3D — 궤도 대역 분류, 위성 레이어와 실시간 위치, 지상궤적·추적, 통과 예측, 그룹 선택 UI. */

// ── 궤도 대역 분류 (P11-3) ────────────────────────────────────────────────────
// 실시간 고도(P10-5의 색)가 아니라 평균운동에서 얻은 **평균 고도**로 나눈다.
// 전파(propagate) 없이 즉시 구할 수 있고, 타원 궤도도 한 대역에 안정적으로 머문다.
const BANDS = [
  { key: "leo", label: "저궤도 LEO", short: "LEO", note: "~2,000km" },
  { key: "meo", label: "중궤도 MEO", short: "MEO", note: "~35,000km" },
  { key: "geo", label: "정지궤도 GEO", short: "GEO", note: "35,000km~" },
];

function orbitBand(rec) {
  const n = rec && rec.no > 0 ? rec.no / 60 : 0;   // rad/min → rad/s
  if (!n || !isFinite(n)) return "leo";            // 값이 이상하면 다수인 LEO 로
  const a = Math.cbrt(398600.4418 / (n * n));      // 반장축(km)
  const alt = a - 6371;
  if (alt < 2000) return "leo";
  return alt < 35000 ? "meo" : "geo";
}

function bandLabel(key) {
  const b = BANDS.find((x) => x.key === key);
  return b ? b.short : "";
}

/** 대역 필터를 통과하는 위성만. 지도·목록이 같은 기준을 쓰게 한 곳에 둔다.
 *  관심 위성은 필터와 무관하게 남긴다 — 관심 탭에서 골랐는데 지도에 점이 없으면 고장으로 보인다. */
function visibleSats() {
  return satrecs.filter((s) => satBands[s.band] !== false || isFavSat(s.norad));
}

// ── 위성 (Celestrak TLE → satellite.js SGP4 실시간 위치) ──────────────────────
function setupSatelliteLayer() {
  // 지상궤적선 — 위성 소스보다 먼저 추가해 위성 점이 선 위에 렌더되게.
  map.addSource("sat-track", { type: "geojson", data: EMPTY_FC });
  map.addLayer({
    id: "sat-track-line",
    type: "line",
    source: "sat-track",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#7dd3fc", "line-width": 1.6, "line-opacity": 0.75 },
  });

  map.addSource("satellites", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "sat-layer",
    type: "circle",
    source: "satellites",
    layout: { visibility: "none" },  // 기본 OFF — 발사 지도에 집중, 필요 시 토글
    paint: {
      "circle-radius": ["case", ["==", ["get", "fav"], true], 5.5, 2.8],  // 관심 위성은 크게(P11-2)
      // 고도(km)로 색을 나눈다 — LEO(하늘색) → MEO(보라) → GEO(주황).
      // 점 하나하나가 어느 궤도 대역인지 눈으로 구분된다.
      "circle-color": [
        "interpolate", ["linear"], ["coalesce", ["get", "alt"], 500],
        300, "#7dd3fc",     // 저궤도 — ISS·Starlink 대역
        2000, "#a78bfa",    // 중궤도 진입
        20000, "#f472b6",   // GPS·Galileo 대역
        35786, "#fbbf24",   // 정지궤도
      ],
      "circle-opacity": 0.9,
      "circle-stroke-width": ["case", ["==", ["get", "fav"], true], 2, 0.6],
      "circle-stroke-color": ["case", ["==", ["get", "fav"], true], FAV_COLOR, "#9fb0ff"],
    },
  });
  // 넓은 투명 클릭 영역 — 위성 점이 작고 계속 움직여 클릭이 빗나가지 않게(보이지 않음)
  map.addLayer({
    id: "sat-hit",
    type: "circle",
    source: "satellites",
    layout: { visibility: "none" },
    paint: { "circle-radius": 10, "circle-color": "#000000", "circle-opacity": 0 },
  });
  // 위성 클릭 → 상세 정보 패널 + 선택(지상궤적 표시)
  map.on("click", "sat-hit", (e) => {
    if (settingObserver) return;  // 관측 위치 지정 중엔 선택하지 않음
    const f = e.features && e.features[0];
    if (!f) return;
    const s = satrecs.find((x) => String(x.norad) === String(f.properties.norad));
    if (s) { selectSatellite(s); openSatPanel(s); }
  });
  // 커서: 손 모양 대신 십자(정확한 조준) — 작은 위성 점을 겨냥하기 쉽게
  map.on("mouseenter", "sat-hit", () => { map.getCanvas().style.cursor = "crosshair"; });
  map.on("mouseleave", "sat-hit", () => { map.getCanvas().style.cursor = ""; });

  // 사용자가 지도를 직접 드래그하면 추적 모드 자동 해제(easeTo는 dragstart를 발생시키지 않음)
  map.on("dragstart", () => { if (tracking) { tracking = false; updateSatCtrl(); } });
  // 관측 위치 지정 모드일 때만 지도 클릭을 소비
  map.on("click", onMapClickForObserver);
}

// ── 지상궤적선 + 추적 모드 (P6-1) ─────────────────────────────────────────────
/** 선택 위성의 지상궤적(약 1주기)을 1분 간격으로 계산해 MultiLineString Feature로.
 *  날짜변경선(±180°) 통과 지점에서 선을 끊어 지도를 가로지르는 가짜 선을 막는다. */
function computeGroundTrack(rec) {
  // 평균운동(rad/min)에서 주기 산출. 비정상값이면 LEO 기본 90분으로 대체.
  let periodMin = (rec.no && rec.no > 0) ? (2 * Math.PI) / rec.no : 90;
  if (!isFinite(periodMin) || periodMin <= 0 || periodMin > 24 * 60) periodMin = 90;
  const half = periodMin / 2;
  const segments = [];
  let cur = [];
  let prevLng = null;
  for (let dm = -half; dm <= half; dm += 1) {
    const t = new Date(Date.now() + dm * 60000);
    let pv;
    try { pv = satellite.propagate(rec, t); } catch (_) { continue; }
    if (!pv || !pv.position) continue;
    const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
    const lng = satellite.degreesLong(geo.longitude);
    const lat = satellite.degreesLat(geo.latitude);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    if (prevLng != null && Math.abs(lng - prevLng) > 180) {
      if (cur.length > 1) segments.push(cur);  // 날짜변경선 통과 → 세그먼트 분리
      cur = [];
    }
    cur.push([lng, lat]);
    prevLng = lng;
  }
  if (cur.length > 1) segments.push(cur);
  return { type: "Feature", geometry: { type: "MultiLineString", coordinates: segments }, properties: {} };
}

function drawGroundTrack() {
  const src = map.getSource("sat-track");
  if (!src) return;
  src.setData(selectedSat ? computeGroundTrack(selectedSat.rec) : EMPTY_FC);
}

function selectSatellite(s) {
  selectedSat = s;
  drawGroundTrack();
  // 궤적은 지구 자전으로 서서히 이동 → 30초마다 재계산해 신선도 유지
  if (trackTimer) clearInterval(trackTimer);
  trackTimer = setInterval(drawGroundTrack, 30000);
  updateSatCtrl();
}

function deselectSatellite() {
  selectedSat = null;
  tracking = false;
  if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
  const src = map.getSource("sat-track");
  if (src) src.setData(EMPTY_FC);
  document.getElementById("sat-ctrl").classList.add("hidden");
  document.getElementById("pass-panel").classList.add("hidden");  // 통과 예측은 위성 종속
  if (satPanelId != null) {  // 위성 상세 패널이 이 위성 것이면 닫는다
    document.getElementById("panel").classList.add("hidden");
    satPanelId = null;
  }
}

/** 선택 위성 컨트롤 박스(이름·추적 버튼) 상태 갱신 + 표시. */
function updateSatCtrl() {
  const box = document.getElementById("sat-ctrl");
  if (!selectedSat) { box.classList.add("hidden"); return; }
  document.getElementById("sat-ctrl-name").textContent = "🛰 " + selectedSat.name;
  const btn = document.getElementById("sat-track-btn");
  btn.textContent = tracking ? "추적 중지" : "추적";
  btn.classList.toggle("active", tracking);
  document.getElementById("sat-obs-btn").classList.toggle("active", !!observer);
  document.getElementById("sat-pass-btn").disabled = !observer;  // 관측지 없으면 예측 불가
  box.classList.remove("hidden");
}

function toggleTracking() {
  if (!selectedSat) return;
  tracking = !tracking;
  updateSatCtrl();
  if (tracking) centerOnSelected();
}

/** 선택 위성의 현재 위치로 지도 중심을 부드럽게 이동. */
function centerOnSelected() {
  if (!selectedSat) return;
  const now = new Date();
  let pv;
  try { pv = satellite.propagate(selectedSat.rec, now); } catch (_) { return; }
  if (!pv || !pv.position) return;
  const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(now));
  const lng = satellite.degreesLong(geo.longitude);
  const lat = satellite.degreesLat(geo.latitude);
  if (!isFinite(lng) || !isFinite(lat)) return;
  map.easeTo({ center: [lng, lat], duration: 950 });
}

// ── 관측 위치 + 통과 예측 (P6-2) ──────────────────────────────────────────────
const DIRS8 = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
function azToCompass(azDeg) {
  return DIRS8[Math.round((((azDeg % 360) + 360) % 360) / 45) % 8];
}

function showObserverMarker() {
  if (!observer) return;
  if (!observerMarker) {
    const el = document.createElement("div");
    el.className = "obs-marker";
    el.textContent = "📍";
    observerMarker = new maplibregl.Marker({ element: el, anchor: "bottom" });
  }
  observerMarker.setLngLat([observer.lng, observer.lat]).addTo(map);
}

/** "지도를 클릭해 관측 위치 지정" 모드 진입. 다음 지도 클릭이 위치를 확정한다. */
function beginSetObserver() {
  settingObserver = true;
  map.getCanvas().style.cursor = "crosshair";
  showStatus("지도를 클릭해 관측 위치를 지정하세요");
}

function onMapClickForObserver(e) {
  if (!settingObserver) return;
  observer = { lat: +e.lngLat.lat.toFixed(4), lng: +e.lngLat.lng.toFixed(4) };
  saveSettings({ observer });  // settings.json에 저장(P8-9)
  showObserverMarker();
  settingObserver = false;
  map.getCanvas().style.cursor = "";
  showStatus(null);
  updateSatCtrl();  // 통과 예측 버튼 활성화
}

/** 관측지 기준, 향후 hours시간의 위성 통과(고도>minEl 연속 구간)를 계산. */
function computePasses(rec, obs, hours = 24, stepSec = 30, minEl = 10) {
  const observerGd = { latitude: obs.lat * DEG, longitude: obs.lng * DEG, height: 0 };
  const passes = [];
  let cur = null;
  const start = Date.now();
  const end = start + hours * 3600 * 1000;
  for (let t = start; t <= end; t += stepSec * 1000) {
    const date = new Date(t);
    let pv;
    try { pv = satellite.propagate(rec, date); } catch (_) { continue; }
    if (!pv || !pv.position) continue;
    const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
    const look = satellite.ecfToLookAngles(observerGd, ecf);
    const elDeg = look.elevation / DEG;
    const azDeg = look.azimuth / DEG;
    if (elDeg >= minEl) {
      if (!cur) cur = { start: t, startAz: azDeg, maxEl: elDeg, maxAz: azDeg };
      else if (elDeg > cur.maxEl) { cur.maxEl = elDeg; cur.maxAz = azDeg; }
      cur.end = t; cur.endAz = azDeg;
    } else if (cur) {
      passes.push(cur); cur = null;
    }
  }
  if (cur) passes.push(cur);  // 창 끝에서 진행 중이던 통과도 포함
  return passes;
}

function fmtPassTime(ms) {
  return new Date(ms).toLocaleString("ko-KR", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function showPasses() {
  if (!selectedSat || !observer) return;
  const passes = computePasses(selectedSat.rec, observer);
  const panel = document.getElementById("pass-panel");
  const body = document.getElementById("pass-body");
  const head =
    `<h2>🛰 ${escapeHtml(selectedSat.name)} 통과 예측</h2>` +
    `<div class="pass-obs">관측지 ${observer.lat.toFixed(3)}, ${observer.lng.toFixed(3)} · 향후 24시간 · 최대고도 10° 이상</div>`;
  if (passes.length === 0) {
    body.innerHTML = head + `<div class="pass-empty">예측된 통과가 없습니다.</div>`;
  } else {
    body.innerHTML = head + passes.map((p) => {
      const dir = `${azToCompass(p.startAz)}→${azToCompass(p.endAz)}`;
      const dur = Math.max(1, Math.round((p.end - p.start) / 60000));
      return `<div class="pass-row">` +
        `<div class="pass-time">${escapeHtml(fmtPassTime(p.start))}</div>` +
        `<div class="pass-meta">${escapeHtml(dir)} · 최대고도 ${Math.round(p.maxEl)}° · ${dur}분</div>` +
        `</div>`;
    }).join("");
  }
  panel.classList.remove("hidden");
}

async function loadSatellites() {
  try {
    deselectSatellite();  // 재로드로 satrec이 갈리므로 이전 선택/궤적은 해제
    const res = await window.pywebview.api.get_satellites(false, satGroups);
    const sats = res.satellites || [];
    // TLE → SGP4 레코드. 파싱 실패한 위성 1개가 전체를 막지 않게 개별 try.
    satrecs = [];
    for (const s of sats) {
      try {
        const rec = satellite.twoline2satrec(s.tle1, s.tle2);
        if (rec && !rec.error) satrecs.push({ name: s.name, norad: s.norad_id, rec, band: orbitBand(rec) });
      } catch (_) { /* 이 위성만 건너뜀 */ }
    }
    updateSatCount();
    if (sidebarTab === "sats") renderSatList();  // 목록 탭이 열려 있으면 즉시 반영
    else if (sidebarTab === "favs") renderFavList();  // 관심 위성이 이제 붙는다
    if (res.error && !res.stale) showStatus(`⚠ 위성: ${res.error}`);
    // 토글이 켜져 있을 때만 계산 루프 시작(기본 OFF)
    if (document.getElementById("toggle-sat").checked) startSatelliteLoop();
  } catch (e) {
    console.error("위성 로드 실패", e);
  }
}

/** 모든 위성의 현재 위경도/고도를 계산해 GeoJSON 으로 지도에 반영. */
function updateSatellitePositions() {
  if (!map.getSource("satellites")) return;
  const now = new Date();
  const gmst = satellite.gstime(now);
  const features = [];
  for (const s of visibleSats()) {
    let pv;
    try { pv = satellite.propagate(s.rec, now); } catch (_) { continue; }
    const eci = pv && pv.position;
    if (!eci) continue;  // 전파 실패(궤도 붕괴/에폭 이탈 등)
    const geo = satellite.eciToGeodetic(eci, gmst);
    const lng = satellite.degreesLong(geo.longitude);
    const lat = satellite.degreesLat(geo.latitude);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        name: s.name, norad: s.norad, alt: Math.round(geo.height), fav: isFavSat(s.norad),
      },
    });
  }
  map.getSource("satellites").setData({ type: "FeatureCollection", features });
  if (tracking && selectedSat) centerOnSelected();  // 추적 모드: 매 초 지도 중심 갱신
  // 상세 패널이 열려 있으면 고도·속도·위치를 실시간 갱신
  if (satPanelId && selectedSat && String(selectedSat.norad) === String(satPanelId)
      && !document.getElementById("panel").classList.contains("hidden")) {
    refreshSatPanel(selectedSat);
  }
}

function startSatelliteLoop() {
  if (satTimer) clearInterval(satTimer);
  updateSatellitePositions();
  satTimer = setInterval(updateSatellitePositions, 1000);
}

function setSatelliteVisible(on) {
  if (!map.getLayer("sat-layer")) return;
  const vis = on ? "visible" : "none";
  map.setLayoutProperty("sat-layer", "visibility", vis);
  map.setLayoutProperty("sat-hit", "visibility", vis);  // 클릭 영역도 함께 토글
  if (sidebarTab === "sats") renderSatList();           // 목록 탭의 안내 문구도 함께 갱신
  else if (sidebarTab === "favs") renderFavList();
  if (on) {
    if (satrecs.length === 0) loadSatellites();  // 첫 켜기 때 lazy 로드
    else if (!satTimer) startSatelliteLoop();
  } else {
    deselectSatellite();  // 레이어를 끄면 선택/궤적/추적도 함께 해제
    if (satTimer) {
      clearInterval(satTimer);
      satTimer = null;  // 숨김 상태에선 계산도 멈춰 자원 절약
    }
  }
}

// ── 위성 그룹 선택 UI (P7-6) ──────────────────────────────────────────────────
async function initSatGroups() {
  try {
    const cat = await window.pywebview.api.get_satellite_groups();
    const box = document.getElementById("sat-groups");
    box.innerHTML = (cat || []).map((g) => {
      const checked = satGroups.includes(g.key) ? "checked" : "";
      const cap = g.cap ? ` <span class="muted">(최대 ${g.cap})</span>` : "";
      return `<label><input type="checkbox" class="satg" value="${escapeHtml(g.key)}" ${checked}/> ${escapeHtml(g.label)}${cap}</label>`;
    }).join("")
      // 궤도 대역 필터(P11-3) — 그룹은 "무엇을 받을지", 대역은 "받은 것 중 무엇을 볼지"
      + `<div class="satg-sec">궤도 대역</div>`
      + BANDS.map((b) =>
        `<label><input type="checkbox" class="satb" value="${b.key}" ${satBands[b.key] !== false ? "checked" : ""}/> ` +
        `${escapeHtml(b.label)} <span class="muted">${escapeHtml(b.note)}</span></label>`).join("");
    box.querySelectorAll(".satg").forEach((c) => c.addEventListener("change", onSatGroupChange));
    box.querySelectorAll(".satb").forEach((c) => c.addEventListener("change", onSatBandChange));
  } catch (e) { console.error("위성 그룹 로드 실패", e); }
}

function onSatGroupChange() {
  satGroups = Array.from(document.querySelectorAll(".satg:checked")).map((c) => c.value);
  const enabled = document.getElementById("toggle-sat").checked;
  saveSettings({ satellites: { enabled, groups: satGroups, bands: satBands } });
  if (enabled) { satrecs = []; loadSatellites(); }  // 그룹이 바뀌었으니 재로드
}

/** 대역 필터 변경 — 재로드 없이 즉시 반영(이미 받아둔 TLE만 걸러낸다). */
function onSatBandChange() {
  BANDS.forEach((b) => { satBands[b.key] = false; });
  document.querySelectorAll(".satb:checked").forEach((c) => { satBands[c.value] = true; });
  saveSettings({
    satellites: { enabled: document.getElementById("toggle-sat").checked, groups: satGroups, bands: satBands },
  });
  // 선택 위성이 필터 밖으로 나가면 궤적선만 지도에 남으므로 함께 해제
  if (selectedSat && satBands[selectedSat.band] === false && !isFavSat(selectedSat.norad)) deselectSatellite();
  updateSatCount();
  if (satTimer) updateSatellitePositions();  // 다음 초를 기다리지 않고 바로 반영
  if (sidebarTab === "sats") renderSatList();
  else if (sidebarTab === "favs") renderFavList();
}

/** 툴바 위성 개수 — 대역 필터가 걸려 있으면 "보이는 수/전체" 로 보여준다. */
function updateSatCount() {
  const el = document.getElementById("sat-count");
  if (!el) return;
  if (!satrecs.length) { el.textContent = ""; return; }
  const shown = visibleSats().length;
  el.textContent = shown === satrecs.length ? `(${shown})` : `(${shown}/${satrecs.length})`;
}

function toggleSatGroups() {
  document.getElementById("sat-groups").classList.toggle("hidden");
}
