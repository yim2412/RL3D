/* RL3D — 키보드 단축키 (P12-14).
 *
 * 판정(무슨 키가 무슨 동작인가)과 실행(그 동작을 하는 것)을 나눈다. 판정은 순수 함수라
 * 테스트가 직접 부르고, 실행은 기존 함수들을 그대로 호출한다.
 */

// 숫자키 ↔ 토글 대상. 1~4 는 결과 필터(툴바 체크박스 순서와 같다), 5~7 은 레이어.
const KEY_TOGGLES = {
  "1": { kind: "filter", value: "upcoming" },
  "2": { kind: "filter", value: "success" },
  "3": { kind: "filter", value: "failure" },
  "4": { kind: "filter", value: "partial" },
  "5": { kind: "el", id: "toggle-sat" },
  "6": { kind: "el", id: "toggle-terminator" },
  "7": { kind: "el", id: "toggle-heat" },
};

/**
 * 키 이벤트 → 동작 이름(없으면 null). 순수 함수.
 *
 * **입력 중에는 단축키가 없어야 한다.** 검색창에 "s" 를 치면 사이드바가 열리는 앱은
 * 검색을 쓸 수 없다 — 화면으로는 "글자가 안 써진다"로만 보이는, 조용한 종류의 고장이다.
 * 조합키(Ctrl/Alt/Meta)도 비켜난다: Ctrl+F 같은 브라우저·시스템 단축키를 뺏지 않는다.
 */
function keyAction(e) {
  const key = e.key;
  const tag = ((e.target && e.target.tagName) || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea" || tag === "select";
  if (typing) return key === "Escape" ? "blur" : null;  // 입력 중 Esc 는 입력에서 빠져나오기
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (key === "Escape") return "escape";
  if (key === "/") return "search";
  if (key === "?") return "help";
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (k === "s") return "sidebar";
  if (k === "r") return "refresh";
  if (KEY_TOGGLES[k]) return "toggle:" + k;
  return null;
}

/**
 * Esc 로 무엇을 닫을 것인가 — **위에 덮인 것부터** 하나씩. 순수 함수.
 * 한 번에 전부 닫으면 "상세만 닫고 목록은 보고 싶다"가 안 되고,
 * 우선순위가 없으면 화면 뒤쪽 것이 먼저 닫혀 아무 반응이 없는 것처럼 보인다.
 */
function escapeTarget(open) {
  if (open.help) return "help";
  if (open.panel) return "panel";
  if (open.pass) return "pass";
  if (open.stats) return "stats";
  if (open.satGroups) return "satGroups";
  if (open.satCtrl) return "satCtrl";
  if (open.sidebar) return "sidebar";
  return null;
}

/** 지금 열려 있는 것들 — escapeTarget 의 입력. */
function openOverlays() {
  const vis = (id) => !document.getElementById(id).classList.contains("hidden");
  return {
    help: vis("keyhelp"), panel: vis("panel"), pass: vis("pass-panel"),
    stats: vis("stats-panel"), satGroups: vis("sat-groups"),
    satCtrl: vis("sat-ctrl"), sidebar: vis("sidebar"),
  };
}

function closeOverlay(what) {
  if (what === "help") toggleKeyHelp(false);
  else if (what === "panel") closePanel();
  else if (what === "pass") document.getElementById("pass-panel").classList.add("hidden");
  else if (what === "stats") document.getElementById("stats-panel").classList.add("hidden");
  else if (what === "satGroups") document.getElementById("sat-groups").classList.add("hidden");
  else if (what === "satCtrl") deselectSatellite();
  else if (what === "sidebar") toggleSidebar();
}

/** 숫자키 토글 — 체크박스를 직접 바꾸고 **원래의 change 경로를 그대로 탄다**(설정 저장 포함). */
function applyKeyToggle(k) {
  const t = KEY_TOGGLES[k];
  if (!t) return;
  if (t.kind === "filter") {
    const box = document.querySelector(`.flt[value="${t.value}"]`);
    if (!box) return;
    box.checked = !box.checked;
    applyFilters();
    saveSettings({ filters: currentFilters() });
    return;
  }
  const el = document.getElementById(t.id);
  el.checked = !el.checked;
  el.fire ? el.fire("change", { target: el })            // 테스트 스텁
          : el.dispatchEvent(new Event("change"));       // 실제 DOM — 저장까지 원래 경로로
}

const KEY_HELP = [
  ["/", "발사 검색으로"],
  ["S", "목록 사이드바 열기/닫기"],
  ["R", "강제 새로고침"],
  ["1 2 3 4", "예정 · 성공 · 실패 · 부분 필터"],
  ["5", "위성 레이어"],
  ["6", "낮/밤 오버레이"],
  ["7", "발사 밀도 히트맵"],
  ["Esc", "열린 패널 닫기 (위에 덮인 것부터)"],
  ["?", "이 도움말"],
];

function toggleKeyHelp(show) {
  const box = document.getElementById("keyhelp");
  const on = show === undefined ? box.classList.contains("hidden") : show;
  if (on) {
    box.innerHTML = `<div class="kh-head">⌨ 단축키</div>` +
      KEY_HELP.map(([k, desc]) =>
        `<div class="kh-row"><kbd>${escapeHtml(k)}</kbd><span>${escapeHtml(desc)}</span></div>`).join("") +
      `<div class="kh-foot">아무 키나 누르면 닫힙니다</div>`;
    box.classList.remove("hidden");
  } else {
    box.classList.add("hidden");
  }
}

function handleKey(e) {
  const action = keyAction(e);
  if (!action) return;
  // 도움말이 떠 있으면 무슨 키든 먼저 닫는다(안내대로) — Esc 만이 아니다.
  if (!document.getElementById("keyhelp").classList.contains("hidden") && action !== "help") {
    toggleKeyHelp(false);
    if (action === "escape" || action === "blur") return;
  }
  if (e.preventDefault) e.preventDefault();
  if (action === "blur") { if (e.target && e.target.blur) e.target.blur(); return; }
  if (action === "escape") { closeOverlay(escapeTarget(openOverlays())); return; }
  if (action === "search") {
    const s = document.getElementById("search");
    s.focus && s.focus();
    return;
  }
  if (action === "help") { toggleKeyHelp(); return; }
  if (action === "sidebar") { toggleSidebar(); return; }
  if (action === "refresh") { forceRefresh(); return; }
  if (action.startsWith("toggle:")) applyKeyToggle(action.slice(7));
}
