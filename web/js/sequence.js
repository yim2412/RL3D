/* RL3D — 발사 순서표 (P13-1).
 *
 * LL2 `timeline` 은 리프토프 기준 상대시각으로 된 이벤트 목록이다(추진제 로딩 → 점화 →
 * Max-Q → MECO → 단분리 → 착륙). **보류된 Phase 4(실시간 텔레메트리)에 가장 가까운 대체**다 —
 * 실측 중계는 못 받지만, "지금이 어느 단계인가"는 시각만으로 말할 수 있다.
 *
 * 파싱(ISO-8601 기간 → 초)은 파이썬이 끝내고(`api_parsing._parse_timeline`) 여기서는 숫자만 다룬다.
 * **실측(2026-09-12, 라이브 50건): 10% 에만 있다.** 없으면 블록을 안 그린다 —
 * 없는 게 정상인 필드라 "순서표 없음"이라고 설명하지 않는다.
 */

/** 초 → `T-50:00` · `T+2:18` · `T+1:05:12`. 순수 함수. */
function tMinus(sec) {
  const s = Math.abs(Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const body = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
  // 0 은 리프토프 순간이다 — `T-0:00` 도 `T+0:00` 도 아닌 `T±0:00` 이 정직하다
  return (sec === 0 ? "T±" : sec < 0 ? "T-" : "T+") + body;
}

/**
 * 지금 어느 단계인가 — { past, next } (각각 이벤트 또는 null). 순수 함수.
 *
 * `elapsed` 는 리프토프 기준 경과 초(음수 = 아직 전). 경계에서는 **같은 시각 이벤트를
 * 지난 것으로** 본다: 리프토프 순간에 `Liftoff` 가 "다음"으로 남아 있으면 틀려 보인다.
 */
function currentPhase(timeline, elapsed) {
  const list = timeline || [];
  let past = null, next = null;
  for (const e of list) {
    if (e.t <= elapsed) past = e;         // 정렬돼 들어오므로 마지막으로 덮인 것이 직전
    else if (next === null) next = e;
  }
  return { past, next };
}

/**
 * net(ISO 문자열) → ms. 읽을 수 없으면 null. 순수 함수.
 *
 * **`new Date(null)` 은 NaN 이 아니라 epoch 0 이다.** `isFinite` 만 보면 발사 시각이
 * 미정(`net: null`)인 발사에서 **1970년 기준으로** "MECO 지남"이 찍힌다 —
 * 예외도 없고 화면에는 그럴듯한 문장이 그대로 나온다(2026-09-12 테스트가 잡았다).
 */
function netMs(netIso) {
  if (typeof netIso !== "string" || !netIso) return null;
  const t = new Date(netIso).getTime();
  return isFinite(t) ? t : null;
}

/** 이벤트가 일어나는 절대 시각(ms) — net 을 모르면 null. 순수 함수. */
function eventTime(netIso, sec) {
  const base = netMs(netIso);
  return base == null ? null : base + sec * 1000;
}

/**
 * 절대 시각을 붙여도 되는가. 순수 함수.
 *
 * **`net_precision` 이 분 단위 아래면 붙이지 않는다** — 날짜만 확정된 발사에
 * `05:12:58 MECO` 를 찍는 것은 **없는 정밀도를 지어내는 것**이다(P12-3 에서 같은 자리를 겪었다).
 */
const PRECISE_NET = ["Second", "Minute"];
function canShowClock(netPrecision) {
  return PRECISE_NET.includes(netPrecision);
}

/** 순서표 HTML. `nowElapsed` 가 숫자면 그 시점의 단계를 강조한다. */
function timelineHtml(d, nowElapsed) {
  const tl = (d && d.timeline) || [];
  if (!tl.length) return "";
  const clock = canShowClock(d.net_precision);
  const cur = typeof nowElapsed === "number" ? currentPhase(tl, nowElapsed) : { past: null, next: null };
  const rows = tl.map((e) => {
    const isPast = cur.past && e === cur.past;
    const isNext = cur.next && e === cur.next;
    const cls = "sq-row" + (isPast ? " sq-past" : "") + (isNext ? " sq-next" : "");
    const at = clock ? eventTime(d.net, e.t) : null;
    const clockTxt = at != null
      ? `<span class="sq-clock">${escapeHtml(fmtClock(at))}</span>` : "";
    return `<div class="${cls}" title="${escapeHtml(e.desc || "")}">` +
      `<span class="sq-t">${escapeHtml(tMinus(e.t))}</span>` +
      `<span class="sq-n">${escapeHtml(tr(TIMELINE_KO, e.abbrev))}</span>${clockTxt}</div>`;
  }).join("");
  return `<div class="sq-wrap"><div class="sq-head">🕒 발사 순서 <span class="sq-note">` +
    `발사사 공개 계획 기준 · 실제 진행은 달라질 수 있습니다</span></div>${rows}</div>`;
}


/** 이 발사의 "지금 경과 초"(리프토프 기준). net 을 모르면 null — 강조를 하지 않는다. */
function launchElapsed(d) {
  const base = netMs(d && d.net);
  return base == null ? null : (Date.now() - base) / 1000;
}

/** 집중 화면용 한 줄 — "방금 Liftoff · 다음 Max-Q (58초 뒤)". 없으면 빈 문자열. */
function phaseLineHtml(d, nowMs) {
  const tl = (d && d.timeline) || [];
  if (!tl.length) return "";
  const base = netMs(d.net);
  if (base == null) return "";
  const elapsed = (nowMs - base) / 1000;
  const { past, next } = currentPhase(tl, elapsed);
  const parts = [];
  if (past) parts.push(`<b>${escapeHtml(tr(TIMELINE_KO, past.abbrev))}</b> 지남`);
  if (next) {
    const inSec = Math.max(0, Math.round(next.t - elapsed));
    parts.push(`다음 <b>${escapeHtml(tr(TIMELINE_KO, next.abbrev))}</b> ` +
      `<span class="sq-in">${escapeHtml(tMinus(next.t))} · ${inSec}초 뒤</span>`);
  }
  if (!parts.length) return "";
  return `<div class="focus-phase">${parts.join(" · ")}</div>`;
}
