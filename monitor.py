#!/usr/bin/env python3
"""CGV IMAX schedule watcher. No login, cookies, or browser automation."""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path


KST = timezone(timedelta(hours=9))
TARGETS = (
    {"date": "2026-09-23", "site_no": "0013", "theater": "CGV 용산아이파크몰",
     "movie": "오디세이", "titles": {"오디세이", "theodyssey", "odyssey"},
     "state_key": "2026-09-23"},
    {"date": "2026-09-23", "site_no": "0074", "theater": "CGV 왕십리",
     "movie": "어벤져스: 엔드게임", "titles": {"어벤져스엔드게임", "어벤져스엔드게임앙코르", "avengersendgame"},
     "state_key": "0074|avengers-endgame|2026-09-23"},
)
API = "https://cgv.co.kr/api/v1/booking/searchMovScnInfo"
BOOKING_PAGE = "https://cgv.co.kr/cnm/movieBook/cinema"
USER_AGENT = "CGVScheduleMonitor/1.0 (+https://github.com/Hero-gif12/cgv-odyssey-imax-alert)"
STATE_PATH = Path(__file__).with_name("state.json")
CHALLENGE_WORDS = ("captcha", "cloudflare", "challenge", "access denied")


class MonitorError(Exception):
    pass


def now():
    return datetime.now(KST)


def iso(instant):
    return instant.isoformat(timespec="seconds")


def log(message, *, error=False):
    print(f"[{now():%H:%M:%S} KST] {message}", file=sys.stderr if error else sys.stdout, flush=True)


def notify(message=None, embed=None):
    """A Discord outage must not stop later CGV checks or consume an unsent alert."""
    try:
        send_discord(message, embed)
    except MonitorError as error:
        log(str(error), error=True)
        return False
    log("Discord 알림 전송 성공")
    return True


def notify_error(state):
    """Report the first failure, including an unsent failure during backoff."""
    current = now()
    last = state.get("error_notified_at")
    if last and current - datetime.fromisoformat(last) < timedelta(hours=6):
        return
    if notify("**CGV 감시 일시 중단**\n상영정보를 읽지 못해 예매 오픈을 놓칠 수 있습니다.\n"
              f"상태: {state.get('last_error', '이전 실행의 CGV 조회 실패')}\n"
              f"감시: {state.get('failed_target', '등록된 IMAX 감시 대상')}\n"
              f"재확인 가능 시각: {state['next_retry']} (이후 GitHub 예약 실행 시 재시도)\n"
              "CGV에서 직접 예매 가능 여부를 확인하세요."):
        state["error_notified_at"] = iso(current)
        save_state(state)


def alert_new_sessions(state, result):
    target = result["target"]
    state_key = target["state_key"]
    seen = set(state["seen"].setdefault(state_key, []))
    new = [s for s in result["sessions"] if s["key"] not in seen]
    if new:
        log(f"신규 IMAX 회차 발견: {target['movie']} / {target['theater']} / {target['date']} " +
            ", ".join(sorted({s["time"] for s in new})))
        if notify(embed=session_embed(target, new)):
            state["seen"][state_key] = sorted(seen | {s["key"] for s in new})
            save_state(state)


def load_state():
    try:
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if not isinstance(state, dict) or state.get("version") != 1:
            raise ValueError("invalid version")
        return state
    except FileNotFoundError:
        return {"version": 1, "initialized": False, "seen": {}, "failures": 0,
                "next_retry": None, "error_notified_at": None, "unhealthy": False}
    except (ValueError, OSError):
        raise MonitorError("상태 파일을 읽을 수 없습니다. 기존 상태를 덮어쓰지 않습니다.") from None


def save_state(state):
    temporary = STATE_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(STATE_PATH)


def normalize_title(value):
    value = re.sub(r"\([^)]*\)|\[[^]]*]", "", value).casefold()
    return re.sub(r"[^\w가-힣]", "", value)


def movie_matches(value, target):
    return normalize_title(value) in target["titles"]


def is_imax(row):
    # A format label alone is insufficient: the actual auditorium must be IMAX.
    return "IMAX" in str(row.get("scnsNm", "")).upper() or "아이맥스" in str(row.get("scnsNm", ""))


