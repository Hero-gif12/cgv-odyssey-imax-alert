import unittest
from pathlib import Path
from unittest.mock import patch

import monitor


def row(date, movie, screen, time, free=30):
    return {"siteNo": "0013", "cntlYn": "N", "movNm": movie, "scnsNm": screen, "scnYmd": date,
            "scnsrtTm": time, "frSeatCnt": free,
            "scnsNo": "1", "scnSseq": time, "prodNo": "movie-1"}


class MonitorTests(unittest.TestCase):
    def test_alert_uses_real_lookup_and_test_label_without_state_change(self):
        date = "2026-09-17"
        result = monitor.parse_schedule(
            {"statusCode": 0, "data": [row("20260917", "오디세이", "IMAX관", "1430")]}, date
        )
        with patch.object(monitor, "now", lambda: monitor.datetime(2026, 9, 17, 12, tzinfo=monitor.KST)), \
                patch.object(monitor, "fetch", return_value=result) as fetch, \
                patch.object(monitor, "send_discord") as send, \
                patch.object(monitor, "save_state") as save:
            monitor.test_alert()
        fetch.assert_called_once_with(date)
        send.assert_called_once()
        self.assertIn("[테스트]", send.call_args.kwargs["embed"]["title"])
        self.assertIn("14:30", send.call_args.kwargs["embed"]["fields"][4]["value"])
        save.assert_not_called()

    def test_related_theater_and_controlled_session_are_excluded(self):
        related = row("20260921", "오디세이", "IMAX관", "1310")
        related["siteNo"] = "P013"
        controlled = row("20260921", "오디세이", "IMAX관", "1650")
        controlled["cntlYn"] = "Y"
        result = monitor.parse_schedule({"statusCode": 0, "data": [related, controlled]}, "2026-09-21")
        self.assertEqual(result["sessions"], [])
        self.assertEqual(result["related_rows"], 1)

    def test_schema_and_wrong_date_fail_even_for_other_movies(self):
        for bad in ({}, row("20260923", "다른 영화", "일반관", "1310")):
            with self.assertRaises(monitor.MonitorError):
                monitor.parse_schedule({"statusCode": 0, "data": [bad]}, "2026-09-21")

    def test_movie_screen_date_and_availability(self):
        payload = {"statusCode": 0, "data": [
            row("20260921", "오디세이", "IMAX관", "1310"),
            row("20260921", "오디세이", "일반 2D관", "1650"),
            row("20260921", "다른 영화", "IMAX관", "1910"),
            row("20260921", "The Odyssey", "IMAX관", "2030", free=0),
        ]}
        result = monitor.parse_schedule(payload, "2026-09-21")
        self.assertEqual([s["time"] for s in result["sessions"]], ["13:10"])
        self.assertIn("일반 2D관", result["screens"])
        with self.assertRaises(monitor.MonitorError):
            monitor.parse_schedule(payload, "2026-09-23")

    def test_first_run_baseline_then_one_new_alert_and_no_duplicate(self):
        path = Path(__file__).resolve().parents[1] / "test-baseline-state.json"
        try:
            first = {"2026-09-21": [row("20260921", "오디세이", "IMAX관", "1310")],
                     "2026-09-23": []}
            second = {"2026-09-21": first["2026-09-21"] + [row("20260921", "오디세이", "IMAX관", "1650")],
                      "2026-09-23": []}
            active = first
            sent = []

            def fetch(date):
                return monitor.parse_schedule({"statusCode": 0, "data": active[date]}, date)

            with patch.object(monitor, "STATE_PATH", path), patch.object(monitor, "fetch", fetch), \
                    patch.object(monitor, "send_discord", lambda message=None, embed=None: sent.append((message, embed))), \
                    patch.object(monitor, "now", lambda: monitor.datetime(2026, 9, 17, 12, tzinfo=monitor.KST)):
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(sent, [])
                self.assertTrue(path.exists())
                active = second
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(len(sent), 1)
                self.assertIn("16:50", sent[0][1]["fields"][4]["value"])
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(len(sent), 1)
        finally:
            path.unlink(missing_ok=True)

    def test_backoff_prevents_immediate_retry(self):
        path = Path(__file__).resolve().parents[1] / "test-backoff-state.json"
        try:
            calls = []

            def fail(date):
                calls.append(date)
                raise monitor.MonitorError("HTTP 403")

            with patch.object(monitor, "STATE_PATH", path), patch.object(monitor, "fetch", fail), \
                    patch.object(monitor, "now", lambda: monitor.datetime(2026, 9, 17, 12, tzinfo=monitor.KST)):
                self.assertEqual(monitor.run(), 1)
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(len(calls), 1)
                self.assertEqual(monitor.load_state()["next_retry"], "2026-09-17T12:05:00+09:00")
        finally:
            path.unlink(missing_ok=True)

    def test_discord_failure_keeps_new_session_pending(self):
        path = Path(__file__).resolve().parents[1] / "test-discord-state.json"
        date = "2026-09-21"
        current_rows = []
        sent = []

        def fetch(requested_date):
            return monitor.parse_schedule(
                {"statusCode": 0, "data": current_rows if requested_date == date else []}, requested_date
            )

        def send(message=None, embed=None):
            sent.append(embed)
            if len(sent) == 1:
                raise monitor.MonitorError("Discord 전송 실패: HTTP 503")

        try:
            with patch.object(monitor, "STATE_PATH", path), patch.object(monitor, "fetch", fetch), \
                    patch.object(monitor, "send_discord", send), \
                    patch.object(monitor, "now", lambda: monitor.datetime(2026, 9, 17, 12, tzinfo=monitor.KST)):
                self.assertEqual(monitor.run(), 0)
                current_rows.append(row("20260921", "오디세이", "IMAX관", "1310"))
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(monitor.load_state()["seen"][date], [])
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(len(monitor.load_state()["seen"][date]), 1)
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(len(sent), 2)
        finally:
            path.unlink(missing_ok=True)

    def test_repeated_errors_and_recovery_notify_once(self):
        path = Path(__file__).resolve().parents[1] / "test-error-state.json"
        current = monitor.datetime(2026, 9, 17, 12, tzinfo=monitor.KST)
        try:
            with patch.object(monitor, "STATE_PATH", path), \
                    patch.object(monitor, "now", lambda: current), \
                    patch.object(monitor, "fetch", side_effect=monitor.MonitorError("HTTP 403")) as fetch, \
                    patch.object(monitor, "send_discord") as send:
                for _ in range(4):
                    self.assertEqual(monitor.run(), 1)
                    current = monitor.datetime.fromisoformat(monitor.load_state()["next_retry"])
                self.assertEqual(send.call_count, 1)
                fetch.side_effect = lambda date: monitor.parse_schedule({"statusCode": 0, "data": []}, date)
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(monitor.run(), 0)
                self.assertEqual(send.call_count, 2)
                self.assertIn("복구", send.call_args.args[0])
        finally:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
