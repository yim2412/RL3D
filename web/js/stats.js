/* RL3D — 발사 통계 패널과 관점 화면(발사장/기관/로켓). panels.js 에서 분리(P14-4). */

// ── 발사 통계 패널 (P8-10) ────────────────────────────────────────────────────
function computeStats(list) {
  const byOutcome = { success: 0, failure: 0, partial: 0, upcoming: 0 };
  const byProvider = {}, byCountry = {}, byYear = {};
  for (const d of list) {
    if (byOutcome[d.outcome] != null) byOutcome[d.outcome]++;
    if (d.provider) byProvider[d.provider] = (byProvider[d.provider] || 0) + 1;
    const c = countryKo(d.provider_country);
    if (c) byCountry[c] = (byCountry[c] || 0) + 1;
    if (d.net) { const y = new Date(d.net).getFullYear(); if (!isNaN(y)) byYear[y] = (byYear[y] || 0) + 1; }
  }
  return { byOutcome, byProvider, byCountry, byYear, total: list.length };
}

/**
 * 통계의 모수(P12-7) — 무엇이 들어갔고 **무엇이 빠졌는지**. 순수 함수.
 *
 * 라이브 데이터는 `previous` 50건 + `upcoming` 50건뿐이라 **올해 앞부분이 통째로 없다**
 * (실측 2026-09-11: 라이브 98건이 전부 2026년이고 가장 이른 것이 7-14).
 * 그대로 "연도별 2026: 98" 막대를 그리면 **올해 발사가 98건이었다고 읽힌다** — 조용한 거짓말.
 * 아카이브로 연도 전체를 불러온 해만 완전하고, 나머지는 부분 표본이다.
 */
/** 통계에서 **완전한 해**로 칠 수 있는 연도 — 불러왔고, 상한에 안 걸린 해.
 *  잘린 해를 완전으로 세면 P12-7 의 경고가 거꾸로 거짓말이 된다(P12-6). */
function completeYears() {
  return new Set([...loadedYears].filter((y) => !truncatedYears.has(y)));
}

function statsScope(list, loaded, nowYear) {
  const years = new Set();
  let from = null, to = null;
  for (const d of list || []) {
    if (!d || !d.net) continue;
    const t = new Date(d.net).getTime();
    if (!isFinite(t)) continue;
    years.add(new Date(t).getFullYear());
    if (from == null || t < from) from = t;
    if (to == null || t > to) to = t;
  }
  const full = [], partial = [];
  for (const y of [...years].sort((a, b) => a - b)) {
    (loaded && loaded.has(y) ? full : partial).push(y);
  }
  return { total: (list || []).length, from, to, full, partial, nowYear };
}

/** 모수 안내 문구 HTML. 부분 표본 연도가 있으면 그것을 **이름으로** 알린다. */
function scopeNoteHtml(sc) {
  const span = sc.from != null
    ? `${escapeHtml(tlLabelDate(sc.from))} ~ ${escapeHtml(tlLabelDate(sc.to))}` : null;
  const partialWarn = sc.partial.length
    ? `<div class="st-warn">⚠ ${sc.partial.join("·")}년은 <b>일부만</b> 포함됐습니다` +
      ` — 라이브 데이터는 최근 발사 50건과 예정 발사뿐입니다.` +
      ` 연도 전체는 타임라인 옆 <b>과거 → 불러오기</b>로 채웁니다.</div>`
    : "";
  const fullNote = sc.full.length
    ? `<div class="st-full">✓ 연도 전체를 불러온 해: ${sc.full.join("·")}</div>` : "";
  return `<div class="st-note">현재 불러온 ${sc.total}건 기준` +
    (span ? ` · ${span}` : "") + `</div>` + partialWarn + fullNote;
}

