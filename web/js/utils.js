/* RL3D — 이스케이프·시간 포맷·발사 조회 같은 순수 유틸. */

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

function fmtDate(iso) {
  if (!iso) return "미정";
  const d = new Date(iso);
  if (isNaN(d)) return escapeHtml(iso);
  return d.toLocaleString("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
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
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
