/* THE WALL — client. Polls /api/wall every 60s, diffs, animates the tick.
   All timeframes arrive in one payload, so the D/W/M/Y/5Y flip is instant
   and client-side. No frameworks. */

(() => {
  'use strict';

  const POLL_MS = 60_000;
  const TF_LABEL = { d: '1D', w: '1W', m: '1M', y: '1Y', y5: '5Y' };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let wall = null;          // last /api/wall payload
  let signalDetail = null;  // last /api/signal payload (lazy)
  let tf = 'd';
  let zwin = '2y';
  let expandedTile = null;  // kpi id
  const collapsed = new Set();
  const charts = new Map(); // kpi id -> uPlot
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
      : `${n}<span class="unit">${k.unit ? ' ' + k.unit : ''}</span>`;
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
    // three-mode direction semantics: what colour does this movement earn?
    const d = dirState || 'flat';
    if (d === 'flat') return 'flat';
    if (k.direction === 'neutral') return d;                 // green up / red down, no judgement
    if (k.direction === 'up_is_good') return d;              // up = green
    return d === 'up' ? 'down' : 'up';                       // down_is_good: invert colour
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
    const badge = k.status === 'ok' ? '' :
      `<span class="tile-badge">${k.status === 'stale' ? 'STALE' : 'ERR'}</span>`;
    const ts = k.latestDate
      ? `as of ${k.latestDate}`
      : 'no data';
    const detail = (k.status !== 'ok' && k.statusDetail)
      ? `<div class="tile-err">${escapeHtml(k.statusDetail)}</div>` : '';
    return `
      <div class="tile-label"><span>${k.label}</span>${badge}</div>
      <div class="tile-num" data-raw="${k.latest ?? ''}">${fmtValue(k, k.latest)}</div>
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
      sec.className = 'cluster' + (collapsed.has(cluster.id) ? ' collapsed' : '');
      sec.dataset.cluster = cluster.id;

      const head = document.createElement('div');
      head.className = 'cluster-head';
      head.innerHTML = `<h2>${cluster.label}</h2>
        <button class="cluster-toggle" aria-expanded="${!collapsed.has(cluster.id)}">
          ${collapsed.has(cluster.id) ? '[ EXPAND ]' : '[ COLLAPSE ]'}</button>`;
      head.querySelector('.cluster-toggle').addEventListener('click', () => {
        collapsed.has(cluster.id) ? collapsed.delete(cluster.id) : collapsed.add(cluster.id);
        render();
      });
      sec.appendChild(head);

      // one-line summary strip for collapsed clusters
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
          + (k.status !== 'ok' ? `, ${k.status}` : '') + '. Toggle full chart.');
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
    renderSignalHead();
  }

  function renderBezel() {
    const lastRun = wall?.lastRun ? new Date(wall.lastRun) : null;
    $('last-run').textContent = lastRun
      ? `data ${lastRun.toISOString().slice(0, 16).replace('T', ' ')}Z`
      : 'data: none yet';
    const s = wall?.signal?.[zwin];
    const chip = $('regime-chip');
    chip.dataset.regime = s?.regime ?? '';
    $('regime-name').textContent = s?.regime ?? 'NO SIGNAL';
    $('regime-score').textContent = s?.score !== null && s?.score !== undefined ? s.score.toFixed(2) : '';
  }

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
          { stroke: '#5f635d', grid: { stroke: '#c9cbc3', width: 1 }, ticks: { stroke: '#b6b8b0' },
            font: '10px "Spline Sans Mono", monospace' },
          { stroke: '#5f635d', grid: { stroke: '#c9cbc3', width: 1 }, ticks: { stroke: '#b6b8b0' },
            font: '10px "Spline Sans Mono", monospace',
            values: (u, splits) => splits.map((v) => v.toLocaleString('en-US', { maximumFractionDigits: body.decimals })) },
        ],
        series: [
          {},
          { label: body.label, stroke: '#17191c', width: 1.5, points: { show: false } },
        ],
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

      // diff: update changed tiles in place, pulse the number
      const prevById = new Map(prev.kpis.map((k) => [k.id, k]));
      let structural = false;
      for (const k of next.kpis) {
        const p = prevById.get(k.id);
        if (!p) { structural = true; break; }
        if (p.status !== k.status) structural = true;
      }
      if (structural || next.kpis.length !== prev.kpis.length) { render(); return; }

      for (const k of next.kpis) {
        const p = prevById.get(k.id);
        const tileEl = wallEl.querySelector(`[data-kpi="${k.id}"]`);
        if (!tileEl) continue;
        if (p.latest !== k.latest || JSON.stringify(p.changes?.[tf]) !== JSON.stringify(k.changes?.[tf])) {
          tileEl.innerHTML = tileHtml(k);
          if (!REDUCED && p.latest !== k.latest) {
            const numEl = tileEl.querySelector('.tile-num');
            numEl.classList.add('ticked');
          }
        }
      }
      renderBezel();
      renderSignalHead();
    } catch (e) {
      // network failure: leave the wall as-is; stamp goes quietly stale
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
      void wallEl.offsetWidth; // restart animation
      wallEl.classList.add('tf-flipping');
    }
    render();
  });

  // ── composite signal panel ───────────────────────────────────────────
  function renderSignalHead() {
    const s = wall?.signal?.[zwin];
    const el = $('sig-regime');
    el.dataset.regime = s?.regime ?? '';
    el.textContent = s?.regime ?? 'NOT COMPUTED';
    $('sig-score').textContent = s?.score !== null && s?.score !== undefined
      ? `score ${s.score.toFixed(2)} · thresholds −0.50 / +0.50 / +1.25 · 3-day hysteresis` : '';
    if ($('signal-panel').classList.contains('open')) renderSignalBody();
  }

  async function openSignal() {
    const panel = $('signal-panel');
    const open = panel.classList.toggle('open');
    $('sig-disclose').setAttribute('aria-expanded', String(open));
    $('signal-body').hidden = !open;
    $('sig-disclose').textContent = open ? 'HIDE ▴' : 'SHOW INPUTS + BACKTEST ▾';
    if (open) {
      if (!signalDetail) {
        try {
          const res = await fetch('/api/signal');
          if (res.ok) signalDetail = await res.json();
        } catch { /* renderSignalBody shows what it can */ }
      }
      renderSignalBody();
    }
  }
  $('sig-disclose').addEventListener('click', openSignal);
  $('regime-chip').addEventListener('click', () => {
    if (!$('signal-panel').classList.contains('open')) openSignal();
    $('signal-panel').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
  });

  $('zwin-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-zw]');
    if (!btn || btn.dataset.zw === zwin) return;
    zwin = btn.dataset.zw;
    for (const b of $('zwin-switch').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.zw === zwin));
    }
    renderBezel();
    renderSignalHead();
  });

  function kpiLabel(id) {
    const k = wall?.kpis.find((x) => x.id === id);
    return k ? k.label : id;
  }

  function renderSignalBody() {
    const det = signalDetail?.detail?.[zwin] ?? wall?.signal?.[zwin];
    const tbl = $('sig-inputs-table');
    if (!det) { tbl.innerHTML = '<tr><td>signal not computed yet</td></tr>'; return; }
    tbl.innerHTML = `
      <tr><th>INPUT</th><th>VALUE</th><th>Z</th><th>W×SGN</th><th>CONTRIB</th></tr>
      ${det.inputs.map((i) => `
        <tr>
          <td>${kpiLabel(i.id)}<div class="rationale">${escapeHtml(i.rationale)}</div></td>
          <td>${i.value === null ? '—' : i.value.toFixed(2)}</td>
          <td>${i.z === null ? '—' : i.z.toFixed(2)}</td>
          <td>${(i.weight * 100).toFixed(0)}%·${i.sign > 0 ? '+' : '−'}</td>
          <td class="${i.contribution > 0 ? 'pos' : i.contribution < 0 ? 'neg' : ''}">
            ${i.contribution === null ? '—' : (i.contribution > 0 ? '+' : '') + i.contribution.toFixed(2)}</td>
        </tr>`).join('')}
      <tr><td><b>COMPOSITE</b></td><td></td><td></td><td>100%</td>
        <td><b>${det.score === null ? '—' : (det.score > 0 ? '+' : '') + det.score.toFixed(2)}</b></td></tr>`;

    renderBacktest();
    renderChangeLog();
  }

  function renderBacktest() {
    const host = $('backtest-chart');
    if (!signalDetail?.history?.length) { host.textContent = 'backtest loads from /api/signal'; return; }
    if (backtestPlot) { backtestPlot.destroy(); backtestPlot = null; }
    const rows = signalDetail.history;
    const scoreKey = zwin === '2y' ? 'score_2y' : 'score_5y';
    const ts = [], vs = [];
    for (const r of rows) {
      if (r[scoreKey] === null) continue;
      ts.push(Math.floor(Date.parse(r.date + 'T00:00:00Z') / 1000));
      vs.push(r[scoreKey]);
    }
    if (ts.length < 2) { host.textContent = 'not enough history yet'; return; }
    const w = host.clientWidth || 500;
    backtestPlot = new uPlot({
      width: w, height: 200,
      scales: { x: { time: true } },
      axes: [
        { stroke: '#5f635d', grid: { stroke: '#c9cbc3' }, font: '10px "Spline Sans Mono", monospace' },
        { stroke: '#5f635d', grid: { stroke: '#c9cbc3' }, font: '10px "Spline Sans Mono", monospace' },
      ],
      series: [{}, { label: 'score', stroke: '#17191c', width: 1.2, points: { show: false } }],
      legend: { show: false },
      cursor: { y: false },
      hooks: {
        drawClear: [(u) => {
          // threshold bands: grey for caution zone boundaries, red/green edges
          const ctx = u.ctx;
          const y = (v) => u.valToPos(v, 'y', true);
          const x0 = u.bbox.left, x1 = u.bbox.left + u.bbox.width;
          ctx.save();
          ctx.fillStyle = 'rgba(220,73,86,0.08)';
          ctx.fillRect(x0, u.bbox.top, x1 - x0, Math.max(0, y(1.25) - u.bbox.top));
          ctx.fillStyle = 'rgba(11,100,51,0.07)';
          ctx.fillRect(x0, y(-0.5), x1 - x0, Math.max(0, u.bbox.top + u.bbox.height - y(-0.5)));
          ctx.strokeStyle = '#b6b8b0';
          ctx.setLineDash([3, 3]);
          for (const t of [-0.5, 0.5, 1.25]) {
            ctx.beginPath(); ctx.moveTo(x0, y(t)); ctx.lineTo(x1, y(t)); ctx.stroke();
          }
          ctx.restore();
        }],
      },
    }, [ts, vs], host);
  }

  function renderChangeLog() {
    const tbl = $('sig-log-table');
    const changes = (signalDetail?.changes ?? []).filter((c) => c.window === zwin);
    if (!changes.length) { tbl.innerHTML = '<tr><td>no regime changes recorded</td></tr>'; return; }
    tbl.innerHTML = `
      <tr><th>DATE</th><th>TRANSITION</th><th>SCORE</th><th>TOP DRIVERS</th></tr>
      ${changes.map((c) => `
        <tr>
          <td>${c.date}</td>
          <td>${c.from_regime} → <span class="to-${c.to_regime}">${c.to_regime}</span></td>
          <td>${c.score.toFixed(2)}</td>
          <td class="drivers">${c.drivers.slice(0, 3).map((d) =>
            `${kpiLabel(d.id)} z=${d.z.toFixed(1)} (${d.contribution > 0 ? '+' : ''}${d.contribution.toFixed(2)})`).join(' · ')}</td>
        </tr>`).join('')}`;
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