/** {키:수} → 가로 막대 HTML. entries는 미리 정렬해 넘긴다. */
/** 패드 이름은 "Space Launch Complex 4E" 처럼 길어 좁은 라벨에서 잘린다 → 통용 약어로. */
const PAD_ABBREV = [
  [/^Space Launch Complex\s*/i, "SLC "],
  [/^Orbital Launch Pad\s*/i, "OLP "],
  [/^Launch Complex\s*/i, "LC "],
  [/^Launch Pad\s*/i, "LP "],
  [/^Launch Area\s*/i, "LA "],
  [/^Launch Vehicle Pad\s*/i, "LVP "],
];

function shortenPad(name) {
  let s = String(name);
  for (const [re, rep] of PAD_ABBREV) {
    if (re.test(s)) return s.replace(re, rep).trim();
  }
  return s;
}

function statBars(entries, color) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return entries.map(([k, v]) =>
    // 축약해도 잘릴 수 있으니 원문은 title 로 남긴다
    `<div class="st-row"><span class="st-k" title="${escapeHtml(String(k))}">${escapeHtml(String(k))}</span>` +
    `<span class="st-bar"><span style="width:${(v / max * 100).toFixed(1)}%;background:${color}"></span></span>` +
    `<span class="st-v">${v}</span></div>`
  ).join("");
}

// ── 관점 화면 (발사장 / 기관 / 로켓) — P10-3, P11-1 ───────────────────────────
// 셋 다 "특정 대상의 발사만 모아 성적을 본다"는 같은 화면이다.
// 뼈대(타일·결과별·예정/최근 목록)는 공유하고 중간 막대 구성만 관점별로 바꾼다.
const ENTITY_VIEWS = {
  site:     { icon: "🛫", field: "location_name" },
  provider: { icon: "🏢", field: "provider" },
  rocket:   { icon: "🚀", field: "rocket" },
  // 로켓 계열(P15-4). `rocket` 은 변형까지 담은 이름이라 관점 화면이 변형별로 쪼개진다 —
  // `Falcon 9 Block 5` 와 `Falcon Heavy` 가 남남이고, `Long March` 는 10종으로 갈린다.
  family:   { icon: "🚀", field: "rocket_family", suffix: " 계열" },
};

/**
 * 우리가 가진 발사 기준으로 그 계열에 속한 **변형 이름들** — 순수 함수 (P15-4).
 *
 * 이 값이 계열 줄을 **보일지도** 정한다: 변형이 하나뿐이면 계열 관점 화면의 목록이
 * 로켓 관점과 **글자 그대로 같아** 버튼이 거짓말이 된다. P10-3 의 "패드가 하나뿐인
 * 발사장은 패드별 막대 생략"과 같은 처리다.
 *
 * 고정값으로 굳히지 않고 매번 세는 이유: 아카이브를 불러오면 변형이 늘어난다
 * (실측 라이브 100건에서 `Vulcan` 은 2종이지만 지난 연도를 더 부르면 달라진다).
 */
function familyVariants(fam, list) {
  if (!fam) return [];
  const out = [];
  for (const d of (list || allLaunches))
    if (d.rocket_family === fam && d.rocket && !out.includes(d.rocket)) out.push(d.rocket);
  return out;
}

function countBy(list, pick) {
  const o = {};
  for (const d of list) { const k = pick(d); if (k) o[k] = (o[k] || 0) + 1; }
  return o;
}

/** 많은 순 상위 n개. **n 을 생략하면 전부** — 자르면 안 되는 막대가 있다(P15-4 변형별). */
const topEntries = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

