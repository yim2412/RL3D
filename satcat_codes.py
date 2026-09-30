"""Celestrak SATCAT 코드 → 사람이 읽는 말 (P12-5).

전역 규칙 6번(상수는 한 곳에)과 7번(에러·코드는 사람 말로)의 적용 지점.
`api_client.py` 가 커지는 것을 막으려고 표만 떼어 놨다 — **아무것도 import 하지 않는다.**

표의 범위는 추측이 아니라 **실측**이다(2026-09-11, satcat.csv 전체 70,649행):
- OBJECT_TYPE 은 4종뿐이라 **전부** 덮는다: DEB 35,888 · PAY 27,705 · R/B 6,891 · UNK 165
- OPS_STATUS 는 8종(빈 값 포함) — 전부 덮는다
- OWNER 는 130종이라 전부는 못 덮는다. 상위 항목만 두고 **모르는 코드는 원문 그대로**
  돌려준다(US 29,172 · CIS 25,220 · PRC 9,323 … 상위 20종이 대부분을 차지한다).
  P96(2026-09-30): 앱이 실제로 받는 9개 그룹 12,043기에서 코드 그대로 뜨던 35종(97기)을 더했다 —
  "상위만" 이 전체 목록 기준이라, 정지궤도 통신위성처럼 **앱이 받는 그룹에 몰린 작은 나라**가 빠져 있었다
- LAUNCH_SITE 는 37종이라 주요 발사장을 덮고, 나머지는 원문 그대로

터미널 확인: `python satcat_codes.py` → 표 크기와 미매핑 시 동작을 출력한다.
"""

# OBJECT_TYPE — 실측 4종 전부
OBJECT_TYPES = {
    "PAY": "위성체",
    "R/B": "로켓 몸체",
    "DEB": "잔해",
    "UNK": "미상",
}

# OPS_STATUS_CODE — 실측 8종 전부(빈 값 포함)
OPS_STATUS = {
    "+": "운용 중",
    "-": "운용 중지",
    "P": "부분 운용",
    "B": "예비",
    "S": "예비(대기)",
    "X": "운용 연장",
    "D": "궤도 이탈(재진입)",
    "?": "불명",
    "": "정보 없음",
}

# OWNER — 상위 종류만. 모르는 코드는 원문 그대로 보여준다(130종을 다 적지 않는다).
OWNERS = {
    "US": "미국", "CIS": "러시아/구소련", "PRC": "중국", "FR": "프랑스",
    "JPN": "일본", "IND": "인도", "UK": "영국", "ESA": "유럽우주국",
    "GER": "독일", "IT": "이탈리아", "ITSO": "인텔샛", "CA": "캐나다",
    "SPN": "스페인", "ISS": "국제우주정거장(공동)", "KOR": "대한민국",
    "SKOR": "대한민국", "NKOR": "북한", "IRAN": "이란", "ISRA": "이스라엘",
    "BRAZ": "브라질", "AUS": "호주", "TURK": "튀르키예", "SES": "SES",
    "EUME": "유럽기상위성기구", "EUTE": "유텔샛", "NATO": "나토",
    "TBD": "미정",
    # P96 — 캐시 9개 그룹 12,043기에서 **실제로 코드 그대로 뜨던** 35종(97기). 관측된 것만 더한다.
    # 뜻은 Celestrak 공식 설명(celestrak.org/satcat/sources.php)에서 옮겼다 — 기억으로 적지 않는다.
    "IM": "인마샛", "AB": "아랍샛", "AC": "아시아샛", "ABS": "아시아방송위성(ABS)",
    "RASC": "라스콤스타(아프리카)", "INDO": "인도네시아", "UAE": "아랍에미리트",
    "MEX": "멕시코", "THAI": "태국", "MALA": "말레이시아", "ARGN": "아르헨티나",
    "NOR": "노르웨이", "EGYP": "이집트", "GREC": "그리스", "VTNM": "베트남",
    "KAZ": "카자흐스탄", "AZER": "아제르바이잔", "NIG": "나이지리아", "BOL": "볼리비아",
    "LAOS": "라오스", "BELA": "벨라루스", "BUL": "불가리아", "ALG": "알제리",
    "BGD": "방글라데시", "ANG": "앙골라", "SWED": "스웨덴", "PAKI": "파키스탄",
    "RP": "필리핀", "SING": "싱가포르", "ASRA": "오스트리아", "POL": "폴란드",
    "STCT": "싱가포르/대만", "FRIT": "프랑스/이탈리아", "TMMC": "투르크메니스탄/모나코",
    "GRSA": "그리스/사우디아라비아",
}

