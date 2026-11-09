# Glassline HB Surf Report

A private surf page for Huntington Beach Pier: surf, live wind, water
temperature and the wetsuit call, and the time the marine layer breaks and the
sun comes out. The forecast updates itself four times a day; the wind is live.

## How it works

1. `scripts/fetch.py` (Python, standard library only) pulls:
   - NWS hourly forecast, sky-cover grid, daily forecast, alerts, the Surf Zone
     Forecast and the forecast discussion (San Diego office covers Orange County)
   - NDBC buoys 46253 (San Pedro South) and 46222 (San Pedro): swell and water temp
   - NOAA tide predictions for Newport Bay Entrance (station 9410580)
   - Open-Meteo wave and weather models (7-day swell, cloud cover, UV) as a second opinion
   - EPA UV index for 92648: hourly values when EPA serves them, else the daily index
   - the City of Huntington Beach's YouTube channel, to check that its pier live cam
     is streaming and pick up its current video id (the cam lives in `config.json`)
   It computes sunrise, first light, the sun-out time, the paddle-out window,
   the wetsuit recommendation, what the tide does to the surf at dawn (and when
   that changes) and a one-line read, then writes `site/data.json`.
   When a source fails, the previous value is kept and flagged stale.
2. `.github/workflows/update.yml` runs that script on a schedule
   (4:37 AM, 6:41 AM, 1:07 PM and 7:23 PM Pacific), commits the new data and
   publishes `site/` to GitHub Pages.
3. `site/` is a static page (no build step) that renders `data.json`.
4. Live wind: while the page is open it polls the wind stations itself, every
   3 minutes (and right away when you come back to the tab). NOAA CO-OPS and the
   NWS observation API both answer browsers directly, no key needed:
   - NOAA Long Beach Pier J (9410665): 6-minute readings, about 4 minutes behind.
     The closest station that is actually live, 10.6 miles up the coast.
   - NWS: Huntington Beach home station AR684 (1.7 mi, but 30 to 60 minutes
     behind), John Wayne Airport (KSNA) and Los Alamitos (KSLI).

   The first station with a reading under 20 minutes old leads; failing that, the
   freshest one, marked Delayed. The card calls the reading glassy / bumpy /
   blown out / offshore with the same thresholds as the forecast, says how it
   sits against the beach (offshore to onshore), compares it with the forecast
   for the hour, and charts the last 6 hours against the next 6 of forecast.

## One-time setup

1. GitHub Pages needs either a public repo or a paid GitHub plan. If this repo
   stays private on a free plan, make it public (Settings → General → Danger
   Zone → Change visibility). Nothing in it is sensitive.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Actions tab → **Update forecast** → Run workflow. The site appears at
   `https://<your-user>.github.io/<repo-name>/` a minute later.

## Tuning

Everything personal lives in `config.json`: location, stations, the wetsuit
rules (`suit.rules`, `suit.runs_cold`), what counts as "sun out"
(`sun.clear_threshold_pct`), the wind thresholds for glassy / textured /
blown out, the tide stages (`tide`, in feet MLLW at the tide station) and the
live wind stations (`live_wind.stations`, in order of preference: `provider`
`coops` takes a NOAA CO-OPS station id, `nws` an NWS observation station id).

The tide call is a rule of thumb for the pier's beach break, not a measurement,
so the reported surf height is never changed by it. Above `tide.high_ft` small
swell gets fat and rides smaller than the number; above `tide.very_high_ft` it
gets swamped. Below `tide.low_ft` things get steep; below `tide.very_low_ft`
bigger swell closes out. Swell is classed as small (surf to 3 ft), medium (to
5 ft) or big, after a foot of credit for long-period swell (14 s+) and half a
foot off for short wind swell (under 10 s). "Dawn" is the first `tide.dawn_hours`
after sunrise, judged at its middle.

## Local preview

```
python scripts/fetch.py --fixtures scripts/fixtures --now 2026-09-30T04:30   # offline sample data
python scripts/fetch.py                                                     # live data
python -m http.server -d site 8000                                          # then open http://localhost:8000
```