def parse_schedule(payload, target):
    requested_date = target["date"]
    if not isinstance(payload, dict) or payload.get("statusCode") != 0:
        raise MonitorError("CGV API 오류 또는 데이터 구조 변경")
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise MonitorError("CGV 데이터 구조 변경: 회차 목록이 없습니다")

    movies, screens, matched = set(), set(), []
    target_rows = 0
    for row in rows:
        if not isinstance(row, dict):
            raise MonitorError("CGV 데이터 구조 변경: 회차 형식이 잘못되었습니다")
        movie = str(row.get("movNm") or "").strip()
        screen = str(row.get("scnsNm") or "").strip()
        date = str(row.get("scnYmd") or "")
        time = str(row.get("scnsrtTm") or "")
        if not movie or not screen or not row.get("siteNo"):
            raise MonitorError("CGV 데이터 구조 변경: 영화·상영관·극장 정보가 없습니다")
        if date != requested_date.replace("-", ""):
            raise MonitorError("CGV 응답 날짜가 요청 날짜와 다릅니다")
        # The official endpoint also includes the neighbouring CINE de CHEF.
        if row["siteNo"] != target["site_no"]:
            continue
        target_rows += 1
        movies.add(movie)
        if movie_matches(movie, target):
            screens.add(screen)
        if not movie_matches(movie, target) or not is_imax(row):
            continue
        if not re.fullmatch(r"\d{4}", time) or int(time[-2:]) > 59 or int(time[:2]) > 29:
            raise MonitorError("CGV 데이터 구조 변경: 상영시간을 읽을 수 없습니다")
        try:
            free = int(row["frSeatCnt"])
        except (KeyError, TypeError, ValueError):
            raise MonitorError("CGV 데이터 구조 변경: 잔여 좌석 수를 읽을 수 없습니다") from None
        if free < 0:
            raise MonitorError("CGV 데이터 구조 변경: 잔여 좌석 수가 잘못되었습니다")
        if row.get("cntlYn") not in ("Y", "N"):
            raise MonitorError("CGV 데이터 구조 변경: 예매 제어 상태가 없습니다")
        if free == 0 or row["cntlYn"] == "Y":
            continue
        key = "|".join((requested_date, str(row.get("scnsNo") or screen),
                        str(row.get("scnSseq") or ""), str(row.get("prodNo") or ""), time))
        matched.append({"key": key, "time": time[:2] + ":" + time[2:],
                        "screen": screen, "movie": movie})
    return {"target": target, "date": requested_date, "rows": target_rows, "related_rows": len(rows) - target_rows, "movies": sorted(movies),
            "screens": sorted(screens), "sessions": matched}


