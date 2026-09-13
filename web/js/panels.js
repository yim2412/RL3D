/* RL3D — 발사 상세 패널. 관심/사이드바/위성/통계는 같은 이름의 파일로 분리(P14-4). */

// ── 발사 상세 패널 ────────────────────────────────────────────────────────────
/**
 * 큰 수를 자릿수에 맞는 단위로. 1,234 를 "1234" 로 찍으면 읽히지 않는다(P13-3 과 같은 갈래).
 *
 * **물리량의 `0` 은 "모름"이라 버린다**(P15-2). LL2 는 안 채운 제원을 `0` 으로도 주는데,
 * `"0 kg"` 은 **truthy 문자열이라 호출부의 `.filter(x => x[1])` 를 그대로 통과**해서
 * `LEO 탑재량 0 kg` 이 화면에 떴다(실측: GSLV Mk. II). 길이 0m 인 로켓은 없다.
 * 횟수의 `0` 은 여기 안 온다 — 통산 성적은 아래 `record` 가 따로 읽고, 거기선 0 이 정상값이다.
 */
function fmtQty(v, unit) {
  if (v == null || !isFinite(v) || Number(v) === 0) return null;
  if (unit === "kg" && v >= 1000) return (v / 1000).toLocaleString("ko-KR") + " t";
  if (unit === "kN" && v >= 1000) return Math.round(v / 1000).toLocaleString("ko-KR") + " MN";
  return v.toLocaleString("ko-KR") + " " + unit;
}

/** 달러 금액을 한국어 단위로 — `52000000` → `5,200만 달러`. 실측 범위 600만~9,000만. */
function fmtUsd(v) {
  if (v == null || !isFinite(v) || Number(v) <= 0) return null;
  const man = Number(v) / 10000;
  return (Number.isInteger(man) ? man.toLocaleString("ko-KR") : Math.round(man).toLocaleString("ko-KR")) + "만 달러";
}

/**
 * 공시가 ÷ LEO 최대 탑재량 → `$2,281`(P15-2). 로켓끼리 값을 견주는 업계 표준 지표다.
 *
 * **탑재량이 0 이거나 없으면 안 만든다** — 0 으로 나누면 `Infinity` 가 나오는데
 * `isFinite` 를 안 보면 `$Infinity` 가 그대로 화면에 실린다(GSLV Mk. II 가 `leo_capacity: 0`).
 */
function costPerKg(cost, leoKg) {
  // 방어를 **한 줄로** 둔다. 앞에 `if (!cost || !leoKg)` 를 겹쳐 뒀더니, 둘 중 하나를
  // 지우는 변이가 **나머지에 막혀 전부 통과**했다 — 방어를 뜯어도 테스트가 조용했다.
  // 나눗셈 결과 하나만 보면 네 경우가 다 걸린다: 0 나눗셈·NaN·null(→0)·음수.
  const v = Number(cost) / Number(leoKg);
  if (!isFinite(v) || v <= 0) return null;
  return "$" + Math.round(v).toLocaleString("ko-KR");
}

/**
 * 참여 기관 한 곳의 표시 이름(P15-5).
 *
 * **긴 이름일 때만 약어를 쓴다.** 약어가 늘 나은 게 아니다 — 실측 18곳 중
 * `BlackSky`→`BS` · `HawkEye 360`→`he360` 처럼 **약어가 원래 이름보다 못한** 경우가 있다.
 * 반대로 `European Organisation for the Exploitation of Meteorological Satellites`(66자)는
 * 줄이지 않으면 줄을 통째로 밀어낸다 → `EUMETSAT`.
 */
function agencyLabel(a) {
  if (!a || !a.name) return null;
  const label = (a.abbrev && a.name.length > 24) ? a.abbrev : a.name;
  const t = tr(AGENCY_TYPE_KO, a.type);
  return t && t !== a.type ? `${label} (${t})` : label;
}

