# 발견 대장 — 전면 감사 2026-09-24

> 정본. 형식은 `check_findings.py` 가 파싱한다 — 바꾸면 검사기도 같이 고친다.
> **재현 없는 발견은 `높음` 이상 금지** · 근거 `추정` 도 금지. 이력은 차분 목록(`00_KNOWN.md`) 대조.
> 실데이터·개인정보(사용자명 경로·관측지 좌표)를 적지 않는다 — `audit_scan.py` 가 잰다.
> 독립 리뷰(에이전트) 발견은 내가 프로브로 재현하기 전엔 최대 `중간` — 요약 끝에 `출처: 독립 리뷰` 로 표시.

```
### F-NNN · 영역: <설계 표의 영역> · 상태: 미처리|수정중|완료|기각
- 위치: `path:line` — `앵커 텍스트(파일에 그대로 있는 조각)`
- 근거: 실측|인용|추정 (+ 한 줄)
- 이력: [신규] | [기존: 출처]
- 심각도: 치명|높음|중간|낮음|판단필요
- 재현: docs/audit/probes/<파일>.py | 없음
- 반증조건: 무엇이 보이면 이 발견이 틀린 것인가
- 수정비용: 소|중|대
- 대상: 고칠 파일
- 요약: 한두 문장
```

### F-001 · 영역: 외부 API 예산 · 상태: 완료
- 위치: `api_client.py:568` — `_cache_write(name, sats)`
- 근거: 실측 — p001: 정상 TLE 4건 캐시 → 200 HTML(캡티브 포털) → 0건·error=None 으로 캐시가 덮임 → 복구 뒤에도 요청 0회·0건. SATCAT 동일(6건 → 0).
- 이력: [신규]
- 심각도: 높음
- 재현: docs/audit/probes/p001_tle_wipe.py
- 반증조건: 포털 응답 뒤에도 캐시가 이전 건수를 유지하거나, 결과에 error/stale 가 실린다
- 수정비용: 소
- 대상: api_client.py (필요하면 api_parsing.py)
- 요약: 200 으로 온 엉뚱한 본문을 파서가 0건으로 읽고, 코드는 그 0건을 **정상 결과로 캐시에 쓴다**. 오래된 캐시 폴백까지 지워져 TLE 2시간·SATCAT 24시간 동안 위성이 조용히 사라진다(문구 없음). 트리거(캡티브 포털·프록시 오류 페이지)의 빈도는 재지 않았다.
- 결과: TLE·SATCAT 이 0건이면 ValueError 로 올려 기존 폴백 경로를 태운다. p001 FAIL→OK · 고장 매트릭스 110칸 FAIL 48→0 · 회귀 `TestResponseShape`(TLE·SATCAT). 되돌리는 변이(가드 끔) 각각 FAIL 확인.

### F-002 · 영역: 외부 API 예산 · 상태: 완료
- 위치: `api_client.py:418` — `upcoming = api_parsing._parse_launches(json.loads(_http_get(LL2_UPCOMING)))`
- 근거: 실측 — p002: (a) 캐시 3건 + 본문 `null` → AttributeError 가 NET_ERRORS 밖이라 폴백 없이 브릿지로 올라감. (b) 캐시 없는 2019 아카이브에 `{"results": null}` → 0건·error=None 으로 영구 캐시, 복구 뒤 요청 0회.
- 이력: [신규] — P38(범위 밖 연도 → 영구 빈 캐시)과 같은 피해가 서버 쪽 응답으로 다시 열린다
- 심각도: 중간
- 재현: docs/audit/probes/p002_ll2_shape.py
- 반증조건: 모양이 틀린 200 본문에 캐시 폴백이 돌거나, 0건을 캐시에 쓰지 않는다
- 수정비용: 소
- 대상: api_client.py, api_parsing.py
- 요약: LL2 경로가 200 응답의 모양(`results` 가 리스트인가)을 검증하지 않는다. 캡티브 포털 HTML 은 json.loads 가 ValueError 로 걸러 주므로 F-001 보다 트리거가 드물다 — JSON 인데 모양이 틀린 경우만. 고장 매트릭스 110칸 중 LL2 쪽 16칸.
- 결과: `_ll2_payload` — dict 이고 `results` 가 리스트가 아니면 ValueError. 발사·아카이브 페이지·릴리스(tag_name) 모두. p002 FAIL→OK · 회귀 3건. 되돌리는 변이 각각 FAIL(첫 변이는 `if False and A or B` 우선순위 탓에 반쯤 살아 있어 무효 — 한 곳씩 `if False:` 로 다시 잼).

