/* RL3D — 관심 목록(발사·위성) 저장과 표시. panels.js 에서 분리(P14-4). */

// ── 관심 목록 (P11-2) ─────────────────────────────────────────────────────────
function isFavLaunch(id) { return favLaunches.has(String(id)); }
function isFavSat(norad) { return favSats.has(String(norad)); }

function saveFavorites() {
  saveSettings({ favorites: { launches: [...favLaunches], sats: [...favSats] } });
}

/** 관심 토글 후 영향받는 화면을 모두 갱신한다(지도 강조·목록·별 버튼). */
function toggleFavLaunch(id) {
  const k = String(id);
  if (favLaunches.has(k)) favLaunches.delete(k); else favLaunches.add(k);
  saveFavorites();
  applyFilters();  // 지도 강조 + 목록(발사/관심 탭) 반영
  updateFavBtn(isFavLaunch(k));
}

function toggleFavSat(norad) {
  const k = String(norad);
  if (favSats.has(k)) favSats.delete(k); else favSats.add(k);
  saveFavorites();
  updateSatellitePositions();  // 강조가 바로 보이게(다음 초를 기다리지 않음)
  if (sidebarTab === "favs") renderFavList();
  updateFavBtn(isFavSat(k));
}

/** 상세 패널의 ⭐ 버튼 표시 갱신. */
function updateFavBtn(on) {
  const b = document.getElementById("fav-btn");
  if (!b) return;
  b.classList.toggle("active", on);
  b.textContent = on ? "★ 관심" : "☆ 관심";
  b.title = on ? "관심 목록에서 빼기" : "관심 목록에 넣기";
}

/** 상세 패널 헤더의 ⭐ 버튼 HTML. kind: launch | sat */
function favBtnHtml(kind, key) {
  const on = kind === "launch" ? isFavLaunch(key) : isFavSat(key);
  return `<button id="fav-btn" class="fav-btn${on ? " active" : ""}" ` +
    `data-kind="${kind}" data-key="${escapeHtml(String(key))}" ` +
    `title="${on ? "관심 목록에서 빼기" : "관심 목록에 넣기"}">${on ? "★" : "☆"} 관심</button>`;
}

function bindFavBtn(root) {
  const b = root.querySelector("#fav-btn");
  if (!b) return;
  b.addEventListener("click", () => {
    if (b.dataset.kind === "launch") toggleFavLaunch(b.dataset.key);
    else toggleFavSat(b.dataset.key);
  });
}

/** 관심 탭 — 발사와 위성을 함께 보여준다(발사 먼저). */
function renderFavList() {
  const cont = document.getElementById("sidebar-list");
  const countEl = document.getElementById("sidebar-count");
  const favL = allLaunches.filter((d) => isFavLaunch(d.id));
  const favS = satrecs.filter((s) => isFavSat(s.norad));
  countEl.textContent = `${favL.length + favS.length}개`;
  if (!favL.length && !favS.length) {
    // 저장은 돼 있는데 아직 데이터가 안 붙은 경우(위성 레이어 OFF 등)를 구분해 안내
    const pending = favLaunches.size + favSats.size;
    cont.innerHTML = `<div class="sb-empty">${pending
      ? "저장된 관심 항목이 아직 불러오지 않은 데이터입니다.<br />위성 레이어를 켜거나 과거 연도를 불러와 보세요."
      : "관심 항목이 없습니다.<br />상세 패널의 <b>☆ 관심</b>을 눌러 담아두면 여기 모입니다."}</div>`;
    return;
  }
  const launchRows = favL.map((d) =>
    `<button class="sb-row" data-id="${escapeHtml(String(d.id))}">` +
    `<span class="dot d-${d.outcome}"></span>` +
    `<span class="sb-main"><span class="sb-name">★ ${escapeHtml(d.name)}</span>` +
    `<span class="sb-sub">${escapeHtml(d.outcome === "upcoming" ? countdownText(d) : fmtDate(d.net))}</span>` +
    `</span></button>`).join("");
  const satRows = favS.map((s) =>
    `<button class="sb-row" data-norad="${escapeHtml(String(s.norad))}">` +
    `<span class="dot d-sat"></span>` +
    `<span class="sb-main"><span class="sb-name">★ ${escapeHtml(s.name)}</span>` +
    `<span class="sb-sub">NORAD ${escapeHtml(String(s.norad))}</span></span></button>`).join("");
  cont.innerHTML =
    (launchRows ? `<div class="sb-group">🚀 발사 ${favL.length}</div>` + launchRows : "") +
    (satRows ? `<div class="sb-group">🛰 위성 ${favS.length}</div>` + satRows : "");
}
