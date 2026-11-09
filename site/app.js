/* Glassline HB Surf Report. Reads data.json (written by scripts/fetch.py) and
   renders it, and polls the wind stations for the live reading. No dependencies. */
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
    const surfNote = surf.low != null
      ? [surf.sets ? `sets to ${fmt.ft(surf.sets)} ft` : null, surf.source === 'nws' ? 'NWS surf zone forecast' : 'model estimate'].filter(Boolean).join(' · ')
      : 'no forecast';
    // the number is the forecast as reported; the line under it says what the tide does to it
    const te = day.tide_effect;
    setKpi('surf', surfVal, surf.low != null ? 'ft' : '', te ? [el('b', { text: te.label }), surfNote] : surfNote);

    const water = data.water;
    setKpi('water', water ? fmt.deg(water.f) : '—', '', day.suit ? `${day.suit.name}${day.suit.alt ? ` · or ${day.suit.alt.name.toLowerCase()}` : ''}` : (water ? water.source : 'no reading'), true);

    const so = day.sun_out || {};
    const sunVal = so.kind === 'sunrise' ? fmt.hm(day.sun.sunrise) : so.kind === 'crossing' ? fmt.hm(so.time) : so.kind === 'cloudy' ? 'Gloomy' : '—';
    const sunUnit = so.kind === 'sunrise' ? fmt.time(day.sun.sunrise).slice(-2) : so.kind === 'crossing' ? fmt.time(so.time).slice(-2) : '';
    const sunNote = so.kind === 'sunrise' ? `sunny from first light (${fmt.time(day.sun.first_light)})` : so.kind === 'crossing' ? `sun breaks through the clouds · first light ${fmt.time(day.sun.first_light)}` : so.kind === 'cloudy' ? 'clouds hold past 3 PM' : 'no sky forecast';
    setKpi('sun', sunVal, sunUnit, sunNote + (so.confidence ? ` · ${so.confidence} confidence` : ''));

    const win = day.window;
    const sameHalf = win && fmt.time(win.start).slice(-2) === fmt.time(win.end).slice(-2);
    const nb = (s) => s.replace(' ', '\u00a0'); // "6:40 AM" never breaks inside; the <wbr> after the dash is the one break
    const winVal = win ? el('span', {}, [nb(sameHalf ? fmt.hm(win.start) : fmt.time(win.start)), '–', el('wbr'), fmt.hm(win.end)]) : '—';
    setKpi('window', winVal, win ? fmt.time(win.end).slice(-2) : '',
      win ? `${win.why}${win.tide ? ` · tide ${win.tide.start_ft}→${win.tide.end_ft} ft ${win.tide.trend}` : ''}` : 'no clean window before noon');
    fitWindowKpi();
  }
  // "6:45 AM–1:00 PM" is the one hero value that can outgrow its column: shrink it until it
  // fits on one line, and only below 24px let it break after the dash (the <wbr> in its markup).
  function fitWindowKpi() {
    const v = $('#kpi-window .kpi-value');
    if (!v || !v.clientWidth) return;
    const wbr = v.querySelector('wbr');
    if (wbr) wbr.style.display = 'none'; // a <wbr> breaks even under nowrap, so hide it while measuring
    v.style.fontSize = '';
    v.style.whiteSpace = 'nowrap';
    let size = parseFloat(getComputedStyle(v).fontSize);
    while (v.scrollWidth > v.clientWidth && size > 24) {
      size -= 1;
      v.style.fontSize = `${size}px`;
    }
    if (v.scrollWidth > v.clientWidth) {
      v.style.whiteSpace = '';
      if (wbr) wbr.style.display = '';
    }
  }
  function setKpi(key, value, unit, note, boldNote) {
    const v = $(`#kpi-${key} .kpi-value`);
    clear(v);
    v.append(value);
    if (unit) v.append(el('small', { text: unit }));
    const n = $(`#kpi-${key} .kpi-note`);
    clear(n);
    for (const line of Array.isArray(note) ? note : [note]) {
      n.append(el('div', {}, [boldNote && typeof line === 'string' ? el('b', { text: line }) : line]));
    }
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
    const te = day.tide_effect;
    if (te) {
      const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
      const value = te.effect === 'fine' ? (te.worse ? 'Fine at dawn' : 'Fine all morning') : `${cap(te.word)} at dawn`;
      const sub = [
        te.peak ? `${te.peak.ft.toFixed(1)} ft ${te.peak.type === 'H' ? 'high' : 'low'} at ${fmt.time(te.peak.time)}` : `${te.dawn.ft.toFixed(1)} ft at dawn, ${te.dawn.trend}`,
        te.better ? `better ${te.better.label}` : te.worse ? `${te.worse.word} ${te.worse.label}` : null,
      ].filter(Boolean).join(' · ');
      grid.append(stat('Tide', value, sub));
    }
    host.append(grid);
    if (te?.note) host.append(el('p', { class: 'note', text: te.note }));

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
    if (data.now && state.dayIndex === 0) {
      const lw = live.primary?.latest; // the station reading beats the forecast for "now"
      const wind = lw ? `wind ${windText(lw)}, live` : data.now.wind_txt ? `wind ${data.now.wind_txt} ${data.now.wind_dir || ''}`.trim() : null;
      grid.append(stat('Right now', data.now.temp_f != null ? fmt.deg(data.now.temp_f) : '—', [data.now.short, wind].filter(Boolean).join(' · ')));
    }
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

  // ------------------------------------------------------------ render: pier cam
  function renderCams(data) {
    const card = $('#cams-card');
    if (!card) return;
    const cam = (data.cams || []).find((c) => c.youtube);
    card.hidden = !cam;
    if (!cam) return;
    const stage = $('#cam-stage');
    // YouTube's own player, loaded in place: one tap on its play button starts the stream
    // with a direct user gesture, which works in every browser. No autoplay tricks.
    // Only (re)created when the video id changes, so switching day tabs keeps it playing.
    const src = `https://www.youtube.com/embed/${cam.youtube}?playsinline=1&rel=0`;
    if (stage.dataset.src !== src) {
      clear(stage);
      stage.dataset.src = src;
      stage.append(el('iframe', {
        src, title: `${cam.name} live cam`, loading: 'lazy',
        allow: 'autoplay; fullscreen; picture-in-picture', allowfullscreen: '',
        referrerpolicy: 'strict-origin-when-cross-origin',
      }));
    }
    const status = cam.live ? el('span', { class: 'pill good', text: 'Live' })
      : cam.live === false ? el('span', { class: 'pill', text: 'Offline' }) : null;
    clear($('#cam-cap')).append(
      el('div', { class: 'cam-text' }, [
        el('div', { class: 'cam-name' }, [cam.name, status]),
        el('div', { class: 'cam-sub', text: cam.sub || '' }),
      ]),
      cam.url ? el('a', { class: 'cam-open', href: cam.url, target: '_blank', rel: 'noopener', text: 'YouTube ↗' }) : null,
    );
    const checked = data.sources?.yt_cams?.fetched_at;
    $('#cams-meta').textContent = checked ? `live check ${fmt.time(checked)}` : '';
  }

  // ------------------------------------------------------------ live wind
  // data.json is rebuilt a few times a day; the wind changes by the minute. So the page
  // polls the stations itself: NOAA CO-OPS (6-minute readings) and the NWS observation
  // API both answer browsers directly (Access-Control-Allow-Origin: *), no key needed.
  const KT_MPH = 1.15078, KMH_MPH = 0.621371, MS_MPH = 2.236936;
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (deg) => (deg == null ? null : COMPASS[Math.floor((((deg % 360) + 360 + 11.25) % 360) / 22.5)]);
  const angDiff = (a, b) => { const d = Math.abs((a - b) % 360); return Math.min(d, 360 - d); };
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const live = { cfg: null, timer: null, busy: false, checkedAt: null, results: [], primary: null, lastFailed: false };

  async function getJSON(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      // a TypeError is the browser's 'Failed to fetch' / 'Load failed': offline, blocked or down
      throw new Error(err.name === 'AbortError' ? 'timed out' : err.name === 'TypeError' ? 'no answer' : err.message);
    } finally { clearTimeout(t); }
  }
  async function fetchCoops(st, hours) {
    const j = await getJSON('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=wind'
      + `&station=${encodeURIComponent(st.id)}&range=${hours}&units=english&time_zone=gmt&format=json`);
    if (j.error) throw new Error(j.error.message || 'no data');
    const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    const series = (j.data || []).map((r) => ({
      t: Date.parse(`${String(r.t).replace(' ', 'T')}:00Z`),
      mph: num(r.s) == null ? null : num(r.s) * KT_MPH, // english units are knots
      gust: num(r.g) == null ? null : num(r.g) * KT_MPH,
      deg: num(r.d),
    })).filter((o) => Number.isFinite(o.t) && o.mph != null);
    if (!series.length) throw new Error('no recent readings');
    return { latest: series[series.length - 1], series };
  }
  function nwsMph(q) {
    if (!q || q.value == null) return null;
    const u = q.unitCode || '';
    return q.value * (u.endsWith('m_s-1') ? MS_MPH : u.endsWith(':kn') || u.endsWith('kt') ? KT_MPH : KMH_MPH);
  }
  function nwsObs(p) {
    return { t: Date.parse(p.timestamp), mph: nwsMph(p.windSpeed), gust: nwsMph(p.windGust), deg: p.windDirection?.value ?? null };
  }
  async function fetchNws(st, hours) {
    const base = `https://api.weather.gov/stations/${encodeURIComponent(st.id)}/observations`;
    if (!hours) { // one reading; the history is only fetched for the station on the chart
      const o = nwsObs((await getJSON(`${base}/latest`)).properties || {});
      if (!Number.isFinite(o.t) || o.mph == null) throw new Error('no wind in the latest report');
      return { latest: o, series: [o] };
    }
    const start = new Date(Date.now() - hours * 36e5).toISOString().replace(/\.\d+Z$/, 'Z');
    const j = await getJSON(`${base}?start=${encodeURIComponent(start)}`);
    const series = (j.features || []).map((f) => nwsObs(f.properties || {}))
      .filter((o) => Number.isFinite(o.t) && o.mph != null).sort((a, b) => a.t - b.t);
    if (!series.length) throw new Error('no recent readings');
    return { latest: series[series.length - 1], series };
  }
  const stationUrl = (st) => (st.provider === 'coops'
    ? `https://tidesandcurrents.noaa.gov/stationhome.html?id=${encodeURIComponent(st.id)}`
    : `https://www.weather.gov/wrh/timeseries?site=${encodeURIComponent(st.id)}`);
  const ageMin = (o) => (Date.now() - o.t) / 6e4;
  function since(t) {
    const m = Math.max(0, Math.round((Date.now() - t) / 6e4));
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h${m % 60 >= 5 ? ` ${m % 60} min` : ''} ago`;
  }

  async function refreshLive() {
    const cfg = live.cfg;
    if (!cfg || live.busy) return;
    live.busy = true;
    clearTimeout(live.timer);
    try {
      const hours = (cfg.history_h || 6) + 1;
      const results = await Promise.all(cfg.stations.map(async (st) => {
        try { return { st, ...(st.provider === 'coops' ? await fetchCoops(st, hours) : await fetchNws(st, 0)) }; }
        catch (err) { return { st, error: err.message }; }
      }));
      // the first station (config order) with a fresh reading leads; failing that, the freshest one
      const usable = results.filter((r) => r.latest && ageMin(r.latest) <= cfg.max_age_min);
      const primary = usable.find((r) => ageMin(r.latest) <= cfg.live_max_age_min)
        || usable.slice().sort((a, b) => b.latest.t - a.latest.t)[0] || null;
      if (primary && primary.st.provider === 'nws' && primary.series.length < 2) {
        try { Object.assign(primary, await fetchNws(primary.st, hours)); } catch (e) { /* keep the one reading */ }
      }
      // one failed round (a network blip) keeps the last reading on screen; it shows its age
      if (primary || !live.primary) { live.results = results; live.primary = primary; }
      live.lastFailed = !primary;
      live.checkedAt = Date.now();
    } finally {
      live.busy = false;
      renderLive();
      if (state.data && state.dayIndex === 0) renderWeather(state.data, currentDay()); // its "Right now" uses the live wind
      scheduleLive();
    }
  }
  function scheduleLive() {
    clearTimeout(live.timer);
    if (!live.cfg || document.hidden) return; // a hidden tab stops polling; coming back checks at once
    live.timer = setTimeout(refreshLive, (live.cfg.refresh_s || 180) * 1000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(live.timer); return; }
    if (!live.checkedAt || Date.now() - live.checkedAt > 60e3) refreshLive(); else scheduleLive();
  });
  // "4 min ago" labels keep counting between checks
  setInterval(() => {
    document.querySelectorAll('[data-age]').forEach((n) => { n.textContent = since(Number(n.dataset.age)); });
  }, 30e3);

  function windQuality(mph, deg, w) {
    if (mph == null) return null;
    if (mph <= w.glassy_max_mph) return 'glassy';
    if (deg != null && angDiff(deg, w.offshore_center_deg) <= w.offshore_half_width_deg) return mph <= w.bumpy_max_mph ? 'offshore' : 'strong offshore';
    if (mph <= w.light_max_mph) return 'light texture';
    return mph <= w.bumpy_max_mph ? 'bumpy' : 'blown out';
  }
  function relativeDir(deg, w) {
    if (deg == null) return null;
    const d = angDiff(deg, w.offshore_center_deg);
    return d <= 22.5 ? 'offshore' : d <= 67.5 ? 'cross-offshore' : d <= 112.5 ? 'cross-shore' : d <= 157.5 ? 'cross-onshore' : 'onshore';
  }
  const QUALITY_PILL = { glassy: 'good', offshore: 'good', 'light texture': '', bumpy: 'warn', 'strong offshore': 'warn', 'blown out': 'bad' };
  const isCalm = (o) => o.mph < 0.5;
  function windText(o) {
    if (isCalm(o)) return 'calm';
    return `${Math.round(o.mph)} mph${compass(o.deg) ? ` ${compass(o.deg)}` : ''}`;
  }
  const gustText = (o) => (o.gust != null && o.gust >= o.mph + 1 ? `gusts ${Math.round(o.gust)}` : null);
  function forecastAt(t) {
    // the hourly forecast period that contains time t
    for (const f of state.data?.wind_forecast || []) {
      const t0 = Date.parse(f.time);
      if (t >= t0 && t < t0 + 36e5) return { ...f, t: t0 };
    }
    return null;
  }

  // a compass with the sea half tinted and the shoreline drawn through it; the arrow
  // points where the wind blows to, as on the morning strip, so offshore points out to sea
  function windDial(o, faces) {
    const s = svgEl('svg', { class: 'dial', viewBox: '0 0 100 100', 'aria-hidden': 'true' });
    const pt = (b, r) => [50 + r * Math.sin((b * Math.PI) / 180), 50 - r * Math.cos((b * Math.PI) / 180)].map((v) => v.toFixed(2));
    s.append(svgEl('circle', { class: 'dial-face', cx: 50, cy: 50, r: 47 }));
    if (faces != null) {
      const [ax, ay] = pt(faces - 90, 47), [bx, by] = pt(faces + 90, 47);
      s.append(svgEl('path', { class: 'dial-sea', d: `M50,50L${ax},${ay}A47,47 0 0 1 ${bx},${by}Z` }));
      s.append(svgEl('line', { class: 'dial-shore', x1: ax, y1: ay, x2: bx, y2: by }));
    }
    for (const b of [0, 90, 180, 270]) {
      const [x1, y1] = pt(b, 47), [x2, y2] = pt(b, b ? 41 : 39);
      s.append(svgEl('line', { class: 'dial-tick', x1, y1, x2, y2 }));
    }
    s.append(svgEl('text', { class: 'dial-n', x: 50, y: 18, 'text-anchor': 'middle', text: 'N' }));
    if (o && !isCalm(o) && o.deg != null) {
      s.append(svgEl('g', { transform: `rotate(${o.deg} 50 50)` }, [
        svgEl('line', { class: 'dial-arrow', x1: 50, y1: 24, x2: 50, y2: 70 }),
        svgEl('path', { class: 'dial-head', d: 'M39.5,64L50,79L60.5,64Z' }),
      ]));
    } else {
      s.append(svgEl('circle', { class: 'dial-hub', cx: 50, cy: 50, r: 4 }));
    }
    return s;
  }

  function renderLive() {
    const card = $('#live-card');
    const cfg = live.cfg;
    card.hidden = !cfg;
    if (!cfg) return;
    const rules = cfg.rules;
    const p = live.primary;
    const o = p?.latest;
    const read = clear($('#live-read'));

    if (!live.checkedAt) {
      read.append(el('p', { class: 'note', text: 'Checking the wind stations…' }));
    } else if (!o) {
      read.append(el('p', { class: 'note', text: `None of the wind stations answered with a recent reading. Trying again in ${Math.round((cfg.refresh_s || 180) / 60)} min.` }));
    } else {
      const q = windQuality(o.mph, o.deg, rules);
      const rel = isCalm(o) ? null : relativeDir(o.deg, rules);
      const fresh = ageMin(o) <= cfg.live_max_age_min;
      const value = isCalm(o) ? el('div', { class: 'live-val', text: 'Calm' })
        : el('div', { class: 'live-val' }, [String(Math.round(o.mph)), el('small', { text: `mph${compass(o.deg) ? ` ${compass(o.deg)}` : ''}` })]);
      const gust = gustText(o);
      read.append(el('div', { class: 'live-top' }, [
        windDial(o, cfg.beach_faces_deg),
        el('div', { class: 'live-num' }, [
          value,
          el('div', { class: 'live-sub', text: [gust ? `${gust} mph` : null, o.deg != null && !isCalm(o) ? `from ${Math.round(o.deg)}°` : null].filter(Boolean).join(' · ') || 'no gust reported' }),
          el('div', { class: 'live-tags' }, [
            q ? el('span', { class: `pill ${QUALITY_PILL[q] || ''}`.trim(), text: cap(q) }) : null,
            rel ? el('span', { class: 'pill', text: cap(rel) }) : null,
          ]),
        ]),
      ]));
      const st = p.st;
      read.append(el('div', { class: 'live-src' }, [
        fresh ? el('span', { class: 'pill live', text: 'Live' }) : el('span', { class: 'pill warn', text: 'Delayed' }),
        el('span', {}, [
          el('a', { href: stationUrl(st), target: '_blank', rel: 'noopener', text: st.name }),
          st.distance_mi != null ? ` · ${st.distance_mi} mi ${st.bearing || ''}`.trimEnd() : '',
          ' · ', el('span', { 'data-age': String(o.t), text: since(o.t) }),
        ]),
      ]));
      const f = forecastAt(Date.now());
      if (f) {
        const d = o.mph - f.mph;
        const verdict = Math.abs(d) < 3 ? 'Right on the forecast.' : d > 0 ? `Blowing ${Math.round(d)} mph harder than forecast.` : `${Math.round(-d)} mph lighter than forecast.`;
        read.append(el('p', { class: 'note' }, [
          `Forecast for ${fmt.hour(f.time)}: `, el('b', { text: f.mph < 0.5 ? 'calm' : `${Math.round(f.mph)} mph${f.dir ? ` ${f.dir}` : ''}` }), `. ${verdict}`,
        ]));
      }
    }
    const at = live.checkedAt ? fmt.time(new Date(live.checkedAt).toISOString()) : null;
    $('#live-meta').textContent = !at ? 'checking the stations…'
      : live.lastFailed && o ? `no answer at ${at}, showing the last reading`
        : `checked ${at} · every ${Math.round((cfg.refresh_s || 180) / 60)} min`;
    renderWindChart();
    renderStations();
  }

  function renderStations() {
    const cfg = live.cfg;
    const ul = clear($('#live-stations'));
    if (!live.checkedAt) return;
    for (const r of live.results) {
      const st = r.st;
      const o = r.latest;
      const a = o ? ageMin(o) : null;
      const cls = !o || a > cfg.max_age_min ? 'off' : a > cfg.live_max_age_min ? 'stale' : '';
      const where = [st.distance_mi != null ? `${st.distance_mi} mi ${st.bearing || ''}`.trim() : null, st.kind].filter(Boolean).join(' · ');
      ul.append(el('li', { class: `station${r === live.primary ? ' lead' : ''}`, title: r.error || '' }, [
        el('span', { class: `dot ${cls}`.trim() }),
        el('span', { class: 'st-main' }, [
          el('a', { class: 'st-name', href: stationUrl(st), target: '_blank', rel: 'noopener', text: st.name }),
          el('span', { class: 'st-sub', text: where }),
        ]),
        el('span', { class: 'st-read' }, o ? [
          el('span', { class: 'st-val', text: windText(o) }),
          el('span', { class: 'st-sub' }, [gustText(o) ? `${gustText(o)} · ` : '', el('span', { 'data-age': String(o.t), text: since(o.t) })]),
        ] : [el('span', { class: 'st-val muted', text: 'no reading' }), el('span', { class: 'st-sub', text: r.error || '' })]),
      ]));
    }
  }

  // observed wind (the lead station) against the hourly forecast, six hours either side of now
  function renderWindChart() {
    const host = clear($('#wind-chart'));
    const legend = clear($('#wind-legend'));
    const cfg = live.cfg;
    const now = Date.now();
    const span = (cfg.history_h || 6) * 36e5;
    const t0 = now - span, t1 = now + span;
    const obs = (live.primary?.series || []).filter((o) => o.t >= t0 && o.t <= now + 6e5);
    const fc = (state.data.wind_forecast || []).map((f) => ({ ...f, t: Date.parse(f.time) + 18e5 })) // plotted mid-hour
      .filter((f) => f.t >= t0 - 36e5 && f.t <= t1 + 36e5 && f.mph != null);
    if (obs.length < 2 && fc.length < 2) {
      host.append(el('p', { class: 'note', text: live.checkedAt ? 'No wind history to chart.' : '' }));
      return;
    }
    const W = Math.max(280, host.clientWidth || 600);
    const H = 200;
    const m = { l: 30, r: 10, t: 34, b: 26 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const top = Math.max(10, ...obs.map((o) => Math.max(o.mph, o.gust || 0)), ...fc.map((f) => f.mph));
    const yMax = Math.ceil((top + 1) / 5) * 5;
    const xOf = (t) => m.l + ((t - t0) / (t1 - t0)) * pw;
    const yOf = (v) => m.t + (1 - Math.min(v, yMax) / yMax) * ph;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Observed wind against the forecast, six hours either side of now' });
    const clipId = `wclip${Math.round(Math.random() * 1e6)}`;
    svg.append(svgEl('defs', {}, [svgEl('clipPath', { id: clipId }, [svgEl('rect', { x: m.l, y: 0, width: pw, height: H })])]));
    const plot = svgEl('g', { 'clip-path': `url(#${clipId})` });

    svg.append(svgEl('rect', { class: 'future', x: xOf(now), y: m.t, width: Math.max(0, m.l + pw - xOf(now)), height: ph }));
    for (let v = 0; v <= yMax; v += 5) {
      svg.append(svgEl('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: yOf(v), y2: yOf(v) }));
      svg.append(svgEl('text', { class: 'axis', x: m.l - 6, y: yOf(v) + 4, 'text-anchor': 'end', text: `${v}` }));
    }
    // hour labels every three local hours (Pacific offsets are whole hours, so UTC hour boundaries line up)
    const firstHour = Math.ceil(t0 / 36e5) * 36e5;
    for (let t = firstHour; t <= t1; t += 36e5) {
      const iso = new Date(t).toISOString();
      const h = Number(laFmt({ hour: 'numeric', hour12: false }).format(new Date(t))) % 24;
      const x = xOf(t);
      if (h % 3 || x < m.l + 14 || x > W - m.r - 14) continue;
      svg.append(svgEl('text', { class: 'axis', x, y: H - 8, 'text-anchor': 'middle', text: fmt.hour(iso).replace(' ', ' ') }));
    }

    // forecast: dashed
    if (fc.length > 1) {
      plot.append(svgEl('path', { class: 'fcst', d: fc.map((f, i) => `${i ? 'L' : 'M'}${xOf(f.t).toFixed(1)},${yOf(f.mph).toFixed(1)}`).join('') }));
    }
    // observed: soft area and a line, broken where the station skipped more than half an hour; gusts dotted
    const runs = [];
    for (const o of obs) {
      const last = runs[runs.length - 1];
      if (last && o.t - last[last.length - 1].t <= 18e5) last.push(o); else runs.push([o]);
    }
    for (const run of runs) {
      const d = run.map((o, i) => `${i ? 'L' : 'M'}${xOf(o.t).toFixed(1)},${yOf(o.mph).toFixed(1)}`).join('');
      if (run.length > 1) {
        plot.append(svgEl('path', { class: 'area', d: `${d}L${xOf(run[run.length - 1].t).toFixed(1)},${yOf(0)}L${xOf(run[0].t).toFixed(1)},${yOf(0)}Z` }));
        plot.append(svgEl('path', { class: 'line', d }));
      }
      const g = run.filter((o) => o.gust != null);
      if (g.length > 1) plot.append(svgEl('path', { class: 'gust', d: g.map((o, i) => `${i ? 'L' : 'M'}${xOf(o.t).toFixed(1)},${yOf(o.gust).toFixed(1)}`).join('') }));
    }
    svg.append(plot);

    // direction along the top, one arrow an hour: observed (averaged) behind now, forecast ahead
    const arrowRow = svgEl('g', { class: 'dir-row' });
    for (let t = Math.floor(t0 / 36e5) * 36e5; t < t1; t += 36e5) {
      const x = xOf(t + 18e5);
      if (x < m.l + 4 || x > W - m.r - 4) continue;
      let deg = null, mph = null, past = false;
      const inHour = obs.filter((o) => o.t >= t && o.t < t + 36e5);
      if (inHour.length && t < now) {
        let u = 0, v = 0;
        for (const o of inHour) { if (o.deg != null) { u += o.mph * Math.sin((o.deg * Math.PI) / 180); v += o.mph * Math.cos((o.deg * Math.PI) / 180); } }
        mph = inHour.reduce((s, o) => s + o.mph, 0) / inHour.length;
        deg = Math.hypot(u, v) > 0.1 ? ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360 : null;
        past = true;
      } else if (t + 36e5 > now) {
        const f = forecastAt(t);
        if (f) { deg = f.deg; mph = f.mph; }
      }
      if (mph == null) continue;
      const cls = `dir${past ? ' obs' : ''}`;
      if (deg == null || mph < 0.5) arrowRow.append(svgEl('circle', { class: cls, cx: x, cy: m.t - 17, r: 1.8 }));
      else arrowRow.append(svgEl('path', { class: cls, d: 'M0,-6V6M-3.6,2L0,6L3.6,2', transform: `translate(${x.toFixed(1)},${m.t - 17}) rotate(${Math.round(deg)})` }));
    }
    svg.append(arrowRow);

    // now
    const xn = xOf(now);
    svg.append(svgEl('line', { class: 'now', x1: xn, x2: xn, y1: m.t, y2: m.t + ph }));
    svg.append(svgEl('text', { class: 'now-lbl', x: xn + 5, y: m.t + 10, text: 'now' }));
    const lastObs = obs[obs.length - 1];
    if (lastObs) svg.append(svgEl('circle', { class: 'obs-dot', cx: xOf(lastObs.t), cy: yOf(lastObs.mph), r: 4.5 }));

    // hover
    const xh = svgEl('line', { class: 'xhair', x1: 0, x2: 0, y1: m.t, y2: m.t + ph, visibility: 'hidden' });
    const xd = svgEl('circle', { class: 'xdot', r: 4, visibility: 'hidden' });
    const hit = svgEl('rect', { class: 'hit', x: m.l, y: m.t, width: pw, height: ph });
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const t = t0 + ((((e.clientX - r.left) / r.width) * W - m.l) / pw) * (t1 - t0);
      let near = null;
      for (const o of obs) if (Math.abs(o.t - t) <= 9e5 && (!near || Math.abs(o.t - t) < Math.abs(near.t - t))) near = o;
      const f = forecastAt(t);
      const x = near ? xOf(near.t) : xOf(t);
      xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.setAttribute('visibility', 'visible');
      if (near) { xd.setAttribute('cx', x); xd.setAttribute('cy', yOf(near.mph)); xd.setAttribute('visibility', 'visible'); } else xd.setAttribute('visibility', 'hidden');
      showTip([
        fmt.time(new Date(near ? near.t : t).toISOString()),
        near ? `observed ${windText(near)}${gustText(near) ? `, ${gustText(near)}` : ''}` : null,
        f ? `forecast ${f.mph < 0.5 ? 'calm' : `${Math.round(f.mph)} mph${f.dir ? ` ${f.dir}` : ''}`}` : null,
      ], e.clientX, e.clientY);
    });
    hit.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); hideTip(); });
    svg.append(xh, xd, hit);
    host.append(svg);

    const src = live.primary?.st?.name;
    legend.append(...[
      obs.length ? el('span', {}, [el('i', { class: 'sw obs' }), `observed${src ? `, ${src}` : ''}`]) : null,
      obs.some((o) => o.gust != null) ? el('span', {}, [el('i', { class: 'sw gust' }), 'gusts']) : null,
      fc.length ? el('span', {}, [el('i', { class: 'sw fcst' }), 'forecast']) : null,
      el('span', {}, ['arrows: where the wind blows to']),
    ].filter(Boolean));
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
    renderCams(data);
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
      // the first renderAll ran while #main was hidden: fit the KPI and size the charts to the real width
      fitWindowKpi();
      renderTide(data, currentDay());
      live.cfg = data.live_wind?.stations?.length ? data.live_wind : null;
      renderLive();
      refreshLive();
      if (document.fonts?.ready) document.fonts.ready.then(fitWindowKpi); // the web font changes the widths
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
    resizeT = setTimeout(() => { if (state.data) { renderTide(state.data, currentDay()); if (live.cfg) renderWindChart(); fitWindowKpi(); } }, 120);
  });

  boot();
})();
