# Cloudflare 개인 CGV 알림

**개인용 상영 스케줄 알림 도구이며 자동 예매 기능 없음**

## 등록

- 영화: 어벤져스: 엔드게임 앙코르 (CGV 실제 표기: 어벤져스-엔드게임 앙코르)
- 극장: CGV 왕십리 (`0074`)
- 관: SCREENX (예: SCREENX관 (리클라이너))
- 날짜: 2026-09-25
- Cron: `*/1 * * * *` (UTC 기준 매분, 로그는 KST)

## 구성

- `worker.mjs`: 공개 CGV 요청, 정확한 조건 판별, Discord 알림, 오류 대기
- `worker.test.mjs`: 합성 자료로 조건 필터·D1 중복 방지·잠금·오류 처리를 검사 (테스트 시각은 실제 예매 정보가 아님)
- `schema.sql`: D1 상태 테이블
- `wrangler.jsonc`: 배포 구성, D1 바인딩과 매분 Cron

D1 바인딩은 `DB`, Secret은 `DISCORD_WEBHOOK_URL`, 감시 스위치는 `MONITOR_ENABLED`입니다. 암호화된 Secret은 코드에 넣지 않습니다. 무료 플랜을 유지하며 유료 상품을 사용하지 않습니다.

조회는 CGV의 공개 `searchMovScnInfo` 요청을 사용합니다. 로그인, 개인 쿠키, CAPTCHA 또는 WAF 우회를 사용하지 않습니다. 접근이 차단되면 즉시 중단하고 대기합니다.

## 상태

`monitor_state`의 1번 행에 현재 회차와 오류 상태를 저장합니다. 새 등록 시 이전 회차·오류·진단 결과를 지우고 새 대상의 빈 목록으로 시작합니다. 이미 열린 회차가 있으면 첫 조회에서 한 번 알립니다. Discord가 전송에 실패하면 이력을 저장하지 않아 다음 실행에서 재시도합니다.

`MONITOR_ENABLED=false`로 중지할 수 있습니다. 2026-09-25가 지나면 CGV 요청을 자동 종료합니다. 재배포 시 D1을 삭제하거나 초기화하지 않으면 알림 이력이 유지됩니다.

## 임시 설치 점검

기존 설치 점검용 `PREFLIGHT_TOKEN`으로 인증한 관리자 경로는 **2026-09-18 19:00 KST까지만** 동작하며 이후 404를 반환합니다. 정상 감시는 이 토큰에 의존하지 않습니다.

- `GET /admin/status`: 현재 대상, 활성 여부와 D1 상태
- `POST /admin/run`: 활성 상태에서 한 번 조회
- `POST /admin/reset-state`: 비활성 상태이고 잠금이 없을 때만 이전 상태 삭제 및 새 등록 초기화
- `POST /admin/registration-notice`: 등록 조건 확인 메시지
- `POST /admin/test-discord`: 연결 시험

관리자 토큰도 암호화된 Secret으로만 관리하고 로컬 `.dev.vars`는 업로드하지 않습니다. 공개 요청은 404입니다.
