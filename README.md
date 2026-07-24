# RL3D — 로켓 발사 & 위성 추적

전 세계 로켓 발사를 **2D 지도**에 표시하고, 위성을 실시간으로 움직이게 보여주는 Windows 데스크톱 앱.
뉴스 상황판 감성의 다크 테마. pywebview + MapLibre GL 로 만든 단일 exe(설치 불필요).

## 기능

- 🗺 **발사 지도** — 전 세계 발사장을 마커로 표시 (🔵예정 / 🟢성공 / 🔴실패 / 🟠부분실패)
- 📋 **상세 패널** — 마커 클릭 시 로켓·기관·미션·궤도·발사 시각·이미지. **범주형 정보는 한국어로 표시**
- 📡 **속보 티커** — 가장 임박한 예정 발사 카운트다운 순환
- 🔍 **검색 / 필터** — 발사명·로켓·기관 검색, 결과별 on/off
- 🔄 **자동 갱신** — 5분마다 백그라운드 폴링, 새 발사·상태 변화(예정→성공 등)를 알림
- 🛰 **위성 레이어(선택)** — Celestrak TLE + satellite.js(SGP4)로 위성 실시간 위치. **기본 OFF**, 툴바에서 켜기

## 실행

```powershell
# 개발 실행
python main.py

# exe 빌드 → dist\RL3D.exe
build.bat
```

의존성: `pip install -r requirements.txt` (pywebview, pyinstaller, pythonnet[win]). Python 3.10+ 권장.

### 개발 테스트 (2번 모니터)
```powershell
RL3D_DEV_MONITOR=2 python main.py   # 창을 2번(보조) 모니터에 배치
```
`RL3D_DEV_MONITOR` 환경변수는 개발 테스트용이며 배포 exe 에는 영향이 없다.

## 데이터 소스

| 데이터 | 출처 | 캐시 TTL |
|---|---|---|
| 발사 | [Launch Library 2](https://thespacedevs.com/llapi) (thespacedevs) | 15분 |
| 위성 TLE | [Celestrak](https://celestrak.org/) (`stations`, `visual` 그룹) | 2시간 |

- 캐시 위치: `%APPDATA%\RL3D\cache\` (`launches.json`, `tle.json`)
- LL2 는 **시간당 약 15회** 제한 → 캐싱 우선. API 실패 시 오래된 캐시라도 반환(오프라인 대응)
- **새로고침 버튼**: 캐시 무시 강제 갱신 (요청 제한 주의)

## ⚠ 온라인/오프라인

- MapLibre GL·satellite.js 라이브러리는 exe 안에 **오프라인 번들**(`web/lib/`)로 포함
- 단 **지도 배경 타일(CARTO)과 발사/위성 데이터는 인터넷 연결이 필요**하다
- 완전 오프라인(지도 배경까지)은 현재 범위 밖 — 로컬 타일 번들은 향후 과제

## 터미널 스모크

```powershell
python api_client.py   # 데이터 소스별 [OK]/[FAIL]·건수 확인 (GUI 없이)
```

## 요구 사항

- Windows 10/11 — WebView2 런타임 필요(대부분 기본 내장). 흰 화면이 뜨면 WebView2 Runtime 설치

## 실시간 발사 텔레메트리에 대하여

발사 순간의 실시간 고도/속도 텔레메트리를 제공하는 **무료 공개 API는 사실상 없다**(SpaceX 등도 웹캐스트 영상뿐).
본 앱의 "실시간"은 **발사 일정·상태의 자동 갱신**(위 자동 갱신 기능)으로 구현했다. 과거 발사 텔레메트리 기록은
[Launch-Dashboard-API](https://github.com/shahar603/Launch-Dashboard-API) 같은 오픈소스가 있으나 라이브가 아니다.

## 파일 구조

```
RL3D/
├── main.py          pywebview 창 + Api 브릿지
├── api_client.py    LL2 발사 + Celestrak TLE 호출·정규화·캐싱
├── build.bat        exe 빌드
├── requirements.txt
└── web/
    ├── index.html · style.css · app.js
    └── lib/         maplibre-gl(.js/.css), satellite.min.js (오프라인 번들)
```
