#!/usr/bin/env python3
"""
Fetch surf, water, sun and weather data for Huntington Beach Pier and write
site/data.json for the static site.

Standard library only, so it runs on a bare GitHub Actions runner.
Every source is optional: when one fails, the value from the previous
data.json is kept and flagged stale, the way the morning routine reports
"sources stale this run".

Usage:
  python scripts/fetch.py                   fetch live, write site/data.json
  python scripts/fetch.py --fixtures DIR    read saved responses instead of the network
  python scripts/fetch.py --dump DIR        also save every raw response for debugging
  python scripts/fetch.py --summary         print a short text summary of site/data.json
"""

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config.json")
DEFAULT_OUT = os.path.join(ROOT, "site", "data.json")
DEFAULT_CACHE = os.path.join(ROOT, "data", "last_fetch.json")

with open(CONFIG_PATH, encoding="utf-8") as fh:
    CONFIG = json.load(fh)

TZ = ZoneInfo(CONFIG["timezone"])
LOC = CONFIG["location"]
LAT, LON = LOC["lat"], LOC["lon"]
UA = CONFIG.get("user_agent", "surf-site/1.0")
NWS = "https://api.weather.gov"

COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]

SOURCE_LABELS = {
    "nws_hourly": "NWS hourly forecast",
    "nws_daily": "NWS daily forecast",
    "nws_grid": "NWS sky cover grid",
    "nws_alerts": "NWS alerts",
    "nws_srf": "NWS surf zone forecast",
    "nws_afd": "NWS forecast discussion",
    "om_weather": "Open-Meteo weather model",
    "om_marine": "Open-Meteo wave model",
    "tides": "NOAA tide predictions",
    "epa_uv": "EPA UV index",
}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- time utils

NOW_OVERRIDE = None


def now_local():
    if NOW_OVERRIDE:
        return NOW_OVERRIDE
    return datetime.now(TZ)


def iso(dt):
    if dt is None:
        return None
    return dt.isoformat(timespec="minutes")


def parse_iso(s):
    """Parse an ISO 8601 timestamp; naive strings are taken as local time."""
    if s is None:
        return None
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt.astimezone(TZ)


def local_hour(d, h):
    return datetime.combine(d, dtime(h), TZ)


def floor_hour(dt):
    return dt.replace(minute=0, second=0, microsecond=0)


def round_minutes(dt, step=5):
    m = int(round(dt.minute / step) * step)
    dt = dt.replace(second=0, microsecond=0, minute=0) + timedelta(minutes=m)
    return dt


def fmt_time(dt):
    """6:45 AM style."""
    if dt is None:
        return None
    return dt.strftime("%I:%M %p").lstrip("0")


def fmt_range(a, b):
    """6:20–9:00 AM, or 11:30 AM–1:00 PM when the suffix changes."""
    if a is None or b is None:
        return None
    ta, tb = fmt_time(a), fmt_time(b)
    if ta[-2:] == tb[-2:]:
        return f"{ta[:-3]}–{tb}"
    return f"{ta}–{tb}"


# ---------------------------------------------------------------- unit utils

def c_to_f(c):
    return None if c is None else c * 9 / 5 + 32


def m_to_ft(m):
    return None if m is None else m * 3.28084


def kmh_to_mph(k):
    return None if k is None else k * 0.621371