/** 관점별 막대 구성 → [제목, entries, 색, 최소개수] 목록. 최소개수 미만이면 그 절은 생략. */
function entityBars(kind, list, s) {
  const rockets = () => topEntries(countBy(list, (d) => d.rocket), 6);
  const providers = () => topEntries(countBy(list, (d) => d.provider), 6);
  const sites = () => topEntries(countBy(list, (d) => d.location_name), 6);
  const pads = () => topEntries(countBy(list, (d) => d.pad_name && shortenPad(d.pad_name)), 6);
  const years = () => Object.entries(s.byYear).sort((a, b) => a[0] - b[0]);
  if (kind === "site")
    // 패드가 하나뿐인 발사장에선 "패드별" 막대가 총합과 같아 의미 없다 → 2개 이상일 때만
    return [["주요 로켓", rockets(), "#f472b6"], ["기관", providers(), "#a78bfa"],
            ["패드별", pads(), "#7dd3fc", 2]];
  if (kind === "provider")
    return [["주요 로켓", rockets(), "#f472b6"], ["발사장", sites(), "#7dd3fc"],
            ["연도별", years(), "#34d399"]];
  if (kind === "family")
    // 계열 화면의 존재 이유가 이 막대다 — `Long March` 13건이 변형 10종으로 갈린 것을
    // 여기서만 한 화면에 볼 수 있다. **상위 6종으로 자르지 않는다**: 상세 패널이
    // `변형 10종` 이라고 말해 놓고 6개만 보이면 화면이 스스로와 어긋난다
    // (실측 렌더에서 실제로 그랬다 — P12-6 의 "캡에 걸리면 조용히 잘린다"와 같은 자리).
    return [["변형별", topEntries(countBy(list, (d) => d.rocket)), "#f472b6"],
            ["기관", providers(), "#a78bfa"],
            ["발사장", sites(), "#7dd3fc"], ["연도별", years(), "#34d399"]];
  return [["기관", providers(), "#a78bfa"], ["발사장", sites(), "#7dd3fc"],
          ["연도별", years(), "#34d399"]];
}

/** 발사장·기관·로켓 중 하나를 기준으로 그 대상만의 성적·목록을 낸다. */
/**
 * 발사장의 **통산 발사 횟수**와 우리 표본 — 순수 함수 (P13-3). 기준값이 없으면 null.
 *
 * P13-2 와 같은 논리다: 우리 통계는 "불러온 N건"까지만 말할 수 있는데, LL2 의
 * `location_launch_attempt_count`(실측 100/100)가 그 발사장의 **통산 횟수**를 알려준다.
 * **이미 일어난 발사만 센다** — 예정 발사에 붙은 번호는 아직 일어나지 않은 수다.
 */
function siteTotals(list) {
  let total = 0, ours = 0;
  for (const d of list || []) {
    if (!d || d.outcome === "upcoming") continue;
    ours++;
    if (typeof d.location_count === "number" && d.location_count > total) total = d.location_count;
  }
  return total > 0 ? { total, ours } : null;
}

/** 위 값을 문장으로. 없으면 빈 문자열(없는 말을 지어내지 않는다). */
function siteTotalsHtml(list) {
  const t = siteTotals(list);
  if (!t) return "";
  const pct = Math.round(t.ours / t.total * 100);
  return `<div class="st-world">🏗 이 발사장은 통산 <b>${t.total.toLocaleString()}회</b> 발사했습니다` +
    ` — 그중 <b>${t.ours}건</b>(${pct}%)을 불러왔습니다</div>` +
    `<div class="st-world-src">기준: Launch Library 2 의 발사장 통산 횟수` +
    ` (우리가 가진 <b>가장 최근 발사</b>까지의 집계다)</div>`;
}

/**
 * 기관 착륙 통산(P15-3) → 그 기관 발사 중 **가장 큰 시도 횟수**를 쓴다.
 *
 * `siteTotals` 와 같은 수법이다 — LL2 가 각 발사 시점의 집계를 주므로,
 * **우리가 가진 가장 최근 발사**의 값이 곧 통산이다. 옛 발사의 값을 쓰면 과소 집계가 된다.
 */
function providerLandings(list) {
  let best = null;
  for (const d of list || []) {
    const L = d && d.provider_landings;
    if (!L || !L.att) continue;
    if (!best || L.att > best.att) best = L;
  }
  return best;
}

