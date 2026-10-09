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
   It computes sunrise, first light, the sun-out time, the paddle-out window,
   the wetsuit recommendation and a one-line read, then writes `site/data.json`.
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
(`sun.clear_threshold_pct`), and the wind thresholds for glassy / textured /
blown out.

## Local preview

```
python scripts/fetch.py --fixtures scripts/fixtures --now 2026-09-30T04:30   # offline sample data
python scripts/fetch.py                                                     # live data
python -m http.server -d site 8000                                          # then open http://localhost:8000
```
