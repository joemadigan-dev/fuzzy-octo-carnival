/* MELT-UP & DOOMSDAY TRACKER — client.
   Reads /api/cockpit (finished object, no arithmetic here), /api/alerts and
   /api/wall. Section 27: turn detail into a 15-second read, and put the
   evidence underneath rather than on top. No frameworks. */

(() => {
  'use strict';

  const POLL_MS = 120_000;
  const INK = '#e6e8ea', DIM = '#9aa1a8', GRID = '#272c31';
  const $ = (id) => document.getElementById(id);

  let ck = null, alerts = null, wall = null, horizon = 'week', ratesPlot = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n1 = (v) => (v === null || v === undefined ? '—' : v.toFixed(1));
  const pct = (v, dp = 1) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(dp)}%`);
  const cls = (v) => (v === null || v === undefined ? 'na' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');

  // ── boot ────────────────────────────────────────────────────────────
  async function load() {
    try {
      const res = await fetch('/api/cockpit', { cache: 'no-store' });
      if (!res.ok) {
        let body = null;
        try { body = await res.json(); } catch { /* not ours */ }
        return outage(body, res.status);
      }
      ck = await res.json();
      $('ck-outage').hidden = true;
      render();
    } catch (e) {
      outage(null, 0);
    }
    // secondary payloads never block the cockpit
    fetch('/api/alerts').then((r) => r.ok && r.json()).then((d) => { if (d) { alerts = d.alerts ?? []; renderAlerts(); } }).catch(() => {});
    fetch('/api/wall').then((r) => r.ok && r.json()).then((d) => { if (d) { wall = d; renderEvidence(); renderSources(); } }).catch(() => {});
  }

  /** An empty cockpit with no explanation is the failure mode this whole
   *  dashboard exists to avoid: "I cannot see" must never render as
   *  "nothing is happening". */
  function outage(body, status) {
    const el = $('ck-outage');
    el.hidden = false;
    const until = body?.retryAfter
      ? new Date(body.retryAfter).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : null;
    el.innerHTML = body?.error === 'database quota exhausted'
      ? `<b>THE TRACKER CANNOT READ ITS DATABASE.</b> The daily storage quota is spent, so nothing below is
         current — treat the whole page as stale, not as calm.${until ? ` Quota resets at <b>${until}</b>.` : ''}`
      : `<b>THE TRACKER CANNOT REACH ITS DATABASE</b>${status ? ` (HTTP ${status})` : ''}. Nothing below is current.
         ${esc(String(body?.detail ?? '').slice(0, 200))}`;
  }

  function render() {
    if (!ck) return;
    $('ck-asof').textContent = ck.asOf ? `market data as of ${ck.asOf} · computed ${String(ck.storedAt || ck.computedAt).slice(0, 16).replace('T', ' ')}Z` : '—';
    cardPhase(); cardScore('meltup', 'MELT-UP SCORE', ck.meltup);
    cardBust(); cardCredit(); cardLiquidity();
    renderHealth(); renderSetup(); renderChanged(); renderTargets(); renderMeltupDetail(); renderLadder();
    renderLiquidityDetail(); renderCommodities(); renderTimeline(); renderRatesChart();
  }

  // ── CARD 1: regime ──────────────────────────────────────────────────
  function cardPhase() {
    const p = ck.phase;
    const el = $('card-phase');
    el.classList.remove('ck-skel');
    // The phase card's stripe follows how far through the thesis we are,
    // not "good/bad" — a melt-up is not benign.
    const state = /BUST|DEFLATION/.test(p.phase) ? 'CRITICAL'
      : /WARNING/.test(p.phase) ? 'STRESS'
      : /PARABOLIC/.test(p.phase) ? 'ELEVATED'
      : /MELT-UP|QE|SUPERCYCLE/.test(p.phase) ? 'WATCH' : 'NORMAL';
    el.dataset.state = state;
    const changed = (ck.phaseChanges ?? [])[0];
    const recent = changed && (Date.now() - Date.parse(changed.date)) < 30 * 86400000;
    el.innerHTML = `
      <div class="ck-k">CURRENT MARKET REGIME</div>
      <div class="ck-v">${esc(p.phase)}</div>
      <span class="ck-state" data-state="${state}">${p.settled ? `${p.confidence} CONFIDENCE` : `UNSETTLED — ${p.heldDays}/${p.persistDays} SESSIONS`}</span>
      ${recent ? `<span class="ck-chip changed">CHANGED ${changed.date} — was ${esc(changed.from_phase ?? '—')}</span>` : ''}
      ${!p.settled && p.candidate !== p.phase ? `<span class="ck-chip">candidate: ${esc(p.candidate)}</span>` : ''}
      <div class="ck-why">${esc(p.explanation)}</div>
      <div class="ck-drivers">${(p.evidence ?? []).slice(0, 3).map((e) => `<div class="ck-driver">· ${esc(e)}</div>`).join('')}</div>
      <div class="ck-why" style="font-size:10.5px;color:var(--dimmer);margin-top:6px">
        A classification generated from the indicators below — not an objective fact about the world.</div>`;
  }

  // ── CARDS 2: generic 0-5 score with expandable breakdown ────────────
  function cardScore(id, title, s, extraHtml = '') {
    const el = $('card-' + id);
    el.classList.remove('ck-skel');
    el.dataset.state = s.level;
    const top = [...s.components].filter((c) => c.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3);
    el.innerHTML = `
      <div class="ck-k">${title}</div>
      <div class="ck-v">${n1(s.score)}<span class="ck-den"> / ${s.max}</span></div>
      <span class="ck-state" data-state="${s.level}">${s.level}</span>
      ${extraHtml}
      <div class="ck-drivers">
        ${top.length
          ? top.map((c) => `<div class="ck-driver"><b>+${c.delta}</b><span>${esc(shortReason(c.reason))}</span></div>`).join('')
          : '<div class="ck-driver">· nothing contributing</div>'}
      </div>
      <span class="ck-chip${s.evidenceAvailable < s.evidenceTotal ? ' partial' : ''}">EVIDENCE ${s.evidenceAvailable}/${s.evidenceTotal}${s.evidenceAvailable < s.evidenceTotal ? ' AVAILABLE' : ''}</span>
      <button class="ck-more" aria-expanded="false">SHOW WORKING ▾</button>
      <div class="ck-breakdown" hidden>
        ${s.components.map((c) => `
          <div class="ck-comp${c.unknown ? ' unknown' : ''}">
            <span class="d${c.delta ? '' : ' zero'}">${c.unknown ? 'n/a' : (c.delta > 0 ? '+' : '') + c.delta}</span>
            <span class="t">${c.unknown ? '<b>UNAVAILABLE</b> — ' : ''}${esc(c.reason)}</span>
          </div>`).join('')}
      </div>`;
    const btn = el.querySelector('.ck-more');
    btn.addEventListener('click', () => {
      const box = el.querySelector('.ck-breakdown');
      const open = box.hidden;
      box.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? 'HIDE WORKING ▴' : 'SHOW WORKING ▾';
    });
  }

  /** Card space is tight; the full sentence lives in the breakdown. */
  function shortReason(r) {
    return r.split(' — ')[0].replace(/^(S&P |Broad |Nearest )/, '').slice(0, 52);
  }

  // ── CARD 3: bust risk, vulnerability vs onset ───────────────────────
  function cardBust() {
    const b = ck.bust;
    const split = `
      <div class="ck-split">
        <div><div class="lab">VULNERABLE</div><div class="val">${n1(b.vulnerability)}<span style="color:var(--dimmer)">/3</span></div>
          <div class="ck-bar"><i style="width:${(b.vulnerability / 3) * 100}%"></i></div></div>
        <div><div class="lab">ONSET</div><div class="val">${n1(b.onset)}<span style="color:var(--dimmer)">/2</span></div>
          <div class="ck-bar onset"><i style="width:${(b.onset / 2) * 100}%"></i></div></div>
      </div>`;
    cardScore('bust', 'BUST RISK', b, split);
    const el = $('card-bust');
    el.querySelector('.ck-drivers').insertAdjacentHTML('beforeend',
      `<div class="ck-driver" style="margin-top:4px;color:var(--dim)">${esc(b.posture)}</div>`);
  }

  // ── CARD 4: credit canary ───────────────────────────────────────────
  function cardCredit() {
    const c = ck.credit;
    const extra = `<div class="ck-why" style="margin-top:4px"><b>${esc(c.stage)}</b></div>
      <span class="ck-chip${c.systemic ? ' changed' : ''}">${c.systemic ? 'SYSTEMIC — reached investment grade' : 'ISOLATED — has not reached investment grade'}</span>`;
    cardScore('credit', 'CREDIT CANARY', c, extra);
    $('ck-credit-verdict').textContent = `${n1(c.score)}/5 · ${c.stage} · ${c.systemic ? 'SYSTEMIC' : 'ISOLATED'}`;
  }

  // ── CARD 5: liquidity / rates ───────────────────────────────────────
  function cardLiquidity() {
    const l = ck.liquidity;
    const el = $('card-liquidity');
    el.classList.remove('ck-skel');
    el.dataset.state = l.level;
    const bn = (v) => (v === null || v === undefined ? '—'
      : Math.abs(v) >= 1000 ? `${v > 0 ? '+' : ''}$${(v / 1000).toFixed(2)}tn` : `${v > 0 ? '+' : ''}$${v.toFixed(0)}bn`);
    el.innerHTML = `
      <div class="ck-k">LIQUIDITY / RATES</div>
      <div class="ck-v" style="font-size:22px">${esc(l.regime)}</div>
      <span class="ck-state" data-state="${l.level}">${l.level}</span>
      <div class="ck-drivers" style="gap:1px">
        <div class="ck-kv"><span>10Y</span><b>${l.us10y === null ? '—' : l.us10y.toFixed(2) + '%'}</b></div>
        <div class="ck-kv"><span>2Y</span><b>${l.us2y === null ? '—' : l.us2y.toFixed(2) + '%'}</b></div>
        <div class="ck-kv"><span>Curve 10s2s</span><b>${l.curve === null ? '—' : (l.curve > 0 ? '+' : '') + l.curve.toFixed(0) + 'bp'}</b></div>
        <div class="ck-kv"><span>Fed B/S 13w</span><b>${bn(l.walcl13wBn)}</b></div>
        <div class="ck-kv"><span>USD trend</span><b>${l.usdTrend ? (l.usdTrend === 'UP' ? '↑' : l.usdTrend === 'DOWN' ? '↓' : '→') + ' ' + l.usdTrend : '—'}</b></div>
        <div class="ck-kv"><span>Credit</span><b>${esc(l.creditWord ?? '—')}</b></div>
      </div>
      <span class="ck-chip${l.rateLeg !== 'RATES STABLE' ? ' changed' : ''}">${esc(l.rateLeg)}</span>`;
  }

  // ── MARKET SETUP — one deterministic sentence ───────────────────────
  function renderSetup() {
    const st = ck.setup;
    if (!st) { $('ck-setup').hidden = true; return; }
    $('ck-setup').hidden = false;
    $('ck-setup').innerHTML = `${esc(st.sentence)}
      <button class="ck-more" aria-expanded="false" style="margin-left:8px">WHY ▾</button>
      <span class="ck-setup-why" hidden>${(st.clauses ?? []).map((c) =>
        `<span class="ck-setup-clause"><b>${esc(c.text)}</b> ← ${esc(c.because)}</span>`).join('')}</span>`;
    const b = $('ck-setup').querySelector('.ck-more');
    b.addEventListener('click', () => {
      const w = $('ck-setup').querySelector('.ck-setup-why');
      const open = w.hidden; w.hidden = !open;
      b.setAttribute('aria-expanded', String(open));
      b.textContent = open ? 'HIDE ▴' : 'WHY ▾';
    });
  }

  // ── SYSTEM HEALTH — small by design, never a sixth card ─────────────
  function renderHealth() {
    const h = ck.health;
    const chip = $('ck-health');
    if (!h) { chip.dataset.state = ''; $('ck-health-state').textContent = '—'; return; }
    chip.dataset.state = h.state;
    $('ck-health-state').textContent = h.state;
    chip.title = h.summary;
    const ago = (iso) => {
      if (!iso) return 'never';
      const hrs = (Date.now() - Date.parse(iso)) / 3600000;
      return `${String(iso).slice(0, 16).replace('T', ' ')}Z (${hrs < 1 ? '<1' : hrs.toFixed(0)}h ago)`;
    };
    $('ck-health-detail').innerHTML = `
      <div class="ck-hrow"><b>${h.state}</b> — ${esc(h.summary)}</div>
      <div class="ck-hgrid">
        <span>Last successful run</span><b>${ago(h.lastRun)}</b>
        <span>Last cockpit computation</span><b>${ago(h.lastCockpit)}</b>
        <span>Last barometer computation</span><b>${ago(h.lastBarometer)}</b>
        <span>KPIs fresh</span><b>${h.kpisOk}</b>
        <span>KPIs stale</span><b>${h.kpisStale}</b>
        <span>KPIs failed</span><b>${h.kpisFailed}</b>
        <span>Latest failed stage</span><b>${esc(h.lastFailedStage ?? 'none')}</b>
        <span>Last run completed</span><b>${h.runCompleted ? 'yes' : 'NO'}</b>
      </div>
      ${h.criticalStale?.length ? `<div class="ck-hrow crit">Critical data stale: ${h.criticalStale.map(esc).join(', ')}</div>` : ''}
      ${(h.notes ?? []).map((n) => `<div class="ck-hrow">${esc(n)}</div>`).join('')}`;
  }
  $('ck-health').addEventListener('click', () => {
    const d = $('ck-health-detail');
    const open = d.hidden; d.hidden = !open;
    $('ck-health').setAttribute('aria-expanded', String(open));
  });

  // ── 2. WHAT CHANGED ─────────────────────────────────────────────────
  function renderChanged() {
    const list = ck.whatChanged?.[horizon] ?? [];
    $('ck-changed').innerHTML = list.length
      ? list.map((c) => `
        <li>
          <div>
            <div class="ck-ch-h">${esc(c.headline)}</div>
            <div class="ck-ch-d">${esc(c.detail)}</div>
          </div>
          <span class="ck-ch-kind" data-k="${c.kind}">${String(c.kind).toUpperCase()}</span>
        </li>`).join('')
      : `<li style="padding-left:0"><div class="ck-empty">Nothing crossed a threshold or moved materially over this horizon.</div></li>`;
  }
  $('ck-horizon').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-h]');
    if (!b) return;
    horizon = b.dataset.h;
    for (const x of $('ck-horizon').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.h === horizon));
    renderChanged();
  });

  // ── 3. ALERTS ───────────────────────────────────────────────────────
  function renderAlerts() {
    const box = $('ck-alerts');
    // One row per condition, most recent first. Alerts logged before the
    // latch was added repeat the same condition on many dates; this panel
    // answers "what is true now", so it collapses them rather than showing
    // one condition six times. Nothing is deleted — the full log keeps
    // every row.
    const seen = new Set();
    const rows = (alerts ?? []).filter((a) => {
      const id = `${a.kind}:${a.key}`;
      if (seen.has(id)) return false;
      seen.add(id); return true;
    }).slice(0, 12);
    $('ck-alert-count').textContent = rows.length ? `${rows.length} most recent` : '';
    box.innerHTML = rows.length
      ? rows.map((a) => {
          const p = priority(a);
          return `<div class="ck-alert" data-p="${p}">
            <span class="pri">${p}</span>
            <span class="msg">${esc(a.message)}</span>
            <span class="when">${a.date}</span>
          </div>`;
        }).join('')
      : '<div class="ck-empty">No alerts recorded yet.</div>';
  }
  function renderAlertHistory() {
    const rows = (alerts ?? []).slice(0, 100);
    $('ck-hist-table').innerHTML = rows.length ? `
      <tr><th>DATE</th><th>KIND</th><th>CONDITION</th><th>DELIVERED</th></tr>
      ${rows.map((a) => `<tr>
        <td>${a.date}</td><td class="na">${esc(a.kind)}/${esc(a.key)}</td>
        <td style="text-align:left;white-space:normal">${esc(a.message)}</td>
        <td class="na">${(a.delivered ?? []).join('+') || 'logged'}</td></tr>`).join('')}`
      : '<tr><td>no alerts recorded</td></tr>';
  }
  $('ck-hist-toggle').addEventListener('click', () => {
    const d = $('ck-alert-history');
    const open = d.hidden; d.hidden = !open;
    $('ck-hist-toggle').setAttribute('aria-expanded', String(open));
    $('ck-hist-toggle').textContent = open ? 'HIDE ALERT HISTORY ▴' : 'SHOW ALERT HISTORY ▾';
    if (open) renderAlertHistory();
  });

  function priority(a) {
    if (a.kind === 'regime' || a.kind === 'divergence') return 'WARNING';
    if (a.kind === 'response_gap' || a.kind === 'state') return 'WATCH';
    if (a.kind === 'input95') return 'WATCH';
    return 'INFO';
  }

  // ── 4. TARGETS ──────────────────────────────────────────────────────
  function renderTargets() {
    const rows = ck.targets ?? [];
    $('ck-targets').innerHTML = `
      <tr><th>ASSET</th><th>CURRENT</th><th>TARGET</th><th>DISTANCE</th><th>1M</th><th>6M</th><th>DD FROM PEAK</th><th>AS OF</th><th>STATUS</th></tr>
      ${rows.map((t) => `
        <tr>
          <td>${esc(t.label)}</td>
          <td>${t.current === null ? '—' : t.current.toLocaleString('en-US', { maximumFractionDigits: t.current < 100 ? 2 : 0 })}</td>
          <td>${t.target.toLocaleString('en-US')}</td>
          <td class="${t.distancePct === null ? 'na' : t.distancePct < 0 ? 'pos' : ''}">${pct(t.distancePct)}</td>
          <td class="${cls(t.change1m)}">${pct(t.change1m)}</td>
          <td class="${cls(t.change6m)}">${pct(t.change6m)}</td>
          <td class="${cls(t.drawdownFromPeak)}">${pct(t.drawdownFromPeak)}</td>
          <td class="na">${t.asOf ?? '—'}</td>
          <td><span class="st" data-s="${t.status}">${t.status}</span></td>
        </tr>`).join('')}`;
  }

  // ── 5 / 6 / 8 / 9 detail panels ─────────────────────────────────────
  function renderMeltupDetail() {
    $('ck-meltup-detail').innerHTML = breakdownHtml(ck.meltup,
      'Every component of the Melt-Up Score, including the ones scoring zero. Acceleration is measured as the '
      + 'three-month pace annualised to a six-month rate against the six-month actual, so a high but decelerating '
      + 'return reads as a late melt-up rather than a building one.');
  }
  function renderLadder() {
    const l = ck.credit.ladder ?? [];
    $('ck-ladder').innerHTML = `
      <tr><th>TIER</th><th>LEVEL</th><th>20-SESSION CHANGE</th><th>DIRECTION</th></tr>
      ${l.map((r) => `
        <tr class="${r.widening ? 'widening' : ''}">
          <td>${esc(r.tier)}</td>
          <td>${r.level === null ? '—' : r.level.toFixed(2) + '%'}</td>
          <td>${r.roc20 === null ? '—' : (r.roc20 > 0 ? '+' : '') + r.roc20.toFixed(0) + 'bp'}</td>
          <td>${r.widening === null ? '—' : r.widening ? 'WIDENING' : 'narrowing'}</td>
        </tr>`).join('')}`;
  }
  function renderLiquidityDetail() {
    const l = ck.liquidity;
    $('ck-liquidity-detail').innerHTML = `
      <div class="ck-ev ${l.qe.active ? 'sup' : 'con'}">
        <span class="m">${l.qe.active ? '▲' : '·'}</span>
        <span><b>QE DETECTOR — ${esc(l.qe.magnitude)}</b><span class="dt">${esc(l.qe.detail)}</span></span>
      </div>
      ${(l.notes ?? []).map((n) => `<div class="ck-ev con"><span class="m">·</span><span>${esc(n)}</span></div>`).join('')}
      <p class="ck-note" style="margin-top:9px">Not every balance-sheet increase is QE. The detector only fires past the
        magnitudes in <code>config/thresholds.json</code>, and always shows the size it fired on.</p>`;
  }
  function renderCommodities() {
    const c = ck.commodities ?? [];
    const leading = c.filter((x) => x.leading).length;
    $('ck-commodities').innerHTML = `
      <tr><th>COMMODITY</th><th>6M RETURN</th><th>vs S&P 500</th><th>LEADING?</th></tr>
      ${c.map((x) => `
        <tr>
          <td>${esc(x.label)}</td>
          <td class="${cls(x.r6m)}">${pct(x.r6m)}</td>
          <td class="${cls(x.vsSpx)}">${pct(x.vsSpx)}</td>
          <td>${x.leading ? '<span class="st" data-s="IMMINENT">LEADING</span>' : '<span class="na">no</span>'}</td>
        </tr>`).join('')}
      <tr><td colspan="4" class="na" style="text-align:left">${leading} of ${c.length} leading the S&P by the configured margin.
        Supercycle confirmation also requires an expanding balance sheet.</td></tr>`;
  }

  function breakdownHtml(s, note) {
    return `<p class="ck-note">${esc(note)}</p>
      <div class="ck-breakdown" style="border:0;padding:0">
        ${s.components.map((c) => `
          <div class="ck-comp${c.unknown ? ' unknown' : ''}">
            <span class="d${c.delta ? '' : ' zero'}">${c.unknown ? '?' : (c.delta > 0 ? '+' : '') + c.delta}</span>
            <span class="t">${esc(c.reason)}</span>
          </div>`).join('')}
      </div>`;
  }

  // ── 10. EVIDENCE — supporting vs contradicting ──────────────────────
  function renderEvidence() {
    const d = wall?.disconfirmation;
    const sup = [];
    if (ck) {
      for (const c of [...ck.meltup.components, ...ck.bust.components, ...ck.credit.components]) {
        if (c.delta > 0 && !c.unknown) sup.push(c.reason);
      }
      if (ck.liquidity.qe.active) sup.push(ck.liquidity.qe.detail);
    }
    const con = (d?.tests ?? []).filter((t) => t.pass === true);
    const unknown = (d?.tests ?? []).filter((t) => t.pass === null);
    $('ck-evidence').innerHTML = `
      <div class="ck-col">
        <h3>SUPPORTING — ${sup.length} SIGNALS PRESENT</h3>
        ${sup.length ? sup.slice(0, 10).map((r) => `<div class="ck-ev sup"><span class="m">▲</span><span>${esc(r)}</span></div>`).join('')
          : '<div class="ck-empty">Nothing currently supporting.</div>'}
      </div>
      <div class="ck-col">
        <h3>CONTRADICTING — ${d ? `${d.passing} OF ${d.total} TESTS PASSING` : 'LOADING'}</h3>
        ${con.length ? con.map((t) => `<div class="ck-ev con"><span class="m">✓</span><span>${esc(t.label)}<span class="dt">${esc(t.detail)}</span></span></div>`).join('')
          : '<div class="ck-empty">No disconfirming test currently passing.</div>'}
        ${unknown.length ? `<div class="ck-ev"><span class="m">?</span><span style="color:var(--dimmer)">${unknown.length} test${unknown.length > 1 ? 's' : ''} unavailable — counted in neither column.</span></div>` : ''}
      </div>`;
  }

  // ── 11. TIMELINE ────────────────────────────────────────────────────
  function renderTimeline() {
    const ch = ck.phaseChanges ?? [];
    $('ck-timeline').innerHTML = ch.length
      ? `<div class="ck-tl">${ch.map((c) => `
          <div class="ck-tl-row">
            <span class="d">${c.date}</span>
            <span class="p">${esc(c.from_phase ?? '—')} → ${esc(c.to_phase)}</span>
            <span class="e">held ${c.held_days ?? '—'} sessions before adopting</span>
          </div>`).join('')}</div>`
      : '<div class="ck-empty">No phase change recorded yet. The timeline fills as the model adopts new phases.</div>';
  }

  // ── 12. SOURCES ─────────────────────────────────────────────────────
  function renderSources() {
    const k = (wall?.kpis ?? []).filter((x) =>
      ['spx', 'us10y', 'vix', 'hy_oas', 'ccc_oas', 'bb_oas', 'ig_oas', 'walcl', 'net_liq', 'dxy', 'gold', 'copper', 'wti', 'erp'].includes(x.id));
    $('ck-sources').innerHTML = `
      <tr><th>INDICATOR</th><th>LATEST</th><th>LAST OBSERVATION</th><th>FREQUENCY</th><th>STATUS</th></tr>
      ${k.map((x) => `
        <tr>
          <td>${esc(x.label)}</td>
          <td>${x.latest === null ? '—' : x.latest.toFixed(x.decimals)}</td>
          <td class="na">${x.latestDate ?? '—'}</td>
          <td class="na">${x.freq}</td>
          <td><span class="st" data-s="${x.status === 'ok' ? 'CLOSE' : 'NO DATA'}">${x.status === 'ok' ? 'FRESH' : x.status.toUpperCase()}</span></td>
        </tr>`).join('')}`;
  }

  // ── 7. rates / credit / equities ────────────────────────────────────
  async function renderRatesChart() {
    const host = $('ck-rates-chart');
    try {
      const [a, b, c] = await Promise.all(
        ['us10y', 'hy_oas', 'spx'].map((id) => fetch(`/api/series/${id}`).then((r) => (r.ok ? r.json() : null))));
      if (!a || !b || !c) { host.textContent = 'chart data unavailable'; return; }
      const map = (s) => new Map(s.data[0].map((t, i) => [t, s.data[1][i]]));
      const mb = map(b), mc = map(c);
      const t = a.data[0];
      const s10 = a.data[1];
      const shy = t.map((x) => mb.get(x) ?? null);
      const sspx = t.map((x) => mc.get(x) ?? null);
      if (ratesPlot) ratesPlot.destroy();
      ratesPlot = new uPlot({
        width: host.clientWidth || 900, height: 260,
        scales: { x: { time: true }, y: {}, spx: {} },
        axes: [
          { stroke: DIM, grid: { stroke: GRID }, ticks: { stroke: GRID }, font: '10px "Spline Sans Mono", monospace' },
          { stroke: DIM, grid: { stroke: GRID }, ticks: { stroke: GRID }, font: '10px "Spline Sans Mono", monospace',
            values: (u, sp) => sp.map((v) => v.toFixed(1) + '%') },
          { side: 1, scale: 'spx', stroke: DIM, grid: { show: false }, font: '10px "Spline Sans Mono", monospace' },
        ],
        series: [
          {},
          { label: '10Y', stroke: '#e8b33a', width: 1.5, points: { show: false } },
          { label: 'HY OAS', stroke: '#f0714f', width: 1.5, points: { show: false } },
          { label: 'S&P 500', stroke: INK, width: 1.2, scale: 'spx', points: { show: false } },
        ],
        legend: { show: true },
        cursor: { y: false },
      }, [t, s10, shy, sspx], host);
      $('ck-rates-legend').innerHTML =
        `<span><i style="border-color:#e8b33a"></i>10Y Treasury, left</span>
         <span><i style="border-color:#f0714f"></i>HY OAS, left</span>
         <span><i style="border-color:${INK}"></i>S&P 500, right</span>`;
    } catch {
      host.textContent = 'chart data unavailable';
    }
  }
  addEventListener('resize', () => { if (ratesPlot) renderRatesChart(); }, { passive: true });

  load();
  setInterval(load, POLL_MS);
})();