function providerLandingsHtml(list) {
  const L = providerLandings(list);
  if (!L) return "";
  // 실패는 받은 값만 쓴다 — 실측 SpaceX 가 699 ≠ 671+29 라 LL2 값끼리 안 맞는다(P15-3)
  const line = landingRecord(L.att, L.ok, L.fail, L.streak);
  if (!line) return "";
  return `<div class="st-world">🛬 ${escapeHtml(line)}</div>` +
    `<div class="st-world-src">기준: Launch Library 2 의 기관 착륙 통산` +
    ` (우리가 가진 <b>가장 최근 발사</b>까지의 집계다)</div>`;
}

/**
 * 로켓 관점 화면에서 **계열 전체**로 올라가는 줄 (P15-4) — 순수 함수.
 *
 * 변형이 2종 이상일 때만 낸다(`familyVariants` 와 같은 판정). `Falcon 9 Block 5` 를
 * 보고 있을 때 "이 계열 전체는?"이 자연스러운 다음 질문인데, 계열은 상세 패널에서만
 * 들어갈 수 있어 관점 화면에 갇혀 있었다.
 */
function familyUpHtml(kind, list) {
  if (kind !== "rocket") return "";
  let fam = null;
  for (const d of list) if (d.rocket_family) { fam = d.rocket_family; break; }
  const vs = familyVariants(fam);
  if (vs.length < 2) return "";
  return `<button class="site-link st-famup" data-kind="family" data-val="${escapeHtml(fam)}">` +
    `🚀 ${escapeHtml(fam)} 계열 전체 · 변형 ${vs.length}종 ›</button>`;
}

function showEntityStats(kind, value) {
  const view = ENTITY_VIEWS[kind];
  if (!view || !value) return;
  const list = allLaunches.filter((d) => d[view.field] === value);
  if (!list.length) return;

  const s = computeStats(list);
  const decided = s.byOutcome.success + s.byOutcome.failure + s.byOutcome.partial;
  const rate = decided ? Math.round(s.byOutcome.success / decided * 100) : null;

  const dated = list.filter((d) => d.net && !isNaN(new Date(d.net)));
  const past = dated.filter((d) => d.outcome !== "upcoming")
    .sort((a, b) => new Date(b.net) - new Date(a.net));
  const upcoming = dated.filter((d) => d.outcome === "upcoming")
    .sort((a, b) => new Date(a.net) - new Date(b.net));
  const rows = (arr, n) => arr.slice(0, n).map((d) =>
    `<button class="site-row" data-id="${escapeHtml(String(d.id))}">` +
    `<span class="dot d-${d.outcome}"></span>` +
    `<span class="site-row-main"><span class="site-row-name">${escapeHtml(d.name)}</span>` +
    `<span class="site-row-sub">${escapeHtml(d.outcome === "upcoming" ? countdown(d.net) : fmtDate(d.net))}</span>` +
    `</span></button>`).join("");

  const bars = entityBars(kind, list, s)
    .map(([label, entries, color, min]) =>
      entries.length >= (min || 1) ? `<div class="st-sec">${label}</div>` + statBars(entries, color) : "")
    .join("");

  document.getElementById("stats-body").innerHTML =
    `<h2>${view.icon} ${escapeHtml(value)}${view.suffix || ""}</h2>` +
    scopeNoteHtml(statsScope(list, completeYears(), new Date().getFullYear())) +
    familyUpHtml(kind, list) +
    (kind === "site" ? siteTotalsHtml(list) : "") +
    (kind === "provider" ? providerLandingsHtml(list) : "") +
    `<div class="st-tiles">` +
      `<div class="st-tile"><div class="st-num">${s.total}</div><div class="st-lab">총 발사</div></div>` +
      `<div class="st-tile"><div class="st-num">${rate == null ? "—" : rate + "%"}</div>` +
        `<div class="st-lab">성공률</div><div class="st-sub">확정 ${decided}건 중</div></div>` +
      `<div class="st-tile"><div class="st-num">${s.byOutcome.upcoming}</div><div class="st-lab">예정</div></div>` +
    `</div>` +
    `<div class="st-sec">결과별</div>` +
    statBars([["성공", s.byOutcome.success], ["실패", s.byOutcome.failure],
              ["부분 실패", s.byOutcome.partial], ["예정", s.byOutcome.upcoming]], "var(--accent)") +
    bars +
    (upcoming.length ? `<div class="st-sec">예정 발사</div>` + rows(upcoming, 5) : "") +
    (past.length ? `<div class="st-sec">최근 발사</div>` + rows(past, 5) : "");

  const panel = document.getElementById("stats-panel");
  panel.querySelectorAll(".site-row").forEach((b) => b.addEventListener("click", () => {
    const d = findLaunch(b.dataset.id);
    if (d) { panel.classList.add("hidden"); openPanel(d); }
  }));
  // 계열로 올라가는 줄(P15-4). 같은 패널을 다시 그리는 것이라 닫지 않는다.
  panel.querySelectorAll(".site-link").forEach((b) =>
    b.addEventListener("click", () => showEntityStats(b.dataset.kind, b.dataset.val)));
  panel.classList.remove("hidden");
}