# LAUNCH_SITE — 실측 37종 중 주요 발사장. 나머지는 원문 그대로.
LAUNCH_SITES = {
    "AFETR": "케이프커내버럴(미국)", "AFWTR": "밴덴버그(미국)",
    "PLMSC": "플레세츠크(러시아)", "TYMSC": "바이코누르(카자흐)",
    "TAISC": "타이위안(중국)", "FRGUI": "기아나 우주센터(프랑스)",
    "JSC": "주취안(중국)", "SRILR": "사티시다완(인도)",
    "XICLF": "시창(중국)", "TANSC": "다네가시마(일본)",
    "VOSTO": "보스토치니(러시아)", "WSC": "원창(중국)",
    "KSCUT": "우치노우라(일본)", "SEAL": "해상 발사(오디세이)",
    "SNMLP": "산마르코(케냐 해상)", "WLPIS": "왈롭스(미국)",
    "KODAK": "코디액(미국)", "SEMLS": "세미팔라틴스크", "ERAS": "유로파 발사장",
    "OREN": "야스니(러시아)", "NSC": "나로우주센터(대한민국)",
    "RLLC": "마히아(뉴질랜드)",
    # P96 — 캐시에서 코드 그대로 뜨던 4종(8기). 뜻은 celestrak.org/satcat/launchsites.php
    "RLLB": "마히아(뉴질랜드)", "WRAS": "미국 서부 공역(공중 발사)",
    "DLS": "돔바롭스키(러시아)", "KWAJ": "콰절린 환초(마셜제도)",
}

# RCS(레이더 반사 단면적, m²) 구간. Celestrak 의 SMALL/MEDIUM/LARGE 기준을 따른다.
RCS_SMALL_MAX = 0.1
RCS_MEDIUM_MAX = 1.0


def label(table, code):
    """표에 있으면 사람 말로, 없으면 **원문 그대로**.

    모르는 코드를 "알 수 없음"으로 뭉개면 정보가 사라진다 — 코드라도 보여주는 편이
    낫다(130종을 전부 적지 않기로 한 결정과 짝이다).
    """
    if code is None:
        return None
    code = str(code).strip()
    return table.get(code, code or None)


def rcs_size(value):
    """RCS 수치(m²) → '작음/보통/큼'. 값이 없거나 숫자가 아니면 None.

    실측상 절반(37,718/70,649)은 값이 비어 있다 — 없는 게 정상이므로 조용히 None.
    """
    if value in (None, ""):
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v < RCS_SMALL_MAX:
        return "작음"
    return "보통" if v < RCS_MEDIUM_MAX else "큼"


if __name__ == "__main__":
    import sys

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    print(f"[OK] satcat_codes - 타입 {len(OBJECT_TYPES)} · 상태 {len(OPS_STATUS)} · "
          f"소유 {len(OWNERS)} · 발사장 {len(LAUNCH_SITES)}")
    print(f"        PAY  → {label(OBJECT_TYPES, 'PAY')}")
    print(f"        ZZZ  → {label(OBJECT_TYPES, 'ZZZ')}  (모르는 코드는 원문 그대로)")
    print(f"        RCS 399.05 → {rcs_size('399.0524')} · 빈 값 → {rcs_size('')}")