/** "누구를 위한 발사인가"(P15-5). 제공자 자신은 파싱에서 이미 빠져 있다. */
function missionAgenciesText(list) {
  const parts = (list || []).map(agencyLabel).filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * 착륙 통산 한 줄(P15-3) — `착륙 620회 시도 · 성공 615 (99%) · 연속 315`.
 *
 * **시도가 0 이면 null.** 소모형 로켓·기관은 착륙을 안 하는 것이지 실패한 게 아니다
 * (실측: Arianespace · ULA · ROSCOSMOS · JAXA 가 전부 0).
 * **실패는 받은 값만 쓴다** — `시도-성공` 으로 유도하면 안 된다. 실측 SpaceX 가
 * `699 시도 · 671 성공 · 29 실패` 인데 671+29 = 700 으로 **LL2 값끼리 안 맞는다.**
 * **성공 0 은 살린다** — Starship V3 의 `2 시도 0 성공` 은 지워야 할 빈 값이 아니다.
 */
function landingRecord(att, ok, fail, streak) {
  if (!att || !isFinite(att)) return null;
  const parts = [`착륙 ${Number(att).toLocaleString()}회 시도`];
  if (ok != null && isFinite(ok)) parts.push(`성공 ${Number(ok).toLocaleString()} (${Math.round((ok / att) * 100)}%)`);
  if (fail != null && isFinite(fail) && fail > 0) parts.push(`실패 ${Number(fail).toLocaleString()}`);
  if (streak != null && isFinite(streak) && streak > 0) parts.push(`연속 ${Number(streak).toLocaleString()}`);
  return parts.join(" · ");
}

/** 로켓 제원·통산 성적(P14-1). 상세 패널의 로켓이 이름 한 줄뿐이었다. */
function rocketSpecBlock(d) {
  const sp = d.rocket_spec;
  if (!sp) return "";
  const items = [
    ["길이", fmtQty(sp.length, "m")],
    ["지름", fmtQty(sp.diameter, "m")],
    ["이륙 질량", fmtQty(sp.launch_mass, "t")],
    ["LEO 탑재량", fmtQty(sp.leo_capacity, "kg")],
    // 정지천이궤도 탑재량(P15-6). LEO 와 짝이라 바로 뒤에 둔다.
    // **LEO 가 0(모름)인데 GTO 는 있는 로켓이 있다** — 둘을 따로 걸러야 한다.
    ["GTO 탑재량", fmtQty(sp.gto_capacity, "kg")],
    ["이륙 추력", fmtQty(sp.to_thrust, "kN")],
    // 공시 발사가와 그 kg 당 값(P15-2). 재사용 로켓의 경제성이 여기서 드러난다 —
    // 실측 Electron $20,000/kg 대 Falcon Heavy $1,411/kg 로 14배 차이다.
    ["공시 발사가", fmtUsd(sp.cost)],
    ["LEO kg당", costPerKg(sp.cost, sp.leo_capacity)],
    ["단 수", sp.max_stage != null ? sp.max_stage + "단" : null],
    ["첫 비행", sp.maiden_flight],
    ["형식", sp.reusable == null ? null : (sp.reusable ? "재사용형" : "소모형")],
  ].filter((x) => x[1]);
  // 통산은 **0 을 살려서** 읽는다 — `fail: 0` 은 지워야 할 빈 값이 아니라 좋은 소식이다.
  let record = "";
  if (sp.total != null) {
    const parts = [`통산 ${sp.total}회`];
    if (sp.success != null) parts.push(`성공 ${sp.success}`);
    if (sp.fail != null) parts.push(`실패 ${sp.fail}`);
    if (sp.streak != null && sp.streak > 0) parts.push(`연속 성공 ${sp.streak}`);
    record = `<div class="spec-record">${escapeHtml(parts.join(" · "))}</div>`;
  }
  // 착륙은 발사 통산과 **다른 줄**로 둔다 — 한 줄에 붙이면 일곱 조각이 되어 안 읽힌다(P15-3)
  const land = landingRecord(sp.land_att, sp.land_ok, sp.land_fail, sp.land_streak);
  if (land) record += `<div class="spec-record">${escapeHtml(land)}</div>`;
  if (!items.length && !record) return "";
  const grid = items.map(([k, v]) =>
    `<div class="spec-i"><span class="spec-k">${escapeHtml(k)}</span>` +
    `<span class="spec-v">${escapeHtml(String(v))}</span></div>`).join("");
  return `<div class="spec-block"><div class="spec-h">로켓 제원</div>` +
    `${record}<div class="spec-grid">${grid}</div></div>`;
}

/** 부스터 1개의 비행 횟수 문장. **`flights` 는 이번 비행 직전까지의 횟수다.**
 *
 * LL2 는 `flights=28` 인 B1080 을 같은 응답에서 "after its 29th flight" 라고 부른다 —
 * 그대로 "28번째"라고 쓰면 매번 하나씩 어긋난다.
 * `0`(신조)과 `null`(부스터 미배정)은 **다른 뜻**이라 한 문장으로 접지 않는다.
 */
function boosterFlightText(b) {
  if (b.flights == null) return null;          // 미배정 — 횟수 줄을 아예 안 낸다
  if (b.flights === 0) return "첫 비행";
  return `${b.flights + 1}번째 비행`;
}

/** 착륙은 **네 상태**다. 예정 발사는 `success=null`·`attempt=true` 로 오므로
 *  `success` 만 보면 아직 날지도 않은 발사가 전부 "착륙 실패"가 된다. */
function boosterLandingText(b) {
  if (b.landing_attempt === false) return "착륙 시도 안 함";
  if (b.landing_attempt !== true) return null;     // 모름 — 지어내지 않는다
  const where = b.landing_name ? " · " + b.landing_name : "";
  if (b.landing_success === true) return "착륙 성공" + where;
  if (b.landing_success === false) return "착륙 실패" + where;
  return "착륙 시도 예정" + where;
}

/** 부스터 재사용 이력(P14-1). 실측 지난 26/50 · 예정 15/50 — 없으면 블록을 안 그린다. */
function boostersBlock(d) {
  const list = d.boosters || [];
  if (!list.length) return "";
  const rows = list.map((b) => {
    const sub = [boosterFlightText(b), boosterLandingText(b)].filter(Boolean).join(" · ");
    // **"신조"는 `reused === false` 가 아니라 `flights === 0` 일 때만 붙인다.**
    // LL2 는 Pallas1 F1 을 `reused=false`·`flights=1` 로 준다 — 그대로 옮기면 화면에
    // **"신조 · 2번째 비행"** 이라는 앞뒤 안 맞는 문장이 나온다(2026-09-13 실제 캐시에서 발견).
    // 두 값이 어긋나면 **더 구체적인 쪽(횟수)을 남기고 태그를 뺀다.**
    const tag = b.reused === true ? `<span class="bst-tag">재사용</span>`
              : b.flights === 0 ? `<span class="bst-tag bst-new">신조</span>` : "";
    return `<div class="bst-row"><span class="bst-id">${escapeHtml(b.serial)}</span>${tag}` +
      (sub ? `<span class="bst-sub">${escapeHtml(sub)}</span>` : "") + `</div>`;
  }).join("");
  return `<div class="spec-block"><div class="spec-h">부스터</div>${rows}</div>`;
}

/** 외부 링크는 파이썬 브릿지로 기본 브라우저에서 연다(http/https만 허용됨). */
function openExternal(url) {
  if (!url) return;
  try { window.pywebview.api.open_url(url); } catch (_) { /* 브릿지 없으면 무시 */ }
}

/** 실패/지연 사유처럼 강조가 필요한 긴 텍스트 블록. */
function reasonBlock(label, text, kind) {
  return `<div class="reason reason-${kind}">` +
    `<div class="reason-k">${escapeHtml(label)}</div>` +
    `<div class="reason-v">${escapeHtml(text)}</div></div>`;
}

/** net_precision 이 초 단위가 아니면 카운트다운을 곧이곧대로 믿으면 안 된다. */
const NET_PRECISION_KO = {
  Second: null, Minute: null,        // 확정에 가까움 — 따로 알리지 않음
  Hour: "시각이 시간 단위까지만 확정",
  Day: "날짜만 확정 (시각 미정)",
  Week: "주 단위로만 확정",
  Month: "월 단위로만 확정",
  Quarter: "분기 단위로만 확정",
  Year: "연 단위로만 확정",
};

/** net_precision → 경고 문구(없으면 null).
 *  LL2 는 **"Quarter 4" · "Year Half 2" 처럼 뒤에 숫자를 붙여** 보낸다 — 표에 정확히 일치하는
 *  키가 없어 경고가 조용히 안 뜨고 있었다(2026-09-11 캐시 97건 중 8건). 앞 단어로 맞춘다. */
function netPrecisionNote(p) {
  if (!p) return null;
  if (p in NET_PRECISION_KO) return NET_PRECISION_KO[p];
  if (p.startsWith("Year Half")) return "반기 단위로만 확정";
  if (p.startsWith("Quarter")) return "분기 단위로만 확정";
  if (p.startsWith("Year")) return "연 단위로만 확정";
  return `${p} 단위로만 확정`;  // 모르는 값도 알린다 — 넘어가면 정밀도를 속이게 된다
}

/** 발사 윈도우가 net 과 다른 구간을 가질 때만 "22:45~00:15 (90분)" 로 보여준다. */
function windowText(d) {
  if (!d.window_start || !d.window_end) return null;
  const s = new Date(d.window_start), e = new Date(d.window_end);
  if (isNaN(s) || isNaN(e) || e <= s) return null;
  const mins = Math.round((e - s) / 60000);
  if (mins < 2) return null;  // 순간 발사(instantaneous)면 net 과 같아 의미 없음
  const hhmm = (dt) => dt.toLocaleTimeString("ko-KR",
    Object.assign({ hour: "2-digit", minute: "2-digit" }, tzOpts()));
  const dur = mins >= 60 ? `${Math.floor(mins / 60)}시간 ${mins % 60 ? (mins % 60) + "분" : ""}`.trim() : `${mins}분`;
  return `${hhmm(s)} ~ ${hhmm(e)} (${dur})`;
}

/** 중계 링크 버튼들. 클릭 시 파이썬 브릿지로 기본 브라우저에서 연다. */
function vidLinksBlock(d) {
  const vids = d.vid_urls || [];
  if (!vids.length) return "";
  const live = d.webcast_live ? `<span class="live-badge">● 생중계 중</span>` : "";
  const btns = vids.map((v) =>
    `<button class="vid-btn" data-url="${escapeHtml(v.url)}" title="${escapeHtml(v.url)}">` +
    `▶ ${escapeHtml(v.title)}</button>`).join("");
  return `<div class="vid-block"><div class="vid-head">중계 ${live}</div>${btns}</div>`;
}

/** "이 발사대 285번째 · SpaceX 올해 90번째" — 숫자 하나로 맥락이 생긴다. */
/**
 * 발사대 재사용 간격 → 사람이 읽는 말 (P13-3). 순수 함수.
 *
 * 실측(라이브 100건)에서 **2.79일 ~ 1541일**까지 온다 — 같은 단위로는 둘 다 안 읽힌다
 * (`0.008년` 도 `1541.0일` 도 못 읽는다). 크기에 따라 단위를 바꾼다.
 */
function turnaroundText(sec) {
  if (typeof sec !== "number" || !isFinite(sec) || sec <= 0) return null;
  const days = sec / 86400;
  if (days < 1 / 24) return `${Math.round(sec / 60)}분`;
  if (days < 1) return `${Math.round(days * 24)}시간`;
  if (days < 10) return `${days.toFixed(1)}일`;
  if (days < 60) return `${Math.round(days)}일`;
  if (days < 730) return `${Math.round(days / 30.44)}개월`;
  return `${(days / 365.25).toFixed(1)}년`;
}

/**
 * "이 발사대 296번째(올해 58)" — 한 축의 두 기준을 한 조각으로(P15-1).
 *
 * **둘이 같으면 괄호를 안 붙인다.** 새로 만든 발사대는 `통산 1 · 올해 1` 로 와서
 * `1번째(올해 1)` 이 되는데, 실측 라이브 100건에 그런 발사가 있었다 — 정보량 0인 괄호다.
 * 반쪽이 없거나 0 이어도 안 붙인다(`orbital_count` 는 옛 발사에서 `null`·`0` 으로 온다).
 */
function countPair(label, main, sub, subLabel) {
  if (!main) return null;
  const head = `${label} ${Number(main).toLocaleString()}번째`;
  if (!sub || Number(sub) === Number(main)) return head;
  return `${head}(${subLabel} ${Number(sub).toLocaleString()})`;
}

function contextText(d) {
  const parts = [];
  // 네 축 모두 "통산과 올해"를 함께 말한다(P15-1). 전에는 축마다 한쪽만 말해서,
  // `이 발사장 통산 912번째 · SpaceX 올해 108번째` 처럼 **기준이 다른 숫자가 나란히** 섰다.
  const pad = countPair("이 발사대", d.pad_count, d.pad_year_count, "올해");
  if (pad) parts.push(pad);
  const ta = turnaroundText(d.pad_turnaround_sec);
  if (ta) parts.push(`직전 발사로부터 ${ta} 만`);
  const loc = countPair("이 발사장 통산", d.location_count, d.location_year_count, "올해");
  if (loc) parts.push(loc);
  const ag = countPair(`${d.provider || "이 기관"} 올해`, d.agency_year_count, d.agency_count, "통산");
  if (ag) parts.push(ag);
  const orb = countPair("전 세계 올해", d.orbital_year_count, d.orbital_count, "통산");
  if (orb) parts.push(orb + " 궤도 발사");
  return parts.length ? parts.join(" · ") : null;
}

function updatesBlock(d) {
  const ups = d.updates || [];
  if (!ups.length) return "";
  const rows = ups.map((u) => {
    const when = u.created_on ? fmtDate(u.created_on) : "";
    const link = u.info_url
      ? `<button class="up-link" data-url="${escapeHtml(u.info_url)}">원문</button>` : "";
    return `<div class="up-row"><div class="up-when">${escapeHtml(when)}${link}</div>` +
           `<div class="up-text">${escapeHtml(u.comment)}</div></div>`;
  }).join("");
  return `<div class="updates"><div class="updates-head">발사 소식</div>${rows}</div>`;
}

function openPanel(d) {
  const panel = document.getElementById("panel");
  const body = document.getElementById("panel-body");
  const cd = d.outcome === "upcoming"
    ? `<div class="cd" data-net="${escapeHtml(d.net)}">${escapeHtml(countdown(d.net))}</div>` : "";
  const precision = netPrecisionNote(d.net_precision);
  const progs = (d.programs || []).map((p) =>
    `<span class="prog-tag">${escapeHtml(p)}</span>`).join("");
  // 발사 궤적 근사선(P12-4) — 그리고, 무엇을 가정했는지를 **패널 위쪽에** 적는다.
  // 선만 그리고 가정을 안 적으면 실측처럼 읽힌다(이 항목의 유일한 전제 조건).
  const ascentInfo = ascentNoteHtml(ascentNote(drawAscentPath(d)));
  body.innerHTML = `
    ${d.image ? `<img src="${escapeHtml(d.image)}" alt="" onerror="this.remove()" />` : ""}
    <h2>${escapeHtml(d.name)}</h2>
    ${d.patch ? `<img class="patch" src="${escapeHtml(d.patch)}" alt="" onerror="this.remove()" />` : ""}
    <span class="badge m-${d.outcome}">${escapeHtml(tr(STATUS_KO, d.status) || OUTCOME_LABEL[d.outcome])}</span>
    ${favBtnHtml("launch", d.id)}
    ${progs}
    ${cd}
    ${precision ? `<div class="net-precision">⚠ ${escapeHtml(precision)}</div>` : ""}
    ${ascentInfo}
    ${vidLinksBlock(d)}
    ${d.fail_reason ? reasonBlock("실패 사유", d.fail_reason, "fail") : ""}
    ${d.hold_reason ? reasonBlock("지연·보류 사유", d.hold_reason, "warn") : ""}
    ${d.weather_concerns ? reasonBlock("기상 우려", d.weather_concerns, "warn") : ""}
    ${row("발사 시각", fmtDate(d.net, true))}
    ${row("발사장 현지", padLocalTimeText(d))}
    ${row("발사 윈도우", windowText(d))}
    ${row("발사 확률", d.probability != null && d.probability >= 0 ? d.probability + "%" : null)}
    ${entityRow("로켓", d.rocket, "rocket")}
    ${rocketSpecBlock(d)}
    ${boostersBlock(d)}
    ${entityRow("기관", d.provider, "provider")}
    ${row("참여 기관", missionAgenciesText(d.mission_agencies))}
    ${row("국가", countryKo(d.provider_country))}
    ${row("미션", d.mission_name)}
    ${row("종류", tr(MISSION_TYPE_KO, d.mission_type))}
    ${row("궤도", tr(ORBIT_KO, d.orbit))}
    ${entityRow("발사장", d.location_name, "site")}
    ${row("패드", d.pad_name)}
    ${row("기록", contextText(d))}
    ${d.mission_desc ? `<div class="mission-desc">${escapeHtml(d.mission_desc)}</div>` : ""}
    ${updatesBlock(d)}
    ${timelineHtml(d, launchElapsed(d))}
  `;
  // 링크는 파이썬 브릿지로만 연다(창 안에서 열리면 지도로 못 돌아온다)
  body.querySelectorAll(".vid-btn, .up-link").forEach((b) =>
    b.addEventListener("click", () => openExternal(b.dataset.url)));
  body.querySelectorAll(".site-link").forEach((b) =>
    b.addEventListener("click", () => showEntityStats(b.dataset.kind, b.dataset.val)));
  bindFavBtn(body);
  satPanelId = null;  // 발사 상세를 열면 위성 상세 라이브 갱신은 중지
  panelLaunchId = String(d.id);  // 시간대를 바꾸면 이 패널을 다시 그린다(P13-5)
  panel.classList.remove("hidden");
  // 좌표 없는 발사(목록에서 열 수 있음)는 flyTo가 NaN이 되므로 좌표가 있을 때만 이동
  if (typeof d.lng === "number" && typeof d.lat === "number")
    map.flyTo({ center: [d.lng, d.lat], zoom: 4.5, speed: 1.2 });
}

function closePanel() {
  document.getElementById("panel").classList.add("hidden");
  satPanelId = null;
  panelLaunchId = null;
  clearAscentPath();   // 패널을 닫으면 근사선도 같이 지운다(P12-4) — 남으면 무엇의 선인지 알 수 없다
}
