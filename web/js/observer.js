/* RL3D — 관측 위치 지정 (P13-6).
 *
 * 통과 예측(P6-2)·오늘 밤(P12-2)은 관측 위치가 있어야 도는데, 지금까지 그 위치를 정하는
 * 길이 **지도 클릭 하나**뿐이었다. 자기 집을 지도에서 찾아 눌러야 했고, 안내는
 * "위성 패널의 관측지 지정을 누르라"고 하는데 **그 버튼은 위성을 골라야 나타난다** —
 * 기능을 시작하는 문턱이 거기 있었다.
 *
 * **외부 지오코딩은 쓰지 않는다.** 새 데이터 소스를 붙이면 정책·한도·에러 문구·스모크가
 * 따라오고 오프라인에서 못 쓴다. 대신 ① 번들한 도시 목록과 ② **이미 가진 발사장 좌표**를
 * 함께 검색한다 — 요청이 0 이다.
 */

/** 번들 도시 목록. 좌표는 소수 2자리(≈1km)면 관측 판정에 충분하다. */
const CITIES = [
  // 한국
  { ko: "서울", en: "Seoul", lat: 37.57, lng: 126.98 },
  { ko: "부산", en: "Busan", lat: 35.18, lng: 129.08 },
  { ko: "인천", en: "Incheon", lat: 37.46, lng: 126.71 },
  { ko: "대구", en: "Daegu", lat: 35.87, lng: 128.60 },
  { ko: "대전", en: "Daejeon", lat: 36.35, lng: 127.38 },
  { ko: "광주", en: "Gwangju", lat: 35.16, lng: 126.85 },
  { ko: "울산", en: "Ulsan", lat: 35.54, lng: 129.31 },
  { ko: "세종", en: "Sejong", lat: 36.48, lng: 127.29 },
  { ko: "수원", en: "Suwon", lat: 37.26, lng: 127.03 },
  { ko: "성남", en: "Seongnam", lat: 37.42, lng: 127.13 },
  { ko: "용인", en: "Yongin", lat: 37.24, lng: 127.18 },
  { ko: "고양", en: "Goyang", lat: 37.66, lng: 126.83 },
  { ko: "청주", en: "Cheongju", lat: 36.64, lng: 127.49 },
  { ko: "천안", en: "Cheonan", lat: 36.82, lng: 127.15 },
  { ko: "전주", en: "Jeonju", lat: 35.82, lng: 127.15 },
  { ko: "창원", en: "Changwon", lat: 35.23, lng: 128.68 },
  { ko: "김해", en: "Gimhae", lat: 35.23, lng: 128.89 },
  { ko: "포항", en: "Pohang", lat: 36.02, lng: 129.37 },
  { ko: "경주", en: "Gyeongju", lat: 35.86, lng: 129.22 },
  { ko: "안동", en: "Andong", lat: 36.57, lng: 128.73 },
  { ko: "춘천", en: "Chuncheon", lat: 37.88, lng: 127.73 },
  { ko: "원주", en: "Wonju", lat: 37.34, lng: 127.92 },
  { ko: "강릉", en: "Gangneung", lat: 37.75, lng: 128.90 },
  { ko: "속초", en: "Sokcho", lat: 38.21, lng: 128.59 },
  { ko: "여수", en: "Yeosu", lat: 34.76, lng: 127.66 },
  { ko: "목포", en: "Mokpo", lat: 34.81, lng: 126.39 },
  { ko: "통영", en: "Tongyeong", lat: 34.85, lng: 128.43 },
  { ko: "제주", en: "Jeju", lat: 33.50, lng: 126.53 },
  { ko: "서귀포", en: "Seogwipo", lat: 33.25, lng: 126.56 },
  // 아시아·오세아니아
  { ko: "도쿄", en: "Tokyo", lat: 35.68, lng: 139.69 },
  { ko: "오사카", en: "Osaka", lat: 34.69, lng: 135.50 },
  { ko: "베이징", en: "Beijing", lat: 39.90, lng: 116.41 },
  { ko: "상하이", en: "Shanghai", lat: 31.23, lng: 121.47 },
  { ko: "홍콩", en: "Hong Kong", lat: 22.32, lng: 114.17 },
  { ko: "타이베이", en: "Taipei", lat: 25.03, lng: 121.57 },
  { ko: "싱가포르", en: "Singapore", lat: 1.35, lng: 103.82 },
  { ko: "방콕", en: "Bangkok", lat: 13.76, lng: 100.50 },
  { ko: "하노이", en: "Hanoi", lat: 21.03, lng: 105.85 },
  { ko: "자카르타", en: "Jakarta", lat: -6.21, lng: 106.85 },
  { ko: "마닐라", en: "Manila", lat: 14.60, lng: 120.98 },
  { ko: "델리", en: "Delhi", lat: 28.61, lng: 77.21 },
  { ko: "뭄바이", en: "Mumbai", lat: 19.08, lng: 72.88 },
  { ko: "두바이", en: "Dubai", lat: 25.20, lng: 55.27 },
  { ko: "시드니", en: "Sydney", lat: -33.87, lng: 151.21 },
  { ko: "멜버른", en: "Melbourne", lat: -37.81, lng: 144.96 },
  { ko: "퍼스", en: "Perth", lat: -31.95, lng: 115.86 },
  { ko: "오클랜드", en: "Auckland", lat: -36.85, lng: 174.76 },
  // 유럽·아프리카
  { ko: "런던", en: "London", lat: 51.51, lng: -0.13 },
  { ko: "파리", en: "Paris", lat: 48.86, lng: 2.35 },
  { ko: "베를린", en: "Berlin", lat: 52.52, lng: 13.40 },
  { ko: "로마", en: "Rome", lat: 41.90, lng: 12.50 },
  { ko: "마드리드", en: "Madrid", lat: 40.42, lng: -3.70 },
  { ko: "암스테르담", en: "Amsterdam", lat: 52.37, lng: 4.90 },
  { ko: "스톡홀름", en: "Stockholm", lat: 59.33, lng: 18.07 },
  { ko: "헬싱키", en: "Helsinki", lat: 60.17, lng: 24.94 },
  { ko: "레이캬비크", en: "Reykjavik", lat: 64.15, lng: -21.94 },
  { ko: "모스크바", en: "Moscow", lat: 55.76, lng: 37.62 },
  { ko: "이스탄불", en: "Istanbul", lat: 41.01, lng: 28.98 },
  { ko: "카이로", en: "Cairo", lat: 30.04, lng: 31.24 },
  { ko: "나이로비", en: "Nairobi", lat: -1.29, lng: 36.82 },
  { ko: "케이프타운", en: "Cape Town", lat: -33.92, lng: 18.42 },
  { ko: "라고스", en: "Lagos", lat: 6.52, lng: 3.38 },
  // 아메리카
  { ko: "뉴욕", en: "New York", lat: 40.71, lng: -74.01 },
  { ko: "워싱턴", en: "Washington", lat: 38.91, lng: -77.04 },
  { ko: "시카고", en: "Chicago", lat: 41.88, lng: -87.63 },
  { ko: "휴스턴", en: "Houston", lat: 29.76, lng: -95.37 },
  { ko: "마이애미", en: "Miami", lat: 25.76, lng: -80.19 },
  { ko: "덴버", en: "Denver", lat: 39.74, lng: -104.99 },
  { ko: "시애틀", en: "Seattle", lat: 47.61, lng: -122.33 },
  { ko: "샌프란시스코", en: "San Francisco", lat: 37.77, lng: -122.42 },
  { ko: "로스앤젤레스", en: "Los Angeles", lat: 34.05, lng: -118.24 },
  { ko: "토론토", en: "Toronto", lat: 43.65, lng: -79.38 },
  { ko: "밴쿠버", en: "Vancouver", lat: 49.28, lng: -123.12 },
  { ko: "멕시코시티", en: "Mexico City", lat: 19.43, lng: -99.13 },
  { ko: "상파울루", en: "Sao Paulo", lat: -23.55, lng: -46.63 },
  { ko: "리마", en: "Lima", lat: -12.05, lng: -77.04 },
  { ko: "산티아고", en: "Santiago", lat: -33.45, lng: -70.67 },
  { ko: "부에노스아이레스", en: "Buenos Aires", lat: -34.60, lng: -58.38 },
];