def fetch(target):
    params = urllib.parse.urlencode({"coCd": "A420", "siteNo": target["site_no"],
                                     "scnYmd": target["date"].replace("-", ""), "rtctlScopCd": "08"})
    request = urllib.request.Request(API + "?" + params,
                                     headers={"Accept": "application/json", "Referer": BOOKING_PAGE,
                                              "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            status = response.status
            content_type = response.headers.get("Content-Type", "")
            body = response.read(2_000_000)
    except urllib.error.HTTPError as error:
        status = error.code
        content_type = error.headers.get("Content-Type", "")
        body = error.read(20_000)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise MonitorError("네트워크 오류") from None

    sample = body.decode("utf-8", errors="replace")
    if status in (403, 429):
        # Log only fixed categories, never response bodies, URLs, or headers.
        kind = "JSON" if "json" in content_type.lower() else "HTML" if "html" in content_type.lower() else "기타"
        markers = [word for word in CHALLENGE_WORDS if word in sample[:20_000].casefold()]
        log(f"CGV HTTP 진단: 상태={status}, 응답유형={kind}, 읽은바이트={len(body)}, "
            f"차단표식={','.join(markers) or '없음'}", error=True)
        raise MonitorError(f"HTTP {status}")
    if any(word in sample[:20_000].casefold() for word in CHALLENGE_WORDS):
        raise MonitorError("CAPTCHA 또는 Challenge 의심")
    if status != 200:
        raise MonitorError(f"HTTP {status}")
    if "json" not in content_type.lower():
        raise MonitorError("응답 파싱 실패: JSON이 아닙니다")
    try:
        return parse_schedule(json.loads(sample), target)
    except ValueError:
        raise MonitorError("응답 파싱 실패: JSON 형식 오류") from None


def webhook_url():
    url = os.environ.get("DISCORD_WEBHOOK_URL", "")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc not in ("discord.com", "discordapp.com") or not parsed.path.startswith("/api/webhooks/"):
        raise MonitorError("DISCORD_WEBHOOK_URL 환경변수가 없거나 형식이 올바르지 않습니다")
    return url


def send_discord(message=None, embed=None):
    url = webhook_url()
    payload = {"allowed_mentions": {"parse": []}}
    if message:
        payload["content"] = message
    if embed:
        payload["embeds"] = [embed]
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json",
                 "User-Agent": "DiscordBot (https://github.com/Hero-gif12/cgv-odyssey-imax-alert, 1.0)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status not in (200, 204):
                raise MonitorError(f"Discord 전송 실패: HTTP {response.status}")
    except urllib.error.HTTPError as error:
        raise MonitorError(f"Discord 전송 실패: HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        # Never print the exception: urllib may include the secret webhook URL.
        raise MonitorError("Discord 전송 실패: 네트워크 오류") from None


def session_embed(target, sessions):
    return {"title": "CGV 예매 오픈 감지", "color": 0xE74C3C,
            "fields": [{"name": "영화", "value": target["movie"], "inline": True},
                       {"name": "극장", "value": target["theater"], "inline": True},
                       {"name": "상영관", "value": "IMAX", "inline": True},
                       {"name": "날짜", "value": target["date"], "inline": True},
                       {"name": "새로 발견된 회차", "value": "\n".join(sorted({s["time"] for s in sessions}))}],
            "description": "CGV에서 직접 예매 가능 여부를 확인하세요.",
            "footer": {"text": "감지 시간(KST): " + now().strftime("%Y-%m-%d %H:%M:%S")}}


def diagnose(result):
    target = result["target"]
    print(f"{result['date']} | 극장: {target['theater']} (siteNo={target['site_no']}) | 회차 {result['rows']}개")
    print("  조회된 영화: " + (", ".join(result["movies"]) or "없음"))
    print(f"  {target['movie']} 상영관: " + (", ".join(result["screens"]) or "없음"))
    if result.get("related_rows"):
        print(f"  다른 극장 회차 {result['related_rows']}개 제외")
    print(f"  예매 가능한 {target['movie']} IMAX: " +
          (", ".join(sorted({s["time"] for s in result["sessions"]})) or "없음"))


def test_alert():
    """Exercise the real CGV lookup and Discord embed without touching saved state."""
    date = now().date().isoformat()
    target = {**TARGETS[0], "date": date}
    result = fetch(target)
    diagnose(result)
    if not result["sessions"]:
        raise MonitorError("오늘 실제 오디세이 IMAX 회차가 없어 예매 알림 테스트를 보낼 수 없습니다")
    sample = sorted(result["sessions"], key=lambda session: session["time"])[0]
    embed = session_embed(target, [sample])
    embed["title"] = "[테스트] CGV 예매 알림 형식 확인"
    embed["description"] = "실제 CGV 회차로 만든 연결 테스트입니다. 새 회차 등록 알림은 아닙니다."
    send_discord(embed=embed)
    print(f"실제 CGV 회차로 Discord 테스트 알림 전송 성공: {date} {sample['time']}")


def run(once=False, notify_existing=False):
    state = load_state()
    current = now()
    if not once and current.date().isoformat() > max(target["date"] for target in TARGETS):
        print("감시 대상 날짜가 지났습니다. 조회를 종료합니다.")
        return 0
    if not once and state.get("next_retry") and current < datetime.fromisoformat(state["next_retry"]):
        print("CGV 조회 대기 중: " + state["next_retry"])
        if state.get("unhealthy"):
            notify_error(state)
        return 0

    results = []
    try:
        for target in TARGETS:
            result = fetch(target)
            diagnose(result)
            results.append(result)
            # Notify immediately; a later target's failure must not hide this result.
            if not once and state.get("initialized"):
                alert_new_sessions(state, result)
    except MonitorError as error:
        log(f"CGV 조회 실패 ({target['movie']} / {target['theater']} / {target['date']}): {error}", error=True)
        if once:
            return 1
        state["failures"] = int(state.get("failures", 0)) + 1
        delays = (5, 15, 30, 60, 120)
        delay = delays[min(state["failures"] - 1, len(delays) - 1)]
        state["next_retry"] = iso(current + timedelta(minutes=delay))
        state["unhealthy"] = True
        state["last_error"] = str(error)
        state["failed_target"] = f"{target['movie']} / {target['theater']} / IMAX / {target['date']}"
        save_state(state)
        notify_error(state)
        return 1

    if once:
        print("CGV 회차 데이터 조회 성공. 단발 조회는 상태를 변경하지 않습니다.")
        return 0

    if state.get("unhealthy") and notify("CGV 감시가 정상 상태로 복구되었습니다."):
        state["unhealthy"] = False
        save_state(state)
    if not state.get("initialized"):
        if notify_existing:
            for result in results:
                if result["sessions"]:
                    target = result["target"]
                    notify(f"현재 {target['movie']} IMAX 회차가 이미 존재함", session_embed(target, result["sessions"]))
        print("최초 기준값 저장")
    if not state.get("initialized"):
        for result in results:
            state["seen"][result["target"]["state_key"]] = sorted({s["key"] for s in result["sessions"]})
    for result in results:
        if not result["sessions"]:
            target = result["target"]
            log(f"{target['movie']} / {target['theater']} / {target['date']} IMAX 회차 없음")
    state.update(initialized=True, failures=0, next_retry=None, error_notified_at=None)
    state.pop("last_error", None)
    state.pop("failed_target", None)
    save_state(state)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="실제 CGV 단발 조회, 알림·상태 변경 없음")
    mode.add_argument("--run", action="store_true", help="한 번 감시하고 상태 저장")
    mode.add_argument("--test-discord", action="store_true", help="Discord 테스트 메시지")
    mode.add_argument("--test-alert", action="store_true", help="오늘 실제 CGV 회차로 예매 알림 형식 테스트")
    parser.add_argument("--notify-existing", action="store_true", help="최초 실행 시 기존 회차도 한 번 알림")
    args = parser.parse_args()
    try:
        if args.test_discord:
            send_discord("CGV 감시 프로그램 Discord 알림 테스트 성공")
            print("Discord 테스트 메시지 전송 성공. 채널 수신 여부를 확인하세요.")
            return 0
        if args.test_alert:
            test_alert()
            return 0
        return run(once=args.once, notify_existing=args.notify_existing)
    except MonitorError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
