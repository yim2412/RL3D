/* RL3D — 이벤트 바인딩과 pywebviewready 부트스트랩. 실행 진입점이라 마지막에 로드된다. */

/**
 * 배선 한 줄 (P23-1). 예전에는 `document.getElementById("x").addEventListener(...)` 를
 * 27줄 늘어놓았는데, **하나가 던지면 나머지 26줄과 `initMap()` 까지 안 돌았다** —
 * 지도가 아예 안 뜨는데 화면에도 로그에도 아무 말이 없었다.
 * 요소가 없으면 그 사실을 로그로 남기고 다음 줄로 간다. 그래서 `index.html` 과
 * `tests/harness.js` 의 목록이 어긋난 것도 여기서 드러난다.
 */
function wire(id, ev, fn) {
  const node = document.getElementById(id);
  if (!node) {
    reportError("배선", "요소를 찾지 못했습니다: #" + id + " (" + ev + ")");
    return false;
  }
  try {
    node.addEventListener(ev, fn);
    return true;
  } catch (e) {
    reportStepError("배선 #" + id + " (" + ev + ")", e);
    return false;
  }
}

/** `wire()` 로 안 되는 한 덩어리(선택자 루프·document 배선 등)를 감싼다. */
function step(label, fn) {
  try {
    return fn();
  } catch (e) {
    reportStepError(label, e);
    return undefined;
  }
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function bindUI() {
  wire("search", "input", applyFilters);
  step("결과 필터(.flt)", () => {
    document.querySelectorAll(".flt").forEach((c) => c.addEventListener("change", () => {
      applyFilters();
      saveSettings({ filters: currentFilters() });
    }));
  });
  wire("panel-close", "click", closePanel);
  wire("toggle-terminator", "change", (e) => {
    updateTerminator();
    saveSettings({ terminator: e.target.checked });
  });
  wire("toggle-sat", "change", (e) => {
    setSatelliteVisible(e.target.checked);
    saveSatSettings();   // 저장 모양은 sats.js 한 곳에만 둔다
  });
  wire("toggle-heat", "change", (e) => {
    setHeatVisible(e.target.checked);
    saveSettings({ heatmap: e.target.checked });
  });
  wire("sat-groups-btn", "click", toggleSatGroups);
  wire("more-btn", "click", () => toggleToolbarMore());
  wire("tz-btn", "click", toggleTimeZone);
  wire("basemap-btn", "click", toggleBasemap);
  wire("stats-btn", "click", showStats);
  wire("stats-close", "click", () =>
    document.getElementById("stats-panel").classList.add("hidden"));
  wire("sat-track-btn", "click", toggleTracking);
  wire("sat-obs-btn", "click", toggleObsPopover);
  wire("sat-pass-btn", "click", showPasses);
  wire("sat-ctrl-close", "click", deselectSatellite);
  wire("sat-ahead", "input", onTrackAhead);
  wire("pass-close", "click", () =>
    document.getElementById("pass-panel").classList.add("hidden"));
  wire("toggle-list", "click", toggleSidebar);
  wire("sidebar-list", "click", (e) => {
    const rowEl = e.target.closest(".sb-row");
    if (!rowEl) return;
    if (rowEl.dataset.norad) { pickSatellite(rowEl.dataset.norad); return; }
    const d = findLaunch(rowEl.dataset.id);
    if (d) openPanel(d);
  });
  wire("tab-launches", "click", () => setSidebarTab("launches"));
  wire("tab-sats", "click", () => setSidebarTab("sats"));
  wire("tab-favs", "click", () => setSidebarTab("favs"));
  wire("tab-tonight", "click", () => setSidebarTab("tonight"));
  // 가시 전용 토글(P12-1) — 열려 있는 통과 패널을 즉시 다시 그리고, 오늘 밤 탭도 갱신한다.
  wire("toggle-visible-only", "change", (e) => {
    saveSettings({ visibleOnly: e.target.checked });
    if (!document.getElementById("pass-panel").classList.contains("hidden")) showPasses();
    if (sidebarTab === "tonight") renderTonightList();
  });
  wire("sat-search", "input", renderSatList);
  // 끄는 동안(input)은 지도만, 놓을 때(change)는 목록까지 — P20-3
  wire("tl-range", "input", () => onTimeline(true));
  wire("tl-range", "change", () => onTimeline(false));
  step("populateArchiveYears", populateArchiveYears);
  wire("arch-load", "click", () =>
    loadArchive(+document.getElementById("arch-year").value));
  wire("refresh", "click", forceRefresh);
  step("bindUpdateBadge", bindUpdateBadge);   // 새 버전 배지(P12-12)
  // 단축키(P12-14) — 판정은 keys.js 의 순수 함수가 한다
  step("keydown", () => document.addEventListener("keydown", handleKey));
}

/** 버튼과 단축키가 같은 경로를 타게 한다(둘이 갈라지면 한쪽만 고치게 된다). */
function forceRefresh() {
  showStatus("강제 갱신 중… (시간당 요청 제한에 주의)");
  loadLaunches(true);
  if (document.getElementById("toggle-sat").checked) loadSatellites();
}

// pywebview 브릿지가 준비된 뒤 시작.
// **각 단계를 감싼다**(P23-1) — 예전에는 try 가 하나도 없어서 첫 단계가 던지면
// 마지막 `initMap()` 까지 통째로 안 돌았다. 지도만은 무슨 일이 있어도 뜨게 한다.
window.addEventListener("pywebviewready", async () => {
  step("bindUI", bindUI);
  flushErrorQueue();   // 브릿지가 생겼으니 그 전에 난 오류를 이제 내보낸다
  const settings = await window.pywebview.api.get_settings().catch(() => null);
  step("applySettings", () => applySettings(settings));   // 필터·토글·그룹·관측 위치 복원(지도 초기화 전)
  step("shouldShowFirstRun", () => { firstRun = shouldShowFirstRun(settings); });  // 첫 실행 안내(P17-4)
  try {
    await initSatGroups();       // 그룹 체크박스를 satGroups 기준으로 생성
  } catch (e) {
    reportStepError("initSatGroups", e);
  }
  step("updateFreshness", () => setInterval(updateFreshness, 30000));  // "N분 전 갱신"(P7-7)
  step("initUpdateCheck", initUpdateCheck);    // 새 버전 확인(P12-12) — await 하지 않는다
  step("startUpdateRecheck", startUpdateRecheck);  // 켜 둔 채로도 알아채게(P19-3)
  step("initMap", initMap);
});
