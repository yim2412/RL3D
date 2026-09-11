/* RL3D — settings.json 저장/복원과 마지막 갱신 시각 표시. */

// ── 마지막 갱신 시각 (P7-7) ───────────────────────────────────────────────────
function updateFreshness() {
  const el = document.getElementById("freshness");
  if (!el) return;
  if (lastLaunchLoad == null) { el.textContent = ""; return; }
  const mins = Math.floor((Date.now() - lastLaunchLoad) / 60000);
  el.textContent = "🕒 " + (mins <= 0 ? "방금 갱신" : `${mins}분 전 갱신`);
}

// ── 설정 저장/복원 (P8-9) ─────────────────────────────────────────────────────
function saveSettings(patch) {
  try { window.pywebview.api.save_settings(patch); } catch (_) { /* 저장 실패는 무시 */ }
}

function currentFilters() {
  const o = {};
  document.querySelectorAll(".flt").forEach((c) => { o[c.value] = c.checked; });
  return o;
}

/** 저장된 설정을 UI 상태로 반영(지도 초기화 전에 호출). */
function applySettings(s) {
  if (!s) return;
  if (s.filters) {
    document.querySelectorAll(".flt").forEach((c) => {
      if (s.filters[c.value] != null) c.checked = !!s.filters[c.value];
    });
  }
  if (typeof s.terminator === "boolean") document.getElementById("toggle-terminator").checked = s.terminator;
  if (typeof s.visibleOnly === "boolean") document.getElementById("toggle-visible-only").checked = s.visibleOnly;
  if (s.satellites) {
    if (Array.isArray(s.satellites.groups) && s.satellites.groups.length) satGroups = s.satellites.groups;
    if (s.satellites.enabled) document.getElementById("toggle-sat").checked = true;
    // 종류·소유국은 **끈 것만** 저장된다 → 없으면 전부 켜진 상태가 된다(P12-5b).
    // 대역처럼 "전부 꺼진 설정"을 걱정하지 않아도 되는 모양이라 방어가 따로 필요 없다.
    if (s.satellites.typesOff && typeof s.satellites.typesOff === "object") {
      satTypesOff = { ...s.satellites.typesOff };
    }
    if (s.satellites.ownersOff && typeof s.satellites.ownersOff === "object") {
      satOwnersOff = { ...s.satellites.ownersOff };
    }
    const b = s.satellites.bands;
    // 전부 꺼진 설정이 저장돼 있으면 위성이 하나도 안 보여 앱이 고장난 것처럼 된다 → 무시
    if (b && BANDS.some((x) => b[x.key])) {
      BANDS.forEach((x) => { satBands[x.key] = b[x.key] !== false; });
    }
  }
  if (s.observer && typeof s.observer.lat === "number" && typeof s.observer.lng === "number") {
    observer = s.observer;
  }
  if (s.basemap === "satellite" || s.basemap === "dark") setBasemap(s.basemap);
  const cam = s.camera;
  if (cam && typeof cam.lng === "number" && typeof cam.lat === "number"
      && typeof cam.zoom === "number" && isFinite(cam.lng) && isFinite(cam.lat)) {
    savedCamera = { lng: cam.lng, lat: cam.lat, zoom: Math.min(Math.max(cam.zoom, 0), 20) };
  }
  if (s.favorites) {
    if (Array.isArray(s.favorites.launches)) favLaunches = new Set(s.favorites.launches.map(String));
    if (Array.isArray(s.favorites.sats)) favSats = new Set(s.favorites.sats.map(String));
  }
}