### F-003 · 영역: 시각 경계 · 상태: 완료
- 위치: `api_client.py:511` — `is_current = year >= time.gmtime().tm_year`
- 근거: 실측 — p003: 시계를 2026 으로 두고 받은 2026 아카이브(5시간 전) → 시계 2027 → 요청 0회. 나이 400일로 만들어도 요청 0회.
- 이력: [신규]
- 심각도: 높음
- 재현: docs/audit/probes/p003_year_rollover.py
- 반증조건: 해가 바뀐 뒤 첫 조회에서 지난해 아카이브를 한 번 다시 받는다
- 수정비용: 소
- 대상: api_client.py
- 요약: 올해 아카이브는 해가 바뀌는 순간 '지난 연도'가 되어 **마지막으로 받은 시점의 스냅샷이 영구 캐시**가 된다. 12월 31일만의 문제가 아니다 — 7월에 받고 연말까지 다시 안 불렀으면 그 해는 영원히 7월에서 멈춘다(결과가 뒤늦게 확정된 발사 포함). 해마다 반드시 한 번 일어난다. 독립 리뷰도 같은 것을 찾았다(겹침).
- 결과: 지난 연도 캐시는 수정 시각이 그 해 뒤일 때만 영구 — 아니면 한 번 다시 받는다(스키마 변경 없음). p003 FAIL→OK · 회귀 `TestArchiveYearEnd` 2건. 기존 테스트 1건이 '해가 시작되기 전에 받은 캐시'(400일)를 영구로 단언하고 있어 해가 끝난 뒤 시각으로 고쳤다. 되돌리는 변이 FAIL.

### F-004 · 영역: 외부 API 예산 · 상태: 완료
- 위치: `api_client.py:426` — `except NET_ERRORS as e:`
- 근거: 실측 — p004: 캐시 만료 + 429 지속, 1시간 폴링 12회 → LL2 12회 · upcoming 성공/previous 429 → 24회(한도 15) · Celestrak 403, 그룹 8 → TLE 96회/시간(위성 레이어가 켜져 있으면 TLE 도 5분 폴링을 탄다 — launches.js startAutoRefresh).
- 이력: [신규] — P29 는 실패 시 **폴백**을 고쳤고, 실패 뒤 **재요청 간격**은 다루지 않았다
- 심각도: 높음
- 재현: docs/audit/probes/p004_retry_storm.py
- 반증조건: 실패 직후의 폴링이 요청을 내지 않는다(실패 시각을 기억해 일정 시간 막는다)
- 수정비용: 중
- 대상: api_client.py
- 요약: 실패하면 캐시가 안 바뀌어 **폴링마다 다시 때린다** — 백오프도 마지막 실패 시각도 없다. 429 상태에서 한도를 스스로 채워 풀리지 않게 하고, previous 만 실패하면 성공한 upcoming 도 버려 두 배가 된다. 출처: 독립 리뷰 발견 1, 여기서 재현.
- 결과: `_gate`/`_gate_fail`/`_gate_ok` — 실패하면 호스트(그룹)별로 LL2 30분·Celestrak 2시간 요청하지 않고 가진 캐시와 직전 오류를 돌려준다. p004: LL2 12→1 · 부분 실패 24→2 · Celestrak 8그룹 96→8 /시간. 회귀 `TestRequestGate` + `TestRequestBudget` 에 값 고정. 되돌리는 변이(백오프 무시·그룹 키 합침) FAIL.

