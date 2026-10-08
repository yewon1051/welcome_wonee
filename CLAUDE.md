# 만나기 체크리스트

부부가 같이 쓰는 출산가방·출산 후 정책 신청 체크리스트 웹앱이에요.
순수 HTML/CSS/JS(빌드 없음) + Firebase(Auth 이메일/비밀번호: 부부 공용 계정 하나 + 숫자 4자리 PIN, Firestore). GitHub Pages(public 저장소)로 배포해요.
아기 이름·출산(예정)일은 Firestore `rooms/home/meta/info`(babyName, birthDate)에만 저장해요.

## 구조
- `index.html`, `style.css`, `app.js`: 앱 본체 (ES 모듈, 프레임워크 없음)
- `seed.js`: 새 공유방에 채워지는 기본 리스트
- `config.js`: Firebase 웹 설정 (공개 가능한 값만)
- `firestore.rules`: 보안 규칙 (콘솔에도 게시해야 적용돼요)
- `scripts/check-public.mjs`: 개인정보·위험 패턴 검사

## 명령
- 검사: `node scripts/check-public.mjs && node --check app.js`
- 로컬 실행: `python3 -m http.server 8000` 후 http://localhost:8000 (config.js가 비어 있으면 체험 모드)

## 규칙 (반드시 지켜요)
@RULES.md

## 작업 방식
- 코드를 바꾼 뒤 커밋 전에 위 검사 명령을 실행해요.
- 개인정보(출산일, 아기 이름, 연락처, 병원명, 비밀번호)를 코드·문서·커밋 메시지에 쓰지 않아요. 예시가 필요하면 가짜 값을 써요.
- 새 의존성, 새 백엔드, 보안 규칙 변경은 먼저 이유를 설명하고 확인을 받아요.
- 정책 금액·기한을 `seed.js`에 쓸 땐 출처와 확인 날짜를 주석에 남기고, 불확실하면 "확인 필요"로 써요.
- 답변과 문서는 한국어로, 쉬운 말로 써요.