def compass(deg):
    if deg is None:
        return None
    return COMPASS[int((deg + 11.25) // 22.5) % 16]


def compass_to_deg(txt):
    if not txt:
        return None
    txt = txt.strip().upper()
    if txt in COMPASS:
        return COMPASS.index(txt) * 22.5
    return None


def ang_diff(a, b):
    d = abs((a - b) % 360)
    return min(d, 360 - d)


def r1(x):
    return None if x is None else round(x, 1)


def num_list(text):
    return [float(x) for x in re.findall(r"\d+(?:\.\d+)?", text or "")]


# ---------------------------------------------------------------- solar

def solar_events(d):
    """Sunrise, sunset, civil dawn/dusk and solar noon for the site on date d.

    Almanac for Computers (USNO, 1990) sunrise/sunset algorithm; accurate to
    about a minute, which is all a dawn patrol needs.
    """

    def calc(zenith, rising):
        n = d.timetuple().tm_yday
        lng_hour = LON / 15
        t = n + ((6 - lng_hour) / 24) if rising else n + ((18 - lng_hour) / 24)
        m = (0.9856 * t) - 3.289
        l = (m + (1.916 * math.sin(math.radians(m)))
             + (0.020 * math.sin(math.radians(2 * m))) + 282.634) % 360
        ra = math.degrees(math.atan(0.91764 * math.tan(math.radians(l)))) % 360
        lq = math.floor(l / 90) * 90
        raq = math.floor(ra / 90) * 90
        ra = (ra + (lq - raq)) / 15
        sin_dec = 0.39782 * math.sin(math.radians(l))
        cos_dec = math.cos(math.asin(sin_dec))
        cos_h = ((math.cos(math.radians(zenith)) - (sin_dec * math.sin(math.radians(LAT))))
                 / (cos_dec * math.cos(math.radians(LAT))))
        if cos_h > 1 or cos_h < -1:
            return None
        h = (360 - math.degrees(math.acos(cos_h))) if rising else math.degrees(math.acos(cos_h))
        h = h / 15
        tt = h + ra - (0.06571 * t) - 6.622
        ut = (tt - lng_hour) % 24
        dt = datetime(d.year, d.month, d.day, tzinfo=timezone.utc) + timedelta(hours=ut)
        local = dt.astimezone(TZ)
        # The UT day can differ from the local day; snap to the requested date.
        if local.date() < d:
            local += timedelta(days=1)
        elif local.date() > d:
            local -= timedelta(days=1)
        return local

    sunrise = calc(90.833, True)
    sunset = calc(90.833, False)
    dawn = calc(96, True)
    dusk = calc(96, False)
    noon = None
    if sunrise and sunset:
        noon = sunrise + (sunset - sunrise) / 2
    return {
        "date": d.isoformat(),
        "first_light": iso(dawn),
        "sunrise": iso(sunrise),
        "solar_noon": iso(noon),
        "sunset": iso(sunset),
        "last_light": iso(dusk),
        "day_length_min": int((sunset - sunrise).total_seconds() // 60) if sunrise and sunset else None,
    }


# ---------------------------------------------------------------- fetching

class Sources:
    """HTTP access with optional fixtures (offline) and raw dumps (debug)."""

    def __init__(self, fixtures=None, dump=None):
        self.fixtures = fixtures
        self.dump = dump
        self.status = {}
        if dump:
            os.makedirs(dump, exist_ok=True)

    def get(self, key, url, headers=None, timeout=30, retries=3):
        if self.fixtures:
            for ext in ("json", "txt", "html", ""):
                path = os.path.join(self.fixtures, f"{key}.{ext}" if ext else key)
                if os.path.exists(path):
                    with open(path, encoding="utf-8") as fh:
                        return fh.read()
            raise FileNotFoundError(f"no fixture for {key}")
        last = None
        for attempt in range(retries):
            try:
                req = urllib.request.Request(url, headers={
                    "User-Agent": UA,
                    "Accept": "application/geo+json, application/ld+json, application/json, text/plain, */*",
                    **(headers or {}),
                })
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    text = resp.read().decode("utf-8", "replace")
                if self.dump:
                    ext = "json" if text.lstrip().startswith(("{", "[")) else "txt"
                    with open(os.path.join(self.dump, f"{key}.{ext}"), "w", encoding="utf-8") as fh:
                        fh.write(text)
                return text
            except Exception as exc:  # noqa: BLE001
                last = exc
                log(f"  retry {attempt + 1}/{retries} for {key}: {exc}")
                time.sleep(2 * (attempt + 1))
        raise last

    def json(self, key, url, headers=None):
        return json.loads(self.get(key, url, headers))


# ---------------------------------------------------------------- NWS

DUR_RE = re.compile(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?")


def expand_grid(series):
    """NWS grid series -> list of {time, value} at hourly resolution (local)."""
    out = []
    for item in series.get("values", []):
        val = item.get("value")
        if val is None:
            continue
        start_s, _, dur_s = item["validTime"].partition("/")
        start = parse_iso(start_s)
        m = DUR_RE.fullmatch(dur_s or "PT1H")
        days = int(m.group(1) or 0) if m else 0
        hours = int(m.group(2) or 0) if m else 1
        mins = int(m.group(3) or 0) if m else 0
        total = days * 24 + hours + (1 if mins else 0)
        for h in range(max(total, 1)):
            out.append({"time": iso(start + timedelta(hours=h)), "value": val})
    return out


def parse_wind_speed(txt):
    nums = num_list(txt)
    if not nums:
        return None, None
    return sum(nums) / len(nums), max(nums)


def fetch_nws_points(src):
    data = src.json("nws_points", f"{NWS}/points/{LAT},{LON}")
    p = data["properties"]
    return {
        "office": p["gridId"],
        "grid": [p["gridX"], p["gridY"]],
        "hourly_url": p["forecastHourly"],
        "daily_url": p["forecast"],
        "grid_url": p["forecastGridData"],
        "zone": (p.get("forecastZone") or "").rsplit("/", 1)[-1],
    }


def fetch_nws_hourly(src, points):
    data = src.json("nws_hourly", points["hourly_url"])
    rows = []
    for per in data["properties"]["periods"]:
        mean, top = parse_wind_speed(per.get("windSpeed"))
        rh = (per.get("relativeHumidity") or {}).get("value")
        pop = (per.get("probabilityOfPrecipitation") or {}).get("value")
        rows.append({
            "time": iso(parse_iso(per["startTime"])),
            "temp_f": per.get("temperature"),
            "wind_mph": r1(mean),
            "wind_max_mph": r1(top),
            "wind_txt": per.get("windSpeed"),
            "wind_dir": per.get("windDirection"),
            "wind_deg": compass_to_deg(per.get("windDirection")),
            "humidity": rh,
            "pop": pop,
            "short": per.get("shortForecast"),
            "is_day": per.get("isDaytime"),
        })
    return {"updated": data["properties"].get("updateTime") or data["properties"].get("generatedAt"),
            "rows": rows[:96]}


def fetch_nws_daily(src, points):
    data = src.json("nws_daily", points["daily_url"])
    periods = []
    for per in data["properties"]["periods"]:
        periods.append({
            "name": per.get("name"),
            "start": iso(parse_iso(per["startTime"])),
            "is_day": per.get("isDaytime"),
            "temp_f": per.get("temperature"),
            "short": per.get("shortForecast"),
            "detailed": per.get("detailedForecast"),
            "wind_txt": per.get("windSpeed"),
            "wind_dir": per.get("windDirection"),
            "pop": (per.get("probabilityOfPrecipitation") or {}).get("value"),
        })
    return {"updated": data["properties"].get("updateTime") or data["properties"].get("generatedAt"),
            "periods": periods}


def fetch_nws_grid(src, points):
    data = src.json("nws_grid", points["grid_url"])
    p = data["properties"]
    weather = []
    for item in (p.get("weather") or {}).get("values", []):
        vals = item.get("value") or []
        kinds = sorted({(v.get("weather") or "") for v in vals if v.get("weather")})
        if not kinds:
            continue
        start_s, _, dur_s = item["validTime"].partition("/")
        weather.append({"time": iso(parse_iso(start_s)), "dur": dur_s, "kinds": kinds})
    return {
        "updated": p.get("updateTime"),
        "sky": expand_grid(p.get("skyCover") or {})[:96],
        "weather": weather[:120],
    }


def fetch_nws_alerts(src):
    data = src.json("nws_alerts", f"{NWS}/alerts/active?point={LAT},{LON}")
    out = []
    for feat in data.get("features", []):
        pr = feat.get("properties", {})
        out.append({
            "event": pr.get("event"),
            "headline": pr.get("headline"),
            "severity": pr.get("severity"),
            "onset": pr.get("onset"),
            "ends": pr.get("ends") or pr.get("expires"),
            "description": (pr.get("description") or "")[:600],
        })
    return {"alerts": out}


def latest_product(src, key, office, code):
    lst = src.json(f"{key}_list", f"{NWS}/products/types/{code}/locations/{office}")
    items = lst.get("@graph") or []
    if not items:
        raise RuntimeError(f"no {code} products listed for {office}")
    items.sort(key=lambda g: g.get("issuanceTime") or "", reverse=True)
    latest = items[0]
    prod = src.json(f"{key}_text", f"{NWS}/products/{latest['id']}")
    return latest.get("issuanceTime"), prod.get("productText") or ""


FIELD_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9 /()'*-]*?)\s*\.{2,}\s*(.*?)\s*$")
HEADLINE_RE = re.compile(r"^\.\.\.(.+?)\.\.\.$")
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def period_token_date(tok, issue_date):
    t = re.sub(r"\b(night|evening|afternoon|morning|late|early|rest of|remainder of)\b", " ", tok.lower())
    t = " ".join(t.split())
    if not t or t in ("today", "tonight", "this", "overnight"):
        return issue_date
    if t == "tomorrow":
        return issue_date + timedelta(days=1)
    for i, wd in enumerate(WEEKDAYS):
        if wd in t:
            return issue_date + timedelta(days=(i - issue_date.weekday()) % 7)
    return None


def period_dates(name, issue_date):
    """Dates a forecast period covers: 'This Afternoon Through Wednesday' -> [Tue, Wed]."""
    if issue_date is None:
        return []
    parts = re.split(r"\s+(?:through|thru|-)\s+", name.strip(), flags=re.I)
    start = period_token_date(parts[0], issue_date)
    end = period_token_date(parts[-1], issue_date) if len(parts) > 1 else start
    if start is None:
        return []
    if end is None or end < start:
        end = start
    return [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]
PERIOD_RE = re.compile(r"^\.([A-Z][A-Z ]+?)\.\.\.\s*(.*)$")
ZONE_CODE_RE = re.compile(r"^[A-Z]{2}Z\d{3}")


def parse_srf(text, keyword, issue_date=None):
    """Pull our zone out of a Surf Zone Forecast and split it into periods."""
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if keyword.lower() in line.lower() and not line.lstrip().startswith("."):
            start = i
            break
    if start is None:
        return {"found": False, "periods": [], "preview": text[:1200]}
    end = len(lines)
    for j in range(start + 1, len(lines)):
        s = lines[j].strip()
        if s.startswith("$$") or ZONE_CODE_RE.match(s):
            end = j
            break
    block = lines[start:end]
    periods = []
    headlines = []
    current = None
    last_key = None

    def add_field(per, key, val):
        key = key.replace("*", "").strip().lower()
        per["fields"][key] = val.strip()
        per["order"].append(key)
        return key

    for raw in block:
        line = raw.rstrip()
        if not line.strip():
            continue
        hm = HEADLINE_RE.match(line.strip())
        if hm and current is None:
            headlines.append(re.sub(r"\b([AP])m\b", lambda m: m.group(1) + "M", hm.group(1).strip().title()))
            continue
        pm = PERIOD_RE.match(line.strip())
        if pm:
            current = {"name": pm.group(1).title(), "fields": {}, "order": [],
                       "dates": period_dates(pm.group(1), issue_date)}
            periods.append(current)
            last_key = None
            rest = pm.group(2).strip()
            if rest:
                fm = FIELD_RE.match(rest)
                if fm:
                    last_key = add_field(current, fm.group(1), fm.group(2))
            continue
        if current is None:
            continue
        fm = FIELD_RE.match(line)
        indented = line.startswith((" ", "\t"))
        if fm and not (indented and last_key):
            last_key = add_field(current, fm.group(1), fm.group(2))
        elif last_key and indented:
            extra = f"{fm.group(1).replace('*', '').strip()}: {fm.group(2).strip()}" if fm else line.strip()
            current["fields"][last_key] = (current["fields"][last_key] + " " + extra).strip()
    for per in periods:
        f = per["fields"]
        surf_txt = next((f[k] for k in per["order"] if k.startswith("surf") and "condition" not in k), None)
        nums = num_list(surf_txt) if surf_txt else []
        sets = None
        if surf_txt:
            sm = re.search(r"sets?\D{0,20}(\d+(?:\.\d+)?)", surf_txt, re.I)
            if sm:
                sets = float(sm.group(1))
                nums = num_list(surf_txt[:sm.start()])
        per["surf_low"] = nums[0] if nums else None
        per["surf_high"] = nums[1] if len(nums) > 1 else (nums[0] if nums else None)
        per["surf_sets"] = sets
        water_txt = next((f[k] for k in per["order"] if "water temp" in k), None)
        wn = num_list(water_txt) if water_txt else []
        per["water_f"] = sum(wn) / len(wn) if wn else None
        per["water_txt"] = water_txt
        per["rip"] = next((f[k] for k in per["order"] if "rip" in k), None)
        per["remarks"] = next((f[k] for k in per["order"] if k.startswith("remark") or k.startswith("swell")), None)
    return {"found": True, "zone_header": block[0].strip(), "headlines": headlines, "periods": periods}


def fetch_nws_srf(src, points):
    issued, text = latest_product(src, "srf", points["office"], "SRF")
    issue_date = parse_iso(issued).date() if issued else now_local().date()
    parsed = parse_srf(text, LOC.get("srf_zone_keyword", "Orange County"), issue_date)
    parsed["issued"] = issued
    parsed["office"] = points["office"]
    return parsed


AFD_KEY = re.compile(r"marine layer|low cloud|stratus|\bfog\b|clearing|burn(?:ing)? off|clear(?:s|ing)? (?:back )?to the coast", re.I)


def fetch_nws_afd(src, points):
    issued, text = latest_product(src, "afd", points["office"], "AFD")
    paras = re.split(r"\n\s*\n", text)
    quote, section = None, None
    current_section = None
    for para in paras:
        flat = " ".join(para.split())
        hm = re.match(r"^\.([A-Z][A-Za-z0-9 /()&-]*?)\.\.\.\s*(.*)$", flat)
        if hm:
            current_section = hm.group(1).strip()
            flat = hm.group(2)
        if not flat or flat.startswith("&&") or flat.startswith("$$"):
            continue
        if AFD_KEY.search(flat):
            sentences = re.split(r"(?<=[.!?])\s+", flat)
            picks = [s for s in sentences if AFD_KEY.search(s)]
            if picks:
                quote = " ".join(picks[:2])
                section = current_section
                break
    if quote and len(quote) > 360:
        quote = quote[:357].rsplit(" ", 1)[0] + "..."
    return {"issued": issued, "office": points["office"], "section": section, "quote": quote}


# ---------------------------------------------------------------- Open-Meteo

def om_rows(hourly, fields):
    times = hourly.get("time") or []
    rows = []
    for i, t in enumerate(times):
        row = {"time": iso(parse_iso(t))}
        for f in fields:
            arr = hourly.get(f) or []
            row[f] = arr[i] if i < len(arr) else None
        rows.append(row)
    return rows


def fetch_om_weather(src):
    fields = ["temperature_2m", "cloud_cover", "cloud_cover_low", "uv_index", "uv_index_clear_sky",
              "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "weather_code", "is_day"]
    url = ("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode({
        "latitude": LAT, "longitude": LON,
        "hourly": ",".join(fields),
        "daily": "sunrise,sunset,uv_index_max,temperature_2m_max,temperature_2m_min",
        "timezone": CONFIG["timezone"], "temperature_unit": "fahrenheit",
        "wind_speed_unit": "mph", "forecast_days": 7,
    }))
    data = src.json("om_weather", url)
    rows = om_rows(data.get("hourly") or {}, fields)
    d = data.get("daily") or {}
    daily = []
    for i, t in enumerate(d.get("time") or []):
        daily.append({
            "date": t,
            "sunrise": iso(parse_iso(d["sunrise"][i])) if d.get("sunrise") else None,
            "sunset": iso(parse_iso(d["sunset"][i])) if d.get("sunset") else None,
            "uv_max": (d.get("uv_index_max") or [None] * 9)[i],
            "high_f": (d.get("temperature_2m_max") or [None] * 9)[i],
            "low_f": (d.get("temperature_2m_min") or [None] * 9)[i],
        })
    return {"rows": rows, "daily": daily, "model": "best_match"}


def fetch_om_marine(src):
    fields = ["wave_height", "wave_period", "wave_direction",
              "swell_wave_height", "swell_wave_period", "swell_wave_direction",
              "secondary_swell_wave_height", "secondary_swell_wave_period", "secondary_swell_wave_direction",
              "wind_wave_height", "wind_wave_period", "wind_wave_direction",
              "sea_surface_temperature"]
    url = ("https://marine-api.open-meteo.com/v1/marine?" + urllib.parse.urlencode({
        "latitude": LAT, "longitude": LON,
        "hourly": ",".join(fields),
        "timezone": CONFIG["timezone"], "length_unit": "imperial",
        "forecast_days": 7,
    }))
    data = src.json("om_marine", url)
    units = data.get("hourly_units") or {}
    rows = om_rows(data.get("hourly") or {}, fields)
    # Normalise units defensively: feet for heights, Fahrenheit for SST.
    height_unit = units.get("wave_height", "m")
    sst_unit = units.get("sea_surface_temperature", "°C")
    for row in rows:
        for f in fields:
            v = row.get(f)
            if v is None:
                continue
            if f.endswith("_height") and height_unit.startswith("m"):
                row[f] = r1(m_to_ft(v))
            elif f == "sea_surface_temperature" and "C" in sst_unit:
                row[f] = r1(c_to_f(v))
    return {"rows": rows}


# ---------------------------------------------------------------- NDBC

def parse_ndbc_table(text):
    lines = [l for l in text.splitlines() if l.strip()]
    if len(lines) < 3:
        raise ValueError("NDBC file too short")
    header = lines[0].lstrip("#").split()
    rows = []
    for line in lines[2:]:
        parts = line.split()
        if len(parts) != len(header):
            continue
        rows.append(dict(zip(header, parts)))
    return rows


def ndbc_time(row):
    yy = row.get("YY") or row.get("#YY")
    return datetime(int(yy), int(row["MM"]), int(row["DD"]), int(row["hh"]), int(row["mm"]),
                    tzinfo=timezone.utc).astimezone(TZ)


def ndbc_val(row, key):
    v = row.get(key)
    if v is None or v == "MM":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def fetch_buoy(src, buoy):
    sid = buoy["id"]
    out = {"id": sid, "name": buoy["name"]}
    std = parse_ndbc_table(src.get(f"ndbc_{sid}_txt", f"https://www.ndbc.noaa.gov/data/realtime2/{sid}.txt"))
    wave = next((r for r in std if ndbc_val(r, "WVHT") is not None), None)
    if wave:
        out.update({
            "time": iso(ndbc_time(wave)),
            "wvht_ft": r1(m_to_ft(ndbc_val(wave, "WVHT"))),
            "dpd_s": ndbc_val(wave, "DPD"),
            "apd_s": ndbc_val(wave, "APD"),
            "mwd_deg": ndbc_val(wave, "MWD"),
            "mwd": compass(ndbc_val(wave, "MWD")),
        })
    wt = next((r for r in std if ndbc_val(r, "WTMP") is not None), None)
    if wt:
        out["wtmp_f"] = r1(c_to_f(ndbc_val(wt, "WTMP")))
        out["wtmp_time"] = iso(ndbc_time(wt))
    at = next((r for r in std if ndbc_val(r, "ATMP") is not None), None)
    if at:
        out["atmp_f"] = r1(c_to_f(ndbc_val(at, "ATMP")))
    try:
        spec = parse_ndbc_table(src.get(f"ndbc_{sid}_spec", f"https://www.ndbc.noaa.gov/data/realtime2/{sid}.spec"))
        sp = next((r for r in spec if ndbc_val(r, "SwH") is not None), None)
        if sp:
            out["spec"] = {
                "time": iso(ndbc_time(sp)),
                "swell_ft": r1(m_to_ft(ndbc_val(sp, "SwH"))),
                "swell_period_s": ndbc_val(sp, "SwP"),
                "swell_dir": sp.get("SwD") if sp.get("SwD") != "MM" else None,
                "windwave_ft": r1(m_to_ft(ndbc_val(sp, "WWH"))),
                "windwave_period_s": ndbc_val(sp, "WWP"),
                "windwave_dir": sp.get("WWD") if sp.get("WWD") != "MM" else None,
                "steepness": (sp.get("STEEPNESS") or "").title() or None,
            }
    except Exception as exc:  # noqa: BLE001
        out["spec_error"] = str(exc)
    if "time" not in out and "wtmp_f" not in out:
        raise RuntimeError(f"buoy {sid}: no usable rows")
    return out


# ---------------------------------------------------------------- tides

def fetch_tides(src, today):
    base = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?"
    common = {
        "product": "predictions", "datum": "MLLW", "station": CONFIG["stations"]["tide"],
        "time_zone": "lst_ldt", "units": "english", "format": "json",
        "begin_date": today.strftime("%Y%m%d"), "range": 48,
    }
    hilo = src.json("tides_hilo", base + urllib.parse.urlencode({**common, "interval": "hilo"}))
    curve = src.json("tides_curve", base + urllib.parse.urlencode({**common, "interval": "30"}))
    if "predictions" not in hilo:
        raise RuntimeError(f"tide API: {hilo.get('error', hilo)}")

    def rows(payload, with_type):
        out = []
        for p in payload.get("predictions", []):
            t = datetime.strptime(p["t"], "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
            row = {"time": iso(t), "ft": round(float(p["v"]), 2)}
            if with_type:
                row["type"] = p.get("type")
            out.append(row)
        return out

    return {"station": CONFIG["stations"]["tide"], "station_name": CONFIG["stations"].get("tide_name"),
            "hilo": rows(hilo, True), "curve": rows(curve, False)}


# ---------------------------------------------------------------- EPA UV

def fetch_epa_uv(src, today):
    url = f"https://data.epa.gov/efservice/getEnvirofactsUVHOURLY/ZIP/{LOC['zip']}/JSON"
    data = src.json("epa_uv", url)
    days = {}
    for item in data:
        raw = item.get("DATE_TIME", "")
        try:
            t = datetime.strptime(raw, "%b/%d/%Y %I %p").replace(tzinfo=TZ)
        except ValueError:
            continue
        if t.date() >= today:
            days.setdefault(t.date().isoformat(), []).append({"time": iso(t), "uv": float(item.get("UV_VALUE", 0))})
    if not days:
        raise RuntimeError("EPA UV has no rows for today or later")
    return {"days": days}


# ---------------------------------------------------------------- analysis

def by_time(rows):
    return {r["time"]: r for r in rows or []}


def wind_quality(speed, deg):
    w = CONFIG["wind"]
    if speed is None:
        return None
    if speed <= w["glassy_max_mph"]:
        return "glassy"
    offshore = deg is not None and ang_diff(deg, w["offshore_center_deg"]) <= w["offshore_half_width_deg"]
    if offshore:
        return "offshore" if speed <= w["bumpy_max_mph"] else "strong offshore"
    if speed <= w["light_max_mph"]:
        return "light texture"
    if speed <= w["bumpy_max_mph"]:
        return "bumpy"
    return "blown out"


QUALITY_RANK = {"glassy": 0, "offshore": 0, "light texture": 1, "bumpy": 2, "strong offshore": 2, "blown out": 3}


def tide_at(curve, t):
    if not curve:
        return None
    pts = [(parse_iso(c["time"]), c["ft"]) for c in curve]
    if t <= pts[0][0]:
        return pts[0][1]
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        if t0 <= t <= t1:
            span = (t1 - t0).total_seconds() or 1
            return v0 + (v1 - v0) * ((t - t0).total_seconds() / span)
    return pts[-1][1]


def hour_rows(d, sec):
    """One row per local hour for date d, merged from every source."""
    nws = by_time((sec.get("nws_hourly") or {}).get("rows"))
    sky = by_time((sec.get("nws_grid") or {}).get("sky"))
    om = by_time((sec.get("om_weather") or {}).get("rows"))
    marine = by_time((sec.get("om_marine") or {}).get("rows"))
    rows = []
    for h in range(24):
        t = local_hour(d, h)
        key = iso(t)
        row = {"time": key, "hour": h}
        n = nws.get(key)
        if n:
            row.update({"temp_f": n.get("temp_f"), "wind_mph": n.get("wind_mph"),
                        "wind_max_mph": n.get("wind_max_mph"), "wind_txt": n.get("wind_txt"),
                        "wind_dir": n.get("wind_dir"), "wind_deg": n.get("wind_deg"),
                        "short": n.get("short"), "humidity": n.get("humidity"), "pop": n.get("pop")})
        s = sky.get(key)
        if s is not None:
            row["cloud"] = s.get("value")
        o = om.get(key)
        if o:
            row["cloud_model"] = o.get("cloud_cover")
            row["cloud_low_model"] = o.get("cloud_cover_low")
            row["uv"] = o.get("uv_index")
            row["uv_clear"] = o.get("uv_index_clear_sky")
            row["weather_code"] = o.get("weather_code")
            if row.get("temp_f") is None:
                row["temp_f"] = o.get("temperature_2m")
            if row.get("wind_mph") is None and o.get("wind_speed_10m") is not None:
                row["wind_mph"] = r1(o.get("wind_speed_10m"))
                row["wind_deg"] = o.get("wind_direction_10m")
                row["wind_dir"] = compass(o.get("wind_direction_10m"))
                row["wind_src"] = "model"
        if row.get("cloud") is None and row.get("cloud_model") is not None:
            row["cloud"] = row["cloud_model"]
            row["cloud_src"] = "model"
        m = marine.get(key)
        if m:
            row["wave_ft"] = m.get("wave_height")
            row["wave_period_s"] = m.get("wave_period")
            row["wave_deg"] = m.get("wave_direction")
            row["swell_ft"] = m.get("swell_wave_height")
            row["swell_period_s"] = m.get("swell_wave_period")
            row["swell_deg"] = m.get("swell_wave_direction")
            row["swell2_ft"] = m.get("secondary_swell_wave_height")
            row["swell2_period_s"] = m.get("secondary_swell_wave_period")
            row["swell2_deg"] = m.get("secondary_swell_wave_direction")
            row["windwave_ft"] = m.get("wind_wave_height")
            row["windwave_period_s"] = m.get("wind_wave_period")
            row["sst_f"] = m.get("sea_surface_temperature")
        row["quality"] = wind_quality(row.get("wind_mph"), row.get("wind_deg"))
        rows.append(row)
    return rows


def first_crossing(d, rows, key, sunrise, threshold, until_hour):
    """Time the cloud series first drops to <= threshold after sunrise."""
    def c(h):
        if 0 <= h < 24:
            return rows[h].get(key)
        return None
    h0 = sunrise.hour
    c0, c1 = c(h0), c(h0 + 1)
    if c0 is None and c1 is None:
        return None, "no data"
    if (c0 if c0 is not None else c1) <= threshold and (c1 is None or c1 <= threshold + 10):
        return sunrise, "sunrise"
    for h in range(h0, until_hour):
        a, b = c(h), c(h + 1)
        if a is None or b is None:
            continue
        if a > threshold >= b:
            frac = (a - threshold) / (a - b) if a != b else 0
            t = local_hour(d, h) + timedelta(minutes=60 * frac)
            t = round_minutes(t, 5)
            if t < sunrise:
                t = sunrise
            return t, "crossing"
    return None, "cloudy"


def sun_out_analysis(d, rows, sun):
    cfg = CONFIG["sun"]
    sunrise = parse_iso(sun["sunrise"])
    thr = cfg["clear_threshold_pct"]
    until = cfg["search_until_hour"]
    nws_t, nws_kind = first_crossing(d, rows, "cloud", sunrise, thr, until) if any(r.get("cloud") is not None and r.get("cloud_src") != "model" for r in rows) else (None, "no data")
    om_t, om_kind = first_crossing(d, rows, "cloud_model", sunrise, thr, until)
    primary_t, primary_kind, primary_src = nws_t, nws_kind, "nws"
    if nws_kind == "no data":
        primary_t, primary_kind, primary_src = om_t, om_kind, "model"
    at_sunrise = rows[sunrise.hour].get("cloud")
    thin_h = next((r["hour"] for r in rows if r["hour"] >= sunrise.hour and r.get("cloud") is not None
                   and r["cloud"] <= cfg["thinning_threshold_pct"]), None)
    fog_early = any("fog" in (r.get("short") or "").lower() for r in rows[4:11])
    if primary_kind == "sunrise":
        label = "Sunny from sunrise"
        short = fmt_time(sunrise)
    elif primary_kind == "crossing":
        label = f"~{fmt_time(primary_t)}"
        short = fmt_time(primary_t)
    elif primary_kind == "cloudy":
        label = f"Not before {until % 12 or 12} PM"
        short = "Gloomy"
    else:
        label = "No forecast"
        short = "?"
    confidence = None
    if nws_t and om_t:
        diff = abs((nws_t - om_t).total_seconds()) / 60
        confidence = "high" if diff <= 60 else "medium" if diff <= 120 else "low"
    elif nws_kind == om_kind and nws_kind in ("sunrise", "cloudy"):
        confidence = "high"
    elif nws_kind != "no data" and om_kind != "no data":
        confidence = "low"
    # narrative
    key = "cloud" if primary_src == "nws" else "cloud_model"
    relapse = None
    if primary_t is not None:
        for r in rows:
            if primary_t.hour < r["hour"] <= 13 and r.get(key) is not None and r[key] > 65:
                relapse = r["hour"]
                break
    if primary_kind == "sunrise":
        c = int(at_sunrise) if at_sunrise is not None else None
        if c is None or c < 20:
            note = "Clear from first light, no marine layer to burn off."
        else:
            note = f"Mostly sunny from first light ({c}% cloud), no marine layer to burn off."
    elif primary_kind == "crossing":
        bits = []
        if at_sunrise is not None:
            bits.append(f"{int(at_sunrise)}% cloud at sunrise")
        if fog_early:
            bits.append("patchy fog early")
        if thin_h is not None and thin_h < primary_t.hour:
            bits.append(f"thinning by {thin_h % 12 or 12}")
        bits.append(f"breaks up around {fmt_time(primary_t)}")
        note = bits[0][0].upper() + ", ".join(bits)[1:] + "."
    elif primary_kind == "cloudy":
        note = (f"{int(at_sunrise)}% cloud at sunrise, " if at_sunrise is not None else "") + "marine layer holds through early afternoon."
    else:
        note = None
    if note and relapse is not None:
        note += f" Clouds may fill back in around {relapse % 12 or 12} {'AM' if relapse < 12 else 'PM'}."
    return {
        "time": iso(primary_t),
        "kind": primary_kind,
        "label": label,
        "short": short,
        "source": primary_src,
        "confidence": confidence,
        "nws_time": iso(nws_t), "nws_kind": nws_kind,
        "model_time": iso(om_t), "model_kind": om_kind,
        "cloud_at_sunrise": at_sunrise,
        "fog_early": fog_early,
        "note": note,
    }


def best_window(d, rows, sun, tide_curve):
    dawn = parse_iso(sun["first_light"]) if sun.get("first_light") else parse_iso(sun["sunrise"])
    start_h = dawn.hour
    end_h = 12

    def longest_block(max_rank):
        best, cur = None, None
        for h in range(start_h, end_h + 1):
            q = rows[h].get("quality")
            ok = q is not None and QUALITY_RANK.get(q, 3) <= max_rank
            if ok:
                cur = [h, h] if cur is None else [cur[0], h]
            else:
                if cur and (best is None or cur[1] - cur[0] > best[1] - best[0]):
                    best = cur
                cur = None
        if cur and (best is None or cur[1] - cur[0] >= best[1] - best[0]):
            best = cur
        return best

    best = longest_block(0)
    if best is None or best[1] - best[0] < 1:
        best = longest_block(1) or best
    if best is None:
        return None
    start = round_minutes(dawn, 5) if best[0] == start_h else local_hour(d, best[0])
    end = local_hour(d, best[1] + 1)
    quals = [rows[h].get("quality") for h in range(best[0], best[1] + 1)]
    t0, t1 = tide_at(tide_curve, start), tide_at(tide_curve, end)
    tide = None
    if t0 is not None and t1 is not None:
        tide = {"start_ft": round(t0, 1), "end_ft": round(t1, 1),
                "trend": "rising" if t1 > t0 + 0.2 else "dropping" if t1 < t0 - 0.2 else "slack"}
    return {
        "start": iso(start), "end": iso(end),
        "label": fmt_range(start, end),
        "hours": best[1] - best[0] + 1,
        "quality": quals,
        "tide": tide,
        "why": ("glassy" if all(q in ("glassy", "offshore") for q in quals)
                else "light wind all morning" if best[0] == start_h and best[1] >= end_h else "light wind"),
    }


def effective_height(swell_ft, swell2_ft, windwave_ft, wave_ft):
    """Height that matters for surf: swell trains in full, wind chop at half weight."""
    parts = [x for x in (swell_ft, swell2_ft) if x is not None]
    if not parts:
        return wave_ft
    if windwave_ft is not None:
        parts.append(0.5 * windwave_ft)
    return math.sqrt(sum(p * p for p in parts))


def surf_estimate(wave_ft, period):
    """Rough breaking-face estimate from open-water significant height."""
    if wave_ft is None:
        return None
    k = 1.0 if (period or 0) < 10 else 1.15 if period < 14 else 1.3
    low = max(0.5, round(wave_ft * 0.75 * k * 2) / 2)
    high = max(low + 0.5, round(wave_ft * 1.1 * k * 2) / 2)
    sets = round(wave_ft * 1.45 * k * 2) / 2
    return {"low": low, "high": high, "sets": sets if sets > high else None}


def fmt_ft(v):
    if v is None:
        return None
    return str(int(v)) if float(v).is_integer() else f"{v:g}"


def surf_range_text(low, high, sets=None):
    if low is None:
        return None
    txt = f"{fmt_ft(low)}–{fmt_ft(high)} ft" if high and high != low else f"{fmt_ft(low)} ft"
    if sets:
        txt += f", sets to {fmt_ft(sets)}"
    return txt


def srf_period_for(srf, d, today):
    if not srf or not srf.get("found"):
        return None
    iso_d = d.isoformat()
    for per in srf.get("periods", []):
        if iso_d in (per.get("dates") or []):
            return per
    return None


def day_surf(d, rows, sec, today):
    srf = sec.get("nws_srf")
    official = srf_period_for(srf, d, today)
    morning = [r for r in rows if 6 <= r["hour"] <= 10 and r.get("wave_ft") is not None]
    model = None
    if morning:
        mid = morning[len(morning) // 2]
        wave = sum(r["wave_ft"] for r in morning) / len(morning)
        eff = sum(effective_height(r.get("swell_ft"), r.get("swell2_ft"), r.get("windwave_ft"), r["wave_ft"]) for r in morning) / len(morning)
        period = mid.get("swell_period_s") or mid.get("wave_period_s")
        model = {
            "wave_ft": round(wave, 1),
            "effective_ft": round(eff, 1),
            "period_s": mid.get("wave_period_s"),
            "dir_deg": mid.get("wave_deg"), "dir": compass(mid.get("wave_deg")),
            "swell_ft": r1(mid.get("swell_ft")), "swell_period_s": mid.get("swell_period_s"),
            "swell_deg": mid.get("swell_deg"), "swell_dir": compass(mid.get("swell_deg")),
            "swell2_ft": r1(mid.get("swell2_ft")), "swell2_period_s": mid.get("swell2_period_s"),
            "swell2_dir": compass(mid.get("swell2_deg")),
            "windwave_ft": r1(mid.get("windwave_ft")), "windwave_period_s": mid.get("windwave_period_s"),
            "estimate": surf_estimate(eff, period),
        }
    out = {"official": None, "model": model}
    if official:
        out["official"] = {
            "period": official["name"],
            "low": official.get("surf_low"), "high": official.get("surf_high"), "sets": official.get("surf_sets"),
            "text": surf_range_text(official.get("surf_low"), official.get("surf_high"), official.get("surf_sets")),
            "fields": [{"k": k.capitalize(), "v": official["fields"][k]} for k in official["order"]],
            "rip": official.get("rip"),
            "remarks": official.get("remarks"),
            "water_f": official.get("water_f"),
            "water_txt": official.get("water_txt"),
        }
    # headline numbers: official first, model estimate second
    if official and official.get("surf_low") is not None:
        out["low"], out["high"], out["sets"] = official["surf_low"], official["surf_high"], official.get("surf_sets")
        out["source"] = "nws"
    elif model and model.get("estimate"):
        e = model["estimate"]
        out["low"], out["high"], out["sets"] = e["low"], e["high"], e["sets"]
        out["source"] = "model"
    else:
        out["low"] = out["high"] = out["sets"] = None
        out["source"] = None
    out["text"] = surf_range_text(out["low"], out["high"], out["sets"])
    return out


def pick_suit(water_f, dawn_air_f):
    cfg = CONFIG["suit"]
    rules = cfg["rules"]
    if water_f is None:
        return None
    air = dawn_air_f if dawn_air_f is not None else 65
    chosen_i = len(rules) - 1
    for i, rule in enumerate(rules):
        if water_f >= rule["min_water"] and air >= rule["min_air"]:
            chosen_i = i
            break
    chosen = rules[chosen_i]
    reasons = []
    for i, rule in enumerate(rules[:chosen_i]):
        fails = []
        if water_f < rule["min_water"]:
            fails.append(f"water needs {rule['min_water']}°+")
        if air < rule["min_air"]:
            fails.append(f"dawn air needs {rule['min_air']}°+ (you have {int(round(air))}°)")
        if fails:
            reasons.append(f"{rule['name']}: " + ", ".join(fails))
    reasons.append(f"{chosen['name']}: water {int(round(water_f))}° clears the {chosen['min_water']}° line"
                   + (f", air {int(round(air))}° clears {chosen['min_air']}°" if chosen["min_air"] else ""))
    alt = None
    if cfg.get("runs_cold") and chosen_i + 1 < len(rules):
        warmer = rules[chosen_i + 1]
        alt = {"name": warmer["name"], "detail": warmer["detail"],
               "why": f"You run cold. The {warmer['name'].lower()} is never the wrong call at dawn in {int(round(air))}° air."}
    return {"name": chosen["name"], "detail": chosen["detail"], "reasons": reasons, "alt": alt,
            "water_f": round(water_f), "dawn_air_f": round(air) if dawn_air_f is not None else None}


def day_weather(d, sec, rows):
    daily = (sec.get("nws_daily") or {}).get("periods") or []
    day_p = night_p = None
    for per in daily:
        st = parse_iso(per["start"])
        if st.date() == d and per.get("is_day") and day_p is None:
            day_p = per
        if per.get("is_day") is False and night_p is None and (st.date() == d):
            night_p = per
    om_daily = next((x for x in ((sec.get("om_weather") or {}).get("daily") or []) if x["date"] == d.isoformat()), None)
    high = day_p["temp_f"] if day_p else (round(om_daily["high_f"]) if om_daily and om_daily.get("high_f") is not None else None)
    low = night_p["temp_f"] if night_p else (round(om_daily["low_f"]) if om_daily and om_daily.get("low_f") is not None else None)
    temps = [r["temp_f"] for r in rows if r.get("temp_f") is not None]
    if high is None and temps:
        high = max(temps)
    if low is None and temps:
        low = min(temps)
    return {
        "high_f": high, "low_f": low,
        "short": day_p["short"] if day_p else None,
        "detailed": day_p["detailed"] if day_p else None,
        "night_short": night_p["short"] if night_p else None,
        "pop": (day_p or {}).get("pop"),
        "source": "nws" if day_p else "model",
    }


def day_uv(rows, epa_rows):
    pts = [(r["hour"], r["uv"]) for r in rows if r.get("uv") is not None]
    src = "model"
    if epa_rows:
        epts = [(parse_iso(r["time"]).hour, r["uv"]) for r in epa_rows]
        if sum(1 for h, _ in epts if 10 <= h <= 14) >= 3:
            pts, src = epts, "epa"
    if not pts:
        return None
    peak_h, peak = max(pts, key=lambda p: p[1])
    thr = CONFIG["uv"]["burn_threshold"]
    burn = [h for h, v in pts if v >= thr]
    clear = [r.get("uv_clear") for r in rows if r.get("uv_clear") is not None]
    return {
        "peak": round(peak, 1), "peak_hour": peak_h,
        "peak_label": f"{peak_h % 12 or 12} {'AM' if peak_h < 12 else 'PM'}",
        "burn_start": min(burn) if burn else None, "burn_end": (max(burn) + 1) if burn else None,
        "burn_label": (f"{min(burn) % 12 or 12}–{(max(burn) + 1) % 12 or 12} {'PM' if (max(burn) + 1) >= 12 else 'AM'}" if burn else None),
        "clear_sky_peak": round(max(clear), 1) if clear else None,
        "threshold": thr, "source": src,
    }


def size_word(high):
    if high is None:
        return None
    if high < 1.5:
        return "Flat"
    if high <= 2.5:
        return "Tiny"
    if high <= 3.5:
        return "Small"
    if high <= 4.5:
        return "Fun-size"
    if high <= 6.5:
        return "Solid"
    return "Big"


def make_read(day, water, suit):
    surf = day.get("surf") or {}
    high = surf.get("high")
    size = size_word(high)
    win = day.get("window")
    sun = day.get("sun_out") or {}
    dawn_q = [day["hours"][h].get("quality") for h in range(6, 9)]
    dawn_q = [q for q in dawn_q if q]
    wind_word = None
    if dawn_q:
        worst = max(QUALITY_RANK.get(q, 3) for q in dawn_q)
        wind_word = ["glassy", "lightly textured", "bumpy", "blown out"][min(worst, 3)]
    if size is None:
        head = "No surf forecast yet."
    elif size == "Flat":
        head = "Flat. Longboard or coffee."
    elif size in ("Tiny", "Small"):
        head = f"{size} and {wind_word} at dawn. Fun longboard morning." if wind_word in ("glassy", "lightly textured") else f"{size} and {wind_word or 'windy'}. Not worth rushing."
    elif size == "Fun-size":
        head = f"Fun-size and {wind_word} at dawn. Worth the alarm." if wind_word in ("glassy", "lightly textured") else f"Fun-size but {wind_word or 'windy'}. Pick your window."
    elif size == "Solid":
        head = f"Solid swell, {wind_word} early. Get out there." if wind_word in ("glassy", "lightly textured") else f"Solid but {wind_word or 'windy'}. Hunt the corners."
    else:
        head = "Big. Sets are real. Respect it." if wind_word in ("glassy", "lightly textured", None) else f"Big and {wind_word}. Watch from the pier."
    parts = []
    if sun.get("kind") == "sunrise":
        parts.append(f"Sunny from first light ({fmt_time(parse_iso(day['sun']['first_light']))}).")
    elif sun.get("kind") == "crossing" and sun.get("time"):
        parts.append(f"Sun breaks through around {fmt_time(parse_iso(sun['time']))}.")
    elif sun.get("kind") == "cloudy":
        parts.append("No sun before 3 PM.")
    if suit:
        parts.append(suit["name"] + ".")
    if win:
        parts.append(f"Best window {win['label']}.")
    return {"headline": head, "sub": " ".join(parts), "size": size, "wind": wind_word}


def build_week(sec, today):
    marine = (sec.get("om_marine") or {}).get("rows") or []
    om_daily = (sec.get("om_weather") or {}).get("daily") or []
    days = []
    for i in range(7):
        d = today + timedelta(days=i)
        morning = [r for r in marine if parse_iso(r["time"]).date() == d and 6 <= parse_iso(r["time"]).hour <= 10
                   and r.get("wave_height") is not None]
        allday = [r for r in marine if parse_iso(r["time"]).date() == d and r.get("wave_height") is not None]
        if not allday:
            continue
        ref = morning[len(morning) // 2] if morning else allday[len(allday) // 2]
        pool = morning or allday
        wave = sum(r["wave_height"] for r in pool) / len(pool)
        eff = sum(effective_height(r.get("swell_wave_height"), r.get("secondary_swell_wave_height"),
                                   r.get("wind_wave_height"), r["wave_height"]) for r in pool) / len(pool)
        est = surf_estimate(eff, ref.get("swell_wave_period") or ref.get("wave_period"))
        omd = next((x for x in om_daily if x["date"] == d.isoformat()), None)
        days.append({
            "date": d.isoformat(), "label": d.strftime("%a"),
            "wave_ft": round(wave, 1), "wave_max_ft": round(max(r["wave_height"] for r in allday), 1),
            "effective_ft": round(eff, 1),
            "period_s": ref.get("wave_period"), "dir": compass(ref.get("wave_direction")), "dir_deg": ref.get("wave_direction"),
            "swell_ft": ref.get("swell_wave_height"), "swell_period_s": ref.get("swell_wave_period"),
            "swell_dir": compass(ref.get("swell_wave_direction")),
            "surf_low": est["low"] if est else None, "surf_high": est["high"] if est else None,
            "surf_text": surf_range_text(est["low"], est["high"]) if est else None,
            "sst_f": ref.get("sea_surface_temperature"),
            "high_f": round(omd["high_f"]) if omd and omd.get("high_f") is not None else None,
            "low_f": round(omd["low_f"]) if omd and omd.get("low_f") is not None else None,
        })
    return days


def tide_now(tides, now):
    if not tides:
        return None
    curve = tides.get("curve") or []
    h = tide_at(curve, now)
    later = tide_at(curve, now + timedelta(minutes=30))
    nxt = [e for e in tides.get("hilo", []) if parse_iso(e["time"]) > now]
    return {
        "ft": round(h, 1) if h is not None else None,
        "trend": None if h is None or later is None else ("rising" if later > h + 0.02 else "dropping" if later < h - 0.02 else "slack"),
        "next": nxt[0] if nxt else None,
        "next_label": (f"{'High' if nxt[0]['type'] == 'H' else 'Low'} {nxt[0]['ft']:.1f} ft at {fmt_time(parse_iso(nxt[0]['time']))}") if nxt else None,
    }


def pick_water(sec, today_surf, buoys):
    cands = []
    official = (today_surf or {}).get("official") or {}
    if official.get("water_f") is not None:
        cands.append({"source": "NWS surf zone forecast", "f": round(official["water_f"]), "kind": "nearshore"})
    for b in buoys or []:
        if b.get("wtmp_f") is not None:
            cands.append({"source": f"Buoy {b['id']} {b['name']}", "f": round(b["wtmp_f"]), "kind": "buoy", "time": b.get("wtmp_time")})
    marine = (sec.get("om_marine") or {}).get("rows") or []
    sst = next((r["sea_surface_temperature"] for r in marine if r.get("sea_surface_temperature") is not None), None)
    if sst is not None:
        cands.append({"source": "Wave model SST", "f": round(sst), "kind": "model"})
    if not cands:
        return None
    primary = cands[0]
    if primary["kind"] == "buoy":
        note = "Buoy reading. Nearshore at the pier can run a few degrees colder."
    elif primary["kind"] == "nearshore":
        note = "Nearshore reading from the NWS surf zone forecast."
    else:
        note = "Model sea-surface temperature. Treat as a rough number."
    return {"f": primary["f"], "source": primary["source"], "kind": primary["kind"], "note": note, "all": cands}


# ---------------------------------------------------------------- build

def build(src, prev):
    now = now_local()
    today = now.date()
    sections = {}
    prev_sections = (prev or {}).get("sections") or {}
    prev_sources = (prev or {}).get("sources") or {}
    status = {}

    def run(name, fn, *args, optional=False):
        try:
            val = fn(*args)
            sections[name] = val
            status[name] = {"ok": True, "stale": False, "fetched_at": iso(now), "error": None}
            log(f"ok    {name}")
        except Exception as exc:  # noqa: BLE001
            err = f"{type(exc).__name__}: {exc}"
            log(f"FAIL  {name}: {err}")
            old = prev_sections.get(name)
            if old is not None:
                sections[name] = old
                status[name] = {"ok": False, "stale": True,
                                "fetched_at": (prev_sources.get(name) or {}).get("fetched_at"), "error": err}
            else:
                sections[name] = None
                status[name] = {"ok": False, "stale": False, "fetched_at": None, "error": err}

    points = None
    try:
        points = fetch_nws_points(src)
        log(f"ok    nws_points ({points['office']} {points['grid']})")
    except Exception as exc:  # noqa: BLE001
        log(f"FAIL  nws_points: {exc}")
        points = prev_sections.get("nws_points")
        if points:
            log("      using cached NWS point metadata")
    sections["nws_points"] = points
    if points:
        run("nws_hourly", fetch_nws_hourly, src, points)
        run("nws_daily", fetch_nws_daily, src, points)
        run("nws_grid", fetch_nws_grid, src, points)
        run("nws_srf", fetch_nws_srf, src, points)
        run("nws_afd", fetch_nws_afd, src, points)
    else:
        for name in ("nws_hourly", "nws_daily", "nws_grid", "nws_srf", "nws_afd"):
            run(name, lambda: (_ for _ in ()).throw(RuntimeError("NWS point lookup failed")))
    run("nws_alerts", fetch_nws_alerts, src)
    run("om_weather", fetch_om_weather, src)
    run("om_marine", fetch_om_marine, src)
    run("tides", fetch_tides, src, today)
    run("epa_uv", fetch_epa_uv, src, today)
    for buoy in CONFIG["stations"]["buoys"]:
        name = f"buoy_{buoy['id']}"
        SOURCE_LABELS[name] = f"NDBC buoy {buoy['id']} ({buoy['name']})"
        run(name, fetch_buoy, src, buoy)

    buoys = [sections[f"buoy_{b['id']}"] for b in CONFIG["stations"]["buoys"] if sections.get(f"buoy_{b['id']}")]
    tides = sections.get("tides")
    tide_curve = (tides or {}).get("curve") or []

    days = []
    for offset in (0, 1):
        d = today + timedelta(days=offset)
        sun = solar_events(d)
        rows = hour_rows(d, sections)
        sun_out = sun_out_analysis(d, rows, sun)
        window = best_window(d, rows, sun, tide_curve)
        surf = day_surf(d, rows, sections, today)
        weather = day_weather(d, sections, rows)
        uv = day_uv(rows, ((sections.get("epa_uv") or {}).get("days") or {}).get(d.isoformat()))
        sunrise = parse_iso(sun["sunrise"])
        dawn_temps = [rows[h].get("temp_f") for h in range(max(sunrise.hour - 1, 0), min(sunrise.hour + 2, 24))
                      if rows[h].get("temp_f") is not None]
        dawn_air = min(dawn_temps) if dawn_temps else None
        lo, hi = CONFIG["morning_hours"]
        morning = [rows[h] for h in range(lo, hi + 1)]
        day_hilo = [e for e in (tides or {}).get("hilo", []) if parse_iso(e["time"]).date() == d]
        days.append({
            "date": d.isoformat(),
            "label": "Today" if offset == 0 else "Tomorrow",
            "weekday": d.strftime("%A"),
            "pretty": d.strftime("%A, %B ") + str(d.day),
            "sun": sun,
            "sun_out": sun_out,
            "morning": morning,
            "hours": rows,
            "window": window,
            "surf": surf,
            "weather": weather,
            "uv": uv,
            "dawn_air_f": dawn_air,
            "tides": day_hilo,
        })

    water = pick_water(sections, days[0]["surf"], buoys)
    for day in days:
        day["suit"] = pick_suit(water["f"], day["dawn_air_f"]) if water else None
        day["read"] = make_read(day, water, day["suit"])
        del day["hours"]  # morning slice is enough for the page

    # current conditions
    hourly_now = by_time((sections.get("nws_hourly") or {}).get("rows")).get(iso(floor_hour(now)))
    now_block = {
        "time": iso(now),
        "temp_f": (hourly_now or {}).get("temp_f"),
        "wind_txt": (hourly_now or {}).get("wind_txt"),
        "wind_dir": (hourly_now or {}).get("wind_dir"),
        "wind_mph": (hourly_now or {}).get("wind_mph"),
        "short": (hourly_now or {}).get("short"),
        "humidity": (hourly_now or {}).get("humidity"),
        "tide": tide_now(tides, now),
    }

    sources = {}
    for name, st in status.items():
        sources[name] = {"label": SOURCE_LABELS.get(name, name), **st}

    data = {
        "generated_at": iso(now),
        "generated_epoch": int(now.timestamp()),
        "timezone": CONFIG["timezone"],
        "site_name": CONFIG.get("site_name"),
        "location": {k: LOC[k] for k in ("name", "short", "lat", "lon")},
        "nws_office": (points or {}).get("office"),
        "days": days,
        "now": now_block,
        "water": water,
        "buoys": buoys,
        "tides": {"station": (tides or {}).get("station"), "station_name": (tides or {}).get("station_name"),
                  "hilo": (tides or {}).get("hilo", []), "curve": tide_curve},
        "week": build_week(sections, today),
        "alerts": (sections.get("nws_alerts") or {}).get("alerts", []),
        "afd": sections.get("nws_afd"),
        "srf": {k: v for k, v in (sections.get("nws_srf") or {}).items() if k in ("found", "issued", "office", "zone_header")},
        "sources": sources,
    }
    cache = {"generated_at": iso(now), "sources": sources, "sections": sections}
    return data, cache


# ---------------------------------------------------------------- summary

def summary(data):
    day = data["days"][0]
    lines = [
        f"## {data['location']['short']} — {day['pretty']}",
        "",
        f"**{day['read']['headline']}** {day['read']['sub']}",
        "",
        f"- Surf: {day['surf'].get('text') or 'n/a'} ({day['surf'].get('source') or 'no source'})",
        f"- Water: {data['water']['f'] if data.get('water') else 'n/a'}° → {day['suit']['name'] if day.get('suit') else 'n/a'}",
        f"- Sunrise {fmt_time(parse_iso(day['sun']['sunrise']))}, sun out: {day['sun_out']['label']} ({day['sun_out'].get('confidence') or 'no'} confidence)",
        f"- Window: {day['window']['label'] if day.get('window') else 'none found'}",
        f"- Weather: {day['weather'].get('short') or 'n/a'}, {day['weather'].get('high_f')}/{day['weather'].get('low_f')}",
        "",
        "| Source | Status |", "|---|---|",
    ]
    for name, st in data["sources"].items():
        state = "ok" if st["ok"] else ("stale (using previous)" if st["stale"] else "unavailable")
        lines.append(f"| {st['label']} | {state}{' — ' + st['error'] if st.get('error') else ''} |")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--cache", default=DEFAULT_CACHE, help="where raw sections are kept for stale fallback")
    ap.add_argument("--now", help="override the current local time, e.g. 2026-09-30T04:30 (for testing)")
    ap.add_argument("--fixtures", help="directory of saved responses to use instead of the network")
    ap.add_argument("--dump", help="directory to save raw responses into")
    ap.add_argument("--summary", action="store_true", help="print a summary of the existing output and exit")
    args = ap.parse_args()

    if args.summary:
        with open(args.out, encoding="utf-8") as fh:
            print(summary(json.load(fh)))
        return 0

    global NOW_OVERRIDE
    if args.now:
        NOW_OVERRIDE = parse_iso(args.now)

    prev = None
    if os.path.exists(args.cache):
        try:
            with open(args.cache, encoding="utf-8") as fh:
                prev = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            log(f"previous cache unreadable: {exc}")

    src = Sources(fixtures=args.fixtures, dump=args.dump)
    data, cache = build(src, prev)
    for path, payload in ((args.out, data), (args.cache, cache)):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        log(f"wrote {path} ({os.path.getsize(path) // 1024} KB)")
    failed = [n for n, s in data["sources"].items() if not s["ok"]]
    if failed:
        log("stale/unavailable: " + ", ".join(failed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
