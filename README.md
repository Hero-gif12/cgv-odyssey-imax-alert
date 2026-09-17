# CGV 용산아이파크몰 오디세이 IMAX 감시

**개인용 상영 스케줄 알림 도구이며 자동 예매 기능 없음**

GitHub Actions에서 2026-09-21, 2026-09-23의 예매 가능한 IMAX 회차를 확인하고, 새 회차가 생기면 Discord Webhook으로 알립니다. 자동 예매·로그인·쿠키·브라우저 자동화는 사용하지 않습니다. Python 표준 라이브러리만 사용합니다.

2026-09-17: [기준 상태 저장 실행](https://github.com/Hero-gif12/cgv-odyssey-imax-alert/actions/runs/35177353460)이 성공했고, `CGV_MONITOR_ENABLED=true`로 예약 감시를 활성화했습니다. 실행 상태와 로그는 [Actions](https://github.com/Hero-gif12/cgv-odyssey-imax-alert/actions/workflows/cgv-monitor.yml)에서 확인할 수 있습니다.

## 먼저 확인할 점

- 2026-09-17 재검증에서 프로그램 식별용 `User-Agent: CGVScheduleMonitor/1.0`를 명시한 일반 HTTP 요청으로 **로컬과 GitHub Actions 모두 실제 회차 조회에 성공했습니다.** 브라우저 위장·쿠키·프록시는 사용하지 않습니다. 서버 측 403 발생 원인 자체를 확정한 것은 아닙니다.
- [GitHub Actions 실제 조회 성공 기록](https://github.com/Hero-gif12/cgv-odyssey-imax-alert/actions/runs/35177285509): 9월 21일 용산아이파크몰 6개 회차, 9월 23일 10개 회차. 검증 시점에 두 날짜의 오디세이 IMAX 회차는 없었습니다. 함께 반환된 씨네드쉐프 용산(`P013`) 회차는 제외합니다.
- Discord 테스트 전송 성공 및 사용자의 채널 수신 확인을 완료했습니다. 오늘(9월 17일)의 실제 회차로 오디세이의 일반관·4DX·IMAX 구분도 확인했습니다. 이 날짜는 진단에만 사용하며 감시 대상에 추가하지 않았습니다.
- Actions 예약 실행의 최단 간격은 5분입니다. 실행이 늦거나 누락될 수 있어 즉시 알림을 보장하지 않습니다.
- 비용을 없애려면 표준 GitHub 호스팅 러너를 쓰는 **공개 저장소**가 적합합니다. 비공개 저장소는 계정의 무료 사용 시간을 소모하므로 이 빈도로 장기 실행하지 마세요.
- `state.json`은 회차 키와 오류 대기 시각을 저장소에 커밋합니다. Webhook URL은 절대 넣지 않습니다.

## 설정

1. 이 폴더의 `monitor.py`, `.gitignore`, `.github/workflows/cgv-monitor.yml`을 저장소 기본 브랜치에 올립니다.
2. 저장소 **Settings → Secrets and variables → Actions → Secrets**에서 `DISCORD_WEBHOOK_URL`을 등록합니다. 실제 URL을 코드, Issue, 로그, 채팅에 붙이지 마세요.
3. **Actions → CGV Odyssey IMAX monitor → Run workflow**에서 `test-discord`를 실행하고 채널에서 테스트 메시지 수신을 확인합니다.
   실제 CGV 조회부터 Discord Embed까지 확인하려면 `test-alert`를 선택합니다. 오늘 조회된 오디세이 IMAX 회차 중 하나를 **[테스트]**로 표시해 보냅니다. 상태 파일은 변경하지 않습니다.
4. 같은 메뉴에서 `once`를 실행합니다. 두 날짜의 `회차 데이터 조회 성공`과 영화·상영관·시간 진단을 확인합니다. HTTP 403·429·Challenge·파싱 오류라면 여기서 멈춥니다.
5. 실제 CGV 회차 데이터가 읽힌 경우에만 `run`을 한 번 실행해 기준 상태를 저장합니다. 최초 기존 회차 알림이 필요하면 `notify_existing`을 선택합니다. `state.json`이 커밋됐는지 확인합니다.
6. 실제 CGV 조회가 성공하는 정상 경로가 확인된 경우에만 **Settings → Secrets and variables → Actions → Variables**에 `CGV_MONITOR_ENABLED` 값을 `true`로 등록해 예약 감시를 켭니다. 중지하려면 `false`로 바꾸거나 **Actions → CGV Odyssey IMAX monitor → … → Disable workflow**를 선택합니다.

## 동작

- 예약: 2026년 9월 17~23일에 5분마다 최대 한 번 실행. 각 실행에서 날짜별로 한 번씩 조회합니다.
- 새 회차 판정: 극장 코드 `0013`, 영화명 `오디세이`/`The Odyssey`/`Odyssey`, 실제 상영관명 `IMAX`/`아이맥스`, 지정 날짜, 잔여 좌석 1석 이상, 예매 제어 상태 `N`. CGV에서 직접 예매 가능 여부를 최종 확인하세요.
- 첫 실행: 기존 회차를 `state.json`에만 기록합니다. 이후 같은 회차는 재알림하지 않습니다.
- 오류: 첫 실패부터 5 → 15 → 30 → 60 → 120분 대기. 세 번 연속 실패 후 Discord 오류 알림, 동일 오류 알림은 6시간 동안 억제. 정상 회복 시 한 번 알립니다.
- CGV 응답 형식이 바뀌면 성공으로 처리하지 않습니다. Webhook 전송 오류에 URL을 출력하지 않습니다.

## 로컬 명령

```bash
python3 monitor.py --once
DISCORD_WEBHOOK_URL='...' python3 monitor.py --test-discord
DISCORD_WEBHOOK_URL='...' python3 monitor.py --run
```

로컬에서도 `.env`는 자동 로드하지 않습니다. 환경변수로 전달하거나 셸에서 직접 로드하세요. `.env`는 `.gitignore`에 등록되어 있습니다.

## 테스트

`python3 -m unittest discover -s tests -v`로 극장·영화·상영관·날짜 필터, 예매 제어 상태, 신규 회차 알림과 중복 방지, 오류 대기, 반복 오류 알림 억제와 복구 알림을 확인합니다. 외부 CGV 요청이나 Discord 전송 없이 실행되며 6개 테스트가 통과했습니다.
