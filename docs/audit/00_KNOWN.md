# 차분 목록 — 분석 전에 이미 알던 것 (2026-09-24)

> 발견마다 `이력:` 을 여기와 대조해 `[신규]` / `[기존: 출처]` 로 단다. **정지 규칙은 `[신규]` 만 센다.**
> 여기 있는 것과 같은 결함이 **다시** 보이면 그건 `[기존]` 이 아니라 **회귀**다 — `[신규]` 로 달고 요약에 "회귀"라고 적는다.

## 이미 고친 부류 (재발이면 회귀)

| 부류 | 출처 | 지금 지키는 장치 |
|---|---|---|
| 연결이 끊기는 방식 13종 중 7종에서 폴백 건너뜀 | P29-1 | `test_cache.TestNetworkErrorKinds` (발사 경로만) |
| 브릿지 인자(연도·그룹)를 믿음 → 요청·영구 빈 캐시 | P38 | `test_cache.TestBridgeInputs` |
| `open_url` 스킴 | P38·P42 | `test_cache.TestBridgeUrlGuard` |
| 설정 파일을 `open('w')` 로 잘라 통째로 사라짐 · 동시 저장 유실 | P22 | `test_cache.TestSettingsDurability` |
| 캐시 스키마 미상향 → 지난 연도 아카이브에서 새 필드 영구 누락 | 2026-09-12 | `test_parsing.SchemaShapeGuard` (이번 감사 1단계) |
| 오버레이가 클릭·시야를 가림 · 대비 · 넘침 | P34~P37 | `test_layout.js` |
| 배선·타이머·지도 배선·조건 분기가 죽어도 초록 | P39~P46 | `mutate.js` 3 프리셋 |
| TTL·상한 상수를 바꿔도 초록 | P47 | `test_cache.TestRequestBudget` + 문서 수치 대조표 |
| 변이된 코드 커밋 | P48 | 훅 + `audit_scan mutation-residue` |
| 문서 ↔ 코드 어긋남(파일 수·로드 순서·Phase 제목·버전) | P32 | `test_docs.js` |
| CI 시간대·로캘 의존 | 2026-09-12 | `TZ` 고정 |
| 콘솔 cp1252 에서 한글 print | 51f227f | 스모크 stdout 재설정 + CI `PYTHONIOENCODING` |
| "오늘 밤" 탭 UI 스레드 115초 | P19-0 | GEO 제외·분할 |

## 의도된 동작 (결함으로 올리지 않는다 — 올리려면 새 근거가 필요)

| 동작 | 근거 |
|---|---|
| 발사장 좌표가 없는 발사는 버린다 | `api_parsing._parse_launch` · `test_parsing.test_missing_coords_dropped` |
| 업데이트 확인은 깨진 응답에 **조용히** 실패한다(업데이트 없음 + error) | `test_cache.test_broken_payload_is_quiet` |
| 지도 타일 URL 은 JS(`map.js`)에 있다 | MapLibre 가 직접 받는다 — `audit_allow.json` 사유 |
| 지난 연도 아카이브는 TTL 없음(영구) | CLAUDE.md API 규칙 · `test_past_year_cache_never_expires` |
| 고해상도 타일 번들 금지 | P17-2 (Esri 이용 조건) |
| 발사 실시간 텔레메트리 없음 | CLAUDE.md "나중에" 표 |

## 열려 있는 계획 항목

- P12-17 로컬 타일 번들 — P17-2 로 대체(라이선스로 막힘). 사실상 닫힘.
- 그 밖에 PLAN 의 Phase 11~48 항목은 전부 ✅/❌ 로 닫혀 있다(2026-09-24 확인).
