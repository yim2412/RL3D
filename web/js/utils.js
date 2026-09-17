/* RL3D — 이스케이프·시간 포맷·발사 조회 같은 순수 유틸. */

/**
 * 날짜 포매터 캐시 (P20-1).
 *
 * `d.toLocaleString(로캘, 옵션)` 은 **부를 때마다 포매터를 새로 만든다.** 목록 한 행에
 * 한 번씩 불리면 그게 화면 비용의 대부분이 된다 — 2026-09-17 실측에서 2,144행 재렌더
 * 107.7ms 중 **82.5ms(77%)** 가 이 한 줄이었고, 아카이브 5년(1,803건)을 불러 두면
 * 검색 키 한 타가 **89.3ms** 였다(슬라이더 드래그 30틱이면 2.68초).
 * 같은 옵션이면 포매터를 하나만 만들어 돌려쓴다 — 같은 실측에서 **87.3ms → 2.0ms**.
 *
 * 키는 옵션을 그대로 직렬화한 것이라 **시간대 모드(`timeZoneMode`)가 바뀌면 자동으로
 * 갈라진다** — 모드 전환 때 캐시를 비울 필요가 없다(비우는 것을 잊으면 화면이 옛 시간대로
 * 굳는데, 그런 종류의 버그는 조용하다).
 *
 * `Intl` 은 모르는 시간대 이름에 `RangeError` 를 던진다(`fmtDateInZone` 주석 참조).
 * 여기서는 **null 을 돌려주고 부르는 쪽이 판단한다** — 지어내지 않는다.
 */
const _dateFmtCache = new Map();
function dateFormatter(opts) {
  const key = JSON.stringify(opts);
  let f = _dateFmtCache.get(key);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat("ko-KR", opts); }
    catch (_) { f = null; }
    _dateFmtCache.set(key, f);   // 실패도 캐시한다 — 매번 던지고 잡는 것도 비용이다
  }
  return f;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 라이브+아카이브 합본 재계산(라이브 id 우선, 아카이브 중복 제거). */
function rebuildAll() {
  const seen = new Set(launches.map((d) => d.id));
  allLaunches = launches.concat(archiveLaunches.filter((d) => !seen.has(d.id)));
}

function findLaunch(id) {
  return allLaunches.find((x) => String(x.id) === String(id));
}

function showStatus(msg) {
  const el = document.getElementById("status");
  if (!msg) { el.classList.add("hidden"); return; }
  el.textContent = msg;
  el.classList.remove("hidden");
}

/**
 * 시각 표시 옵션 — **모든 포맷터가 여기 한 곳을 거친다**(P13-5).
 * 갈라지면 화면의 한쪽은 현지, 한쪽은 UTC 가 되고 그건 표기가 없는 것보다 나쁘다.
 */
function tzOpts() {
  return timeZoneMode === "utc" ? { timeZone: "UTC" } : {};
}

/**
 * 지금 쓰는 시간대의 이름 — `UTC` 또는 실행 PC 의 시간대(`GMT+9` · `KST`). 순수 함수가 아니다
 * (모드와 브라우저 설정을 읽는다). 이름을 못 구하면 빈 문자열이다 — **지어내지 않는다**.
 */
function tzName() {
  if (timeZoneMode === "utc") return "UTC";
  const f = dateFormatter({ timeZoneName: "short" });
  if (!f) return "";
  const z = f.formatToParts(new Date()).find((p) => p.type === "timeZoneName");
  return (z && z.value) || "";
}

/** 시각 문자열 뒤에 붙일 접미사(` UTC` · ` GMT+9`). 이름이 없으면 아무것도 안 붙인다. */
function tzSuffix() {
  const n = tzName();
  return n ? " " + n : "";
}

/**
 * 시간대 설정과 화면 표기를 함께 바꾼다(P13-5).
 *
 * **툴바 버튼이 현재 시간대를 상시 보여주는 것**이 이 기능의 핵심이다 — 시각마다 접미사를
 * 붙이면 화면이 지저분해지고, 아무 데도 안 붙이면 지금 상태로 돌아간다.
 */