/**
 * 연도별 "전 세계 궤도 발사 몇 건 중 우리가 몇 건인가" — 순수 함수 (P13-2).
 *
 * P12-7 은 통계의 모수를 밝혔지만 **"불러온 N건"이라고 말하는 것이 전부**였다.
 * 그 N 이 전체의 얼마인지는 우리 데이터 안에 답이 없다. LL2 `orbital_launch_attempt_count_year`
 * (실측 98% 채워짐)가 **유일한 외부 기준값**이다.
 *
 * **이미 일어난 발사와 예정 발사를 나눠 센다.** 카운터 최대값을 통째로 쓰면 예정 발사의
 * 번호(연말 예상치)가 섞여 **"올해 지금까지 356건 발사됐다"는 거짓말**이 된다
 * (2026-09-12 실측: 일어난 것 215 · 예정 포함 356 — 141건 차이).
 *
 * 우리 쪽 건수는 **궤도 발사만** 센다 — LL2 카운터가 궤도 발사만 세므로,
 * 탄도 비행을 섞으면 분자와 분모의 기준이 달라진다.
 */
function orbitalYearStats(list, nowYear) {
  const by = {};
  for (const d of list || []) {
    if (!d || !d.net) continue;
    const y = new Date(d.net).getFullYear();
    if (!isFinite(y)) continue;
    const b = (by[y] = by[y] || { year: y, done: 0, planned: 0, ours: 0, oursDone: 0 });
    const n = d.orbital_year_count;
    const isDone = d.outcome !== "upcoming";
    if (d.orbit !== "Suborbital") {
      b.ours++;
      if (isDone) b.oursDone++;
    }
    if (typeof n === "number" && n > 0) {
      if (n > b.planned) b.planned = n;
      if (isDone && n > b.done) b.done = n;
    }
  }
  return Object.values(by)
    .filter((b) => b.done > 0)          // 기준값이 없으면 말할 것이 없다
    .sort((a, b) => b.year - a.year)
    .map((b) => Object.assign({ current: b.year === nowYear }, b));
}

/** 위 통계를 문장으로. 기준값이 없으면 빈 문자열(없는 말을 지어내지 않는다). */
function orbitalYearNoteHtml(list, nowYear) {
  const rows = orbitalYearStats(list, nowYear);
  if (!rows.length) return "";
  const lines = rows.map((b) => {
    const pct = b.done ? Math.round(b.oursDone / b.done * 100) : 0;
    const when = b.current ? "지금까지" : "총";
    const plan = b.current && b.planned > b.done
      ? ` · 예정까지 포함하면 연말 <b>${b.planned}건</b>` : "";
    return `<div class="st-world">🌍 ${b.year}년 전 세계 궤도 발사 ${when} <b>${b.done}건</b>` +
      ` — 그중 <b>${b.oursDone}건</b>(${pct}%)을 불러왔습니다${plan}</div>`;
  }).join("");
  return lines + `<div class="st-world-src">기준: Launch Library 2 의 연내 궤도 발사 순번 ` +
    `(우리가 가진 <b>가장 최근 발사</b>까지의 집계다 — 그 뒤의 발사는 안 세어진다)</div>`;
}

