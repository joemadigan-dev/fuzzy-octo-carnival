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

  function tickerClass(k, dirState) {
    const d = dirState || 'flat';
    if (d === 'flat') return 'flat';
    if (k.direction === 'neutral' || k.direction === 'up_is_good') return d;
    return d === 'up' ? 'down' : 'up'; // down_is_good: invert colour
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
  function tileHtml(k) {
    const chg = k.changes?.[tf] ?? null;
    const dirCls = tickerClass(k, k.dir?.[tf]);
    const c = fmtChange(k, chg);
    const cls = tickerClass(k, chg && (chg.abs > 0 ? 'up' : chg.abs < 0 ? 'down' : 'flat'));
    const badges = [];
    if (k.status !== 'ok') badges.push(`<span class="tile-badge">${k.status === 'stale' ? 'STALE' : 'ERR'}</span>`);
    if (k.flag) badges.push(`<span class="tile-badge flagchip">${k.flag}</span>`);
    const ts = (k.latestDate ? `as of ${k.latestDate}` : 'no data')
      + (k.deadline ? ` · by ${k.deadline}` : '');
    const detail = (k.status !== 'ok' && k.statusDetail)
      ? `<div class="tile-err">${escapeHtml(k.statusDetail)}</div>` : '';
    return `
      <div class="tile-label"><span>${k.label}</span><span class="badges">${badges.join('')}</span></div>
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
    $('chip-divergence').hidden = !(wall?.barometer?.divergence?.[zwin]);
  }

  function setChip(chipId, valId, d, tone) {
    $(chipId).dataset.tone = tone;
    $(valId).textContent = d?.regime
      ? `${d.regime} ${d.score !== null && d.score !== undefined ? (d.score > 0 ? '+' : '') + d.score.toFixed(2) : ''}`
      : '—';
  }

  // tone: 'good' | '' | 'bad' — the only chroma on the page
  function pressureTone(r) { return r === 'SET FAIR' || r === 'FAIR' ? 'good' : r === 'UNSETTLED' || r === 'STORM' ? 'bad' : ''; }
  function altitudeTone(r) { return r === 'EXTREME' ? 'bad' : ''; } // high altitude is a state, not an alarm

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
    return `
      <h3>${title} <span class="g-regime" data-tone="${tone}">${d.regime ?? '—'}</span>
        <span class="g-score">${d.score === null ? '' : (d.score > 0 ? '+' : '') + d.score.toFixed(2)}</span></h3>
      <p class="sig-note">${subtitle}</p>
      <table class="sig-inputs">
        <tr><th>SUB-INDEX / INPUT</th><th>WT</th><th>Z</th><th>CONTRIB</th></tr>
        ${rows}
      </table>`;
  }

  function renderBaroBody() {
    $('divergence-note').hidden = !(wall?.barometer?.divergence?.[zwin]);
    const p = baro?.barometer?.pressure?.[zwin];
    const a = baro?.barometer?.altitude?.[zwin];
    $('gauge-pressure').innerHTML = gaugeHtml('pressure', 'PRESSURE',
      'Is stress arriving now? Fast, coincident-to-leading. Falling pressure = deteriorating conditions. Thresholds +1.0 / +0.3 / −0.3 / −1.0, 3-day hysteresis.',
      pressureTone(p?.regime));
    $('gauge-altitude').innerHTML = gaugeHtml('altitude', 'ALTITUDE',
      'How far is there to fall? Slow, structural. Melt-ups end AT maximum altitude — high is a state, not an order. Thresholds −0.5 / +0.5 / +1.25.',
      altitudeTone(a?.regime));
    renderBacktest();
    renderChangeLog();
    renderDiagnostics();
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

    const eps = (diag.divergenceEpisodes ?? []).filter((e) => e.window === zwin);
    $('div-table').innerHTML = eps.length
      ? `<tr><th>START</th><th>END</th></tr>` + eps.map((e) => `<tr><td>${e.start}</td><td>${e.end}</td></tr>`).join('')
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
