/* RL3D — 궤도 대역 분류와 그룹·종류·소유국 필터 UI(P11-3·P7-6·P12-5b). sats.js 에서 분리(P12-23). */

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

/** 대역·종류·소유국 필터를 통과하는 위성만. 지도·목록·개수가 **같은 기준**을 쓰게 한 곳에 둔다.
 *  관심 위성은 필터와 무관하게 남긴다 — 관심 탭에서 골랐는데 지도에 점이 없으면 고장으로 보인다. */
function visibleSats() {
  return satrecs.filter((s) => {
    if (isFavSat(s.norad)) return true;
    if (satBands[s.band] === false) return false;
    // 메타가 아직 안 왔거나(비동기) 실패했으면 **숨기지 않는다.** 분류를 모르는 것을
    // 숨기면 SATCAT 이 늦게 올 때 위성이 사라졌다 나타난다.
    const m = satMeta(s.norad);
    if (!m) return true;
    if (m.type && satTypesOff[m.type]) return false;
    if (m.owner && satOwnersOff[m.owner]) return false;
    return true;
  });
}

/** 불러온 위성의 종류·소유국 분포. 필터 UI 는 **고정 표가 아니라 이 결과**로 만든다.
 *  SATCAT 의 나라 코드는 130종이고 그룹마다 달라서, 고정 목록을 두면 반드시 어긋난다.
 *  반환: [{ value, count }] — 많은 순. */
function satFacet(field) {
  const counts = new Map();
  for (const s of satrecs) {
    const m = satMeta(s.norad);
    const v = m && m[field];
    if (!v) continue;   // 메타가 없는 위성은 세지 않는다(필터로 숨기지도 않는다)
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "ko"));
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
        `${escapeHtml(b.label)} <span class="muted">${escapeHtml(b.note)}</span></label>`).join("")
      // 종류·소유국은 SATCAT 이 온 뒤에야 채워진다 → 자리만 만들어 두고 따로 그린다.
      + `<div id="sat-facets"></div>`;
    box.querySelectorAll(".satg").forEach((c) => c.addEventListener("change", onSatGroupChange));
    box.querySelectorAll(".satb").forEach((c) => c.addEventListener("change", onSatBandChange));
    renderFacetFilters();   // 종류·소유국(P12-5b). 메타가 오면 다시 그린다
  } catch (e) { console.error("위성 그룹 로드 실패", e); }
}

// ── 종류·소유국 필터 (P12-5b) ──────────────────────────────────────────────────
// 실측이 근거다(2026-09-11): `visual` 159개 중 위성체는 66개뿐이고 92개가 다 쓴
// 로켓 몸체다. "밝게 보이는 위성"의 58%가 위성이 아니다.
const FACETS = [
  { field: "type", cls: "satt", title: "종류", off: () => satTypesOff },
  { field: "owner", cls: "sato", title: "소유국", off: () => satOwnersOff },
];

function facetSectionHtml(f) {
  const items = satFacet(f.field);
  if (!items.length) return "";   // 메타가 아직 없으면 빈 제목만 남기지 않는다
  const off = f.off();
  return `<div class="satg-sec">${escapeHtml(f.title)}</div>` +
    items.map((it) =>
      `<label><input type="checkbox" class="${f.cls}" value="${escapeHtml(it.value)}" ` +
      `${off[it.value] ? "" : "checked"}/> ${escapeHtml(it.value)} ` +
      `<span class="muted">${it.count}</span></label>`).join("");
}

/** 종류·소유국 구역만 다시 그린다 — 그룹·대역 체크박스는 건드리지 않는다
 *  (전부 다시 그리면 열어 둔 드롭다운에서 방금 누른 체크가 튄다). */
function renderFacetFilters() {
  const host = document.getElementById("sat-facets");
  if (!host) return;
  host.innerHTML = FACETS.map(facetSectionHtml).join("");
  host.querySelectorAll(".satt").forEach((c) => c.addEventListener("change", onFacetChange));
  host.querySelectorAll(".sato").forEach((c) => c.addEventListener("change", onFacetChange));
}

function onFacetChange() {
  // **끈 것만** 모은다 — 켠 것을 담으면 새로 나타난 종류·나라가 조용히 숨겨진다.
  satTypesOff = {};
  document.querySelectorAll(".satt:not(:checked)").forEach((c) => { satTypesOff[c.value] = true; });
  satOwnersOff = {};
  document.querySelectorAll(".sato:not(:checked)").forEach((c) => { satOwnersOff[c.value] = true; });
  saveSatSettings();
  applySatFilter();
}

/** 필터가 바뀐 뒤 화면을 맞춘다 — 대역·종류·소유국이 같은 뒷정리를 쓰게 한 곳에 모은다. */
function applySatFilter() {
  // 숨겨진 위성이 선택돼 있으면 해제 — 지도에 점이 없는데 패널만 떠 있으면 혼란스럽다.
  if (selectedSat && !visibleSats().some((s) => s.norad === selectedSat.norad)) {
    deselectSatellite();
  }
  updateSatCount();
  if (satTimer) updateSatellitePositions();  // 다음 초를 기다리지 않고 바로 반영
  if (sidebarTab === "sats") renderSatList();
  else if (sidebarTab === "favs") renderFavList();
}

/** 위성 설정을 통째로 저장한다.
 *
 * 저장 지점이 셋(그룹·대역·종류/소유국)인데 각자 객체를 만들고 있었다. 새 필드를 늘리면
 * **한 곳만 빠뜨려도 그 경로로 저장할 때 조용히 사라진다** — 실제로 P12-5b 을 넣으며 그럴
 * 뻔했다. 저장 모양은 여기 한 곳에만 둔다(전역 규칙 6번과 같은 이유).
 */
function saveSatSettings() {
  saveSettings({ satellites: {
    enabled: document.getElementById("toggle-sat").checked,
    groups: satGroups,
    bands: satBands,
    typesOff: satTypesOff,
    ownersOff: satOwnersOff,
  } });
}

function onSatGroupChange() {
  satGroups = Array.from(document.querySelectorAll(".satg:checked")).map((c) => c.value);
  saveSatSettings();
  if (document.getElementById("toggle-sat").checked) {
    satrecs = []; loadSatellites();   // 그룹이 바뀌었으니 재로드
  }
}

/** 대역 필터 변경 — 재로드 없이 즉시 반영(이미 받아둔 TLE만 걸러낸다). */
function onSatBandChange() {
  BANDS.forEach((b) => { satBands[b.key] = false; });
  document.querySelectorAll(".satb:checked").forEach((c) => { satBands[c.value] = true; });
  saveSatSettings();
  applySatFilter();
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