### F-005 · 영역: 외부 API 예산 · 상태: 완료
- 위치: `web/js/boot.js:106` — `function forceRefresh() {`
- 근거: 실측 — p005: 방금 받은 캐시가 있는데 `get_launches(force=True)` 8회 → LL2 16회. 프론트 `beginLoad` 는 진행 중인 같은 키만 막는다(인용: launches.js:9).
- 이력: [신규]
- 심각도: 중간
- 재현: docs/audit/probes/p005_force_refresh.py
- 반증조건: 짧은 간격의 강제 갱신이 캐시를 돌려주고 요청을 내지 않는다
- 수정비용: 소
- 대상: api_client.py (또는 web/js/boot.js)
- 요약: `↻ 갱신`·단축키 R 에 쿨다운이 없다. 누르는 만큼 LL2 2회씩 — 8번이면 한도를 넘는다. 강제 갱신과 자동 폴링은 키가 달라 동시에 돌 수도 있다(그쪽은 재지 않음). 출처: 독립 리뷰 발견 2, 여기서 재현.
- 결과: 캐시가 60초(`FORCE_MIN_INTERVAL`)보다 새것이면 강제 갱신도 캐시, 백오프 중 강제 갱신은 60초에 한 번. p005: 16→2. 기존 테스트 2건은 '받자마자 강제'라 캐시 나이를 쿨다운 밖으로 고쳤다. 되돌리는 변이 FAIL.

### F-006 · 영역: 코드·로직 · 상태: 완료
- 위치: `api_client.py:277` — `os.makedirs(CACHE_DIR, exist_ok=True)`
- 근거: 실측 — p006: 캐시 폴더 자리에 파일 → 3회 호출, 요청 6회, 발사 0건, error "연결이 중간에 끊겼습니다".
- 이력: [신규]
- 심각도: 낮음
- 재현: docs/audit/probes/p006_cache_dir_error.py
- 반증조건: 캐시를 못 써도 받은 데이터는 화면에 나온다
- 수정비용: 소
- 대상: api_client.py
- 요약: 캐시 쓰기 실패(OSError)가 네트워크 실패로 분류돼 **받은 데이터를 버리고 틀린 문구**를 내며 폴링마다 다시 요청한다. 트리거(APPDATA 쓰기 불가)는 드물다. 출처: 독립 리뷰 발견 4, 여기서 재현.
- 결과: `os.makedirs` 를 `_cache_write` 의 try 안으로. p006 FAIL→OK(발사 3건·error None) · 회귀 `TestCacheWriteFailure`. 되돌리는 변이 FAIL 확인.

### F-007 · 영역: 측정 도구 자체 · 상태: 미처리
- 위치: `CLAUDE.md:337` — `스모크가 말해 준다`
- 근거: 실측 — 2026-09-24 스모크 `[OK] update - 최신 릴리스 v1.62.0` · 실제 GitHub 최신 릴리스 v1.63.0(`gh release list`). update 캐시(TTL 24시간)가 v1.63.0 릴리스 직전에 저장돼 있었다.
- 이력: [신규]
- 심각도: 낮음
- 재현: 없음
- 반증조건: 스모크의 update 줄이 캐시를 우회한다
- 수정비용: 소
- 대상: api_client.py(스모크에서 `check_update(..., force=True)`) 또는 CLAUDE.md
- 요약: CLAUDE.md 는 *"스모크 줄이 코드 버전과 다르면 그만큼 밀린 것"* 이라 하지만 스모크는 24시간 캐시를 읽는다 — 릴리스 직후 하루 동안 **밀리지 않았는데 밀렸다고** 말한다. 감사 중 실제로 오판할 뻔했다.

### F-008 · 영역: 위생 · 상태: 미처리
- 위치: `api_client.py:494` — `year_raw = year`
- 근거: 실측 — `api_client.get_archive.__doc__` 가 `None`.
- 이력: [신규]
- 심각도: 낮음
- 재현: 없음
- 반증조건: `get_archive.__doc__` 가 문서 문자열을 돌려준다
- 수정비용: 소
- 대상: api_client.py
- 요약: 대입문이 docstring 앞에 들어가 docstring 이 버려지는 문자열 식이 됐다(P38 때 들어간 것으로 보인다 — 추정).

### F-009 · 영역: 위생 · 상태: 미처리
- 위치: `web/js/satpass.js:308` — `끝까지 한 번에 돌린다 — 테스트와, 대상이 적을 때의 경로.`
- 근거: 실측 — `computeTonight` 는 web/js 에서 정의 1회 외 참조 0회, tests/test_frontend.js 에서만 4회 불린다.
- 이력: [신규]
- 심각도: 낮음
- 재현: 없음
- 반증조건: 앱 코드에 `computeTonight(` 호출이 있다
- 수정비용: 소
- 대상: web/js/satpass.js
- 요약: 주석은 앱이 "대상이 적을 때" 쓰는 경로라 말하지만 앱은 부르지 않는다 — 테스트 전용 기준 구현이다. 주석을 사실대로 고치거나 테스트 쪽으로 옮긴다.