function setTimeZoneMode(mode) {
  timeZoneMode = mode === "utc" ? "utc" : "local";
  const btn = document.getElementById("tz-btn");
  if (btn) {
    const n = tzName();
    // 툴바가 빡빡하다 — 이모지와 이름 사이 공백을 빼 폭을 아낀다(P13-5 캡처에서 줄이 밀렸다)
    btn.textContent = "🕓" + (n || (timeZoneMode === "utc" ? "UTC" : "현지"));
    btn.classList.toggle("active", timeZoneMode === "utc");
    btn.title = timeZoneMode === "utc"
      ? "시각을 UTC 로 보고 있습니다 — 눌러서 현지 시각으로"
      : "시각을 현지 시각으로 보고 있습니다 — 눌러서 UTC 로";
  }
}

/** 토글 — 바뀐 시간대를 **이미 열려 있는 화면에도** 반영한다(안 하면 다시 열 때까지 옛 시각이 남는다). */
function toggleTimeZone() {
  setTimeZoneMode(timeZoneMode === "utc" ? "local" : "utc");
  saveSettings({ timeZone: timeZoneMode });
  refreshTimeViews();
}

/** 시각이 찍혀 있는 열린 화면들을 다시 그린다. */
function refreshTimeViews() {
  applyFilters();                                   // 사이드바 목록의 날짜
  if (typeof onTimeline === "function") onTimeline();  // 타임라인 라벨
  const panel = document.getElementById("panel");
  if (panel && !panel.classList.contains("hidden") && panelLaunchId) {
    const d = findLaunch(panelLaunchId);
    if (d) openPanel(d);
  }
  if (!document.getElementById("pass-panel").classList.contains("hidden")) showPasses();
  if (sidebarTab === "tonight") renderTonightList();
}

function fmtDate(iso, withZone) {
  if (!iso) return "미정";
  const d = new Date(iso);
  if (isNaN(d)) return escapeHtml(iso);
  const f = dateFormatter(Object.assign({
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }, tzOpts()));
  if (!f) return escapeHtml(iso);
  return f.format(d) + (withZone ? tzSuffix() : "");
}

/**
 * **발사장 현지** 시각(P14-2) — `America/Chicago` 같은 IANA 이름으로 찍는다.
 *
 * 툴바 스위치(P13-5)는 일부러 안 건드린다. "발사장 현지"는 **발사마다 다른 값**이라
 * 툴바가 상시 표시할 수 없고, 목록·타임라인에는 적용할 대상조차 정해지지 않는다
 * (한 화면에 발사장이 여럿이다). 그래서 상세 패널 한 줄로만 둔다.
 *
 * **`Intl` 은 모르는 시간대 이름에 `RangeError` 를 던진다** — 실행 PC 의 ICU 판이
 * 우리 것보다 낡으면 새로 생긴 이름에서 그렇게 되고, 그 예외 하나가 패널 전체를
 * 날린다. 읽을 수 없으면 **null 을 돌려주고 그 줄만 빠진다.**
 */
function fmtDateInZone(iso, tz) {
  if (!iso || !tz) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const f = dateFormatter({
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", timeZone: tz,
  });
  return f ? f.format(d) : null;   // 모르는 시간대 — 지어내지 않는다
}

/** 그 시간대의 짧은 이름(`GMT+8`). 못 구하면 빈 문자열 — 여기서도 지어내지 않는다. */
function zoneShortName(iso, tz) {
  if (!tz) return "";
  const f = dateFormatter({ timeZone: tz, timeZoneName: "short" });
  if (!f) return "";
  const z = f.formatToParts(new Date(iso || Date.now())).find((p) => p.type === "timeZoneName");
  return (z && z.value) || "";
}

/**
 * 발사장 현지 시각 문자열 — **지금 보고 있는 표기와 같으면 null**(같은 줄을 두 번 쓰지 않는다).
 *
 * 오프셋을 비교하지 않고 **찍힌 문자열을 비교한다** — 결과가 같은지가 중요하지
 * 어떤 경로로 같아졌는지는 중요하지 않다(일본 발사장은 한국과 같은 GMT+9 다).
 */
