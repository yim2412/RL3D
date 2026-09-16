/* RL3D — 첫 실행 안내 카드 (P17-4).
 *
 * **첫 실행은 일부러 얇다.** 설정 파일이 없으면 위성 OFF · 히트맵 OFF · 아카이브 미로드라,
 * 처음 여는 사람이 보는 것은 올해 발사 100건 남짓뿐이다. LL2 시간당 15회 제한을 아끼려는
 * 의도적 설계인데, **화면이 그 사실을 말한 적이 없다** — 통계 패널 안쪽의 모수 안내
 * (`statsScope`, P12-7)를 연 사람만 알 수 있었다. 처음 여는 사람은 열지 않는다.
 *
 * 그래서 기본값은 그대로 두고, 그 상태를 **숫자로 말하고 켜는 길을 같이 준다**.
 */

/**
 * 안내를 띄울 것인가. 순수 함수.
 * 한 번 닫으면 다시 뜨지 않는다(P12-12 업데이트 배지와 같은 약속).
 * 설정 읽기가 실패해 `null` 이 와도 **첫 실행으로 본다** — 안내가 한 번 더 뜨는 쪽이
 * 아무 말도 없는 쪽보다 낫다.
 */
function shouldShowFirstRun(settings) {
  return !(settings && settings.firstRunSeen);
}

/**
 * 지금 화면에 무엇이 있는지 센다. 순수 함수.
 * `nowMs` 를 받는 이유: 예정/지난 판정을 `Date.now()` 에 걸면 **오전엔 통과하고 저녁엔
 * 실패하는** 테스트가 된다(이 리포가 2026-09-11 에 세 번 당한 갈래다).
 */
function firstRunCounts(launches, nowMs) {
  const list = launches || [];
  const years = new Set();
  let upcoming = 0;
  for (const d of list) {
    const t = Date.parse(d.net);
    if (isFinite(t)) years.add(new Date(t).getUTCFullYear());
    // outcome 을 기준으로 삼는다 — 시각만 보면 "오늘 발사했는데 결과 미정"이 지난 것으로 샌다
    if (d.outcome === "upcoming") upcoming++;
  }
  return {
    total: list.length,
    upcoming: upcoming,
    past: list.length - upcoming,
    years: [...years].sort(),
  };
}

/**
 * 안내 문구 HTML. 순수 함수.
 * **무엇이 빠졌는지**를 켜는 법과 함께 말한다. 단축키를 같이 적는 것은 P17-3 에서 낸
 * 길이 여기서 발견되게 하려는 것이다 — 아무 데서도 안 가리키는 단축키는 없는 것과 같다.
 */
function firstRunHtml(counts, archiveYear) {
  const span = counts.years.length
    ? (counts.years.length === 1 ? `${counts.years[0]}년`
       : `${counts.years[0]}~${counts.years[counts.years.length - 1]}년`)
    : "최근";
  return `<div class="fr-head">지금 지도에 ${span} 발사 ${counts.total}건이 있습니다` +
    ` <span class="fr-sub">(예정 ${counts.upcoming} · 지난 ${counts.past})</span></div>` +
    `<div class="fr-row"><span>🛰 위성을 켜면 실시간 위치가 함께 움직입니다</span>` +
    `<button id="fr-sat" class="btn sm">켜기 <kbd>5</kbd></button></div>` +
    `<div class="fr-row"><span>📅 과거 연도를 불러오면 통계·밀도가 두꺼워집니다</span>` +
    `<button id="fr-arch" class="btn sm">${escapeHtml(String(archiveYear))}년 <kbd>A</kbd></button></div>` +
    `<div class="fr-foot"><span>요청 제한을 아끼려고 기본은 꺼 둔 상태입니다.</span>` +
    `<button id="fr-close" class="btn sm">나중에</button></div>`;
}

/** 안내를 띄운다 — **발사 로드가 끝난 뒤**에 부른다(건수를 말해야 하므로). */
function showFirstRun() {
  const box = document.getElementById("firstrun");
  if (!box) return;
  const counts = firstRunCounts(allLaunches, Date.now());
  if (!counts.total) return;   // 아직 아무것도 못 받았으면 말할 것이 없다
  const sel = document.getElementById("arch-year");
  const cur = new Date().getUTCFullYear();
  // 올해는 이미 화면에 있다 → 권하는 것은 **작년**이다
  const year = cur - 1;
  box.innerHTML = firstRunHtml(counts, year);
  box.classList.remove("hidden");
  bindFirstRunButtons(year, sel);
}

function dismissFirstRun() {
  document.getElementById("firstrun").classList.add("hidden");
  saveSettings({ firstRunSeen: true });
}

/**
 * 버튼은 **기존 경로를 그대로** 탄다(체크박스의 change 를 발생시키고, `loadArchive` 를 부른다).
 * 여기서 따로 구현하면 저장·필터 갱신이 갈라져 한쪽만 고치게 된다(`forceRefresh` 와 같은 이유).
 */
function bindFirstRunButtons(year, sel) {
  const satBtn = document.getElementById("fr-sat");
  if (satBtn) satBtn.addEventListener("click", () => {
    const box = document.getElementById("toggle-sat");
    if (!box.checked) {
      box.checked = true;
      box.fire ? box.fire("change", { target: box }) : box.dispatchEvent(new Event("change"));
    }
    dismissFirstRun();
  });
  const archBtn = document.getElementById("fr-arch");
  if (archBtn) archBtn.addEventListener("click", () => {
    if (sel) sel.value = String(year);   // 툴바의 연도 선택도 같이 맞춘다
    loadArchive(year);
    dismissFirstRun();
  });
  const closeBtn = document.getElementById("fr-close");
  if (closeBtn) closeBtn.addEventListener("click", dismissFirstRun);
}
