/* RL3D — 관측 위치·가시 판정·통과 예측·오늘 밤 목록(P6-2·P12-1·P12-2). sats.js 에서 분리(P12-23). */

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

// ── 가시 판정 (P12-1) ─────────────────────────────────────────────────────────
// "기하학적으로 지나간다"와 "실제로 눈에 보인다"는 다르다. visual 그룹의 존재 이유가
// 후자인데 그 판정이 없었다. 두 조건을 함께 봐야 한다:
//   ① 관측자가 어둡다 (해가 졌다)  ② 위성은 아직 햇빛을 받는다 (지구 그림자 밖)
// 태양 위치는 map.js 의 sunEquatorial/gmstHours 를 그대로 쓴다 — 터미네이터(P6-3)가
// 이미 쓰던 계산이라 두 벌 만들지 않는다. index.html 로드 순서상 map.js 가 먼저다.

const EARTH_RADIUS_KM = 6378.137;
// 시민박명 종료. 이보다 태양이 낮으면 하늘이 충분히 어둡다고 본다.
// −12°(항해박명)·−18°(천문박명)로 올릴수록 엄격해지고 통과 수가 줄어든다.
const DARK_SUN_ELEV = -6;

/** 태양 방향 단위벡터(ECI, 지구중심). 거리는 판정에 필요 없어 방향만 쓴다. */
function sunEciUnit(date) {
  const { alpha, delta } = sunEquatorial(julianDay(date));
  const a = alpha * DEG, d = delta * DEG;
  return { x: Math.cos(d) * Math.cos(a), y: Math.cos(d) * Math.sin(a), z: Math.sin(d) };
}

/** 위성이 햇빛을 받는가 — 원통 그림자 근사.
 *
 * 반그림자·대기 굴절은 무시한다(수 초 차이라 "볼 만한 통과" 판단을 바꾸지 않는다).
 * 태양 쪽 반구에 있으면 무조건 조명. 반대쪽이면 태양축에서의 수직거리가 지구
 * 반지름보다 클 때만 조명이다.
 */
function isSunlit(posEci, sunUnit) {
  if (!posEci) return false;
  const dot = posEci.x * sunUnit.x + posEci.y * sunUnit.y + posEci.z * sunUnit.z;
  if (dot >= 0) return true;                       // 태양 쪽 반구
  const r2 = posEci.x * posEci.x + posEci.y * posEci.y + posEci.z * posEci.z;
  const perp = Math.sqrt(Math.max(0, r2 - dot * dot));   // 태양축에서의 수직거리
  return perp > EARTH_RADIUS_KM;
}

/** 관측지에서 본 태양 고도(도). 음수가 클수록 어둡다. */
function observerSunElev(obs, date) {
  const jd = julianDay(date);
  const { alpha, delta } = sunEquatorial(jd);
  const ha = (gmstHours(jd) * 15 + obs.lng - alpha) * DEG;   // 시간각
  const phi = obs.lat * DEG, dec = delta * DEG;
  const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, sinEl))) / DEG;
}

/** 시각별 태양 정보를 미리 계산해 둔다 — 위성마다 다시 구하면 같은 값을 수백 번 만든다.
 *  (2026-09-11 실측: visual 157개 × 24시간 30초 간격 = 전파 45만 회 / 413ms) */
function sunTable(obs, start, end, stepMs) {
  const table = [];
  for (let t = start; t <= end; t += stepMs) {
    const date = new Date(t);
    table.push({ t, unit: sunEciUnit(date), dark: observerSunElev(obs, date) < DARK_SUN_ELEV });
  }
  return table;
}

/** 관측지 기준, 향후 hours시간의 위성 통과(고도>minEl 연속 구간)를 계산.
 *
 * 통과마다 `visible` 을 붙인다(P12-1) — 그 통과 중 **한 순간이라도** 관측자가 어둡고
 * 위성이 햇빛을 받으면 true. 걸러내지 않고 표시만 하는 이유는, 전파 수신·안테나 목적이면
 * 낮 통과도 의미가 있어서다(화면의 체크박스로 사용자가 고른다).
 *
 * sun 을 넘기면 미리 계산한 태양표를 쓴다(P12-2 가 157개 위성에 같은 표를 공유).
 * 안 넘기면 이 함수가 직접 만든다 — 위성 1개짜리 기존 호출부는 고치지 않아도 된다.
 */
function computePasses(rec, obs, hours = 24, stepSec = 30, minEl = 10, sun = null) {
  const observerGd = { latitude: obs.lat * DEG, longitude: obs.lng * DEG, height: 0 };
  const passes = [];
  let cur = null;
  const stepMs = stepSec * 1000;
  const start = Date.now();
  const end = start + hours * 3600 * 1000;
  const table = sun || sunTable(obs, start, end, stepMs);
  let i = 0;
  for (let t = start; t <= end; t += stepMs, i++) {
    const date = new Date(t);
    let pv;
    try { pv = satellite.propagate(rec, date); } catch (_) { continue; }
    if (!pv || !pv.position) continue;
    const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
    const look = satellite.ecfToLookAngles(observerGd, ecf);
    const elDeg = look.elevation / DEG;
    const azDeg = look.azimuth / DEG;
    if (elDeg >= minEl) {
      const sky = table[i];
      // 관측자가 밝으면 조명 판정 자체를 건너뛴다(어차피 안 보인다) — 계산도 아낀다.
      const lit = !!sky && sky.dark && isSunlit(pv.position, sky.unit);
      if (!cur) cur = { start: t, startAz: azDeg, maxEl: elDeg, maxAz: azDeg, visible: lit };
      else if (elDeg > cur.maxEl) { cur.maxEl = elDeg; cur.maxAz = azDeg; }
      if (lit) {
        cur.visible = true;
        if (cur.visStart === undefined) cur.visStart = t;
        cur.visEnd = t;
        if (elDeg > (cur.visMaxEl || -90)) cur.visMaxEl = elDeg;
      }
      cur.end = t; cur.endAz = azDeg;
    } else if (cur) {
      passes.push(cur); cur = null;
    }
  }
  if (cur) passes.push(cur);  // 창 끝에서 진행 중이던 통과도 포함
  return passes;
}

