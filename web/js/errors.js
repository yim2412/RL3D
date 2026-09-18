/* RL3D — 프론트 예외를 로그와 화면으로 내보내는 통로 (P23-1).
 *
 * `applog.install_excepthook()` 의 docstring 이 이유를 이미 적어 뒀다 —
 * *"GUI 에선 traceback 이 아무 데도 안 남는다"*. **그 논리가 JS 쪽에는 적용돼
 * 있지 않았다**: 2026-09-18 실측으로 `window.onerror`·`unhandledrejection` 0건 ·
 * 브릿지에 로그 통로 없음 · 로그 5일치에 ERROR 0건이었고, 그 사이 코드의 72%
 * (JS 4,557줄 대 파이썬 1,739줄)가 침묵하고 있었다.
 *
 * **이 파일은 다른 앱 파일에 의존하지 않는다** — 가장 먼저 로드돼 다른 파일이
 * 로드 중에 던지는 것까지 잡아야 하므로 `showStatus`·`escapeHtml` 을 쓸 수 없다.
 * 화면 출력은 `textContent` 로만 한다(그래서 XSS 도 구조적으로 막힌다).
 */

// ── 상수 (전역 규칙 6: 튜닝 값은 파일 상단 한 곳에) ───────────────────────────
// 억제가 **필수**인 이유는 실측이다(2026-09-18): `updateFocus`·`updateSatellitePositions`
// 가 매초 도는데 `setInterval` 콜백은 던져도 멈추지 않고 계속 뛴다. JS 오류 줄은
// 메시지+스택+`url:line` 이라 300바이트급이고, 로그는 512KB·백업 3이다
// → 억제가 없으면 **29분에 한 바퀴, 116분이면 백업까지 덮여 최초 증거가 사라진다.**
// 두 번째 이유는 UI 스레드다: `webview/util.py` 가 브릿지 호출마다 Thread 를 만든다(P22-3).
const ERR_COOLDOWN_MS = 60000;    // 같은 오류를 다시 남기기까지
const ERR_SESSION_CAP = 50;       // 세션당 기록 상한(넘으면 마지막 한 줄만)
const ERR_QUEUE_CAP = 20;         // 브릿지가 아직 없을 때 쌓아 두는 최대 건수
const ERR_STACK_LINES = 6;        // 스택은 앞쪽 몇 줄만
const ERR_MAX_CHARS = 1800;       // 한 건의 최대 길이(파이썬 쪽에서도 자른다)
const ERR_BANNER_TEXT =
  "앱 내부에서 오류가 발생했습니다. 일부 기능이 동작하지 않을 수 있습니다 — "
  + "새로고침(R)으로 낫지 않으면 %APPDATA%\\RL3D\\logs\\rl3d.log 를 확인해 주세요.";

const errState = {
  seen: new Map(),      // 오류 키 → 마지막으로 기록한 시각
  logged: 0,            // 실제로 기록한 건수
  suppressed: 0,        // 쿨다운으로 접은 건수
  capNoted: false,      // 상한 안내를 이미 남겼는가
  bannerShown: false,   // 배너를 이미 띄웠는가(세션당 한 번)
  queue: [],            // 브릿지가 생기기 전에 난 오류
};

/**
 * 이 오류를 기록할 것인가. **시각을 주입받는다** — 안 그러면 테스트가 쿨다운을 잴 수 없다
 * (P19 에서 `Date.now()` 를 직접 부르는 구조 때문에 설계를 고친 것과 같은 갈래).
 * 상태를 바꾸는 함수지만 상태를 인자로 받으므로 테스트가 새 상태로 몇 번이든 부를 수 있다.
 * 반환: "log" | "cooldown" | "cap-final" | "cap"
 */
function shouldReport(st, key, now) {
  if (st.logged >= ERR_SESSION_CAP) {
    if (st.capNoted) return "cap";
    st.capNoted = true;
    return "cap-final";
  }
  const last = st.seen.get(key);
  if (last !== undefined && now - last < ERR_COOLDOWN_MS) {
    st.suppressed++;
    return "cooldown";
  }
  st.seen.set(key, now);
  st.logged++;
  return "log";
}

/** 같은 자리에서 반복되는 오류를 한 줄로 접기 위한 키. 순수 함수. */
function errorKey(message, source, line) {
  return [message || "?", shortSource(source) || "?",
    line === undefined || line === null ? "?" : line].join("|");
}

/**
 * `file:///C:/.../web/js/sats.js` → `sats.js`. 순수 함수.
 * 경로 전체를 남기면 한 줄이 200자를 넘고, 정작 알고 싶은 건 파일과 줄번호다.
 */