### F-010 · 영역: 하위호환 · 상태: 미처리
- 위치: `api_client.py:472` — `return [g for g in items if g in SATELLITE_GROUP_CATALOG]`
- 근거: 실측 — `_clean_groups([{}])`·`([["a"]])` 가 TypeError(unhashable).
- 이력: [신규] — P38 `_clean_groups` 의 남은 칸
- 심각도: 낮음
- 재현: 없음
- 반증조건: 해시 불가 원소가 걸러지고 예외가 없다
- 수정비용: 소
- 대상: api_client.py
- 요약: 설정의 `satellites.groups` 에 문자열이 아닌 원소가 있으면(손으로 고친 설정 등) 위성 로드가 매 실행 예외로 끝난다. 출처: 독립 리뷰 발견 6, 여기서 재현.

### F-011 · 영역: 하위호환 · 상태: 미처리
- 위치: `main.py:196` — `saved_win = api_client.load_settings().get("window") or {}`
- 근거: 인용 — `window` 가 문자열·리스트면 `.get` 에서 AttributeError → 시작 실패. 실행은 안 했다(창을 띄우는 경로).
- 이력: [신규]
- 심각도: 낮음
- 재현: 없음
- 반증조건: 모양이 틀린 `window` 에도 창이 기본 크기로 뜬다
- 수정비용: 소
- 대상: main.py
- 요약: 설정 파일이 유효한 JSON 이지만 `window` 모양이 틀리면 매 실행 크래시 안내가 뜬다. 앱 스스로는 그런 모양을 쓰지 않는다 — 손으로 고친 경우만. 출처: 독립 리뷰 발견 9.

### F-012 · 영역: 시각 경계 · 상태: 미처리
- 위치: `api_client.py:183` — `age = time.time() - os.path.getmtime(path)`
- 근거: 인용 — 독립 리뷰가 mtime 을 3일 뒤로 두고 실행: 요청 0회, age=-259200. 내가 다시 돌리지는 않았다.
- 이력: [신규]
- 심각도: 낮음
- 재현: 없음
- 반증조건: 음수 나이를 만료로 본다
- 수정비용: 소
- 대상: api_client.py
- 요약: 시계를 되돌리거나 다른 PC 에서 복사한 캐시면 나이가 음수가 되어, 그 차이만큼 캐시가 신선하다. 출처: 독립 리뷰 발견 9.

### F-013 · 영역: 보안 · 상태: 미처리
- 위치: `api_client.py:448` — `url = payload.get("next")`
- 근거: 추정 — 원격 응답의 `next` 를 스킴·호스트 확인 없이 `urlopen` 한다. urllib 은 `file://` 도 연다. 응답이 JSON 이 아니면 ValueError 로 끝나 유출 경로는 찾지 못했다.
- 이력: [신규]
- 심각도: 낮음
- 재현: 없음
- 반증조건: `next` 가 LL2_BASE 밖이면 따라가지 않는다
- 수정비용: 소
- 대상: api_client.py
- 요약: 방어 한 겹. LL2 응답이 오염되지 않는 한 트리거가 없다. 출처: 독립 리뷰 발견 7.

### F-014 · 영역: 외부 API 예산 · 상태: 미처리
- 위치: `api_client.py:168` — `CACHE_SCHEMA = 10`
- 근거: 인용 — `_cache_read` 가 전역 하나와 비교한다. 발사 필드만 바꿔도 TLE·SATCAT·update·모든 연도 아카이브가 무효가 된다.
- 이력: [기존: CLAUDE.md 한 세션에 CACHE_SCHEMA 를 여러 번 올리면 한도를 태운다] — 그때는 절차로 막았고 구조는 그대로다
- 심각도: 판단필요
- 재현: 없음
- 반증조건: 캐시 종류별 스키마가 따로 있다
- 수정비용: 중
- 대상: api_client.py
- 요약: 판단용 숫자 — 스키마를 올린 직후 첫 실행 = LL2 2 + 불러온 아카이브 연도당 최대 5 + Celestrak 그룹 수 × 2 + GitHub 1. 발사 필드만 바뀐 경우 Celestrak·GitHub 몫은 낭비다. 출처: 독립 리뷰 발견 5.

