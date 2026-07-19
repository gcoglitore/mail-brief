"""Fetch a Google Calendar "secret iCal address" and return upcoming events.

Stdlib only (no pip deps on either runner). Read-only — we only ever GET the
.ics URL, so the app can never modify the calendar.

Handles single events plus DAILY / WEEKLY recurrence expanded across a short
lookahead window (enough for a "this week" agenda), honouring INTERVAL, UNTIL
and EXDATE. Other RRULE frequencies fall back to their first instance. Times are
kept in their original timezone so recurrences land on the correct wall-clock
time across DST changes.
"""

import datetime as dt
import re
import urllib.request
from zoneinfo import ZoneInfo

_UTC = dt.timezone.utc
_WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


def _unfold(text):
    # RFC 5545 line folding: a CRLF followed by a space/tab continues the line.
    return re.sub(r"\r?\n[ \t]", "", text)


def _unescape(s):
    return (s.replace("\\N", "\n").replace("\\n", "\n")
             .replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\"))


def _prop(line):
    """Split 'NAME;P1=v1;P2=v2:value' into (NAME, {params}, value)."""
    head, _, value = line.partition(":")
    parts = head.split(";")
    params = {}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        params[k.upper()] = v
    return parts[0].upper(), params, value


def _parse_dt(value, params):
    """Return (aware_datetime, all_day_bool) from a DTSTART/DTEND value+params.

    The datetime keeps its source timezone (Z -> UTC, TZID -> that zone,
    floating -> assumed UTC, since Google always stamps TZID or Z)."""
    value = (value or "").strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
        try:
            return dt.datetime.strptime(value, "%Y%m%d").replace(tzinfo=_UTC), True
        except ValueError:
            return None, False
    m = re.fullmatch(r"(\d{8}T\d{6})(Z)?", value)
    if not m:
        return None, False
    naive = dt.datetime.strptime(m.group(1), "%Y%m%dT%H%M%S")
    if m.group(2) == "Z":
        return naive.replace(tzinfo=_UTC), False
    tzid = params.get("TZID")
    if tzid:
        try:
            return naive.replace(tzinfo=ZoneInfo(tzid)), False
        except Exception:
            pass
    return naive.replace(tzinfo=_UTC), False


def _rrule(value):
    out = {}
    for kv in value.split(";"):
        k, _, v = kv.partition("=")
        if k:
            out[k.upper()] = v
    return out


def _parse_vevent(block):
    ev = {"exdates": set()}
    for line in block.strip().splitlines():
        if ":" not in line:
            continue
        name, params, value = _prop(line)
        if name == "SUMMARY":
            ev["summary"] = _unescape(value)
        elif name == "LOCATION":
            ev["location"] = _unescape(value)
        elif name == "STATUS":
            ev["status"] = value.strip().upper()
        elif name == "DTSTART":
            d, all_day = _parse_dt(value, params)
            if d:
                ev["start"], ev["all_day"] = d, all_day
        elif name == "DTEND":
            d, _ = _parse_dt(value, params)
            if d:
                ev["end"] = d
        elif name == "RRULE":
            ev["rrule"] = _rrule(value)
        elif name == "EXDATE":
            for v in value.split(","):
                d, _ = _parse_dt(v, params)
                if d:
                    ev["exdates"].add(d)
    return ev


def _occurrences(ev, win_start, win_end):
    """Occurrence start-datetimes of ev within [win_start, win_end]."""
    start = ev["start"]
    rule = ev.get("rrule")
    exdates = ev.get("exdates", set())
    if not rule or not rule.get("FREQ"):
        return [start] if win_start <= start <= win_end else []

    freq = rule["FREQ"]
    if freq not in ("DAILY", "WEEKLY", "MONTHLY", "YEARLY"):
        return [start] if win_start <= start <= win_end else []

    interval = max(1, int(rule.get("INTERVAL") or "1"))
    until = _parse_dt(rule["UNTIL"], {})[0] if rule.get("UNTIL") else None
    bydays = [_WEEKDAYS[d] for d in rule.get("BYDAY", "").split(",") if d in _WEEKDAYS]
    if freq == "WEEKLY" and not bydays:
        bydays = [start.weekday()]
    monthday = start.day
    if rule.get("BYMONTHDAY"):
        try:
            md = int(rule["BYMONTHDAY"].split(",")[0])
            if md > 0:
                monthday = md
        except ValueError:
            pass

    base_week = start.date() - dt.timedelta(days=start.weekday())
    # Walk day-by-day across the (short) window — the walk starts at the window
    # edge, not the series start, so an old recurring event stays cheap. The
    # per-occurrence match below does the real filtering.
    day = max(start.date(), (win_start - dt.timedelta(days=1)).date())
    last = (win_end + dt.timedelta(days=1)).date()
    out = []
    guard = 0
    while day <= last and guard < 4000:
        guard += 1
        occ = dt.datetime.combine(day, start.timetz())  # keeps start's timezone
        if occ >= start and win_start <= occ <= win_end and (not until or occ <= until) and occ not in exdates:
            match = False
            if freq == "DAILY":
                match = (day - start.date()).days % interval == 0
            elif freq == "WEEKLY":
                wk = (day - base_week).days // 7
                match = day.weekday() in bydays and wk % interval == 0
            elif freq == "MONTHLY":
                mo = (day.year - start.year) * 12 + (day.month - start.month)
                match = mo >= 0 and mo % interval == 0 and day.day == monthday
            elif freq == "YEARLY":
                yr = day.year - start.year
                match = yr >= 0 and yr % interval == 0 and (day.month, day.day) == (start.month, start.day)
            if match:
                out.append(occ)
        day += dt.timedelta(days=1)
    return out


def parse_ics(text, win_start, win_end, limit=40):
    """Parse an .ics document; return upcoming events as plain dicts."""
    text = _unfold(text)
    events = []
    for block in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", text, re.S):
        ev = _parse_vevent(block)
        if not ev.get("start") or ev.get("status") == "CANCELLED":
            continue
        for occ in _occurrences(ev, win_start, win_end):
            dur = (ev["end"] - ev["start"]) if ev.get("end") else dt.timedelta(0)
            end = occ + dur
            events.append({
                "title": (ev.get("summary") or "(busy)")[:120],
                "start": int(occ.timestamp()),
                "end": int(end.timestamp()),
                "location": (ev.get("location") or "")[:120],
                "all_day": bool(ev.get("all_day")),
            })
    events.sort(key=lambda e: e["start"])
    return events[:limit]


def _fetch(url, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": "MailBrief/1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def upcoming_events(ical_url, days=7, now=None, timeout=20):
    """Fetch the iCal URL and return events from ~now to now+days."""
    now = now or dt.datetime.now(_UTC)
    win_start = now - dt.timedelta(hours=3)   # keep an in-progress meeting visible
    win_end = now + dt.timedelta(days=days)
    return parse_ics(_fetch(ical_url, timeout), win_start, win_end)