function fmtPassTime(ms) {
  return new Date(ms).toLocaleString("ko-KR", Object.assign({
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }, tzOpts()));
}

/** 통과 1건을 목록 행으로. 가시 통과는 ☀ 로 표시하고 조명 구간 시각을 앞세운다. */
function passRow(p, name) {
  const dir = `${azToCompass(p.startAz)}→${azToCompass(p.endAz)}`;
  const dur = Math.max(1, Math.round((p.end - p.start) / 60000));
  // 가시 통과는 "언제 보이기 시작하는가"가 알고 싶은 값이다 — 통과 시작이 아니라 조명 시작.
  const when = p.visible && p.visStart !== undefined ? p.visStart : p.start;
  const el = p.visible && p.visMaxEl !== undefined ? p.visMaxEl : p.maxEl;
  const mark = p.visible ? `<span class="pass-vis" title="관측자가 어둡고 위성이 햇빛을 받는다">☀</span>` : "";
  const dim = p.visible ? "" : " pass-row-dim";
  return `<div class="pass-row${dim}">` +
    (name ? `<div class="pass-name">${escapeHtml(name)}</div>` : "") +
    `<div class="pass-time">${mark}${escapeHtml(fmtPassTime(when))}</div>` +
    `<div class="pass-meta">${escapeHtml(dir)} · 최대고도 ${Math.round(el)}° · ${dur}분</div>` +
    `</div>`;
}

function visibleOnly() {
  const el = document.getElementById("toggle-visible-only");
  return el ? el.checked : true;
}

function showPasses() {
  if (!selectedSat || !observer) return;
  const all = computePasses(selectedSat.rec, observer);
  const onlyVis = visibleOnly();
  const passes = onlyVis ? all.filter((p) => p.visible) : all;
  const panel = document.getElementById("pass-panel");
  const body = document.getElementById("pass-body");
  const head =
    `<h2>🛰 ${escapeHtml(selectedSat.name)} 통과 예측</h2>` +
    `<div class="pass-obs">관측지 ${observer.lat.toFixed(3)}, ${observer.lng.toFixed(3)} · 향후 24시간 · 최대고도 10° 이상` +
    (onlyVis ? ` · <b>눈에 보이는 것만</b>` : "") + `</div>`;
  if (passes.length === 0) {
    // 빈 이유를 구분해 알려준다 — "계산이 안 된 것"과 "조건에 안 맞는 것"은 다르다.
    const why = onlyVis && all.length > 0
      ? `통과는 ${all.length}건 있지만 <b>눈에 보이는 것은 없습니다</b>(낮이거나 위성이 지구 그림자 안).`
      : "예측된 통과가 없습니다.";
    body.innerHTML = head + `<div class="pass-empty">${why}</div>`;
  } else {
    body.innerHTML = head + passes.map((p) => passRow(p, null)).join("");
  }
  panel.classList.remove("hidden");
}

// ── 오늘 밤 볼 만한 통과 (P12-2) ──────────────────────────────────────────────
// 지금까지는 위성을 **1개 골라야** 통과를 볼 수 있었다 — 무엇을 고를지 모르면 못 쓴다.
// 관심 위성 + visual 그룹을 한 번에 훑어 최대고도 순으로 세운다.
const TONIGHT_HOURS = 24;

/** 훑을 대상: 관심 위성(전부) + visual 그룹. norad 로 중복 제거. */
function tonightTargets() {
  const seen = new Set();
  const out = [];
  for (const r of satrecs) {
    const isFav = favSats && favSats.includes(r.norad);
    // visual 그룹 여부는 로드된 satrecs 만으로 알 수 없다 → 관심 위성은 항상,
    // 나머지는 현재 로드된 것 전부를 본다(그룹 선택이 곧 사용자의 관심 범위다).
    if (!isFav && !r.rec) continue;
    if (seen.has(r.norad)) continue;
    seen.add(r.norad);
    out.push(r);
  }
  return out;
}

function computeTonight(obs, hours = TONIGHT_HOURS, stepSec = 30) {
  const start = Date.now(), end = start + hours * 3600 * 1000;
  const table = sunTable(obs, start, end, stepSec * 1000);
  const rows = [];
  for (const r of tonightTargets()) {
    let passes;
    try { passes = computePasses(r.rec, obs, hours, stepSec, 10, table); } catch (_) { continue; }
    for (const p of passes) {
      if (p.visible) rows.push({ name: r.name, norad: r.norad, pass: p });
    }
  }
  // 최대고도 순 — "가장 높이 뜨는 것"이 가장 잘 보이는 것이다.
  rows.sort((a, b) => (b.pass.visMaxEl || b.pass.maxEl) - (a.pass.visMaxEl || a.pass.maxEl));
  return rows;
}
