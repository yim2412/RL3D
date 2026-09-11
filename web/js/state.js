/* RL3D — 상태 변수와 상수. 다른 파일들이 여기 값을 읽고 쓴다(클래식 스크립트라 최상위 let 이 공유된다). */

// ── 상태 ─────────────────────────────────────────────────────────────────────
let map = null;
let launches = [];          // 라이브 발사(예정+최근 previous). 5분마다 갱신되며 통째 교체됨
let archiveLaunches = [];   // 불러온 과거 연도 발사(P7-5). 라이브 갱신에 안 지워짐
let loadedYears = new Set();// 이미 불러온 아카이브 연도
let allLaunches = [];       // 라이브+아카이브 합본(id 중복 제거) — 필터/목록/타임라인이 사용
let tickerTimer = null;

let satrecs = [];           // { name, norad, rec } — satellite.js SGP4 레코드
// 위성 메타데이터(P12-5). { norad(문자열): {type, owner, launch_date, ...} }
// **없어도 위성은 그대로 뜬다** — 상세 패널이 있는 값만 채운다.
let satcat = {};
let satTimer = null;        // 위성 위치 갱신 타이머(초당)

let selectedSat = null;     // 선택된 위성 { name, norad, rec } — 지상궤적/추적 대상
let tracking = false;       // 추적 모드(지도 중심을 위성에 고정)
let trackTimer = null;      // 지상궤적선 주기적 재계산 타이머

let satPanelId = null;      // 상세 패널이 열려 있는 위성 norad(매 초 값 갱신용)
let observer = null;        // 관측 위치 { lat, lng } — 통과 예측 기준(settings.json 저장)
let observerMarker = null;  // 지도 위 관측 위치 마커
let settingObserver = false;  // 지도 클릭으로 관측 위치 지정 중인지

const EMPTY_FC = { type: "FeatureCollection", features: [] };
const DEG = Math.PI / 180;

let terminatorTimer = null;  // 낮/밤 오버레이 분 단위 갱신 타이머

let autoTimer = null;       // 발사 자동 갱신 타이머
let focusTimer = null;      // 발사 임박 집중 화면 갱신 타이머(P12-3, 초당)
const AUTO_REFRESH_MS = 5 * 60 * 1000;  // 5분마다 폴링(실제 API는 캐시 TTL이 제어)

let satGroups = ["stations", "visual"];  // 선택된 위성 그룹(P7-6). 설정으로 덮어씀
let satBands = { leo: true, meo: true, geo: true };  // 궤도 대역 필터(P11-3). 설정으로 덮어씀
// 종류·소유국 필터(P12-5b). **끈 것만** 담는다 — 켠 것을 담으면 새로 나타난 종류/나라가
// 목록에 없어서 조용히 숨겨진다(SATCAT 은 나라 코드가 130종이고 그룹마다 달라진다).
// 값이 없으면 보인다 = 기본은 전부 켜짐.
let satTypesOff = {};    // { "로켓 몸체": true, ... }
let satOwnersOff = {};   // { "미국": true, ... }
let lastLaunchLoad = null;  // 마지막 발사 데이터 기준 시각(ms) — "N분 전 갱신"(P7-7)

// 관심 목록(P11-2) — id/norad 는 항상 문자열로 넣는다(LL2 id는 문자열, NORAD는 숫자로 와 섞인다)
let favLaunches = new Set();
let favSats = new Set();

let tlMin = null, tlMax = null;   // 타임라인 net 범위(ms)
let timelineMax = null;           // 이 시각 이하의 발사만 표시(null=무제한)
let timelineInited = false;