function shortSource(source) {
  if (!source) return "";
  const s = String(source).split("?")[0].split("#")[0];
  const cut = s.lastIndexOf("/");
  return cut === -1 ? s : s.slice(cut + 1);
}

/** 로그에 남길 한 건의 문장. 순수 함수 — 테스트가 문자열로 직접 잰다. */
function formatError(kind, message, source, line, stack) {
  let out = "[" + kind + "] " + (message || "(메시지 없음)");
  const where = shortSource(source);
  if (where) {
    out += " @ " + where;
    if (line !== undefined && line !== null) out += ":" + line;
  }
  if (stack) {
    out += "\n" + String(stack).split("\n").slice(0, ERR_STACK_LINES).join("\n");
  }
  return out.slice(0, ERR_MAX_CHARS);
}

/**
 * 파이썬 로그로 보낸다. 브릿지가 아직 없으면 쌓아 뒀다가 `flushErrorQueue()` 가 보낸다.
 * **여기서 나는 예외는 삼킨다** — 보고 경로가 또 보고를 부르면 재귀한다.
 * 브릿지가 돌려주는 Promise 도 반드시 `catch` 한다(거부되면 unhandledrejection 으로
 * 다시 이 파일로 들어와 무한히 돈다).
 */
function sendToLog(text) {
  try {
    const api = window.pywebview && window.pywebview.api;
    if (!api || !api.log) {
      errState.queue.push(text);
      if (errState.queue.length > ERR_QUEUE_CAP) errState.queue.shift();
      return false;
    }
    const p = api.log("error", text);
    if (p && typeof p.catch === "function") p.catch(function () {});
    return true;
  } catch (e) {
    return false;
  }
}

/** 브릿지가 준비된 뒤 그동안 쌓인 것을 내보낸다(boot 에서 부른다). */
function flushErrorQueue() {
  const api = window.pywebview && window.pywebview.api;
  if (!api || !api.log) return 0;
  const pending = errState.queue.splice(0, errState.queue.length);
  for (const text of pending) sendToLog(text);
  return pending.length;
}

/**
 * 사용자에게도 한 번 말한다 — **침묵하지 않는다**(P18 계열).
 * 세션당 한 번만 뜨고, 닫으면 다시 뜨지 않는다. 오류가 초당 나도 배너는 하나다.
 */
function showErrorBanner() {
  if (errState.bannerShown) return false;
  errState.bannerShown = true;
  const box = document.getElementById("app-error");
  const text = document.getElementById("app-error-text");
  if (!box || !text) return false;
  text.textContent = ERR_BANNER_TEXT;
  box.classList.remove("hidden");
  return true;
}

function hideErrorBanner() {
  const box = document.getElementById("app-error");
  if (box) box.classList.add("hidden");
}

/** 오류 한 건을 처리한다. 반환은 `shouldReport` 의 판정(테스트가 억제를 잰다). */
function reportError(kind, message, source, line, stack) {
  const verdict = shouldReport(errState, errorKey(message, source, line), Date.now());
  if (verdict === "cooldown" || verdict === "cap") return verdict;
  if (verdict === "cap-final") {
    sendToLog("[한도] 이후 오류는 기록하지 않습니다 (세션 상한 "
      + ERR_SESSION_CAP + "건 도달, 접은 것 " + errState.suppressed + "건)");
    return verdict;
  }
  sendToLog(formatError(kind, message, source, line, stack));
  showErrorBanner();
  return verdict;
}

/** 부트·배선 한 단계가 실패했을 때. `boot.js` 의 `step`/`wire` 가 부른다. */
function reportStepError(label, e) {
  reportError("부트", label + " 실패: " + (e && e.message ? e.message : String(e)),
    null, null, e && e.stack);
}

// ── 등록 ─────────────────────────────────────────────────────────────────────
// **`bindUI()` 가 아니라 여기서 건다.** bindUI 가 죽어도 보고는 살아야 한다 —
// 그게 이 기능의 전부다(bindUI 가 죽는 것이 P23-1 이 잡으려는 바로 그 경우다).
window.addEventListener("error", function (e) {
  reportError("오류", e && e.message, e && e.filename, e && e.lineno,
    e && e.error && e.error.stack);
});
window.addEventListener("unhandledrejection", function (e) {
  const reason = e && e.reason;
  const msg = reason && reason.message ? reason.message : String(reason);
  reportError("처리되지 않은 거부", msg, null, null, reason && reason.stack);
});
{
  const closeBtn = document.getElementById("app-error-close");
  if (closeBtn) closeBtn.addEventListener("click", hideErrorBanner);
}
