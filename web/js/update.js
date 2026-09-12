/* RL3D — 업데이트 확인 배지 (P12-12).

   파이썬(api_client.check_update)이 GitHub 최신 릴리스를 받아 비교까지 끝내고,
   여기서는 "띄울 것인가 / 뭐라고 쓸 것인가"만 정한다.
   판정은 순수 함수로 떼어 두고(테스트 대상), 배선은 initUpdateCheck 하나로 모은다. */

/** 배지를 띄울지 정한다. 닫은 버전과 같으면 다시 띄우지 않는다.
 *  info 가 없거나 형태가 어긋나도 조용히 false — 업데이트 확인 실패는 앱 기능이 아니다. */
function shouldShowUpdate(info, dismissedVersion) {
  if (!info || !info.update_available) return false;
  if (!info.latest) return false;
  // 저장된 "닫은 버전"과의 비교는 v 접두 차이를 흡수한다(태그는 v1.14.0, 저장은 1.14.0 일 수 있다)
  const norm = (s) => String(s || "").trim().replace(/^v/i, "");
  if (norm(dismissedVersion) && norm(dismissedVersion) === norm(info.latest)) return false;
  return true;
}

/** 배지 문구. 받은 값만 쓰고 없는 것은 적지 않는다(빈 괄호가 남지 않게). */
function updateBadgeText(info) {
  const latest = String((info && info.latest) || "").trim().replace(/^v/i, "");
  const current = String((info && info.current) || "").trim().replace(/^v/i, "");
  const from = current ? ` (현재 v${current})` : "";
  return `⬆ 새 버전 v${latest} 가 있습니다${from} — 눌러서 받기`;
}

function setUpdateBadge(info) {
  const el = document.getElementById("update-badge");
  if (!el) return;
  const show = shouldShowUpdate(info, settingsDismissedUpdate);
  if (show) {
    // 문구는 우리가 만든 것이지만 latest 는 외부(GitHub 태그)에서 온 문자열이다 → 이스케이프
    el.innerHTML = `<span class="ub-text">${escapeHtml(updateBadgeText(info))}</span>`
                 + `<span class="ub-close" title="닫기">✕</span>`;
  }
  el.classList.toggle("hidden", !show);
}

/** 시작 직후 한 번 확인한다. 실패는 조용히 넘긴다(배지가 안 뜰 뿐). */
async function initUpdateCheck() {
  if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.check_update) return;
  const info = await window.pywebview.api.check_update().catch(() => null);
  latestUpdateInfo = info;
  setUpdateBadge(info);
}

function bindUpdateBadge() {
  const el = document.getElementById("update-badge");
  if (!el) return;
  el.addEventListener("click", (e) => {
    const info = latestUpdateInfo;
    // ✕ 를 눌렀으면 이 버전은 다시 띄우지 않는다(다음 버전이 나오면 또 뜬다)
    if (e.target && e.target.classList && e.target.classList.contains("ub-close")) {
      settingsDismissedUpdate = (info && info.latest) || "";
      saveSettings({ dismissedUpdate: settingsDismissedUpdate });
      el.classList.add("hidden");
      return;
    }
    if (info && info.url) window.pywebview.api.open_url(info.url);
  });
}
