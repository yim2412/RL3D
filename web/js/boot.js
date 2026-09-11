/* RL3D — 이벤트 바인딩과 pywebviewready 부트스트랩. 실행 진입점이라 마지막에 로드된다. */

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function bindUI() {
  document.getElementById("search").addEventListener("input", applyFilters);
  document.querySelectorAll(".flt").forEach((c) => c.addEventListener("change", () => {
    applyFilters();
    saveSettings({ filters: currentFilters() });
  }));
  document.getElementById("panel-close").addEventListener("click", closePanel);
  document.getElementById("toggle-terminator").addEventListener("change", (e) => {
    updateTerminator();
    saveSettings({ terminator: e.target.checked });
  });
  document.getElementById("toggle-sat").addEventListener("change", (e) => {
    setSatelliteVisible(e.target.checked);
    saveSatSettings();   // 저장 모양은 sats.js 한 곳에만 둔다
  });
  document.getElementById("sat-groups-btn").addEventListener("click", toggleSatGroups);
  document.getElementById("basemap-btn").addEventListener("click", toggleBasemap);
  document.getElementById("stats-btn").addEventListener("click", showStats);
  document.getElementById("stats-close").addEventListener("click", () =>
    document.getElementById("stats-panel").classList.add("hidden"));
  document.getElementById("sat-track-btn").addEventListener("click", toggleTracking);
  document.getElementById("sat-obs-btn").addEventListener("click", beginSetObserver);
  document.getElementById("sat-pass-btn").addEventListener("click", showPasses);
  document.getElementById("sat-ctrl-close").addEventListener("click", deselectSatellite);
  document.getElementById("pass-close").addEventListener("click", () =>
    document.getElementById("pass-panel").classList.add("hidden"));
  document.getElementById("toggle-list").addEventListener("click", toggleSidebar);
  document.getElementById("sidebar-list").addEventListener("click", (e) => {
    const rowEl = e.target.closest(".sb-row");
    if (!rowEl) return;
    if (rowEl.dataset.norad) { pickSatellite(rowEl.dataset.norad); return; }
    const d = findLaunch(rowEl.dataset.id);
    if (d) openPanel(d);
  });
  document.getElementById("tab-launches").addEventListener("click", () => setSidebarTab("launches"));
  document.getElementById("tab-sats").addEventListener("click", () => setSidebarTab("sats"));
  document.getElementById("tab-favs").addEventListener("click", () => setSidebarTab("favs"));
  document.getElementById("tab-tonight").addEventListener("click", () => setSidebarTab("tonight"));
  // 가시 전용 토글(P12-1) — 열려 있는 통과 패널을 즉시 다시 그리고, 오늘 밤 탭도 갱신한다.
  document.getElementById("toggle-visible-only").addEventListener("change", (e) => {
    saveSettings({ visibleOnly: e.target.checked });
    if (!document.getElementById("pass-panel").classList.contains("hidden")) showPasses();
    if (sidebarTab === "tonight") renderTonightList();
  });
  document.getElementById("sat-search").addEventListener("input", renderSatList);
  document.getElementById("tl-range").addEventListener("input", onTimeline);
  populateArchiveYears();
  document.getElementById("arch-load").addEventListener("click", () =>
    loadArchive(+document.getElementById("arch-year").value));
  document.getElementById("refresh").addEventListener("click", () => {
    showStatus("강제 갱신 중… (시간당 요청 제한에 주의)");
    loadLaunches(true);
    if (document.getElementById("toggle-sat").checked) loadSatellites();
  });
}

// pywebview 브릿지가 준비된 뒤 시작
window.addEventListener("pywebviewready", async () => {
  bindUI();
  const settings = await window.pywebview.api.get_settings().catch(() => null);
  applySettings(settings);       // 필터·토글·그룹·관측 위치 복원(지도 초기화 전)
  await initSatGroups();         // 그룹 체크박스를 satGroups 기준으로 생성
  setInterval(updateFreshness, 30000);  // "N분 전 갱신" 주기 갱신(P7-7)
  initMap();
});