function padLocalTimeText(d) {
  const t = fmtDateInZone(d && d.net, d && d.pad_timezone);
  if (!t) return null;
  if (t === fmtDate(d.net)) return null;     // 내 시각과 같은 줄 — 생략
  const z = zoneShortName(d.net, d.pad_timezone);
  return z ? t + " " + z : t;
}

/** net까지 남은 시간 → "T-02:14:33" / 지났으면 "T+…" */
function countdown(iso) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  const sign = diff >= 0 ? "T-" : "T+";
  let s = Math.floor(Math.abs(diff) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const pad = (n) => String(n).padStart(2, "0");
  return sign + (d > 0 ? `${d}일 ` : "") + `${pad(h)}:${pad(m)}:${pad(s)}`;
}

const OUTCOME_LABEL = {
  upcoming: "예정", success: "성공", failure: "실패", partial: "부분 실패",
};

// 범주형 필드 한국어 매핑(고유명사는 번역하지 않고 원문 유지).
// 매핑에 없는 값은 tr()이 원문을 그대로 돌려준다.
const STATUS_KO = {
  "Launch Successful": "발사 성공",
  "Launch Failure": "발사 실패",
  "Launch was a Partial Failure": "부분 실패",
  "Go for Launch": "발사 준비 완료",
  "To Be Determined": "일정 미정",
  "To Be Confirmed": "일정 미확정",
  "In Flight": "비행 중",
  "Hold": "발사 보류",
  "Payload Deployed": "탑재체 전개 완료",
};
const ORBIT_KO = {
  "Low Earth Orbit": "지구 저궤도(LEO)",
  "Medium Earth Orbit": "지구 중궤도(MEO)",
  "Geostationary Transfer Orbit": "정지천이궤도(GTO)",
  "Geostationary Orbit": "정지궤도(GEO)",
  "Sun-Synchronous Orbit": "태양동기궤도(SSO)",
  "Polar Orbit": "극궤도",
  "Elliptical Orbit": "타원궤도",
  "Suborbital": "준궤도",
  "Lunar Orbit": "달 궤도",
  "Mars Orbit": "화성 궤도",
  "Sun-Earth L2": "태양–지구 L2",
  "Unknown": "미상",
};
const MISSION_TYPE_KO = {
  "Communications": "통신",
  "Earth Science": "지구 과학",
  "Government/Top Secret": "정부/기밀",
  "Test Flight": "시험 비행",
  "Technology": "기술 시연",
  "Navigation": "항법",
  "Planetary Science": "행성 과학",
  "Astrophysics": "천체물리",
  "Resupply": "보급",
  "Human Exploration": "유인 탐사",
  "Lunar Exploration": "달 탐사",
  "Dedicated Rideshare": "전용 라이드셰어",
  "Mission Extension": "임무 연장",
  "Tourism": "우주 관광",
  "Unknown": "미상",
};
// 참여 기관의 성격(P15-5). 라이브 18곳 실측에 네 값만 나왔다.
const AGENCY_TYPE_KO = {
  "Government": "정부",
  "Private": "민간",
  "Commercial": "상업",
  "Multinational": "다국적",
  "Educational": "교육",
  "Unknown": "미상",
};
const COUNTRY_KO = {
  USA: "미국", CHN: "중국", RUS: "러시아", KOR: "대한민국", JPN: "일본",
  FRA: "프랑스", IND: "인도", DEU: "독일", ITA: "이탈리아", GBR: "영국",
  ESP: "스페인", NZL: "뉴질랜드", LUX: "룩셈부르크", UKR: "우크라이나",
  IRN: "이란", ISR: "이스라엘", BRA: "브라질", CAN: "캐나다", AUS: "호주",
};