### F-015 · 영역: 보안 · 상태: 미처리
- 위치: `web/index.html:4` — `<meta charset="utf-8" />`
- 근거: 인용 — CSP 메타가 없고, 이미지 `onerror="this.remove()"` 인라인 핸들러가 있어 CSP 를 넣으려면 `unsafe-inline` 이 필요하다. p_xss: 렌더 45회 · 오염 도달 45회 · 날것 0건이라 지금 뚫린 곳은 없다.
- 이력: [신규]
- 심각도: 판단필요
- 재현: 없음
- 반증조건: index.html 에 CSP 가 있다
- 수정비용: 중
- 대상: web/index.html, web/js/*.js
- 요약: 방어 한 겹을 더할지의 결정. XSS 가 뚫려도 브릿지로 할 수 있는 일은 설정 덮어쓰기·http(s) 링크 열기 정도다. 출처: 독립 리뷰 발견 8.

### F-016 · 영역: 라이선스·귀속 · 상태: 미처리
- 위치: `build.bat:24` — `--add-data "web;web" main.py`
- 근거: 인용 — MapLibre(BSD-3)는 바이너리 재배포에 저작권 고지·조건·면책을 배포물과 함께 요구한다. 번들 JS 헤더에는 전문 대신 URL 만 있고, exe 에는 라이선스 파일이 없다. README 에는 이름만 있다.
- 이력: [신규]
- 심각도: 판단필요
- 재현: 없음
- 반증조건: exe 나 릴리스 자산에 서드파티 라이선스 전문이 있다
- 수정비용: 소
- 대상: build.bat, README.md (또는 THIRD_PARTY_LICENSES 파일)
- 요약: 판단용 숫자 — 필요한 전문 2개(MapLibre BSD-3, satellite.js MIT) · 추가 크기 수 KB. 릴리스 페이지에 붙일지 exe 에 넣을지 결정.

### F-017 · 영역: 빌드·배포물 · 상태: 미처리
- 위치: `build.bat:24` — `--onefile --windowed --name RL3D`
- 근거: 인용 — 전역 규칙 8번은 `--onedir` 를 기본으로 본다(시작 지연·DLL 문제). 이 프로젝트는 onefile 이고 부모만 죽이면 창이 남는 사고(2026-09-17)를 겪었다. exe 15.06MB(dist/RL3D.exe 실측). 시작 시간은 재지 않았다.
- 이력: [기존: CLAUDE.md exe 스모크 항목]
- 심각도: 판단필요
- 재현: 없음
- 반증조건: 결정 사안이라 반증 대상이 아니다
- 수정비용: 중
- 대상: build.bat, README.md, CLAUDE.md
- 요약: 단일 파일 배포의 편의와 onedir 의 시작 속도·프로세스 단순함의 교환. 바꾸려면 시작 시간을 먼저 잰다.

### F-018 · 영역: 회귀 · 상태: 미처리
- 위치: `web/js/focus.js:100` — `if (focusTimer) clearInterval(focusTimer);`
- 근거: 실측 — if-js 변이(격리 사본, 536개 중 생존 26): 타이머 재무장 가드 8줄을 뒤집어도 test_frontend 1,427건 전부 초록. focus.js:100 · launches.js:479 · launches.js:555 · sats.js:252 · sattrack.js:144 · sattrack.js:153 · update.js:52 · map.js:11(clearTimeout).
- 이력: [신규] — P41 은 타이머 **등록과 주기**를 쟀고 **재무장 시 이전 것 해제**는 안 쟀다
- 심각도: 중간
- 재현: 없음 (node ~/.claude/tools/mutate.js --preset if-js --test "node tests/test_frontend.js" --files "web/js/*.js")
- 반증조건: 시작 함수를 두 번 부른 뒤 같은 주기의 살아 있는 타이머가 1개라는 단언이 있다
- 수정비용: 소
- 대상: tests/test_frontend.js
- 요약: 리소스 누수 영역을 PASS 로 본 근거가 이 가드들인데, **가드가 사라져도 아무 테스트도 실패하지 않는다**. 사라지면 같은 타이머가 겹쳐 돌아(카운트다운 2배속·위성 위치 계산 2배) 오래 켜 둘수록 무거워진다. 하네스 `timers.every(ms)` 로 잴 수 있다.

### F-019 · 영역: 회귀 · 상태: 미처리
- 위치: `web/js/panels.js:249` — `if (!vids.length) return "";`
- 근거: 실측 — 같은 변이 실행에서 나머지 18줄 생존: keys.js:84 · launches.js:525/568/586(티커 구성·순환) · panels.js:139/249/351/426 · satfilter.js:91/127 · satpanel.js:214 · satpass.js:191/279 · sats.js:269 · stats.js:11 · utils.js:85/172/174.
- 이력: [기존: P43 에서 166개 중 25개 생존 — 이번엔 대상이 536개로 넓어졌다]
- 심각도: 중간
- 재현: 없음 (위와 같은 명령)
- 반증조건: 각 줄이 동치 변이이거나 이를 잡는 단언이 있다
- 수정비용: 중
- 대상: tests/test_frontend.js
- 요약: 동치 변이인지 한 줄씩 판단해야 한다(예: 빈 배열 가드는 결과가 같을 수 있다). 동치가 아니면 단언을 더한다. 티커 순환(5초마다 다음 항목)과 가시 통과 필터(satpass.js:279)는 화면으로 알아채기 어려운 부류다.

### F-020 · 영역: 회귀 · 상태: 완료
- 위치: `api_client.py:572` — `if cached is None:`
- 근거: 실측 — if-py 변이(격리 사본, 106개 중 생존 26): api_client 실제 경로 6줄 생존 — 263(파일 재시도 마지막 회차) · 329(설정 동일 비교) · 450(아카이브 next·상한) · 523(잘림 로그) · **572·627(TLE·SATCAT 캐시 없을 때 오래된 캐시 폴백)**. 스모크 전용 9줄(720~769)은 P42 기준대로 제외.
- 이력: [기존: P42 에서 93개 중 32개 생존 — 그중 남은 것]
- 심각도: 중간
- 재현: 없음 (node ~/.claude/tools/mutate.js --preset if-py --test "python tests/test_cache.py && python tests/test_parsing.py" --files "api_client.py,…")
- 반증조건: 각 줄을 뒤집으면 실패하는 단언이 있다
- 수정비용: 소
- 대상: tests/test_cache.py
- 요약: 572·627 은 **F-001 을 고칠 바로 그 자리의 폴백**이다 — 수정 전에 단언부터 둔다(안 그러면 고친 폴백을 지키는 것이 없다).
- 결과: `TestAuditMutationGaps` 5건(TLE·SATCAT 옛 모양 폴백 · 교체 재시도 · 반쪽 설정 비격리 · 3페이지 대기). api_client 재변이 48개 중 생존 10 — 263·329·450·572·627 전부 잡힘, 남은 것은 로그 전용 523 과 스모크 9줄.

### F-021 · 영역: 회귀 · 상태: 미처리
- 위치: `main.py:195` — `if not dev_mode:`
- 근거: 실측 — 같은 변이 실행: main.py 11줄(89~104 개발 모니터 선택 · 187 · 195~222 창 크기·위치 복원) · startup.py:127 생존.
- 이력: [기존: P42 에서 개발 전용으로 분류한 부류 포함]
- 심각도: 낮음
- 재현: 없음 (위와 같은 명령)
- 반증조건: 창 상태 복원 판정이 순수 함수로 떼어져 테스트된다
- 수정비용: 중
- 대상: main.py, tests/test_parsing.py
- 요약: 개발 모니터 선택은 개발 전용이라 제외해도 되지만, **창 크기·위치 복원(195~222)은 사용자 경로**다 — 창을 띄우는 `main()` 안에 있어 테스트가 못 닿는다. F-011 과 같은 자리라 함께 순수 함수로 떼어 내는 것이 싸다.

### F-022 · 영역: 회귀 · 상태: 미처리
- 위치: `tests/test_cache.py:1` — `import`
- 근거: 실측 — 2026-09-24 test_cache.py 24회 실행 중 1회 `FAILED (failures=1)`(git archive 사본에서). 이어서 3회·20회 전부 통과. 실패한 테스트 이름은 출력을 걸러 내다 잃었다.
- 이력: [신규]
- 심각도: 낮음
- 재현: 없음
- 반증조건: 100회 반복에서 실패 0
- 수정비용: 중
- 대상: tests/test_cache.py
- 요약: 간헐 실패(약 4%). 동시 저장·재시도 대기처럼 시간에 기대는 테스트가 후보다(추정). 다음에 나면 **출력 전체를 보존**한다 — CI 에서 나면 이유 없이 빨간 run 이 된다.
