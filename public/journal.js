/* THE JOE MADIGAN FINANCIAL CONDITIONS BAROMETER — decision journal.
   Token-gated, personal, never cached.
   The barometer shows the present tense; this remembers what you concluded from
   it, and later fills in what actually happened. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const KEY = 'wall.token';
  let token = sessionStorage.getItem(KEY) || '';
  let wall = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const api = (path, opts = {}) => fetch(path, {
    ...opts,
    cache: 'no-store',
    headers: { ...(opts.headers || {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });

  // ── gate ─────────────────────────────────────────────────────────────
  async function unlock(candidate) {
    token = candidate;
    const res = await fetch('/api/journal', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!res.ok) { token = ''; return false; }
    sessionStorage.setItem(KEY, token);
    $('jr-gate').hidden = true;
    $('jr-app').hidden = false;
    $('jr-status').textContent = 'unlocked';
    render(await res.json());
    loadWallState();
    return true;
  }

  $('jr-gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('jr-gate-error').textContent = '';
    const ok = await unlock($('jr-token').value.trim());
    if (!ok) $('jr-gate-error').textContent = 'rejected — wrong token, or ADMIN_TOKEN is not set on the worker';
  });

  // ── current wall state, shown above the form and snapshotted server-side
  async function loadWallState() {
    try {
      const res = await fetch('/api/wall', { cache: 'no-store' });
      wall = await res.json();
    } catch { return; }
    const p = wall.barometer?.pressure?.['2y'];
    const a = wall.barometer?.altitude?.['2y'];
    const dv = wall.barometer?.divergence?.['2y'];
    $('jr-snapshot').innerHTML = `SNAPSHOTTED WITH THIS ENTRY —
      PRESSURE <b>${p?.regime ?? '—'}</b> ${p?.score?.toFixed(2) ?? ''} ·
      ALTITUDE <b>${a?.regime ?? '—'}</b> ${a?.score?.toFixed(2) ?? ''} ·
      ${dv?.active ? `DIVERGENCE ${dv.days}d` : 'no divergence'} ·
      ${wall.kpis?.length ?? 0} inputs`;

    const sel = $('jr-instruments');
    sel.innerHTML = (wall.kpis ?? []).map((k) =>
      `<option value="${k.id}">${esc(k.label)}</option>`).join('');
  }

  // ── submit ───────────────────────────────────────────────────────────
  $('jr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('jr-form-error').textContent = '';
    $('jr-submit').disabled = true;
    try {
      const body = {
        entry: $('jr-entry').value,
        action: $('jr-action').value || null,
        stance: $('jr-stance').value || null,
        conviction: $('jr-conviction').value ? Number($('jr-conviction').value) : null,
        instruments: [...$('jr-instruments').selectedOptions].map((o) => o.value),
      };
      const res = await api('/api/journal', { method: 'POST', body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      $('jr-entry').value = '';
      $('jr-action').value = '';
      $('jr-stance').value = '';
      $('jr-conviction').value = '';
      for (const o of $('jr-instruments').options) o.selected = false;
      const list = await (await api('/api/journal')).json();
      render(list);
    } catch (err) {
      $('jr-form-error').textContent = `not recorded — ${err.message}`;
    } finally {
      $('jr-submit').disabled = false;
    }
  });

  // ── review ───────────────────────────────────────────────────────────
  function pct(v) {
    return v === null || v === undefined
      ? '<span class="pending">pending</span>'
      : `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
  }

  function render(data) {
    const cal = data.calibration ?? [];
    $('jr-calibration').innerHTML = cal.length
      ? `<tr><th>CONVICTION</th><th>ENTRIES</th><th>3M HIT RATE</th><th></th></tr>` +
        cal.map((c) => `<tr>
          <td>${c.conviction}</td><td>${c.n}</td><td>${c.hitRate.toFixed(1)}%</td>
          <td><span class="cal-bar" style="width:${Math.round(c.hitRate * 1.2)}px"></span></td>
        </tr>`).join('')
      : '<tr><td>no settled entries yet — calibration needs a stance, a conviction, and three elapsed months</td></tr>';

    const entries = data.entries ?? [];
    $('jr-entries').innerHTML = entries.length
      ? entries.map((e) => {
          const s = e.snapshot ?? {};
          const r = e.realized ?? {};
          const p = s.pressure?.['2y'], a = s.altitude?.['2y'];
          const hit = r.hit3m === true ? '<span class="hit up">STANCE CORRECT @3M</span>'
            : r.hit3m === false ? '<span class="hit down">STANCE WRONG @3M</span>' : '';
          const instr = (e.instruments ?? []).map((id) => {
            const f = r.instruments?.[id] ?? {};
            return `<div class="jr-instr">${esc(id)}: 1M ${pct(f.m1)} · 3M ${pct(f.m3)} · 6M ${pct(f.m6)}</div>`;
          }).join('');
          return `<article class="jr-entry">
            <div class="jr-entry-head">
              <span class="jr-date">${String(e.createdAt).slice(0, 16).replace('T', ' ')}Z</span>
              ${e.stance ? `<span class="jr-tag">${esc(e.stance)}</span>` : ''}
              ${e.conviction ? `<span class="jr-tag">conviction ${e.conviction}/5</span>` : ''}
              ${hit}
            </div>
            <div class="jr-state">at write time — PRESSURE ${p?.regime ?? '—'} ${p?.score?.toFixed(2) ?? ''}
              · ALTITUDE ${a?.regime ?? '—'} ${a?.score?.toFixed(2) ?? ''}
              ${s.divergence?.['2y']?.active ? `· DIVERGENCE ${s.divergence['2y'].days}d` : ''}</div>
            <div class="jr-text">${esc(e.entry)}</div>
            ${e.action ? `<div class="jr-action">ACTION: ${esc(e.action)}</div>` : ''}
            <div class="jr-realized">S&amp;P since: 1M ${pct(r.spx?.m1)} · 3M ${pct(r.spx?.m3)} · 6M ${pct(r.spx?.m6)}</div>
            ${instr}
          </article>`;
        }).join('')
      : '<p class="sig-note">no entries yet.</p>';
  }

  setInterval(() => { $('clock').textContent = new Date().toISOString().slice(11, 19) + 'Z'; }, 1000);

  if (token) unlock(token).then((ok) => { if (!ok) sessionStorage.removeItem(KEY); });
})();
