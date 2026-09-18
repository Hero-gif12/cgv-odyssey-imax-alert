import io
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

import monitor


ODYSSEY, ENDGAME = monitor.TARGETS
NOW = monitor.datetime(2026, 9, 17, 12, tzinfo=monitor.KST)


def row(site_no, movie, screen, time, free=30, date="20260923"):
    return {"siteNo": site_no, "cntlYn": "N", "movNm": movie, "scnsNm": screen,
            "scnYmd": date, "scnsrtTm": time, "frSeatCnt": free,
            "scnsNo": "1", "scnSseq": time, "prodNo": "movie-1"}


def result(target, rows):
    return monitor.parse_schedule({"statusCode": 0, "data": rows}, target)


class MonitorTests(unittest.TestCase):
    def test_target_configuration_and_exact_matching(self):
        self.assertEqual([(t["site_no"], t["date"]) for t in monitor.TARGETS],
                         [("0013", "2026-09-23"), ("0074", "2026-09-23")])
        rows = [row("0074", "어벤져스-엔드게임", "IMAX관", "1310"),
                row("0074", "어벤져스: 인피니티 워", "IMAX관", "1650"),
                row("0074", "어벤져스: 엔드게임", "일반 2D관", "1910"),
                row("0013", "어벤져스: 엔드게임", "IMAX관", "2030"),
                row("0074", "Avengers: Endgame", "IMAX관", "2210", free=0)]
        parsed = result(ENDGAME, rows)
        self.assertEqual([s["time"] for s in parsed["sessions"]], ["13:10"])
        self.assertIn("일반 2D관", parsed["screens"])
        self.assertEqual(result(ODYSSEY, rows)["sessions"], [])

    def test_wrong_date_schema_and_controlled_session(self):
        for bad in ({}, row("0074", "어벤져스-엔드게임", "IMAX관", "1310", date="20260921")):
            with self.assertRaises(monitor.MonitorError):
                result(ENDGAME, [bad])
        controlled = row("0074", "어벤져스-엔드게임", "IMAX관", "1650")
        controlled["cntlYn"] = "Y"
        self.assertEqual(result(ENDGAME, [controlled])["sessions"], [])

    def test_legacy_odyssey_state_survives_and_new_target_alerts_once(self):
        path = Path(__file__).resolve().parents[1] / "test-legacy-state.json"
        odyssey_row = row("0013", "오디세이", "IMAX관", "1310")
        old_key = result(ODYSSEY, [odyssey_row])["sessions"][0]["key"]
        state = {"version": 1, "initialized": True, "seen": {
            "2026-09-21": ["old-session"], "2026-09-23": [old_key]},
            "failures": 0, "next_retry": None, "error_notified_at": None, "unhealthy": False}
        endgame_rows = []
        sent, fetched = [], []

        def fetch(target):
            fetched.append((target["site_no"], target["date"]))
            return result(target, [odyssey_row] if target is ODYSSEY else endgame_rows)

        try:
            path.write_text(monitor.json.dumps(state), encoding="utf-8")
            with patch.object(monitor, "STATE_PATH", path), patch.object(monitor, "fetch", fetch), \
                    patch.object(monitor, "send_discord", lambda message=None, embed=None: sent.append(embed)), \
                    patch.object(monitor, "now", lambda: NOW):
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(sent, [])
                endgame_rows = [row("0074", "어벤져스-엔드게임", "IMAX관", "1650")]
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(len(sent), 1)
                self.assertEqual(sent[0]["fields"][0]["value"], "어벤져스: 엔드게임")
                self.assertEqual(sent[0]["fields"][1]["value"], "CGV 왕십리")
                self.assertEqual(sent[0]["fields"][4]["value"], "16:50")
                saved = monitor.load_state()["seen"]
                self.assertEqual(saved["2026-09-23"], [old_key])
                self.assertEqual(saved["2026-09-21"], ["old-session"])
                self.assertEqual(len(saved[ENDGAME["state_key"]]), 1)
                self.assertEqual(set(fetched), {("0013", "2026-09-23"), ("0074", "2026-09-23")})
        finally:
            path.unlink(missing_ok=True)

    def test_first_run_baseline_and_no_duplicate(self):
        path = Path(__file__).resolve().parents[1] / "test-baseline-state.json"
        rows = {"0013": [row("0013", "오디세이", "IMAX관", "1310")],
                "0074": [row("0074", "어벤져스-엔드게임", "IMAX관", "1650")]}
        try:
            with patch.object(monitor, "STATE_PATH", path), \
                    patch.object(monitor, "fetch", lambda target: result(target, rows[target["site_no"]])), \
                    patch.object(monitor, "send_discord") as send, patch.object(monitor, "now", lambda: NOW):
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(monitor.run(), 0)
                send.assert_not_called()
                self.assertEqual(len(monitor.load_state()["seen"][ENDGAME["state_key"]]), 1)
        finally:
            path.unlink(missing_ok=True)

    def test_discord_failure_keeps_new_session_pending(self):
        path = Path(__file__).resolve().parents[1] / "test-discord-state.json"
        rows, sent = [], []

        def send(message=None, embed=None):
            sent.append(embed)
            if len(sent) == 1:
                raise monitor.MonitorError("Discord 전송 실패: HTTP 503")

        try:
            with patch.object(monitor, "STATE_PATH", path), \
                    patch.object(monitor, "fetch", lambda target: result(target, rows if target is ENDGAME else [])), \
                    patch.object(monitor, "send_discord", send), patch.object(monitor, "now", lambda: NOW):
                self.assertEqual(monitor.run(), 0)
                rows.append(row("0074", "어벤져스-엔드게임", "IMAX관", "1310"))
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(monitor.load_state()["seen"][ENDGAME["state_key"]], [])
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(len(monitor.load_state()["seen"][ENDGAME["state_key"]]), 1)
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(len(sent), 2)
        finally:
            path.unlink(missing_ok=True)

    def test_access_and_parse_errors_stop_lookup_and_back_off(self):
        path = Path(__file__).resolve().parents[1] / "test-backoff-state.json"
        for message in ("HTTP 403", "HTTP 429", "CAPTCHA 또는 Challenge 의심", "응답 파싱 실패"):
            calls = []

            def fail(target):
                calls.append(target["site_no"])
                raise monitor.MonitorError(message)

            try:
                with patch.object(monitor, "STATE_PATH", path), patch.object(monitor, "fetch", fail), \
                        patch.object(monitor, "now", lambda: NOW), patch.object(monitor, "send_discord") as send:
                    self.assertEqual(monitor.run(), 1)
                    self.assertEqual(send.call_count, 1)
                    self.assertEqual(monitor.run(), 0)
                    self.assertEqual(send.call_count, 1)
                    self.assertEqual(calls, ["0013"])
                    self.assertEqual(monitor.load_state()["next_retry"], "2026-09-17T12:05:00+09:00")
            finally:
                path.unlink(missing_ok=True)

    def test_repeated_errors_and_recovery_notify_once(self):
        path = Path(__file__).resolve().parents[1] / "test-error-state.json"
        current = NOW
        try:
            with patch.object(monitor, "STATE_PATH", path), patch.object(monitor, "now", lambda: current), \
                    patch.object(monitor, "fetch", side_effect=monitor.MonitorError("HTTP 403")) as fetch, \
                    patch.object(monitor, "send_discord") as send:
                for _ in range(4):
                    self.assertEqual(monitor.run(), 1)
                    current = monitor.datetime.fromisoformat(monitor.load_state()["next_retry"])
                self.assertEqual(send.call_count, 1)
                fetch.side_effect = lambda target: result(target, [])
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(send.call_count, 2)
                self.assertIn("복구", send.call_args.args[0])
        finally:
            path.unlink(missing_ok=True)

    def test_first_target_alert_survives_second_target_failure(self):
        path = Path(__file__).resolve().parents[1] / "test-partial-state.json"
        state = {"version": 1, "initialized": True, "seen": {}, "failures": 0}
        current = NOW

        def fetch(target):
            if target is ENDGAME:
                raise monitor.MonitorError("HTTP 403")
            return result(target, [row("0013", "오디세이", "IMAX관", "1310")])

        try:
            path.write_text(monitor.json.dumps(state), encoding="utf-8")
            with patch.object(monitor, "STATE_PATH", path), patch.object(monitor, "fetch", fetch), \
                    patch.object(monitor, "now", lambda: current), patch.object(monitor, "send_discord") as send:
                self.assertEqual(monitor.run(), 1)
                self.assertEqual(send.call_count, 2)  # booking alert, then interruption alert
                self.assertEqual(send.call_args_list[0].args[1]["fields"][4]["value"], "13:10")
                self.assertEqual(len(monitor.load_state()["seen"][ODYSSEY["state_key"]]), 1)
                current = monitor.datetime.fromisoformat(monitor.load_state()["next_retry"])
                self.assertEqual(monitor.run(), 1)
                self.assertEqual(send.call_count, 2)
        finally:
            path.unlink(missing_ok=True)

    def test_error_notification_retry_during_backoff_does_not_fetch_cgv(self):
        path = Path(__file__).resolve().parents[1] / "test-pending-error-state.json"
        state = {"version": 1, "initialized": True, "seen": {}, "failures": 2,
                 "unhealthy": True, "error_notified_at": None,
                 "next_retry": monitor.iso(NOW + monitor.timedelta(minutes=15))}
        try:
            path.write_text(monitor.json.dumps(state), encoding="utf-8")
            with patch.object(monitor, "STATE_PATH", path), patch.object(monitor, "now", lambda: NOW), \
                    patch.object(monitor, "fetch") as fetch, patch.object(monitor, "send_discord") as send:
                send.side_effect = monitor.MonitorError("Discord 전송 실패: HTTP 503")
                self.assertEqual(monitor.run(), 0)
                self.assertIsNone(monitor.load_state()["error_notified_at"])
                send.side_effect = None
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(send.call_count, 2)
                fetch.assert_not_called()
        finally:
            path.unlink(missing_ok=True)

    def test_http_block_diagnostic_does_not_print_response_body(self):
        response = monitor.urllib.error.HTTPError(monitor.API, 403, "Forbidden",
            {"Content-Type": "text/html"}, io.BytesIO(b"<html>access denied private-response-must-not-log</html>"))
        output = io.StringIO()
        with patch.object(monitor.urllib.request, "urlopen", side_effect=response) as request, redirect_stderr(output):
            with self.assertRaisesRegex(monitor.MonitorError, "HTTP 403"):
                monitor.fetch(ODYSSEY)
        request.assert_called_once()
        self.assertIn("403", output.getvalue())
        self.assertIn("access denied", output.getvalue())
        self.assertNotIn("private-response-must-not-log", output.getvalue())
        self.assertNotIn(monitor.API, output.getvalue())

    def test_alert_uses_real_lookup_and_test_label_without_state_change(self):
        sample_target = {**ODYSSEY, "date": "2026-09-17"}
        sample = result(sample_target, [row("0013", "오디세이", "IMAX관", "1430", date="20260917")])
        with patch.object(monitor, "now", lambda: NOW), patch.object(monitor, "fetch", return_value=sample) as fetch, \
                patch.object(monitor, "send_discord") as send, patch.object(monitor, "save_state") as save:
            monitor.test_alert()
        fetch.assert_called_once_with(sample_target)
        self.assertIn("[테스트]", send.call_args.kwargs["embed"]["title"])
        self.assertIn("14:30", send.call_args.kwargs["embed"]["fields"][4]["value"])
        save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
