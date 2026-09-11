/* RL3D — 발사 카운트다운 집중 화면 (P12-3).
 *
 * 티커는 5초마다 다음 항목으로 흘러가서 "지금 곧 발사"라는 사실이 약하다.
 * T-60분 안쪽으로 들어온 발사가 있으면 지도 위에 카드 하나를 띄워 두고,
 * ✕ 로 닫으면 그 발사는 이 실행 동안 다시 뜨지 않는다.
 */

const FOCUS_LEAD_MS = 60 * 60 * 1000;   // T-60분부터 띄운다
const FOCUS_TAIL_MS = 30 * 60 * 1000;   // T+30분까지 남겨 둔다(중계는 발사 뒤에도 이어진다)
// **초 단위 카운트다운은 net 이 그만큼 확정일 때만 참말이다.** LL2 의 net_precision 이
// Hour/Day/Month 면 "T-00:47:12" 는 지어낸 정밀도가 된다 → 집중 화면을 띄우지 않는다.
const FOCUS_PRECISIONS = new Set(["Second", "Minute"]);

let focusDismissed = new Set();  // ✕ 로 닫은 발사 id(문자열). 재시작하면 초기화된다
let focusShownId = null;         // 지금 그려져 있는 발사 — 매초 카드 전체를 다시 그리지 않는다

/**
 * 집중 화면에 띄울 발사 1건을 고른다(없으면 null). 순수 함수 — 테스트가 직접 부른다.
 * 창(窓) 안의 **아직 안 온 발사 중 가장 임박한 것**이 1순위,
 * 그런 게 없으면 방금 발사한 것(T+) 중 가장 최근.
 */
function pickFocusLaunch(list, now, dismissed) {
  let next = null, justFlown = null;
  for (const d of list || []) {
    if (!d || d.outcome !== "upcoming" || !d.net) continue;
    if (!FOCUS_PRECISIONS.has(d.net_precision)) continue;
    if (dismissed && dismissed.has(String(d.id))) continue;
    const t = new Date(d.net).getTime();
    if (!isFinite(t)) continue;
    const diff = t - now;
    if (diff > FOCUS_LEAD_MS || diff < -FOCUS_TAIL_MS) continue;
    if (diff >= 0) { if (!next || t < new Date(next.net).getTime()) next = d; }
    else if (!justFlown || t > new Date(justFlown.net).getTime()) justFlown = d;
  }
  return next || justFlown;
}

/** 카드 안쪽을 그린다(매초가 아니라 대상이 바뀔 때만). */
function renderFocus(d) {
  const box = document.getElementById("focus");
  const vid = (d.vid_urls || [])[0];
  const live = d.webcast_live ? `<span class="focus-live">● 생중계 중</span>` : "";
  const where = [d.rocket, d.location_name].filter(Boolean).map(escapeHtml).join(" · ");
  box.innerHTML =
    `<button id="focus-close" class="focus-close" title="이 발사는 다시 띄우지 않음">✕</button>` +
    `<div class="focus-head">🚀 발사 임박 ${live}</div>` +
    (d.patch ? `<img class="focus-patch" src="${escapeHtml(d.patch)}" alt="" onerror="this.remove()" />` : "") +
    `<div id="focus-cd" class="focus-cd">${escapeHtml(countdown(d.net))}</div>` +
    `<div class="focus-name">${escapeHtml(d.name)}</div>` +
    (where ? `<div class="focus-sub">${where}</div>` : "") +
    `<div class="focus-btns">` +
    (vid ? `<button id="focus-live-btn" class="btn sm" data-url="${escapeHtml(vid.url)}">▶ ${escapeHtml(vid.title)}</button>` : "") +
    `<button id="focus-open" class="btn sm">발사장 보기</button></div>`;

  const close = document.getElementById("focus-close");
  if (close) close.addEventListener("click", () => dismissFocus(d.id));
  const vb = document.getElementById("focus-live-btn");
  if (vb && vid) vb.addEventListener("click", () => openExternal(vid.url));
  const ob = document.getElementById("focus-open");
  if (ob) ob.addEventListener("click", () => openPanel(d));
}

/** 매초 호출 — 대상이 바뀌었으면 다시 그리고, 아니면 카운트다운 숫자만 갈아 끼운다. */
function updateFocus() {
  const box = document.getElementById("focus");
  if (!box) return;
  const d = pickFocusLaunch(allLaunches, Date.now(), focusDismissed);
  if (!d) {
    box.classList.add("hidden");
    focusShownId = null;
    return;
  }
  if (String(d.id) !== focusShownId) {
    renderFocus(d);
    focusShownId = String(d.id);
    // 발사장이 지도 밖이면 카드만 보고 어디인지 알 수 없다 → 첫 노출에만 살짝 옮긴다
    if (map && typeof d.lng === "number" && typeof d.lat === "number") {
      map.easeTo({ center: [d.lng, d.lat], duration: 1200 });
    }
  } else {
    const cdEl = document.getElementById("focus-cd");
    if (cdEl) cdEl.textContent = countdown(d.net);
  }
  box.classList.remove("hidden");
}

function dismissFocus(id) {
  focusDismissed.add(String(id));
  focusShownId = null;
  document.getElementById("focus").classList.add("hidden");
  updateFocus();  // 닫은 뒤 그다음 임박 발사가 있으면 바로 이어 띄운다
}

function startFocusTimer() {
  if (focusTimer) clearInterval(focusTimer);
  updateFocus();
  focusTimer = setInterval(updateFocus, 1000);
}
