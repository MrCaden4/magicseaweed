# HB Pier dawn patrol

A private surf page for Huntington Beach Pier: surf, water temperature and the
wetsuit call, and the time the marine layer breaks and the sun comes out.
It updates itself four times a day.

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

## One-time setup

1. GitHub Pages needs either a public repo or a paid GitHub plan. If this repo
   stays private on a free plan, make it public (Settings → General → Danger
   Zone → Change visibility). Nothing in it is sensitive.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Actions tab → **Update forecast** → Run workflow. The site appears at
   `https://<your-user>.github.io/magicseaweed/` a minute later.

## Tuning

Everything personal lives in `config.json`: location, stations, the wetsuit
rules (`suit.rules`, `suit.runs_cold`), what counts as "sun out"
(`sun.clear_threshold_pct`), the wind thresholds for glassy / textured /
blown out, and the tide stages (`tide`, in feet MLLW at the tide station).

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