/** 연도별 막대 라벨 — 부분 표본인 해는 이름 옆에 표시한다(막대 모양만으로는 구분이 안 된다). */
function yearEntries(years, sc) {
  const partial = new Set(sc.partial);
  return years.map(([y, n]) => [partial.has(+y) ? `${y} (일부)` : String(y), n]);
}

/**
 * 발사가 한 건도 없을 때의 통계 화면. 순수 함수 (P18-4).
 *
 * 0건에서도 숫자판을 그리면 `0 총 발사 · 성공률 — · 확정 0건 중` 이 나온다(2026-09-16 실측).
 * **틀린 숫자는 아니지만 아무것도 알려주지 않고**, 통계가 고장난 것처럼 보이기도 한다.
 * 0건은 곧 "아직 못 받았다"는 뜻이다 — 통계는 필터가 아니라 `allLaunches` 를 세기 때문에
 * 필터·검색으로는 0 이 되지 않는다. 그래서 **원인을 나눌 필요가 없고**, 갈 길은 하나다.
 */
function statsEmptyHtml() {
  return `<h2>📊 발사 통계</h2>` +
    `<div class="st-empty">아직 셀 발사가 없습니다.<br />` +
    `데이터를 받지 못했습니다 — 툴바의 <b>↻ 갱신</b>으로 다시 시도하거나, ` +
    `타임라인 옆 <b>과거 → 불러오기</b>로 지난 연도를 채울 수 있습니다.</div>`;
}

function showStats() {
  // 0건에서는 숫자판 대신 이유를 말한다(P18-4)
  if (!allLaunches.length) {
    document.getElementById("stats-body").innerHTML = statsEmptyHtml();
    document.getElementById("stats-panel").classList.remove("hidden");
    return;
  }
  const s = computeStats(allLaunches);
  const scope = statsScope(allLaunches, completeYears(), new Date().getFullYear());
  const decided = s.byOutcome.success + s.byOutcome.failure + s.byOutcome.partial;
  const rate = decided ? Math.round(s.byOutcome.success / decided * 100) : null;
  const providers = Object.entries(s.byProvider).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const countries = Object.entries(s.byCountry).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const years = Object.entries(s.byYear).sort((a, b) => a[0] - b[0]);

  document.getElementById("stats-body").innerHTML =
    `<h2>📊 발사 통계</h2>` +
    scopeNoteHtml(scope) +
    orbitalYearNoteHtml(allLaunches, new Date().getFullYear()) +
    `<div class="st-tiles">` +
      `<div class="st-tile"><div class="st-num">${s.total}</div><div class="st-lab">총 발사</div></div>` +
      `<div class="st-tile"><div class="st-num">${rate == null ? "—" : rate + "%"}</div>` +
        `<div class="st-lab">성공률</div><div class="st-sub">확정 ${decided}건 중</div></div>` +
      `<div class="st-tile"><div class="st-num">${s.byOutcome.upcoming}</div><div class="st-lab">예정</div></div>` +
    `</div>` +
    `<div class="st-sec">결과별</div>` +
    statBars([["성공", s.byOutcome.success], ["실패", s.byOutcome.failure],
              ["부분 실패", s.byOutcome.partial], ["예정", s.byOutcome.upcoming]], "var(--accent)") +
    (years.length ? `<div class="st-sec">연도별</div>` + statBars(yearEntries(years, scope), "#7dd3fc") : "") +
    (providers.length ? `<div class="st-sec">기관 (상위 8)</div>` + statBars(providers, "#a78bfa") : "") +
    (countries.length ? `<div class="st-sec">국가 (상위 8)</div>` + statBars(countries, "#34d399") : "");
  document.getElementById("stats-panel").classList.remove("hidden");
}
