#!/usr/bin/env python3
"""CGV Yongsan IMAX schedule watcher. No login, cookies, or browser automation."""

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
DATES = ("2026-09-21", "2026-09-23")
SITE_NO = "0013"
THEATER = "CGV 용산아이파크몰"
API = "https://cgv.co.kr/api/v1/booking/searchMovScnInfo"
BOOKING_PAGE = "https://cgv.co.kr/cnm/movieBook/cinema"
STATE_PATH = Path(__file__).with_name("state.json")
CHALLENGE_WORDS = ("captcha", "cloudflare", "challenge", "access denied")


class MonitorError(Exception):
    pass


def now():
    return datetime.now(KST)


def iso(instant):
    return instant.isoformat(timespec="seconds")


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


def movie_matches(value):
    return normalize_title(value) in {"오디세이", "theodyssey", "odyssey"}


def is_imax(row):
    # A format label alone is insufficient: the actual auditorium must be IMAX.
    return "IMAX" in str(row.get("scnsNm", "")).upper() or "아이맥스" in str(row.get("scnsNm", ""))


def parse_schedule(payload, requested_date):
    if not isinstance(payload, dict) or payload.get("statusCode") != 0:
        raise MonitorError("CGV API 오류 또는 데이터 구조 변경")
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise MonitorError("CGV 데이터 구조 변경: 회차 목록이 없습니다")

    movies, screens, matched = set(), set(), []
    for row in rows:
        if not isinstance(row, dict):
            raise MonitorError("CGV 데이터 구조 변경: 회차 형식이 잘못되었습니다")
        movie = str(row.get("movNm") or "").strip()
        screen = str(row.get("scnsNm") or "").strip()
        date = str(row.get("scnYmd") or "")
        time = str(row.get("scnsrtTm") or "")
        movies.add(movie)
        if movie_matches(movie):
            screens.add(screen)
        if not movie_matches(movie) or not is_imax(row):
            continue
        if date != requested_date.replace("-", ""):
            raise MonitorError("CGV 응답 날짜가 요청 날짜와 다릅니다")
        if not re.fullmatch(r"\d{4}", time) or int(time[-2:]) > 59 or int(time[:2]) > 29:
            raise MonitorError("CGV 데이터 구조 변경: 상영시간을 읽을 수 없습니다")
        try:
            free = int(row["frSeatCnt"])
        except (KeyError, TypeError, ValueError):
            raise MonitorError("CGV 데이터 구조 변경: 잔여 좌석 수를 읽을 수 없습니다") from None
        if free < 0:
            raise MonitorError("CGV 데이터 구조 변경: 잔여 좌석 수가 잘못되었습니다")
        if free == 0:
            continue
        key = "|".join((requested_date, str(row.get("scnsNo") or screen),
                        str(row.get("scnSseq") or ""), str(row.get("prodNo") or ""), time))
        matched.append({"key": key, "time": time[:2] + ":" + time[2:],
                        "screen": screen, "movie": movie})
    return {"date": requested_date, "rows": len(rows), "movies": sorted(movies),
            "screens": sorted(screens), "sessions": matched}


def fetch(date):
    params = urllib.parse.urlencode({"coCd": "A420", "siteNo": SITE_NO,
                                     "scnYmd": date.replace("-", ""), "rtctlScopCd": "08"})
    request = urllib.request.Request(API + "?" + params,
                                     headers={"Accept": "application/json", "Referer": BOOKING_PAGE})
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

    if status in (403, 429):
        raise MonitorError(f"HTTP {status}")
    sample = body.decode("utf-8", errors="replace")
    if any(word in sample[:20_000].casefold() for word in CHALLENGE_WORDS):
        raise MonitorError("CAPTCHA 또는 Challenge 의심")
    if status != 200:
        raise MonitorError(f"HTTP {status}")
    if "json" not in content_type.lower():
        raise MonitorError("응답 파싱 실패: JSON이 아닙니다")
    try:
        return parse_schedule(json.loads(sample), date)
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