// 발사 순서 이벤트 이름(P13-1). LL2 `type.abbrev` 는 영어 약어라 그대로는 안 읽힌다.
// **표에 없으면 원문 그대로 나간다**(`tr`) — 새 이벤트가 생겨도 화면이 비지 않는다.
const TIMELINE_KO = {
  "GO for Prop Load": "추진제 주입 승인",
  "Stage 1 LOX Load": "1단 액체산소 주입",
  "Stage 2 LOX Load": "2단 액체산소 주입",
  "Stage 1 LNG Load": "1단 액화천연가스 주입",
  "Stage 2 LNG Load": "2단 액화천연가스 주입",
  "Stage 1 RP-1 Load": "1단 등유(RP-1) 주입",
  "Stage 2 RP-1 Load": "2단 등유(RP-1) 주입",
  "Stage 1 Propellant Load Complete": "1단 주입 완료",
  "Stage 2 Propellant Load Complete": "2단 주입 완료",
  "Engine Chill": "엔진 예냉",
  "GO for Launch": "발사 승인",
  "Flame Deflector Activation": "화염 유도판 가동",
  "Ignition": "점화",
  "Liftoff": "리프토프",
  "Max-Q": "최대 동압(Max-Q)",
  "MECO": "1단 엔진 정지(MECO)",
  "Stage 1 Separation": "1단 분리",
  "Stage 2 Separation": "2단 분리",
  "Fairing Separation": "페어링 분리",
  "SES-1": "2단 엔진 점화",
  "SES-2": "2단 엔진 재점화",
  "SECO-1": "2단 엔진 정지(SECO)",
  "SECO-2": "2단 엔진 2차 정지",
  "SEB-2": "2단 엔진 2차 연소",
  "Booster Boostback Burn Startup": "부스터 귀환 연소 시작",
  "Booster Boostback Burn Shutdown": "부스터 귀환 연소 종료",
  "Entry Burn Startup": "재진입 연소 시작",
  "Entry Burn Shutdown": "재진입 연소 종료",
  "Stage 1 Landing Burn": "1단 착륙 연소",
  "Stage 1 Landing": "1단 착륙",
  "Atmospheric Entry": "대기권 재진입",
  "Landing Flip": "착륙 자세 전환",
  "Payload Separation": "탑재체 분리",
  "Payload Deployment Sequence Start": "탑재체 전개 시작",
  "Payload Deployment Sequence End": "탑재체 전개 종료",
};

/** 절대 시각의 시:분:초 — 순서표에서 "몇 시에 일어나나"를 보여줄 때만 쓴다(P13-1). */
function fmtClock(ms) {
  const d = new Date(ms);
  if (isNaN(d)) return "";
  const f = dateFormatter(
    Object.assign({ hour: "2-digit", minute: "2-digit", second: "2-digit" }, tzOpts()));
  return f ? f.format(d) : "";
}

function tr(map, v) {
  if (v == null) return v;
  return map[v] || v;  // 매핑 없으면 원문 유지
}

/** 국가코드(단일 또는 콤마 다국) → 한국어. 다국이면 "유럽 다국적" 등으로. */
function countryKo(code) {
  if (!code) return "";
  if (code.includes(",")) return "다국적";
  return COUNTRY_KO[code] || code;
}

// ── 상세 패널·관점 화면 공용 행 (P14-4) ──────────────────────────────────────
// 발사 상세와 위성 상세가 같이 쓴다 — 분리 전에는 발사 상세 쪽에 있어서
// 위성 상세가 역방향으로 의존하는 모양이었다.
function row(k, v) {
  if (!v) return "";
  return `<div class="row"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`;
}

/**
 * 클릭하면 그 대상(발사장·기관·로켓·계열)만의 관점 화면으로 가는 행.
 *
 * `note` 는 **보이기만 하는 덧말**이다(P15-4 의 `변형 10종`). `data-val` 은 조회 키라
 * 여기에 섞으면 관점 화면이 아무것도 못 찾는다 — 그래서 표시와 키를 갈라 둔다.
 */
function entityRow(k, v, kind, note) {
  if (!v) return "";
  return `<div class="row"><div class="k">${escapeHtml(k)}</div><div class="v">` +
    `<button class="site-link" data-kind="${kind}" data-val="${escapeHtml(v)}">` +
    `${escapeHtml(v)}${note ? " · " + escapeHtml(note) : ""} ›</button></div></div>`;
}
