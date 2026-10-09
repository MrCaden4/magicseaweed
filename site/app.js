/* HB Pier dawn patrol page. Reads data.json (written by scripts/fetch.py) and
   renders it. No dependencies. */
(function () {
  'use strict';

  const TZ = 'America/Los_Angeles';
  const $ = (sel, root) => (root || document).querySelector(sel);

  // ------------------------------------------------------------ helpers
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v; // only used with markup built here, never with data
        else if (k === 'style') node.style.cssText = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    for (const c of children || []) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  const svgNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, children) {
    const node = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined) continue;
      if (k === 'text') node.textContent = v; else node.setAttribute(k, v);
    }
    for (const c of children || []) if (c) node.append(c);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  const laFmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
  const fmt = {
    time(iso) { return iso ? laFmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '—'; },
    hm(iso) { return iso ? laFmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(/ [AP]M$/, '') : '—'; },
    hour(iso) { return iso ? laFmt({ hour: 'numeric' }).format(new Date(iso)) : '—'; },
    range(a, b) {
      if (!a || !b) return '—';
      const ta = fmt.time(a), tb = fmt.time(b);
      return ta.slice(-2) === tb.slice(-2) ? `${ta.slice(0, -3)}–${tb}` : `${ta}–${tb}`;
    },
    date(iso) { return iso ? laFmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(iso)) : '—'; },
    dateShort(iso) { return iso ? laFmt({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '—'; },
    ft(v) { if (v === null || v === undefined) return '—'; return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10); },
    deg(v) { return (v === null || v === undefined) ? '—' : `${Math.round(v)}°`; },
    num(v, d) { return (v === null || v === undefined) ? '—' : Number(v).toFixed(d || 0); },
    hourLabel(h) { return `${h % 12 || 12}${h < 12 ? ' AM' : ' PM'}`; },
  };
  function laNow() {
    const parts = laFmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
  }
  function minutesOfDay(iso) {
    const d = new Date(iso);
    const parts = laFmt({ hour: 'numeric', minute: '2-digit', hour12: false }).formatToParts(d);
    const get = (t) => Number(parts.find((p) => p.type === t)?.value);
    return (get('hour') % 24) * 60 + get('minute');
  }
  function dateOf(iso) {
    const parts = laFmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  // ------------------------------------------------------------ tooltip
  const tip = el('div', { class: 'tip', role: 'status', 'aria-live': 'polite' });
  document.body.append(tip);
  function showTip(lines, x, y) {
    clear(tip);
    lines.forEach((ln, i) => {
      if (ln === null || ln === undefined) return;
      const row = el('div', { class: i === 0 ? '' : 'muted' });
      if (i === 0) row.append(el('b', { text: ln })); else row.textContent = ln;
      tip.append(row);
    });
    const pad = 12;
    const w = tip.offsetWidth || 160, h = tip.offsetHeight || 40;
    let left = x + pad, top = y + pad;
    if (left + w > window.innerWidth - 8) left = x - w - pad;
    if (top + h > window.innerHeight - 8) top = y - h - pad;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
    tip.classList.add('on');
  }
  function hideTip() { tip.classList.remove('on'); }
  function attachTip(node, linesFn) {
    node.addEventListener('pointermove', (e) => showTip(linesFn(), e.clientX, e.clientY));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => { const r = node.getBoundingClientRect(); showTip(linesFn(), r.left + r.width / 2, r.top); });
    node.addEventListener('blur', hideTip);
  }

  // ------------------------------------------------------------ theme
  const themeBtn = $('#theme');
  function applyTheme(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
    else document.documentElement.removeAttribute('data-theme');
    themeBtn.setAttribute('aria-label', `Theme: ${mode || 'system'}. Click to change.`);
    themeBtn.title = `Theme: ${mode || 'system'}`;
  }
  let theme = null;
  try { theme = localStorage.getItem('theme'); } catch (e) { /* ignore */ }
  applyTheme(theme);
  themeBtn.addEventListener('click', () => {
    theme = theme === null ? 'light' : theme === 'light' ? 'dark' : null;
    try { theme ? localStorage.setItem('theme', theme) : localStorage.removeItem('theme'); } catch (e) { /* ignore */ }
    applyTheme(theme);
    if (state.data) renderTide(state.data, currentDay());
  });

  // ------------------------------------------------------------ state
  const state = { data: null, dayIndex: 0 };
  function currentDay() { return state.data.days[state.dayIndex]; }

  // ------------------------------------------------------------ render: header + hero
  function renderTop(data) {
    const gen = new Date(data.generated_at);
    const ageH = (Date.now() - gen.getTime()) / 36e5;
    const upd = $('#updated');
    upd.textContent = `Updated ${ageH < 20 ? fmt.time(data.generated_at) : fmt.dateShort(data.generated_at)}`;
    const stale = $('#stale');
    if (ageH > 30) { stale.hidden = false; stale.textContent = `Forecast is ${Math.round(ageH / 24)} day${ageH > 48 ? 's' : ''} old`; }
    else stale.hidden = true;
    $('#loc-name').textContent = data.location?.name || 'Huntington Beach Pier';
  }

  function dayLabel(d) {
    const now = laNow();
    if (d.date === now.date) return 'Today';
    const t = new Date(`${now.date}T12:00:00-07:00`);
    t.setDate(t.getDate() + 1);
    if (d.date === dateOf(t.toISOString())) return 'Tomorrow';
    return d.weekday || d.label;
  }

  function renderTabs(data) {
    const tabs = $('#day-tabs');
    clear(tabs);
    data.days.forEach((d, i) => {
      const b = el('button', {
        class: 'tab', role: 'tab', 'aria-selected': String(i === state.dayIndex), text: dayLabel(d),
        onclick: () => { state.dayIndex = i; renderAll(); },
      });
      tabs.append(b);
    });
  }

  function renderHero(data, day) {
    $('#day-pretty').textContent = fmt.date(day.sun.sunrise);
    $('#headline').textContent = day.read?.headline || 'No read yet.';
    $('#subline').textContent = day.read?.sub || '';

    const surf = day.surf || {};
    const surfVal = surf.low != null ? (surf.high && surf.high !== surf.low ? `${fmt.ft(surf.low)}–${fmt.ft(surf.high)}` : fmt.ft(surf.low)) : '—';
    setKpi('surf', surfVal, surf.low != null ? 'ft' : '', surf.low != null
      ? [surf.sets ? `sets to ${fmt.ft(surf.sets)} ft` : null, surf.source === 'nws' ? 'NWS surf zone forecast' : 'model estimate'].filter(Boolean).join(' · ')
      : 'no forecast');

    const water = data.water;
    setKpi('water', water ? fmt.deg(water.f) : '—', '', day.suit ? `${day.suit.name}${day.suit.alt ? ` · or ${day.suit.alt.name.toLowerCase()}` : ''}` : (water ? water.source : 'no reading'), true);

    const so = day.sun_out || {};
    const sunVal = so.kind === 'sunrise' ? fmt.hm(day.sun.sunrise) : so.kind === 'crossing' ? fmt.hm(so.time) : so.kind === 'cloudy' ? 'Gloomy' : '—';
    const sunUnit = so.kind === 'sunrise' ? fmt.time(day.sun.sunrise).slice(-2) : so.kind === 'crossing' ? fmt.time(so.time).slice(-2) : '';
    const sunNote = so.kind === 'sunrise' ? `sunny from first light (${fmt.time(day.sun.first_light)})` : so.kind === 'crossing' ? `sun breaks through the clouds · first light ${fmt.time(day.sun.first_light)}` : so.kind === 'cloudy' ? 'clouds hold past 3 PM' : 'no sky forecast';
    setKpi('sun', sunVal, sunUnit, sunNote + (so.confidence ? ` · ${so.confidence} confidence` : ''));

    const win = day.window;
    const sameHalf = win && fmt.time(win.start).slice(-2) === fmt.time(win.end).slice(-2);
    setKpi('window', win ? `${sameHalf ? fmt.hm(win.start) : fmt.time(win.start)}–${fmt.hm(win.end)}` : '—', win ? fmt.time(win.end).slice(-2) : '',
      win ? `${win.why}${win.tide ? ` · tide ${win.tide.start_ft}→${win.tide.end_ft} ft ${win.tide.trend}` : ''}` : 'no clean window before noon');
  }
  function setKpi(key, value, unit, note, boldNote) {
    const v = $(`#kpi-${key} .kpi-value`);
    clear(v);
    v.append(value);
    if (unit) v.append(el('small', { text: unit }));
    const n = $(`#kpi-${key} .kpi-note`);
    clear(n);
    if (boldNote) n.append(el('b', { text: note })); else n.textContent = note;
  }

  // ------------------------------------------------------------ render: morning strip
  const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="arrow"><path d="M12 4v16M6 14l6 6 6-6"/></svg>';

  function renderMorning(data, day) {
    const rows = day.morning || [];
    const host = $('#morning-strip');
    clear(host);
    if (!rows.length) { host.append(el('p', { class: 'note', text: 'No hourly forecast available.' })); return; }
    const n = rows.length;
    const h0 = rows[0].hour;
    const pct = (iso) => Math.max(0, Math.min(100, ((minutesOfDay(iso) / 60 - h0) / n) * 100));

    const hours = el('div', { class: 'hours' }, rows.map((r) => el('span', { text: `${r.hour % 12 || 12}${r.hour < 12 ? 'a' : 'p'}` })));
    const skyCells = el('div', { class: 'cells' });
    const windCells = el('div', { class: 'cells' });
    const tempCells = el('div', { class: 'cells' });
    for (const r of rows) {
      const cloud = r.cloud ?? r.cloud_model;
      const sky = el('div', { class: 'cell sky', tabindex: '0', style: `--v:${cloud ?? 0}` });
      if ((r.short || '').toLowerCase().includes('fog')) sky.append(el('span', { class: 'fog', text: 'fog' }));
      attachTip(sky, () => [
        `${fmt.hourLabel(r.hour)} · ${cloud != null ? `${Math.round(cloud)}% cloud` : 'no sky data'}`,
        r.short || null,
        r.cloud_model != null && r.cloud != null && r.cloud_src !== 'model' ? `model says ${Math.round(r.cloud_model)}%` : null,
      ]);
      skyCells.append(sky);

      const w = r.wind_mph;
      const wind = el('div', { class: 'cell wind', tabindex: '0', style: `--v:${w == null ? 0 : Math.min(100, (w / 18) * 100)}` });
      if (r.wind_deg != null) {
        wind.insertAdjacentHTML('beforeend', ARROW);
        const a = wind.lastElementChild;
        a.style.setProperty('--rot', `${r.wind_deg}deg`);
        if (w != null && w < 3) a.classList.add('faint');
      }
      attachTip(wind, () => [
        `${fmt.hourLabel(r.hour)} · ${r.wind_txt ? r.wind_txt : w != null ? `${Math.round(w)} mph` : 'calm'}${r.wind_dir ? ` ${r.wind_dir}` : ''}`,
        r.quality ? `${r.quality}${r.wind_src === 'model' ? ' (model wind)' : ''}` : null,
      ]);
      windCells.append(wind);

      tempCells.append(el('div', { class: 'cell temp', text: r.temp_f != null ? `${Math.round(r.temp_f)}°` : '' }));
    }

    const skyRow = el('div', { class: 'strip-row' }, [el('span', { class: 'row-lbl', text: 'Sky' }), skyCells]);
    const windRow = el('div', { class: 'strip-row' }, [el('span', { class: 'row-lbl', text: 'Wind' }), windCells]);
    const tempRow = el('div', { class: 'strip-row' }, [el('span', { class: 'row-lbl', text: 'Air' }), tempCells]);
    const hourRow = el('div', { class: 'strip-row' }, [el('span', { class: 'row-lbl' }), hours]);

    // overlays on the sky row: sunrise line, sun-out dot
    const ov = el('div', { class: 'overlay' });
    const sr = day.sun?.sunrise;
    const fl = day.sun?.first_light;
    if (fl) {
      const x = pct(fl);
      ov.append(el('div', { class: 'marker first-light', style: `left:${x}%` }));
      ov.append(el('div', { class: 'marker-lbl hide-narrow', style: `left:${x}%; top:-22px`, text: `first light ${fmt.hm(fl)}` }));
    }
    if (sr) ov.append(el('div', { class: 'marker sunrise', style: `left:${pct(sr)}%`, title: `sunrise ${fmt.time(sr)}` }));
    const so = day.sun_out || {};
    if (so.kind === 'crossing' && so.time) {
      const x = pct(so.time);
      ov.append(el('div', { class: 'sun-dot', style: `left:${x}%; top:50%` }));
      ov.append(el('div', { class: 'marker-lbl gold', style: `left:${x}%; top:-22px`, text: `sun out ${fmt.hm(so.time)}` }));
    } else if (so.kind === 'sunrise' && fl) {
      const x = pct(fl);
      ov.append(el('div', { class: 'sun-dot', style: `left:${x}%; top:50%` }));
      ov.append(el('div', { class: 'marker-lbl gold', style: `left:${x}%; top:-22px`, text: `sunny from ${fmt.hm(fl)}` }));
    }
    skyCells.append(ov);

    // best-window bracket
    const wb = el('div', { class: 'window-bar' });
    if (day.window) {
      const a = pct(day.window.start), b = pct(day.window.end);
      wb.append(el('div', { class: 'window-span', style: `left:${a}%; width:${Math.max(1, b - a)}%` }));
      wb.append(el('div', { class: 'window-lbl', style: `left:${(a + b) / 2}%`, text: `best window ${fmt.range(day.window.start, day.window.end)}` }));
    }

    host.append(el('div', { style: 'height:16px' }), skyRow, windRow, tempRow, hourRow, wb);
    host.append(el('div', { class: 'legend' }, [
      el('span', {}, [el('i', { class: 'sw sky' }), 'clear → overcast (NWS sky cover)']),
      el('span', {}, [el('i', { class: 'sw wind' }), 'calm → 18 mph, arrow shows where the wind blows to']),
    ]));

    // the headline sun line
    const sunLine = $('#sun-line');
    clear(sunLine);
    const SUN_ICO = '<svg class="sun-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    sunLine.insertAdjacentHTML('beforeend', SUN_ICO);
    if (so.kind === 'crossing' && so.time) sunLine.append(`Sun breaks through at ${fmt.time(so.time)}`, el('small', { text: ` · first light ${fmt.time(fl)}` }));
    else if (so.kind === 'sunrise') sunLine.append(`Sunny from first light, ${fmt.time(fl)}`);
    else if (so.kind === 'cloudy') sunLine.append('Clouds all morning, no sun before 3 PM', el('small', { text: ` · first light ${fmt.time(fl)}` }));
    else sunLine.append('No sky forecast yet');

    // notes
    const note = $('#sun-note');
    clear(note);
    const bits = [];
    if (so.note) bits.push(so.note);
    if (so.nws_time && so.model_time && so.confidence !== 'high') {
      bits.push(`NWS says ${fmt.time(so.nws_time)}, the weather model says ${fmt.time(so.model_time)}.`);
    } else if (so.kind === 'crossing' && so.model_time && so.confidence === 'high') {
      bits.push(`The weather model agrees (${fmt.time(so.model_time)}).`);
    }
    if (day.sun?.first_light) bits.push(`First light ${fmt.time(day.sun.first_light)}, sunrise ${fmt.time(day.sun.sunrise)}, sunset ${fmt.time(day.sun.sunset)}.`);
    note.textContent = bits.join(' ');

    const afd = $('#afd');
    if (data.afd?.quote) {
      afd.hidden = false;
      clear(afd);
      afd.append(`“${data.afd.quote}”`);
      afd.append(el('cite', { text: `NWS ${officeName(data.afd.office)} forecast discussion, ${fmt.dateShort(data.afd.issued)}` }));
    } else afd.hidden = true;

    // table twin
    const tbody = $('#morning-table tbody');
    clear(tbody);
    for (const r of rows) {
      tbody.append(el('tr', {}, [
        el('td', { text: fmt.hourLabel(r.hour) }),
        el('td', { class: 'num', text: (r.cloud ?? r.cloud_model) != null ? `${Math.round(r.cloud ?? r.cloud_model)}%` : '—' }),
        el('td', { text: r.short || '—' }),
        el('td', { text: r.wind_txt || (r.wind_mph != null ? `${Math.round(r.wind_mph)} mph` : '—') + (r.wind_dir ? ` ${r.wind_dir}` : '') }),
        el('td', { text: r.quality || '—' }),
        el('td', { class: 'num', text: r.temp_f != null ? `${Math.round(r.temp_f)}°` : '—' }),
      ]));
    }
  }
  function officeName(code) { return ({ SGX: 'San Diego', LOX: 'Los Angeles' })[code] || code || ''; }

  // ------------------------------------------------------------ render: surf
  function renderSurf(data, day) {
    const surf = day.surf || {};
    const host = $('#surf-body');
    clear(host);
    const official = surf.official;
    const model = surf.model;

    const grid = el('div', { class: 'stat-grid' });
    grid.append(stat('Surf', surf.text ? surf.text.replace(/, sets.*$/, '') : '—', surf.sets ? `sets to ${fmt.ft(surf.sets)} ft` : (surf.source === 'model' ? 'model estimate' : '')));
    if (model) grid.append(stat('Swell (model)', model.swell_ft != null ? `${fmt.ft(model.swell_ft)} ft` : '—',
      [`${model.swell_period_s ? `${fmt.num(model.swell_period_s)}s` : ''} ${model.swell_dir || ''}${model.swell_deg != null ? ` (${Math.round(model.swell_deg)}°)` : ''}`.trim(),
        model.swell2_ft ? `+ ${fmt.ft(model.swell2_ft)} ft @ ${fmt.num(model.swell2_period_s)}s ${model.swell2_dir || ''}` : null].filter(Boolean).join(' · ')));
    if (official?.rip) grid.append(stat('Rip risk', official.rip.replace(/\.$/, ''), ''));
    host.append(grid);

    if (official?.fields?.length) {
      const dl = el('dl', { class: 'kv' });
      for (const f of official.fields) {
        if (/sunrise|uv index|max temperature|tides|thunderstorm/i.test(f.k) || !f.v) continue;
        const label = f.k.replace(/^Remarks$/i, 'Swell').replace(/^Surf height$/i, 'Surf');
        dl.append(el('dt', { text: label }), el('dd', {}, [/^surf$/i.test(label) ? el('b', { text: f.v }) : f.v]));
      }
      host.append(el('p', { class: 'card-meta', text: `NWS surf zone forecast, ${official.period.toLowerCase()}${data.srf?.issued ? `, issued ${fmt.dateShort(data.srf.issued)}` : ''}` }), dl);
    } else {
      host.append(el('p', { class: 'note', text: 'NWS surf zone forecast unavailable for this day. Numbers above are a model estimate from open-water wave height.' }));
    }

    const buoys = data.buoys || [];
    if (buoys.length) {
      const dl = el('dl', { class: 'kv' });
      for (const b of buoys) {
        const parts = [];
        if (b.spec?.swell_ft != null) parts.push(`swell ${fmt.ft(b.spec.swell_ft)} ft @ ${fmt.num(b.spec.swell_period_s)}s ${b.spec.swell_dir || ''}`.trim());
        if (b.wvht_ft != null) parts.push(`${parts.length ? 'total ' : ''}${fmt.ft(b.wvht_ft)} ft @ ${fmt.num(b.dpd_s)}s${b.mwd ? ` from ${b.mwd}` : ''}`);
        if (b.spec?.windwave_ft != null && b.spec.windwave_ft >= 1) parts.push(`chop ${fmt.ft(b.spec.windwave_ft)} ft @ ${fmt.num(b.spec.windwave_period_s)}s`);
        if (b.wtmp_f != null) parts.push(`water ${fmt.deg(b.wtmp_f)}`);
        const dd = el('dd', {}, [el('b', { text: parts[0] || '—' }), parts.length > 1 ? ` · ${parts.slice(1).join(' · ')}` : '']);
        dd.append(el('span', { class: 'card-meta', text: b.time ? ` · ${ago(b.time)}` : '' }));
        dl.append(el('dt', { text: `Buoy ${b.id}` }), dd);
      }
      host.append(el('p', { class: 'card-meta', text: 'Live buoys (NDBC)' }), dl);
    }

    const alerts = $('#alerts');
    clear(alerts);
    for (const a of data.alerts || []) {
      alerts.append(el('div', { class: 'alert' }, [
        el('b', { text: a.event || 'Alert' }),
        el('span', { text: trim((a.description || a.headline || '').replace(/\s+/g, ' '), 240) }),
        el('span', { class: 'muted', text: [a.ends ? `until ${fmt.dateShort(a.ends)}` : '', a.also?.length ? `also: ${a.also.join(', ')}` : ''].filter(Boolean).join(' · ') }),
      ]));
    }
    alerts.hidden = !(data.alerts || []).length;
  }
  function trim(text, n) {
    if (!text || text.length <= n) return text || '';
    return `${text.slice(0, n).replace(/\s+\S*$/, '')}…`;
  }
  function stat(label, value, sub) {
    return el('div', { class: 'stat' }, [el('div', { class: 'lbl', text: label }), el('div', { class: 'val', text: value }), sub ? el('div', { class: 'sub', text: sub }) : null]);
  }
  function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 6e4);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  }

  // ------------------------------------------------------------ render: water + suit
  function renderWater(data, day) {
    const host = $('#water-body');
    clear(host);
    const water = data.water;
    const suit = day.suit;
    if (!water) { host.append(el('p', { class: 'note', text: 'No water temperature available.' })); return; }

    const row = el('div', { class: 'stat-grid' });
    row.append(el('div', { class: 'stat' }, [el('div', { class: 'lbl', text: 'Water' }), el('div', { class: 'big' }, [fmt.deg(water.f), el('small', { text: water.kind === 'buoy' ? 'buoy' : water.kind === 'nearshore' ? 'nearshore' : 'model' })])]));
    if (suit) row.append(el('div', { class: 'stat' }, [el('div', { class: 'lbl', text: 'Wear' }), el('div', { class: 'big', text: suit.name }), el('div', { class: 'sub', text: suit.detail })]));
    if (day.dawn_air_f != null) row.append(el('div', { class: 'stat' }, [el('div', { class: 'lbl', text: 'Air at dawn' }), el('div', { class: 'big', text: fmt.deg(day.dawn_air_f) })]));
    host.append(row);

    host.append(renderMeter(data.rules || DEFAULT_RULES, water.f));

    if (suit?.alt) host.append(el('div', { class: 'suit-alt' }, [el('b', { text: `${suit.alt.name} ` }), suit.alt.why]));
    if (suit?.reasons?.length) host.append(el('ul', { class: 'reasons' }, suit.reasons.map((r) => el('li', { text: r }))));
    const others = (water.all || []).filter((c) => c.source !== water.source);
    const srfWater = day.surf?.official?.water_txt;
    const meta = [srfWater && water.kind === 'nearshore' ? `NWS surf zone forecast says ${srfWater.replace(/\.$/, '')}.` : water.note];
    if (others.length) meta.push(`Other readings: ${others.map((c) => `${c.source} ${fmt.deg(c.f)}`).join(', ')}.`);
    host.append(el('p', { class: 'card-meta', text: meta.join(' ') }));
  }
  const DEFAULT_RULES = [
    { name: '5/4', min: 50 }, { name: '4/3', min: 54 }, { name: '3/2', min: 60 }, { name: 'Spring', min: 67 }, { name: 'Trunks', min: 72 },
  ];
  function renderMeter(rules, temp) {
    const lo = 50, hi = 80;
    const segs = rules.map((r, i) => ({ name: r.name, a: Math.max(lo, r.min), b: i + 1 < rules.length ? rules[i + 1].min : hi }));
    const track = el('div', { class: 'meter-track' });
    const lbls = el('div', { class: 'meter-lbls' });
    segs.forEach((s, i) => {
      const w = (s.b - s.a) / (hi - lo);
      track.append(el('div', { class: 'meter-seg', style: `--w:${w}; --o:${0.35 + (0.65 * i) / (segs.length - 1)}`, title: `${s.name}: ${s.a}–${s.b}°` }));
      lbls.append(el('span', { style: `--w:${w}`, text: s.name }));
    });
    const x = Math.max(0, Math.min(100, ((temp - lo) / (hi - lo)) * 100));
    const pin = el('div', { class: 'meter-pin', style: `left:${x}%` }, [el('span', { class: 'pin-lbl', text: fmt.deg(temp) }), el('span', { class: 'pin-tick' })]);
    return el('div', { class: 'meter' }, [pin, track, lbls]);
  }

  // ------------------------------------------------------------ render: tide chart
  function renderTide(data, day) {
    const host = $('#tide-chart');
    clear(host);
    const curve = (data.tides?.curve || []).filter((p) => dateOf(p.time) === day.date);
    const hilo = (data.tides?.hilo || []).filter((p) => dateOf(p.time) === day.date);
    if (curve.length < 4) { host.append(el('p', { class: 'note', text: 'Tide predictions unavailable for this day.' })); return; }

    const W = Math.max(280, host.clientWidth || 600);
    const H = 210;
    const m = { l: 34, r: 12, t: 28, b: 30 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const vals = curve.map((p) => p.ft);
    let yMin = Math.floor(Math.min(...vals) - 0.5), yMax = Math.ceil(Math.max(...vals) + 0.7);
    const xOf = (iso) => m.l + (minutesOfDay(iso) / 1440) * pw;
    const yOf = (v) => m.t + (1 - (v - yMin) / (yMax - yMin)) * ph;

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Tide height through the day' });

    // night shading
    const srM = day.sun?.sunrise ? minutesOfDay(day.sun.sunrise) : null;
    const ssM = day.sun?.sunset ? minutesOfDay(day.sun.sunset) : null;
    if (srM != null && ssM != null) {
      svg.append(svgEl('rect', { class: 'night', x: m.l, y: m.t, width: (srM / 1440) * pw, height: ph }));
      svg.append(svgEl('rect', { class: 'night', x: m.l + (ssM / 1440) * pw, y: m.t, width: pw - (ssM / 1440) * pw, height: ph }));
    }
    // grid + y labels
    for (let v = yMin; v <= yMax; v += 1) {
      svg.append(svgEl('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: yOf(v), y2: yOf(v) }));
      svg.append(svgEl('text', { class: 'axis', x: m.l - 6, y: yOf(v) + 4, 'text-anchor': 'end', text: `${v}` }));
    }
    // x labels
    [0, 6, 12, 18, 24].forEach((h) => {
      const x = m.l + (h / 24) * pw;
      svg.append(svgEl('text', { class: 'axis', x, y: H - 8, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle', text: h === 0 ? '12 AM' : h === 24 ? '12 AM' : fmt.hourLabel(h) }));
    });
    // area + line
    const pts = curve.map((p) => [xOf(p.time), yOf(p.ft)]);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    svg.append(svgEl('path', { class: 'area', d: `${path}L${pts[pts.length - 1][0].toFixed(1)},${yOf(yMin)}L${pts[0][0].toFixed(1)},${yOf(yMin)}Z` }));
    svg.append(svgEl('path', { class: 'line', d: path }));
    // hi/lo markers
    for (const e of hilo) {
      const x = xOf(e.time), y = yOf(e.ft);
      svg.append(svgEl('circle', { class: 'dot', cx: x, cy: y, r: 5 }));
      // labels sit above highs and below lows, unless that would hit the axis band
      const up = e.type === 'H' ? y > m.t + 30 : y + 34 > m.t + ph;
      const anchor = x < m.l + 40 ? 'start' : x > W - m.r - 40 ? 'end' : 'middle';
      svg.append(svgEl('text', { class: 'dot-lbl', x, y: up ? y - 14 : y + 20, 'text-anchor': anchor, text: `${e.ft.toFixed(1)} ft` }));
      svg.append(svgEl('text', { class: 'dot-sub', x, y: up ? y - 26 : y + 32, 'text-anchor': anchor, text: fmt.time(e.time) }));
    }
    // now marker
    const now = laNow();
    if (now.date === day.date) {
      const mins = now.hour * 60 + now.minute;
      const x = m.l + (mins / 1440) * pw;
      const yv = interp(curve, mins);
      svg.append(svgEl('line', { class: 'now', x1: x, x2: x, y1: m.t, y2: m.t + ph }));
      if (yv != null) svg.append(svgEl('circle', { class: 'now-dot', cx: x, cy: yOf(yv), r: 4.5 }));
      svg.append(svgEl('text', { class: 'now-lbl', x: x + 5, y: m.t + 10, text: 'now' }));
    }
    // hover crosshair
    const xh = svgEl('line', { class: 'xhair', x1: 0, x2: 0, y1: m.t, y2: m.t + ph, visibility: 'hidden' });
    const xd = svgEl('circle', { class: 'xdot', r: 4, visibility: 'hidden' });
    const hit = svgEl('rect', { class: 'hit', x: m.l, y: m.t, width: pw, height: ph });
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const mins = Math.max(0, Math.min(1439, ((px - m.l) / pw) * 1440));
      const v = interp(curve, mins);
      if (v == null) return;
      const x = m.l + (mins / 1440) * pw;
      xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.setAttribute('visibility', 'visible');
      xd.setAttribute('cx', x); xd.setAttribute('cy', yOf(v)); xd.setAttribute('visibility', 'visible');
      const hh = Math.floor(mins / 60), mm = Math.round(mins % 60);
      showTip([`${v.toFixed(1)} ft`, `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`], e.clientX, e.clientY);
    });
    hit.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); hideTip(); });
    svg.append(xh, xd, hit);
    host.append(svg);

    // list + table twin
    const list = $('#tide-list');
    clear(list);
    for (const e of hilo) {
      list.append(el('div', { class: 'stat' }, [el('div', { class: 'lbl', text: e.type === 'H' ? 'High' : 'Low' }), el('div', { class: 'val' }, [`${e.ft.toFixed(1)}`, el('small', { text: 'ft' })]), el('div', { class: 'sub', text: fmt.time(e.time) })]));
    }
    const nowT = data.now?.tide;
    $('#tide-now').textContent = nowT && now.date === data.days[0].date && day.date === now.date
      ? `Now ${nowT.ft != null ? `${nowT.ft.toFixed(1)} ft` : ''}${nowT.trend ? ` and ${nowT.trend}` : ''}${nowT.next_label ? `. Next: ${nowT.next_label.toLowerCase()}` : ''}. ${data.tides?.station_name || ''} station.`
      : `${data.tides?.station_name || 'NOAA'} station predictions, MLLW.`;
  }
  function interp(curve, mins) {
    let prev = null;
    for (const p of curve) {
      const mm = minutesOfDay(p.time);
      if (mm >= mins) {
        if (!prev) return p.ft;
        const span = mm - prev.m || 1;
        return prev.v + (p.ft - prev.v) * ((mins - prev.m) / span);
      }
      prev = { m: mm, v: p.ft };
    }
    return prev ? prev.v : null;
  }

  // ------------------------------------------------------------ render: weather
  function renderWeather(data, day) {
    const host = $('#weather-body');
    clear(host);
    const w = day.weather || {};
    const uv = day.uv;
    const grid = el('div', { class: 'stat-grid' });
    grid.append(stat('High / low', `${w.high_f != null ? fmt.deg(w.high_f) : '—'} / ${w.low_f != null ? fmt.deg(w.low_f) : '—'}`, w.short || ''));
    grid.append(stat('First light', fmt.time(day.sun?.first_light), `sunrise ${fmt.time(day.sun?.sunrise)}`));
    grid.append(stat('Sunset', fmt.time(day.sun?.sunset), `last light ${fmt.time(day.sun?.last_light)}`));
    if (uv) grid.append(stat('UV peak', `${fmt.num(uv.peak, 1)}`, `${uv.peak_label}${uv.burn_label ? ` · burn window ${uv.burn_label}` : ' · below burn threshold'}`));
    if (data.now && state.dayIndex === 0) grid.append(stat('Right now', data.now.temp_f != null ? fmt.deg(data.now.temp_f) : '—', [data.now.short, data.now.wind_txt ? `wind ${data.now.wind_txt} ${data.now.wind_dir || ''}` : null].filter(Boolean).join(' · ')));
    host.append(grid);
    if (w.detailed) host.append(el('p', { class: 'note', text: w.detailed }));
    if (uv?.clear_sky_peak && uv.peak < uv.clear_sky_peak - 1) host.append(el('p', { class: 'card-meta', text: `Clear-sky UV would peak near ${fmt.num(uv.clear_sky_peak, 1)}; clouds are holding it down.` }));
  }

  // ------------------------------------------------------------ render: week
  function renderWeek(data) {
    const host = $('#week');
    clear(host);
    const days = data.week || [];
    if (!days.length) { host.append(el('p', { class: 'note', text: 'No wave model data.' })); return; }
    const max = Math.max(1, ...days.map((d) => d.wave_ft || 0));
    const today = laNow().date;
    for (const d of days) {
      const hPct = Math.max(4, ((d.wave_ft || 0) / max) * 100);
      const col = el('div', { class: `day${d.date === today ? ' today' : ''}`, tabindex: '0' }, [
        el('div', { class: 'd-lbl', text: d.date === today ? 'Today' : d.label }),
        el('div', { class: 'd-val', text: d.surf_text ? d.surf_text.replace(' ft', '') : '—' }),
        el('div', { class: 'bar-box' }, [el('div', { class: 'bar', style: `height:${hPct}%` })]),
        el('div', { class: 'd-sub', text: `${d.period_s ? `${fmt.num(d.period_s)}s ` : ''}${d.dir || ''}` }),
        el('div', { class: 'd-sub', text: d.high_f != null ? `${fmt.deg(d.high_f)} · ${d.sst_f != null ? `${fmt.deg(d.sst_f)} sea` : ''}` : '' }),
      ]);
      attachTip(col, () => [
        `${d.label}: surf ${d.surf_text || '—'}`,
        `open water ${fmt.ft(d.wave_ft)} ft (max ${fmt.ft(d.wave_max_ft)}) @ ${fmt.num(d.period_s)}s ${d.dir || ''}`,
        d.swell_ft != null ? `swell ${fmt.ft(d.swell_ft)} ft @ ${fmt.num(d.swell_period_s)}s ${d.swell_dir || ''}` : null,
        d.sst_f != null ? `sea ${fmt.deg(d.sst_f)} · air ${fmt.deg(d.high_f)}/${fmt.deg(d.low_f)}` : null,
      ]);
      host.append(col);
    }
    const tbody = $('#week-table tbody');
    clear(tbody);
    for (const d of days) {
      tbody.append(el('tr', {}, [
        el('td', { text: `${d.label} ${d.date.slice(5).replace('-', '/')}` }),
        el('td', { text: d.surf_text || '—' }),
        el('td', { class: 'num', text: fmt.ft(d.wave_ft) }),
        el('td', { class: 'num', text: fmt.num(d.period_s) }),
        el('td', { text: d.dir || '—' }),
        el('td', { class: 'num', text: d.sst_f != null ? fmt.deg(d.sst_f) : '—' }),
        el('td', { class: 'num', text: d.high_f != null ? `${fmt.deg(d.high_f)}/${fmt.deg(d.low_f)}` : '—' }),
      ]));
    }
  }

  // ------------------------------------------------------------ render: sources
  function renderSources(data) {
    const ul = $('#sources');
    clear(ul);
    const entries = Object.values(data.sources || {});
    for (const s of entries) {
      const cls = s.ok ? '' : s.stale ? 'stale' : 'off';
      const st = s.ok ? fmt.hm(s.fetched_at) : s.stale ? `stale, ${s.fetched_at ? fmt.dateShort(s.fetched_at) : 'old'}` : 'unavailable';
      const li = el('li', { title: s.error || '' }, [el('span', { class: `dot ${cls}` }), el('span', { class: 'nm', text: s.label }), el('span', { class: 'st', text: st })]);
      ul.append(li);
    }
    const bad = entries.filter((s) => !s.ok);
    $('#sources-summary').textContent = bad.length
      ? `${entries.length - bad.length} of ${entries.length} sources fresh. Stale or missing: ${bad.map((s) => s.label).join(', ')}.`
      : `All ${entries.length} sources fetched fresh at ${fmt.time(data.generated_at)}.`;
  }

  // ------------------------------------------------------------ boot
  function renderAll() {
    const data = state.data;
    const day = currentDay();
    renderTabs(data);
    renderHero(data, day);
    renderMorning(data, day);
    renderSurf(data, day);
    renderWater(data, day);
    renderTide(data, day);
    renderWeather(data, day);
    renderWeek(data);
    renderSources(data);
  }

  function pickDay(data) {
    const now = laNow();
    let idx = data.days.findIndex((d) => d.date === now.date);
    if (idx === -1) idx = 0;
    else if (idx === 0 && now.hour >= 15 && data.days[1]) idx = 1;
    return idx;
  }

  async function boot() {
    try {
      const res = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`data.json ${res.status}`);
      const data = await res.json();
      if (!data.days?.length) throw new Error('data.json has no days');
      state.data = data;
      state.dayIndex = pickDay(data);
      renderTop(data);
      renderAll();
      $('#main').hidden = false;
      $('#loading').hidden = true;
    } catch (err) {
      $('#loading').hidden = true;
      const box = $('#error');
      box.hidden = false;
      box.textContent = `Could not load the forecast (${err.message}). The daily update may not have run yet; check the Actions tab of the repo.`;
    }
  }

  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (state.data) renderTide(state.data, currentDay()); }, 120);
  });

  boot();
})();