def session_embed(date, sessions):
    return {"title": "CGV 예매 오픈 감지", "color": 0xE74C3C,
            "fields": [{"name": "영화", "value": "오디세이", "inline": True},
                       {"name": "극장", "value": THEATER, "inline": True},
                       {"name": "상영관", "value": "IMAX", "inline": True},
                       {"name": "날짜", "value": date, "inline": True},
                       {"name": "새로 발견된 회차", "value": "\n".join(sorted({s["time"] for s in sessions}))}],
            "description": "CGV에서 직접 예매 가능 여부를 확인하세요.",
            "footer": {"text": "감지 시간(KST): " + now().strftime("%Y-%m-%d %H:%M:%S")}}


def diagnose(result):
    print(f"{result['date']} | 극장: {THEATER} (siteNo={SITE_NO}) | 회차 {result['rows']}개")
    print("  조회된 영화: " + (", ".join(result["movies"]) or "없음"))
    print("  오디세이 상영관: " + (", ".join(result["screens"]) or "없음"))
    print("  예매 가능한 오디세이 IMAX: " +
          (", ".join(sorted({s["time"] for s in result["sessions"]})) or "없음"))


def run(once=False, notify_existing=False):
    state = load_state()
    current = now()
    if not once and current.date().isoformat() > max(DATES):
        print("감시 대상 날짜가 지났습니다. 조회를 종료합니다.")
        return 0
    if not once and state.get("next_retry") and current < datetime.fromisoformat(state["next_retry"]):
        print("CGV 조회 대기 중: " + state["next_retry"])
        return 0

    results = []
    try:
        for date in DATES:
            result = fetch(date)
            diagnose(result)
            results.append(result)
    except MonitorError as error:
        print("CGV 조회 실패: " + str(error), file=sys.stderr)
        if once:
            return 1
        state["failures"] = int(state.get("failures", 0)) + 1
        delays = (5, 15, 30, 60, 120)
        delay = delays[min(state["failures"] - 1, len(delays) - 1)]
        state["next_retry"] = iso(current + timedelta(minutes=delay))
        state["unhealthy"] = True
        save_state(state)
        if state["failures"] >= 3:
            last = state.get("error_notified_at")
            if not last or current - datetime.fromisoformat(last) >= timedelta(hours=6):
                send_discord("**CGV 감시 오류**\nCGV 상영정보 조회를 연속으로 실패했습니다.\n"
                             f"상태: {error}\n감시: 오디세이 / 용산아이파크몰 / IMAX\n"
                             f"조치: 요청 간격을 {delay}분으로 늘렸습니다.")
                state["error_notified_at"] = iso(current)
                save_state(state)
        return 1

    if once:
        print("CGV 회차 데이터 조회 성공. 단발 조회는 상태를 변경하지 않습니다.")
        return 0

    if state.get("unhealthy"):
        send_discord("CGV 감시가 정상 상태로 복구되었습니다.")
    if not state.get("initialized"):
        if notify_existing:
            for result in results:
                if result["sessions"]:
                    send_discord("현재 오디세이 IMAX 회차가 이미 존재함", session_embed(result["date"], result["sessions"]))
        print("최초 기준값 저장")
    else:
        for result in results:
            date = result["date"]
            seen = set(state["seen"].get(date, []))
            new = [s for s in result["sessions"] if s["key"] not in seen]
            if new:
                send_discord(embed=session_embed(date, new))
                print(f"신규 회차 알림: {date}, {len(new)}개")
    for result in results:
        date = result["date"]
        state["seen"][date] = sorted(set(state["seen"].get(date, [])) |
                                     {s["key"] for s in result["sessions"]})
    state.update(initialized=True, failures=0, next_retry=None, unhealthy=False, error_notified_at=None)
    save_state(state)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="실제 CGV 단발 조회, 알림·상태 변경 없음")
    mode.add_argument("--run", action="store_true", help="한 번 감시하고 상태 저장")
    mode.add_argument("--test-discord", action="store_true", help="Discord 테스트 메시지")
    parser.add_argument("--notify-existing", action="store_true", help="최초 실행 시 기존 회차도 한 번 알림")
    args = parser.parse_args()
    try:
        if args.test_discord:
            send_discord("CGV 감시 프로그램 Discord 알림 테스트 성공")
            print("Discord 테스트 메시지 전송 성공. 채널 수신 여부를 확인하세요.")
            return 0
        return run(once=args.once, notify_existing=args.notify_existing)
    except MonitorError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
