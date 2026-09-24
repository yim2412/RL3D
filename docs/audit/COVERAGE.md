# COVERAGE — 어느 파일을 어느 영역으로 실제로 읽었나

> 전면 감사(2026-09-24). 이 표가 없으면 *"감사했다"* 를 반증할 수 없다.
> `check_findings.py` 가 추적 파일과 대조한다(누락·유령). 제외: `tests/fixtures/`·`tests/golden/`
> (데이터) · `web/lib/`(서드파티 번들 — 라이선스만 본다) · `docs/audit/`·`docs/notes/`(감사 자신·노트).
>
> 열: **영역** 은 읽을 때 본 감사 영역(설계 표의 이름) · **상태** 는 `미독`/`훑음`/`정독`.

| 파일 | 영역 | 상태 |
|---|---|---|
| `.gitattributes` | — | 미독 |
| `.github/workflows/tests.yml` | 회귀 · 인코딩 | 정독 |
| `.gitignore` | 위생(산출물·비밀) | 정독 |
| `.mutate.json` | 측정 도구(프리셋 하나만 설정 — 기준선은 격리 사본에서 3종) | 정독 |
| `CHANGELOG.md` | — | 미독 |
| `CLAUDE.md` | 측정 도구 · 영역 도출('당한 것' 대조) · 문서 수치 | 정독 |
| `LICENSE` | 라이선스 | 정독 |
| `PLAN.md` | 차분 목록(열린 항목) | 훑음 |
| `README.md` | 라이선스·귀속 · 문서 수치(대조표) | 훑음 |
| `api_client.py` | 외부 API 예산 · 데이터 · 시각 경계 · 보안 · 하위호환 · 위생 (고장 매트릭스 110칸 + p001~p006) | 정독 |
| `api_errors.py` | 외부 API 예산 (오류 문구 — 매트릭스 RAW 판정 0건) | 훑음 |
| `api_parsing.py` | 데이터 (필드 퍼징 1,224건) · 스키마 모양(SchemaShapeGuard) | 훑음 |
| `applog.py` | 인코딩(cp949·cp1252 스모크) | 훑음 |
| `build.bat` | 빌드·배포물 · 인코딩(ASCII) · 라이선스 | 정독 |
| `docs/DECISIONS.md` | 차분 목록 | 훑음 |
| `docs/index.html` | — | 미독 |
| `docs/screenshot.png` | — | 미독 |
| `main.py` | 보안(브릿지) · 하위호환(창 설정) | 훑음 |
| `requirements.txt` | 빌드·배포물(버전 고정) | 정독 |
| `satcat_codes.py` | 정적 스캔 전수 | 훑음 |
| `startup.py` | 인코딩(cp949·cp1252 스모크) · URL 허용 | 훑음 |
| `tests/capture_fixtures.py` | 정적 스캔 전수 | 훑음 |
| `tests/harness.js` | 측정 도구(XSS 프로브의 토대) · 건수 하한 | 훑음 |
| `tests/test_cache.py` | 회귀(고장 매트릭스와 중복 확인) · 건수 하한 | 훑음 |
| `tests/test_docs.js` | 회귀 · 문서 수치 | 훑음 |
| `tests/test_frontend.js` | 회귀 · 건수 하한 | 훑음 |
| `tests/test_layout.js` | 회귀 · 건수 하한 | 훑음 |
| `tests/test_parsing.py` | 회귀 · 건수 하한 | 훑음 |
| `tools/audit_allow.json` | 측정 도구(허용 목록) | 정독 |
| `tools/audit_scan.py` | 측정 도구(이번 감사에서 작성) | 정독 |
| `tools/build_ne_land.py` | 정적 스캔 전수 | 훑음 |
| `web/index.html` | 보안(CSP) | 훑음 |
| `web/js/boot.js` | 외부 API 예산(강제 갱신) · 리소스 누수 · 정적 스캔 전수 | 훑음 |
| `web/js/errors.js` | 보안(배너 textContent) · 리소스 누수 · 정적 스캔 전수 | 훑음 |
| `web/js/favorites.js` | 보안(XSS 프로브) · 정적 스캔 전수 | 훑음 |
| `web/js/firstrun.js` | 정적 스캔 전수(innerHTML·변이흔적·URL) | 훑음 |
| `web/js/focus.js` | 보안(XSS) · 리소스 누수 · 정적 스캔 전수 | 훑음 |
| `web/js/keys.js` | 정적 스캔 전수(innerHTML·변이흔적·URL) | 훑음 |
| `web/js/launches.js` | 보안(XSS 프로브) · 외부 API 예산(폴링) · 리소스 누수 · 정적 스캔 전수 | 훑음 |
| `web/js/map.js` | 라이선스(귀속) · 리소스 누수 · URL · 정적 스캔 전수 | 훑음 |
| `web/js/observer.js` | 보안(검색 결과 이스케이프) · 정적 스캔 전수 | 훑음 |
| `web/js/panels.js` | 보안(XSS 프로브·되돌리는 변이) · 정적 스캔 전수 | 훑음 |
| `web/js/satfilter.js` | 정적 스캔 전수(innerHTML·변이흔적·URL) | 훑음 |
| `web/js/satpanel.js` | 보안(XSS 프로브) · 정적 스캔 전수 | 훑음 |
| `web/js/satpass.js` | 위생(computeTonight) · 정적 스캔 전수 | 훑음 |
| `web/js/sats.js` | 외부 API 예산(TLE 폴링) · 리소스 누수 · 정적 스캔 전수 | 훑음 |
| `web/js/sattrack.js` | 리소스 누수 · 정적 스캔 전수 | 훑음 |
| `web/js/sequence.js` | 정적 스캔 전수(innerHTML·변이흔적·URL) | 훑음 |
| `web/js/settings.js` | 하위호환(그룹 복원) · 정적 스캔 전수 | 훑음 |
| `web/js/sidebar.js` | 보안(XSS 프로브) · 정적 스캔 전수 | 훑음 |
| `web/js/state.js` | 문서 수치(AUTO_REFRESH_MS) · 정적 스캔 전수 | 훑음 |
| `web/js/stats.js` | 보안(XSS 프로브) · 정적 스캔 전수 | 훑음 |
| `web/js/trajectory.js` | 정적 스캔 전수(innerHTML·변이흔적·URL) | 훑음 |
| `web/js/update.js` | 보안(배지 이스케이프) · 리소스 누수 · 정적 스캔 전수 | 훑음 |
| `web/js/utils.js` | 보안(escapeHtml) · 정적 스캔 전수 | 훑음 |
| `web/style.css` | UI(ui-top 스캔) | 훑음 |
