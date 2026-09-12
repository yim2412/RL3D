/* RL3D — 위성 레이어(Celestrak TLE → satellite.js SGP4)와 실시간 위치 갱신.
 *  대역·그룹 필터는 satfilter.js, 궤적·추적은 sattrack.js, 통과 예측은 satpass.js (P12-23 분리). */

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

/** 한 위성의 메타데이터. 없으면 null — 호출부는 항상 null 을 감당해야 한다. */
function satMeta(norad) {
  return (satcat && satcat[String(norad)]) || null;
}

/** 위성 메타데이터(P12-5)를 받아 둔다.
 *
 * 위성 표시와 **분리**한다: TTL 이 24시간이라 갱신 주기가 다르고, 이게 실패해도
 * 위성은 지도에 떠야 한다. 그래서 await 하지 않고 실패도 조용히 넘긴다.
 */
async function loadSatcat() {
  try {
    const res = await window.pywebview.api.get_satcat(satGroups, false);
    satcat = (res && res.satcat) || {};
    // 종류·소유국 목록은 메타가 있어야 만들 수 있다 → 도착한 지금 그린다(P12-5b).
    renderFacetFilters();
    applySatFilter();   // 저장돼 있던 필터가 이제서야 적용될 수 있다
  } catch (_) {
    satcat = satcat || {};   // 실패해도 이전 값을 버리지 않는다
  }
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
    loadSatcat();   // 메타데이터는 따로·늦게 와도 된다(위성 표시를 막지 않는다)
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