const PLACE_RESULT_MAX = 8;

/** 위도·경도가 실제로 지구 위인가. 순수 함수. */
function validLatLng(lat, lng) {
  return typeof lat === "number" && typeof lng === "number" &&
    isFinite(lat) && isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * "37.5665, 126.978" · "37.5665 126.978" · "N37.5 E127" → {lat, lng}. 못 읽으면 null. 순수 함수.
 *
 * **첫 숫자가 위도다.** 순서를 뒤집어 받으면 관측지가 엉뚱한 곳에 서고, 통과 예측은
 * 조용히 다른 하늘을 계산한다 — 경고도 오류도 없다.
 */
function parseLatLng(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return null;
  const nums = s.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return null;
  let lat = parseFloat(nums[0]);
  let lng = parseFloat(nums[1]);
  // 남/서 표기를 음수로. 숫자 앞뒤 어디에 붙어도 받는다.
  if (/[sS남]/.test(s.split(nums[1])[0])) lat = -Math.abs(lat);
  if (/[wW서]/.test(s.slice(s.indexOf(nums[1]) - 3))) lng = -Math.abs(lng);
  return validLatLng(lat, lng) ? { lat, lng } : null;
}

/**
 * 검색어 → 후보 목록. 도시와 **이미 가진 발사장**을 함께 찾는다. 순수 함수.
 * 발사장을 넣는 이유: 데이터가 이미 있고, "발사장에서 보면 어떤가"가 이 앱에서 자연스럽다.
 */
function searchPlaces(q, launches) {
  const query = String(q || "").trim().toLowerCase();
  if (!query) return [];
  const out = [];
  for (const c of CITIES) {
    if (c.ko.toLowerCase().includes(query) || c.en.toLowerCase().includes(query)) {
      out.push({ kind: "city", name: c.ko, sub: c.en, lat: c.lat, lng: c.lng });
    }
  }
  const seen = new Set();
  for (const d of launches || []) {
    if (!d || !d.location_name || !validLatLng(d.lat, d.lng)) continue;
    if (seen.has(d.location_name)) continue;
    if (!d.location_name.toLowerCase().includes(query)) continue;
    seen.add(d.location_name);
    out.push({ kind: "pad", name: d.location_name, sub: "발사장", lat: d.lat, lng: d.lng });
  }
  return out.slice(0, PLACE_RESULT_MAX);
}

/** 관측 위치를 실제로 세운다 — **모든 지정 경로가 여기 한 곳으로 모인다**(지도 클릭 포함). */
function setObserver(lat, lng, label) {
  if (!validLatLng(lat, lng)) return false;
  observer = { lat: +lat.toFixed(4), lng: +lng.toFixed(4) };
  if (label) observer.label = label;
  saveSettings({ observer });
  showObserverMarker();
  updateSatCtrl();                       // 통과 예측 버튼 활성화
  if (sidebarTab === "tonight") renderTonightList();   // 막혀 있던 목록이 바로 채워진다
  if (map && map.flyTo) map.flyTo({ center: [observer.lng, observer.lat], zoom: 6, speed: 1.2 });
  return true;
}

/** 지금 관측 위치를 사람이 읽는 말로. 없으면 null. 순수 함수. */
function observerLabel() {
  if (!observer) return null;
  const coord = `${observer.lat.toFixed(2)}°, ${observer.lng.toFixed(2)}°`;
  return observer.label ? `${observer.label} (${coord})` : coord;
}

// ── 팝오버 ───────────────────────────────────────────────────────────────────
function obsPopoverHtml() {
  const cur = observerLabel();
  return `<div class="obs-head">📍 관측 위치</div>` +
    `<div class="obs-cur">${cur ? "현재: <b>" + escapeHtml(cur) + "</b>" : "아직 정하지 않았습니다"}</div>` +
    `<input id="obs-search" class="obs-input" type="text" placeholder="도시 · 발사장 이름 (예: 서울)" />` +
    `<div id="obs-results" class="obs-results"></div>` +
    `<input id="obs-coord" class="obs-input" type="text" placeholder="좌표 직접 입력 (예: 37.5665, 126.978)" />` +
    `<div id="obs-coord-msg" class="obs-msg"></div>` +
    `<div class="obs-btns">` +
      `<button id="obs-map-btn" class="btn sm">지도에서 클릭</button>` +
      (cur ? `<button id="obs-clear-btn" class="btn sm">해제</button>` : "") +
    `</div>`;
}

function renderObsResults(q) {
  const box = document.getElementById("obs-results");
  if (!box) return;
  const rows = searchPlaces(q, allLaunches);
  if (!rows.length) {
    box.innerHTML = q ? `<div class="obs-empty">일치하는 곳이 없습니다 — 좌표로 넣거나 지도를 클릭하세요</div>` : "";
    return;
  }
  box.innerHTML = rows.map((r, i) =>
    `<button class="obs-row" data-i="${i}">` +
    `<span class="obs-name">${escapeHtml(r.name)}</span>` +
    `<span class="obs-sub">${escapeHtml(r.sub)}</span></button>`).join("");
  box.querySelectorAll(".obs-row").forEach((b) => b.addEventListener("click", () => {
    const r = rows[+b.dataset.i];
    if (r) { setObserver(r.lat, r.lng, r.name); closeObsPopover(); }
  }));
}

function openObsPopover() {
  const box = document.getElementById("obs-popover");
  if (!box) return;
  box.innerHTML = obsPopoverHtml();
  box.classList.remove("hidden");
  const search = document.getElementById("obs-search");
  if (search) {
    search.addEventListener("input", () => renderObsResults(search.value));
    if (search.focus) search.focus();
  }
  const coord = document.getElementById("obs-coord");
  if (coord) coord.addEventListener("change", () => {
    const p = parseLatLng(coord.value);
    const msg = document.getElementById("obs-coord-msg");
    if (p) { setObserver(p.lat, p.lng); closeObsPopover(); }
    else if (msg) msg.textContent = "위도, 경도 두 숫자로 넣어 주세요 (예: 37.5665, 126.978)";
  });
  const mapBtn = document.getElementById("obs-map-btn");
  if (mapBtn) mapBtn.addEventListener("click", () => { closeObsPopover(); beginSetObserver(); });
  const clearBtn = document.getElementById("obs-clear-btn");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    observer = null;
    saveSettings({ observer: null });
    if (observerMarker && observerMarker.remove) observerMarker.remove();
    updateSatCtrl();
    if (sidebarTab === "tonight") renderTonightList();
    closeObsPopover();
  });
}

function closeObsPopover() {
  const box = document.getElementById("obs-popover");
  if (box) box.classList.add("hidden");
}

function toggleObsPopover() {
  const box = document.getElementById("obs-popover");
  if (!box) return;
  if (box.classList.contains("hidden")) openObsPopover(); else closeObsPopover();
}
