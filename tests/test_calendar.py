"""Tests for the iCal parser (pipeline/calendar_feed.py). Stdlib only."""
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pipeline"))
import calendar_feed as cf  # noqa: E402

UTC = dt.timezone.utc


def _win(days=7, base="2026-07-20T12:00:00"):
    start = dt.datetime.fromisoformat(base).replace(tzinfo=UTC)
    return start - dt.timedelta(hours=3), start + dt.timedelta(days=days)


def _wrap(vevent):
    return "BEGIN:VCALENDAR\r\n" + vevent + "\r\nEND:VCALENDAR"


class SingleEvent(unittest.TestCase):
    def test_timed_event_in_window(self):
        ws, we = _win()
        ics = _wrap(
            "BEGIN:VEVENT\r\nSUMMARY:Board call\r\n"
            "DTSTART:20260721T150000Z\r\nDTEND:20260721T160000Z\r\n"
            "LOCATION:Zoom\r\nEND:VEVENT"
        )
        out = cf.parse_ics(ics, ws, we)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["title"], "Board call")
        self.assertEqual(out[0]["location"], "Zoom")
        self.assertFalse(out[0]["all_day"])
        self.assertEqual(out[0]["start"],
                         int(dt.datetime(2026, 7, 21, 15, tzinfo=UTC).timestamp()))

    def test_event_outside_window_excluded(self):
        ws, we = _win(days=2)
        ics = _wrap("BEGIN:VEVENT\r\nSUMMARY:Later\r\nDTSTART:20260801T150000Z\r\nEND:VEVENT")
        self.assertEqual(cf.parse_ics(ics, ws, we), [])

    def test_all_day_event(self):
        ws, we = _win()
        ics = _wrap("BEGIN:VEVENT\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20260722\r\nEND:VEVENT")
        out = cf.parse_ics(ics, ws, we)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0]["all_day"])

    def test_cancelled_event_skipped(self):
        ws, we = _win()
        ics = _wrap("BEGIN:VEVENT\r\nSUMMARY:Off\r\nSTATUS:CANCELLED\r\n"
                    "DTSTART:20260721T150000Z\r\nEND:VEVENT")
        self.assertEqual(cf.parse_ics(ics, ws, we), [])

    def test_folded_summary_is_unfolded(self):
        ws, we = _win()
        ics = _wrap("BEGIN:VEVENT\r\nSUMMARY:Quarterly plan\r\n ning sync\r\n"
                    "DTSTART:20260721T150000Z\r\nEND:VEVENT")
        out = cf.parse_ics(ics, ws, we)
        self.assertEqual(out[0]["title"], "Quarterly planning sync")


class Timezones(unittest.TestCase):
    def test_tzid_converted_to_correct_utc(self):
        ws, we = _win()
        # 9am America/New_York on 2026-07-21 is 13:00 UTC (EDT, UTC-4).
        ics = _wrap("BEGIN:VEVENT\r\nSUMMARY:Standup\r\n"
                    "DTSTART;TZID=America/New_York:20260721T090000\r\nEND:VEVENT")
        out = cf.parse_ics(ics, ws, we)
        self.assertEqual(out[0]["start"],
                         int(dt.datetime(2026, 7, 21, 13, tzinfo=UTC).timestamp()))


class Recurrence(unittest.TestCase):
    def test_weekly_byday_expands_within_window(self):
        ws, we = _win(days=15)  # window 2026-07-20 12:00 .. 2026-08-04 12:00
        ics = _wrap("BEGIN:VEVENT\r\nSUMMARY:Team sync\r\n"
                    "DTSTART:20260720T140000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\nEND:VEVENT")
        out = cf.parse_ics(ics, ws, we)
        # Mondays 7/20, 7/27, 8/3 (all 14:00Z) fall in the window.
        self.assertEqual([dt.datetime.fromtimestamp(e["start"], UTC).date().isoformat() for e in out],
                         ["2026-07-20", "2026-07-27", "2026-08-03"])

    def test_daily_recurrence(self):
        ws, we = _win(days=3, base="2026-07-20T10:00:00")
        ics = _wrap("BEGIN:VEVENT\r\nSUMMARY:Daily\r\n"
                    "DTSTART:20260720T090000Z\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT")
        out = cf.parse_ics(ics, ws, we)
        self.assertEqual(len(out), 4)  # 7/20, 21, 22, 23 (all 09:00Z, within the window)

    def test_until_bounds_the_series(self):
        ws, we = _win(days=21)
        ics = _wrap("BEGIN:VEVENT\r\nSUMMARY:Ends soon\r\n"
                    "DTSTART:20260720T140000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260727T000000Z\r\n"
                    "END:VEVENT")
        out = cf.parse_ics(ics, ws, we)
        self.assertEqual(len(out), 1)  # only 7/20; 7/27 is after UNTIL midnight

    def test_exdate_skips_one_instance(self):
        ws, we = _win(days=14)
        ics = _wrap("BEGIN:VEVENT\r\nSUMMARY:Weekly\r\n"
                    "DTSTART:20260720T140000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\n"
                    "EXDATE:20260727T140000Z\r\nEND:VEVENT")
        out = cf.parse_ics(ics, ws, we)
        dates = [dt.datetime.fromtimestamp(e["start"], UTC).date().isoformat() for e in out]
        self.assertNotIn("2026-07-27", dates)
        self.assertIn("2026-07-20", dates)

    def test_interval_every_two_weeks(self):
        ws, we = _win(days=21)
        ics = _wrap("BEGIN:VEVENT\r\nSUMMARY:Biweekly\r\n"
                    "DTSTART:20260720T140000Z\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO\r\nEND:VEVENT")
        out = cf.parse_ics(ics, ws, we)
        dates = [dt.datetime.fromtimestamp(e["start"], UTC).date().isoformat() for e in out]
        self.assertEqual(dates, ["2026-07-20", "2026-08-03"])  # skips 7/27


class OrderingAndLimit(unittest.TestCase):
    def test_events_sorted_by_start(self):
        ws, we = _win()
        ics = _wrap(
            "BEGIN:VEVENT\r\nSUMMARY:Second\r\nDTSTART:20260721T150000Z\r\nEND:VEVENT\r\n"
            "BEGIN:VEVENT\r\nSUMMARY:First\r\nDTSTART:20260721T090000Z\r\nEND:VEVENT"
        )
        out = cf.parse_ics(ics, ws, we)
        self.assertEqual([e["title"] for e in out], ["First", "Second"])


if __name__ == "__main__":
    unittest.main()
