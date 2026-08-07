/* THE WALL — client. Polls /api/wall every 60s, diffs, animates the tick.
   All timeframes arrive in one payload, so the D/W/M/Y/5Y flip is instant
   and client-side. Barometer detail + diagnostics load lazily from
   /api/barometer. No frameworks. */

(() => {
  'use strict';

  const POLL_MS = 60_000;
  const TF_LABEL = { d: '1D', w: '1W', m: '1M', y: '1Y', y5: '5Y' };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const INK = '#17191c', MUTED = '#5f635d', GRID = '#c9cbc3';

  let wall = null;          // last /api/wall payload
  let baro = null;          // last /api/barometer payload (lazy)
  let alerts = null;        // last /api/alerts payload (lazy)
  let tf = 'd';
  let zwin = '2y';
  let expandedTile = null;
  const collapsed = new Set();
  const charts = new Map();
  let backtestPlot = null;

  const $ = (id) => document.getElementById(id);
  const wallEl = $('wall');

  // ── formatting ───────────────────────────────────────────────────────
  const fmtNum = (v, dec) => v === null || v === undefined
    ? '—'
    : v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

  function fmtValue(k, v) {
    if (v === null || v === undefined) return '—';
    const n = fmtNum(v, k.decimals);
    return k.unitPrefix
      ? `<span class="unit">${k.unit}</span>${n}`
      : `${n}<span class="unit">${k.unit ? ' ' + k.unit : ''}</span>`;
  }

  // direction is encoded three times: glyph, explicit sign, colour class
  function fmtChange(k, chg) {
    if (!chg) return { html: `<span aria-hidden="true">–</span> no ${TF_LABEL[tf]} data`, cls: 'flat' };
    const dir = chg.abs > 0 ? 'up' : chg.abs < 0 ? 'down' : 'flat';
    const glyph = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '–';
    const sign = chg.abs > 0 ? '+' : '';
    const absTxt = sign + fmtNum(chg.abs, k.decimals);
    const pctTxt = (chg.pct === null || k.showPct === false) ? '' : ` <span class="pct">(${sign}${fmtNum(chg.pct, 2)}%)</span>`;
    return { html: `${glyph} ${absTxt}${pctTxt}`, cls: dir };
  }

  // Colour IS the tile's contribution to the Barometer: green = this move
  // pushes the system toward benign, red = toward storm. The .up class
  // renders green and .down renders red — here they are colour tokens, not
  // directions (the arrow glyph carries the actual direction).
  function tickerClass(k, dirState) {
    const d = dirState || 'flat';
    if (d === 'flat') return 'flat';
    const towardStress = (d === 'up') === ((k.stressSign ?? 1) > 0);
    return towardStress ? 'down' : 'up';
  }

  // ── sparkline (inline SVG, shape only) ───────────────────────────────
  function sparkSvg(spark, dirCls) {
    if (!spark || !spark.v || spark.v.length < 2) {
      return `<svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true"></svg>`;
    }
    const v = spark.v;
    let min = Infinity, max = -Infinity;
    for (const x of v) { if (x < min) min = x; if (x > max) max = x; }
    const span = max - min || 1;
    const W = 100, H = 26, pad = 2;
    const pts = v.map((x, i) => {
      const px = (i / (v.length - 1)) * W;
      const py = pad + (1 - (x - min) / span) * (H - 2 * pad);
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    });
    const last = pts[pts.length - 1].split(',');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <polyline class="spark-line" points="${pts.join(' ')}" vector-effect="non-scaling-stroke"/>
      <circle class="spark-dot ${dirCls}" cx="${last[0]}" cy="${last[1]}" r="2.4"/>
    </svg>`;
  }

  // ── tile ─────────────────────────────────────────────────────────────
  /** The tone the whole tile wears. Uses the deadbanded direction state, so
   *  a move too small to mean anything stays neutral instead of shouting.
   *  Stale/error tiles are never toned — a number that stopped updating
   *  must not assert a signal. */
  function tileTone(k) {
    if (k.status !== 'ok') return 'flat';
    return tickerClass(k, k.dir?.[tf]);
  }

  function tileHtml(k) {
    const chg = k.changes?.[tf] ?? null;
    const dirCls = tickerClass(k, k.dir?.[tf]);
    const c = fmtChange(k, chg);
    const cls = dirCls; // change text follows the same deadbanded state
    const badges = [];
    if (k.status !== 'ok') badges.push(`<span class="tile-badge">${k.status === 'stale' ? 'STALE' : 'ERR'}</span>`);
    if (k.flag) badges.push(`<span class="tile-badge flagchip">${k.flag}</span>`);
    const ts = (k.latestDate ? `as of ${k.latestDate}` : 'no data')
      + (k.deadline ? ` · by ${k.deadline}` : '');
    const detail = (k.status !== 'ok' && k.statusDetail)
      ? `<div class="tile-err">${escapeHtml(k.statusDetail)}</div>` : '';
    const hover = k.signRationale ? ` title="${escapeHtml(k.signRationale)}"` : '';
    return `
      <div class="tile-label"${hover}><span>${k.label}</span><span class="badges">${badges.join('')}</span></div>
      <div class="tile-num">${fmtValue(k, k.latest)}</div>
      <div class="tile-chg ${c.cls === 'flat' ? 'flat' : cls}">${c.html}</div>
      ${detail}
      <div class="tile-spark">${sparkSvg(k.sparks?.[tf], dirCls)}</div>
      <div class="tile-chart" id="chart-${k.id}"></div>
      <div class="tile-ts">${ts}</div>`;
  }

  function render() {
    if (!wall) return;
    const frag = document.createDocumentFragment();
    for (const cluster of wall.clusters) {
      const kpis = wall.kpis.filter((k) => k.cluster === cluster.id);
      if (!kpis.length) continue;
      const sec = document.createElement('section');
      sec.className = 'cluster' + (collapsed.has(cluster.id) ? ' collapsed' : '') + (cluster.attribution ? ' attributed' : '');
      sec.dataset.cluster = cluster.id;

      const head = document.createElement('div');
      head.className = 'cluster-head';
      head.innerHTML = `<h2>${cluster.label}</h2>`
        + (cluster.attribution ? `<span class="attribution">${cluster.attribution}</span>` : '')
        + `<button class="cluster-toggle" aria-expanded="${!collapsed.has(cluster.id)}">
          ${collapsed.has(cluster.id) ? '[ EXPAND ]' : '[ COLLAPSE ]'}</button>`;
      head.querySelector('.cluster-toggle').addEventListener('click', () => {
        collapsed.has(cluster.id) ? collapsed.delete(cluster.id) : collapsed.add(cluster.id);
        render();
      });
      sec.appendChild(head);

      const strip = document.createElement('div');
      strip.className = 'cluster-strip';
      strip.innerHTML = kpis.map((k) => {
        const chg = k.changes?.[tf];
        const cls = tickerClass(k, chg ? (chg.abs > 0 ? 'up' : chg.abs < 0 ? 'down' : 'flat') : 'flat');
        const glyph = chg ? (chg.abs > 0 ? '▲' : chg.abs < 0 ? '▼' : '–') : '–';
        return `<span class="s-item"><span class="s-label">${k.label}</span>
          <span class="s-val">${fmtValue(k, k.latest)}</span>
          <span class="s-chg ${cls}">${glyph}</span></span>`;
      }).join('');
      sec.appendChild(strip);

      const grid = document.createElement('div');
      grid.className = 'grid';
      for (const k of kpis) {
        const t = document.createElement('button');
        t.className = 'tile' + (expandedTile === k.id ? ' expanded' : '');
        t.dataset.kpi = k.id;
        t.dataset.status = k.status;
        t.dataset.tone = tileTone(k);
        t.setAttribute('aria-expanded', String(expandedTile === k.id));
        t.setAttribute('aria-label',
          `${k.label}: ${k.latest === null ? 'no data' : fmtNum(k.latest, k.decimals) + ' ' + k.unit}`
          + (k.status !== 'ok' ? `, ${k.status}` : '') + (k.flag ? `, ${k.flag}` : '') + '. Toggle full chart.');
        t.innerHTML = tileHtml(k);
        t.addEventListener('click', () => toggleExpand(k.id));
        grid.appendChild(t);
      }
      sec.appendChild(grid);
      frag.appendChild(sec);
    }
    wallEl.replaceChildren(frag);
    if (expandedTile) mountChart(expandedTile);
    renderBezel();
    renderBaroHead();
  }

  function renderBezel() {
    const lastRun = wall?.lastRun ? new Date(wall.lastRun) : null;
    $('last-run').textContent = lastRun
      ? `data ${lastRun.toISOString().slice(0, 16).replace('T', ' ')}Z`
      : 'data: none yet';

    const p = wall?.barometer?.pressure?.[zwin];
    const a = wall?.barometer?.altitude?.[zwin];
    setChip('chip-pressure', 'chip-pressure-v', p, pressureTone(p?.regime));
    setChip('chip-altitude', 'chip-altitude-v', a, altitudeTone(a?.regime));
    $('chip-divergence').hidden = !(wall?.barometer?.divergence?.[zwin]?.active);
  }

  function setChip(chipId, valId, d, tone) {
    $(chipId).dataset.tone = tone;
    $(valId).textContent = d?.regime
      ? `${d.regime} ${d.score !== null && d.score !== undefined ? (d.score > 0 ? '+' : '') + d.score.toFixed(2) : ''}`
      : '—';
  }

  // tone: 'good' | '' | 'bad' — the only chroma on the page
  function pressureTone(r) { return r === 'SET FAIR' || r === 'FAIR' ? 'good' : r === 'UNSETTLED' || r === 'STORM' ? 'bad' : ''; }
  function altitudeTone(r) { return r === 'STRATOSPHERIC' ? 'bad' : ''; } // stretch, not imminence

  // ── expand-in-place chart ────────────────────────────────────────────
  function toggleExpand(id) {
    expandedTile = expandedTile === id ? null : id;
    for (const p of charts.values()) p.destroy();
    charts.clear();
    render();
  }

  async function mountChart(id) {
    const host = $(`chart-${id}`);
    if (!host) return;
    try {
      const res = await fetch(`/api/series/${id}`);
      if (!res.ok) throw new Error(`series fetch ${res.status}`);
      const body = await res.json();
      const [ts, vs] = body.data;
      if (!ts || ts.length < 2) { host.textContent = 'no chart data'; return; }
      const w = host.clientWidth || host.parentElement.clientWidth - 24;
      const plot = new uPlot({
        width: w, height: 240,
        scales: { x: { time: true } },
        axes: [
          { stroke: MUTED, grid: { stroke: GRID, width: 1 }, ticks: { stroke: GRID }, font: '10px "Spline Sans Mono", monospace' },
          { stroke: MUTED, grid: { stroke: GRID, width: 1 }, ticks: { stroke: GRID }, font: '10px "Spline Sans Mono", monospace',
            values: (u, splits) => splits.map((v) => v.toLocaleString('en-US', { maximumFractionDigits: body.decimals })) },
        ],
        series: [{}, { label: body.label, stroke: INK, width: 1.5, points: { show: false } }],
        legend: { show: false },
        cursor: { y: false },
      }, [ts, vs], host);
      charts.set(id, plot);
    } catch (e) {
      host.textContent = `chart unavailable — ${e.message}`;
    }
  }

  // ── polling + diff + tick animation ──────────────────────────────────
  async function poll(initial = false) {
    try {
      const res = await fetch('/api/wall', { cache: 'no-store' });
      if (!res.ok) throw new Error(`wall fetch ${res.status}`);
      const next = await res.json();
      const prev = wall;
      wall = next;
      if (initial || !prev) { render(); return; }

      const prevById = new Map(prev.kpis.map((k) => [k.id, k]));
      let structural = next.kpis.length !== prev.kpis.length;
      for (const k of next.kpis) {
        const p = prevById.get(k.id);
        if (!p || p.status !== k.status || p.flag !== k.flag) { structural = true; break; }
      }
      if (structural) { render(); return; }

      for (const k of next.kpis) {
        const p = prevById.get(k.id);
        const tileEl = wallEl.querySelector(`[data-kpi="${k.id}"]`);
        if (!tileEl) continue;
        if (p.latest !== k.latest || JSON.stringify(p.changes?.[tf]) !== JSON.stringify(k.changes?.[tf])) {
          tileEl.dataset.tone = tileTone(k);
          tileEl.innerHTML = tileHtml(k);
          if (!REDUCED && p.latest !== k.latest) {
            tileEl.querySelector('.tile-num').classList.add('ticked');
          }
        }
      }
      renderBezel();
      renderBaroHead();
    } catch {
      $('last-run').textContent = `poll failed ${new Date().toISOString().slice(11, 16)}Z`;
    }
  }

  // ── timeframe toggle: whole wall flips as one event ──────────────────
  $('tf-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tf]');
    if (!btn || btn.dataset.tf === tf) return;
    tf = btn.dataset.tf;
    for (const b of $('tf-switch').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.tf === tf));
    }
    if (!REDUCED) {
      wallEl.classList.remove('tf-flipping');
      void wallEl.offsetWidth;
      wallEl.classList.add('tf-flipping');
    }
    render();
  });

  // ── THE BAROMETER panel ──────────────────────────────────────────────
  function kpiLabel(id) {
    const k = wall?.kpis.find((x) => x.id === id);
    return k ? k.label : id.toUpperCase().replaceAll('_', ' ');
  }

  function renderBaroHead() {
    const p = wall?.barometer?.pressure?.[zwin];
    const a = wall?.barometer?.altitude?.[zwin];
    const ph = $('head-pressure'), ah = $('head-altitude');
    ph.textContent = p?.regime ? `PRESSURE ${p.regime}` : 'PRESSURE —';
    ah.textContent = a?.regime ? `ALTITUDE ${a.regime}` : 'ALTITUDE —';
    ph.dataset.tone = pressureTone(p?.regime);
    ah.dataset.tone = altitudeTone(a?.regime);
    if ($('signal-panel').classList.contains('open')) renderBaroBody();
  }

  async function openBaro() {
    const panel = $('signal-panel');
    const open = panel.classList.toggle('open');
    $('sig-disclose').setAttribute('aria-expanded', String(open));
    $('signal-body').hidden = !open;
    $('sig-disclose').textContent = open ? 'HIDE ▴' : 'SHOW GAUGES + BACKTEST + DIAGNOSTICS ▾';
    if (open) {
      if (!baro) {
        try {
          const res = await fetch('/api/barometer');
          if (res.ok) baro = await res.json();
        } catch { /* body renders what it can */ }
      }
      renderBaroBody();
    }
  }
  $('sig-disclose').addEventListener('click', openBaro);
  for (const id of ['chip-pressure', 'chip-altitude', 'chip-divergence']) {
    $(id).addEventListener('click', () => {
      if (!$('signal-panel').classList.contains('open')) openBaro();
      $('signal-panel').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
    });
  }

  $('zwin-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-zw]');
    if (!btn || btn.dataset.zw === zwin) return;
    zwin = btn.dataset.zw;
    for (const b of $('zwin-switch').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.zw === zwin));
    }
    renderBezel();
    renderBaroHead();
  });

  // ── gauge face: zones, density, needle, reference marks, tf range ────
  const ZONES = {
    pressure: { bounds: [-1.0, -0.3, 0.3, 1.0], labels: ['STORM', 'UNSETTLED', 'CHANGE', 'FAIR', 'SET FAIR'] },
    altitude: { bounds: [-0.5, 0.5, 1.0, 1.75], labels: ['GROUNDED', 'CLIMBING', 'HIGH', 'EXTENDED', 'STRATOSPHERIC'] },
  };

  function gaugeSvg(layerId, g, score) {
    if (!g || score === null || score === undefined) return '';
    const W = 640, H = 132, L = 14, R = 626;
    const lo = Math.min(g.hist.min, -2.5), hi = Math.max(g.hist.max, 2.5);
    const x = (s) => L + ((Math.max(lo, Math.min(hi, s)) - lo) / (hi - lo)) * (R - L);
    const zones = ZONES[layerId];
    const parts = [];

    // altitude zones hatched, pressure zones solid — the two faces must not
    // be mistakable for each other
    if (layerId === 'altitude') {
      parts.push(`<defs><pattern id="hatch" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <line x1="0" y1="0" x2="0" y2="5" stroke="#9a9d95" stroke-width="1.1"/></pattern></defs>`);
    }
    const edges = [lo, ...zones.bounds, hi];
    for (let i = 0; i < zones.labels.length; i++) {
      const x0 = x(edges[i]), x1 = x(edges[i + 1]);
      // shading darkens toward the storm end (left for pressure, right for altitude)
      const t = layerId === 'pressure' ? (zones.labels.length - 1 - i) : i;
      const fill = layerId === 'altitude' ? 'url(#hatch)' : `rgba(23,25,28,${(0.05 + t * 0.075).toFixed(3)})`;
      parts.push(`<rect x="${x0.toFixed(1)}" y="58" width="${(x1 - x0).toFixed(1)}" height="18" fill="${fill}" stroke="#b6b8b0" stroke-width="0.5"/>`);
      if (layerId === 'altitude') {
        parts.push(`<rect x="${x0.toFixed(1)}" y="58" width="${(x1 - x0).toFixed(1)}" height="18" fill="rgba(23,25,28,${(0.03 + t * 0.05).toFixed(3)})"/>`);
      }
      const label = zones.labels[i];
      const cx = (x0 + x1) / 2;
      parts.push(`<text x="${cx.toFixed(1)}" y="70.5" text-anchor="middle" font-size="8" letter-spacing="0.08em"
        fill="${t >= 3 ? '#edeee9' : '#5f635d'}" font-family="'Spline Sans Mono',monospace">${label}</text>`);
    }

    // density of the full score history behind the needle
    if (g.hist.bins.length) {
      const n = g.hist.bins.length;
      const bx = (i) => x(g.hist.min + ((i + 0.5) / n) * (g.hist.max - g.hist.min));
      const pts = [`${x(g.hist.min).toFixed(1)},56`];
      for (let i = 0; i < n; i++) pts.push(`${bx(i).toFixed(1)},${(56 - g.hist.bins[i] * 40).toFixed(1)}`);
      pts.push(`${x(g.hist.max).toFixed(1)},56`);
      parts.push(`<polyline points="${pts.join(' ')}" fill="rgba(23,25,28,0.10)" stroke="#8b8e88" stroke-width="0.8"/>`);
    }

    // timeframe hi–lo bracket (where has it BEEN in the selected window)
    const tfr = g.tfRange?.[tf === 'y5' ? 'y' : tf];
    if (tfr) {
      const x0 = x(tfr.lo), x1 = x(tfr.hi);
      parts.push(`<line x1="${x0.toFixed(1)}" y1="82" x2="${x1.toFixed(1)}" y2="82" stroke="#17191c" stroke-width="2"/>
        <line x1="${x0.toFixed(1)}" y1="78" x2="${x0.toFixed(1)}" y2="86" stroke="#17191c" stroke-width="1"/>
        <line x1="${x1.toFixed(1)}" y1="78" x2="${x1.toFixed(1)}" y2="86" stroke="#17191c" stroke-width="1"/>
        <text x="${((x0 + x1) / 2).toFixed(1)}" y="94" text-anchor="middle" font-size="7.5" fill="#5f635d"
          font-family="'Spline Sans Mono',monospace">${TF_LABEL[tf]} RANGE</text>`);
    }

    // fixed historical reference marks: 2008 / 2020 / 2022 / recent peak.
    // Crisis dates cluster tightly on the altitude face, so labels stagger
    // onto a second row rather than overprinting each other.
    const marks = [...(g.refMarks ?? [])].sort((p, q) => p.score - q.score);
    const rowEnds = [-Infinity, -Infinity, -Infinity]; // rightmost label edge per row
    for (const m of marks) {
      const mx = x(m.score);
      const half = (`${m.label} ${m.score.toFixed(1)}`.length * 4.6) / 2;
      let row = rowEnds.findIndex((end) => mx - half > end);
      if (row < 0) row = 0;
      rowEnds[row] = mx + half + 4;
      const ty = 100 + row * 13;
      parts.push(`<line x1="${mx.toFixed(1)}" y1="52" x2="${mx.toFixed(1)}" y2="${(ty - 8).toFixed(1)}" stroke="#17191c" stroke-width="0.9" stroke-dasharray="2 2"/>
        <text x="${mx.toFixed(1)}" y="${ty}" text-anchor="middle" font-size="7.5" fill="#5f635d"
          font-family="'Spline Sans Mono',monospace">${m.label} <tspan fill="#8b8e88">${m.score.toFixed(1)}</tspan></text>`);
    }

    // needle
    const nx = x(score);
    parts.push(`<line x1="${nx.toFixed(1)}" y1="12" x2="${nx.toFixed(1)}" y2="80" stroke="#17191c" stroke-width="2"/>
      <path d="M ${(nx - 5).toFixed(1)} 6 L ${(nx + 5).toFixed(1)} 6 L ${nx.toFixed(1)} 14 Z" fill="#17191c"/>`);

    return `<svg viewBox="0 0 ${W} ${H}" class="gauge-svg" role="img"
      aria-label="${layerId} gauge: score ${score.toFixed(2)}, ${g.percentile === null ? '' : Math.round(g.percentile) + 'th percentile'}">${parts.join('')}</svg>`;
  }

  const ordinal = (n) => { const v = Math.round(n); const s = ['th', 'st', 'nd', 'rd'], k = v % 100; return v + (s[(k - 20) % 10] || s[k] || s[0]); };

  function gaugeHtml(layerId, title, subtitle, tone) {
    const d = baro?.barometer?.[layerId]?.[zwin];
    if (!d) return `<h3>${title}</h3><p class="sig-note">not computed yet</p>`;
    const rows = (d.subs ?? []).map((s) => {
      const subRow = `
        <tr class="sub-row">
          <td>${s.label}</td>
          <td>${(s.weight * 100).toFixed(0)}%</td>
          <td>${s.z === null ? '—' : s.z.toFixed(2)}</td>
          <td class="${s.contribution > 0 ? (layerId === 'pressure' ? 'neg' : 'pos') : s.contribution < 0 ? (layerId === 'pressure' ? 'pos' : 'neg') : ''}">
            ${s.contribution === null ? '—' : (s.contribution > 0 ? '+' : '') + s.contribution.toFixed(2)}</td>
        </tr>`;
      const inputRows = (s.inputs ?? []).map((i) => `
        <tr class="input-row">
          <td>· ${kpiLabel(i.id)} <span class="in-meta">${i.sign > 0 ? '+' : '−'}·${(i.weight * 100).toFixed(0)}%${i.asOf ? ' · ' + i.asOf : ''}</span></td>
          <td></td>
          <td>${i.z === null ? '—' : i.z.toFixed(2)}</td>
          <td></td>
        </tr>`).join('');
      return subRow + inputRows;
    }).join('');
    const g = d.gauge;
    const pctTxt = g?.percentile === null || g?.percentile === undefined
      ? ''
      : `<span class="g-pct">${ordinal(g.percentile)} pct${g.firstDate ? ' since ' + g.firstDate.slice(0, 4) : ''}</span>`;
    return `
      <h3>${title} <span class="g-regime" data-tone="${tone}">${d.regime ?? '—'}</span>
        <span class="g-score">${d.score === null ? '' : (d.score > 0 ? '+' : '') + d.score.toFixed(2)}</span>
        ${pctTxt}</h3>
      <p class="sig-note">${subtitle}</p>
      ${gaugeSvg(layerId, g, d.score)}
      <table class="sig-inputs">
        <tr><th>SUB-INDEX / INPUT</th><th>WT</th><th>Z</th><th>CONTRIB</th></tr>
        ${rows}
      </table>`;
  }

  // one line naming the current configuration — the actual output of the
  // two-layer design
  function divergenceReadout() {
    const p = baro?.barometer?.pressure?.[zwin];
    const a = baro?.barometer?.altitude?.[zwin];
    if (!p || !a) return '';
    const trend = (t) => t === null || t === undefined ? '' : t > 0.05 ? ' and rising' : t < -0.05 ? ' and falling' : ' and steady';
    const dv = baro?.divergence?.[zwin] ?? wall?.barometer?.divergence?.[zwin];
    let tail = 'no divergence';
    if (dv?.active) {
      const wks = Math.round(dv.days / 7);
      tail = `DIVERGENCE holding ${dv.days >= 14 ? wks + ' weeks' : dv.days + ' days'} (since ${dv.since})`;
    }
    const aPct = a.gauge?.percentile !== null && a.gauge?.percentile !== undefined ? ` (${ordinal(a.gauge.percentile)} pct)` : '';
    const pPct = p.gauge?.percentile !== null && p.gauge?.percentile !== undefined ? ` (${ordinal(p.gauge.percentile)} pct)` : '';
    return `ALTITUDE: <b>${a.regime}</b>${aPct}${trend(a.gauge?.trend30d)} · PRESSURE: <b>${p.regime}</b>${pPct}${trend(p.gauge?.trend30d)} — ${tail}`;
  }

  function renderBaroBody() {
    $('divergence-note').hidden = !(wall?.barometer?.divergence?.[zwin]?.active);
    const p = baro?.barometer?.pressure?.[zwin];
    const a = baro?.barometer?.altitude?.[zwin];
    $('gauge-pressure').innerHTML = gaugeHtml('pressure', 'PRESSURE',
      'Is stress arriving now? Fast, coincident-to-leading. Falling pressure = deteriorating conditions. 3-day hysteresis.',
      pressureTone(p?.regime));
    $('gauge-altitude').innerHTML = gaugeHtml('altitude', 'ALTITUDE',
      'How far is there to fall? Slow, structural stretch — melt-ups end AT maximum altitude. High is a state, not an order.',
      altitudeTone(a?.regime));
    $('divergence-readout').innerHTML = divergenceReadout();
    renderBacktest();
    renderChangeLog();
    renderAnalogues();
    renderAlerts();
    renderDiagnostics();
  }

  // Five closest historical episodes and what followed each. Dispersion is
  // the point — the mean of five non-independent outcomes is noise.
  function renderAnalogues() {
    const tbl = $('analogue-table');
    const rows = baro?.analogues ?? [];
    if (!rows.length) { tbl.innerHTML = '<tr><td>not enough comparable history yet</td></tr>'; return; }
    const cell = (v) => v === null || v === undefined
      ? '<td class="pending">—</td>'
      : `<td class="${v > 0 ? 'neg' : 'pos'}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</td>`;
    const spreads = ['m1', 'm3', 'm6', 'm12'].map((h) => {
      const vs = rows.map((r) => r.forward[h]).filter((v) => v !== null && v !== undefined);
      return vs.length >= 2 ? `${Math.min(...vs).toFixed(0)}% to +${Math.max(...vs).toFixed(0)}%`.replace('+-', '−') : '—';
    });
    tbl.innerHTML = `
      <tr><th>DATE</th><th>SIM</th><th>S&P +1M</th><th>+3M</th><th>+6M</th><th>+12M</th></tr>
      ${rows.map((r) => `
        <tr>
          <td>${r.date}</td>
          <td>${r.similarity.toFixed(3)}<span class="in-meta"> ${r.dims}d</span></td>
          ${cell(r.forward.m1)}${cell(r.forward.m3)}${cell(r.forward.m6)}${cell(r.forward.m12)}
        </tr>`).join('')}
      <tr class="spread-row"><td colspan="2">SPREAD ACROSS EPISODES</td>
        <td colspan="1">${spreads[0]}</td><td>${spreads[1]}</td><td>${spreads[2]}</td><td>${spreads[3]}</td></tr>`;
  }

  async function renderAlerts() {
    const tbl = $('alerts-table');
    if (!alerts) {
      try {
        const res = await fetch('/api/alerts');
        if (res.ok) alerts = (await res.json()).alerts ?? [];
      } catch { alerts = []; }
    }
    if (!alerts?.length) { tbl.innerHTML = '<tr><td>no alerts fired yet</td></tr>'; return; }
    tbl.innerHTML = `
      <tr><th>DATE</th><th>KIND</th><th>WHAT CHANGED</th><th>SENT</th></tr>
      ${alerts.map((a) => `
        <tr>
          <td>${a.date}</td>
          <td>${a.kind}</td>
          <td>${escapeHtml(a.message)}</td>
          <td class="in-meta">${(a.delivered ?? []).join('+') || 'logged'}</td>
        </tr>`).join('')}`;
  }

  function renderBacktest() {
    const host = $('backtest-chart');
    const h = baro?.history;
    if (!h?.t?.length) { host.textContent = 'backtest loads from /api/barometer'; return; }
    if (backtestPlot) { backtestPlot.destroy(); backtestPlot = null; }
    const pKey = zwin === '2y' ? 'p_2y' : 'p_5y';
    const aKey = zwin === '2y' ? 'a_2y' : 'a_5y';
    const dKey = zwin === '2y' ? 'div_2y' : 'div_5y';
    const w = host.clientWidth || 900;
    backtestPlot = new uPlot({
      width: w, height: 220,
      scales: { x: { time: true } },
      axes: [
        { stroke: MUTED, grid: { stroke: GRID }, font: '10px "Spline Sans Mono", monospace' },
        { stroke: MUTED, grid: { stroke: GRID }, font: '10px "Spline Sans Mono", monospace' },
      ],
      series: [
        {},
        { label: 'PRESSURE', stroke: INK, width: 1.4, points: { show: false } },
        { label: 'ALTITUDE', stroke: MUTED, width: 1.2, dash: [4, 3], points: { show: false } },
      ],
      legend: { show: true },
      cursor: { y: false },
      hooks: {
        drawClear: [(u) => {
          // shade divergence episodes — the configuration that precedes busts
          const ctx = u.ctx;
          const div = h[dKey];
          ctx.save();
          ctx.fillStyle = 'rgba(220,73,86,0.14)';
          let start = null;
          for (let i = 0; i <= div.length; i++) {
            const on = i < div.length && div[i] === 1;
            if (on && start === null) start = i;
            if (!on && start !== null) {
              const x0 = u.valToPos(h.t[start], 'x', true);
              const x1 = u.valToPos(h.t[Math.min(i, div.length - 1)], 'x', true);
              ctx.fillRect(x0, u.bbox.top, Math.max(1.5, x1 - x0), u.bbox.height);
              start = null;
            }
          }
          ctx.restore();
        }],
      },
    }, [h.t, h[pKey], h[aKey]], host);
  }

  function renderChangeLog() {
    const tbl = $('sig-log-table');
    const changes = (baro?.changes ?? []).filter((c) => c.window === zwin);
    if (!changes.length) { tbl.innerHTML = '<tr><td>no regime changes recorded</td></tr>'; return; }
    tbl.innerHTML = `
      <tr><th>DATE</th><th>LAYER</th><th>TRANSITION</th><th>SCORE</th><th>TOP DRIVERS (SUB-INDICES)</th></tr>
      ${changes.map((c) => `
        <tr>
          <td>${c.date}</td>
          <td>${c.layer.toUpperCase()}</td>
          <td>${c.from_regime} → <span class="to-${c.to_regime.replaceAll(' ', '_')}">${c.to_regime}</span></td>
          <td>${c.score.toFixed(2)}</td>
          <td class="drivers">${c.drivers.slice(0, 3).map((d) =>
            `${kpiLabel(d.id)} z=${d.z.toFixed(1)} (${d.contribution > 0 ? '+' : ''}${d.contribution.toFixed(2)})`).join(' · ')}</td>
        </tr>`).join('')}`;
  }

  function renderDiagnostics() {
    const diag = baro?.diagnostics;
    if (!diag) return;

    // correlation matrix — compact heat table, flagged pairs in signal red
    const { ids, matrix } = diag.corr;
    const flaggedSet = new Set(diag.corr.flagged.flatMap((f) => [`${f.a}|${f.b}`, `${f.b}|${f.a}`]));
    const short = (id) => id.length > 10 ? id.slice(0, 10) : id;
    $('corr-matrix').innerHTML = `
      <tr><th></th>${ids.map((id) => `<th class="vert"><span>${short(id)}</span></th>`).join('')}</tr>
      ${ids.map((a, i) => `<tr><th>${short(a)}</th>${ids.map((b, j) => {
        const r = matrix[i][j];
        if (i === j) return '<td class="diag-self">·</td>';
        if (r === null) return '<td>—</td>';
        const flag = flaggedSet.has(`${a}|${b}`);
        const shade = Math.round(Math.abs(r) * 60);
        return `<td class="${flag ? 'corr-flag' : ''}" style="background:rgba(23,25,28,0.${String(shade).padStart(2, '0')})">${(r).toFixed(1).replace('0.', '.')}</td>`;
      }).join('')}</tr>`).join('')}`;
    $('corr-flagged').innerHTML = diag.corr.flagged.length
      ? 'FLAGGED: ' + diag.corr.flagged.map((f) => `${kpiLabel(f.a)} × ${kpiLabel(f.b)} ρ=${f.r.toFixed(2)}`).join(' · ')
      : 'no pair above 0.7';

    $('loo-table').innerHTML = `
      <tr><th>INPUT</th><th>LAYER</th><th>% DAYS CHANGED</th><th>SCORE Δ NOW</th></tr>
      ${diag.loo.map((l) => `
        <tr>
          <td>${kpiLabel(l.id)}</td>
          <td>${l.layer.toUpperCase()}</td>
          <td>${l.pctDaysChanged.toFixed(1)}%</td>
          <td>${l.scoreDelta === null ? '—' : (l.scoreDelta > 0 ? '+' : '') + l.scoreDelta.toFixed(2)}</td>
        </tr>`).join('')}`;

    // duration chart: the whole nature of divergence is that it persists
    // longer than expected before resolving — show how long each one held
    const eps = (diag.divergenceEpisodes ?? []).filter((e) => e.window === zwin);
    $('div-table').innerHTML = eps.length
      ? `<tr><th>START</th><th>END</th><th>HELD</th></tr>` + eps.map((e) => {
          const days = Math.round((Date.parse(e.end) - Date.parse(e.start)) / 86400000) + 1;
          return `<tr><td>${e.start}</td><td>${e.end}</td>
            <td><span class="dur-bar" style="width:${Math.min(140, days * 2)}px"></span> ${days}d</td></tr>`;
        }).join('')
      : '<tr><td>none in the backtest window</td></tr>';
  }

  // ── clock ────────────────────────────────────────────────────────────
  setInterval(() => {
    $('clock').textContent = new Date().toISOString().slice(11, 19) + 'Z';
  }, 1000);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── boot ─────────────────────────────────────────────────────────────
  poll(true);
  setInterval(poll, POLL_MS);
})();
