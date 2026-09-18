# CGV IMAX 상영 회차 알림

**개인용 상영 스케줄 알림 도구이며 자동 예매 기능 없음**

Cloudflare Workers Free에서 매분 실행하고, 새로 예매 가능한 IMAX 회차를 Discord Webhook으로 알립니다. 컴퓨터나 Codex를 켜 둘 필요가 없습니다.

| 영화 | 극장 | 상영 날짜 |
| --- | --- | --- |
| 오디세이 | CGV 용산아이파크몰 | 2026-09-23 |
| 어벤져스: 엔드게임 | CGV 왕십리 | 2026-09-23 |

용산 오디세이 **2026-09-21 감시는 종료**했습니다. 과거 전송 이력은 보존하지만 해당 날짜를 조회하지 않습니다. 대상은 예매가 열리는 날짜가 아니라 실제 상영 날짜입니다.

## 현재 운영 방식

- 실행 코드: [`cloudflare/worker.mjs`](cloudflare/worker.mjs), 상태 저장: Cloudflare D1. JavaScript 표준 기능만 사용하며 외부 라이브러리가 없습니다.
- Cron은 매분 실행을 요청합니다. 매 실행에서 두 극장을 순서대로 한 번씩 조회하고 새 회차는 발견 즉시 전송합니다. 실행 지연이나 CGV 차단이 있을 수 있어 정확한 60초 감지와 100% 전달을 보장하지는 않습니다.
- 극장 코드·날짜·정확한 영화 제목·실제 IMAX 상영관·잔여 좌석 1석 이상·예매 제어 상태 `N`을 확인합니다. 왕십리의 실제 표기 `어벤져스-엔드게임 앙코르`도 인식합니다. 4DX/SCREENX/일반관은 제외합니다.
- D1에 전송 완료 회차를 저장하고 180초 잠금으로 겹친 실행을 막습니다. 기존 GitHub `state.json`의 기록을 그대로 이전했습니다. Discord 전송 실패 시 완료로 표시하지 않으며 다음 실행에서 다시 시도합니다.
- 403/429/CAPTCHA/Challenge/파싱 오류 시 그 실행의 추가 CGV 요청을 중단하고 5→15→30→60→120분 대기합니다. 첫 오류부터 Discord로 알리고 6시간 동안 반복 오류 알림을 억제합니다. 복구 시 한 번 알립니다. 정상적인 영화 없음·IMAX 회차 없음은 오류가 아닙니다.
- 2026-09-24 00:00 KST부터 CGV 조회를 중단합니다. 다른 영화나 날짜는 `TARGETS`와 종료일을 함께 변경한 뒤 테스트해야 합니다.
- 공개 상영정보만 조회합니다. 로그인·계정 쿠키·자동 예매·좌석 선택·결제·브라우저 위장·프록시·CAPTCHA 우회 기능이 없습니다.

## 실조회 검증

2026-09-18 17:06 KST, Cloudflare 운영 코드로 확인했습니다.

| 대상 | 실제 해당 극장 회차 수 | 알림 대상 IMAX 회차 |
| --- | ---: | --- |
| 용산 오디세이 9월 23일 | 31 | 07:30, 11:00, 14:30, 18:00, 21:30, 25:00 |
| 왕십리 엔드게임 9월 23일 | 34 | 없음 (4DX/SCREENX만 확인) |

이 표는 검증 시점의 결과입니다. CGV에서 직접 현재 예매 가능 여부를 확인하세요. 이전 GitHub 실행에서 이미 전송한 용산 6개 회차는 Cloudflare에서 다시 전송하지 않습니다.

Discord 테스트는 서버의 메시지 생성 응답과 실제 채널 표시까지 확인했습니다. 휴대폰 알림 배너는 Discord 앱의 서버·채널 알림 설정과 기기 설정에 따릅니다.

## 비밀값과 관리

- `DISCORD_WEBHOOK_URL`은 Cloudflare Worker의 **Settings → Runtime variables and secrets → Secret**으로만 저장합니다. 실제 URL을 코드·Issue·로그·README에 쓰지 마세요.
- `.env`, `.dev.vars`, `.wrangler/`는 Git에서 제외합니다. GitHub에 남아 있는 기존 Actions Secret은 Python 복구용이며 읽어 와서 코드에 복사하지 않습니다.
- [Cloudflare 대시보드](https://dash.cloudflare.com/) → Workers & Pages → `cgv-personal-preflight` → **Observability**에서 KST 조회 로그를 확인합니다. 이 이름의 Worker가 현재 개인 감시 실행부입니다.
- 중지: **Settings → Runtime variables and secrets → MONITOR_ENABLED**를 `false`로 저장합니다. 재개는 `true`입니다.
- 회차 이력을 유지하려면 `DB` 바인딩의 `cgv-personal-monitor-state`를 그대로 유지하세요. 재배포한다고 초기화하지 마세요.
- 운영 설정·검증·복구 세부사항: [Cloudflare README](cloudflare/README.md).

Cloudflare Free에서 무료 사용량 내로 운영합니다. 매분 실행은 하루 약 1,440회이며 유료 서비스나 유료 API를 사용하지 않습니다. 예약 실행 정책과 한도는 [Cloudflare 문서](https://developers.cloudflare.com/workers/configuration/cron-triggers/)와 [무료 사용량 안내](https://developers.cloudflare.com/workers/platform/pricing/)를 참고하세요.

## GitHub Actions와 Python 복구용 코드

GitHub의 CGV 정기 조회 cron은 제거했습니다. `cgv-monitor.yml`은 `CGV_LEGACY_MONITOR_ENABLED=true`를 별도로 등록해야 동작하는 수동 복구용입니다. 이전 `CGV_MONITOR_ENABLED` 변수는 더 이상 실행 조건에 쓰지 않습니다. Cloudflare와 GitHub 감시를 동시에 켜지 마세요.

Python `--once`, `--test-discord`, `--test-alert`, `--run`, `--notify-existing`와 기존 전송 이력 파일을 보존했습니다. 실제 CGV 접근 검증 후에만 복구용 감시를 사용하세요.

```sh
python3 monitor.py --once
python3 monitor.py --test-discord
python3 -m unittest discover -s tests -v
node --test --test-isolation=none cloudflare/worker.test.mjs
```

`Offline monitor tests` workflow는 공개 응답에서 만든 fixture와 모의 오류로 판별·중복 방지·오류 처리만 테스트합니다. 이 테스트는 CGV에 요청하거나 Discord 메시지를 보내지 않습니다.
