const REFRESH_MS = 5000;
const grid = document.getElementById('grid');
const lastUpdated = document.getElementById('last-updated');
const connection = document.getElementById('connection');
const marketStateEl = document.getElementById('market-state');
const symbolCountEl = document.getElementById('symbol-count');

const tiles = new Map();
const lastPrice = new Map();

function fmtPrice(v, currency) {
  if (v == null || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 10 ? 2 : 4;
  return v.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function fmtChange(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return sign + v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function classify(changePercent) {
  if (changePercent == null || Number.isNaN(changePercent)) return 'flat';
  if (changePercent > 0.0001) return 'up';
  if (changePercent < -0.0001) return 'down';
  return 'flat';
}

function buildTile(q) {
  const tile = document.createElement('div');
  tile.className = 'tile flat';
  tile.dataset.symbol = q.symbol;
  tile.innerHTML = `
    <div class="tile-head">
      <div class="symbol"></div>
      <div class="name"></div>
    </div>
    <div class="price">—</div>
    <div class="change-row">
      <div class="change"><span class="arrow"></span><span class="change-value">—</span></div>
      <div class="pct">—</div>
    </div>
    <div class="range">
      <span class="lo">L: —</span>
      <span class="hi">H: —</span>
    </div>
  `;
  return tile;
}

function updateTile(tile, q) {
  const cls = classify(q.changePercent);
  tile.classList.remove('up', 'down', 'flat');
  tile.classList.add(cls);

  tile.querySelector('.symbol').textContent = q.symbol;
  tile.querySelector('.name').textContent = q.name || '';
  tile.querySelector('.price').textContent = fmtPrice(q.price, q.currency);
  tile.querySelector('.change-value').textContent = fmtChange(q.change);
  tile.querySelector('.pct').textContent = fmtPct(q.changePercent);

  const arrow = tile.querySelector('.arrow');
  arrow.textContent = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '▬';

  if (q.dayLow != null) tile.querySelector('.lo').textContent = `L: ${fmtPrice(q.dayLow)}`;
  if (q.dayHigh != null) tile.querySelector('.hi').textContent = `H: ${fmtPrice(q.dayHigh)}`;

  const prev = lastPrice.get(q.symbol);
  if (prev != null && q.price != null && prev !== q.price) {
    tile.classList.remove('flash-up', 'flash-down');
    void tile.offsetWidth;
    tile.classList.add(q.price > prev ? 'flash-up' : 'flash-down');
  }
  if (q.price != null) lastPrice.set(q.symbol, q.price);
}

function setConnection(state, label) {
  connection.className = `connection ${state}`;
  connection.textContent = label;
}

function setMarketState(state) {
  if (!state) {
    marketStateEl.textContent = '--';
    marketStateEl.className = 'market-state';
    return;
  }
  const lower = state.toLowerCase();
  marketStateEl.textContent = state;
  marketStateEl.className = `market-state ${lower}`;
}

async function refresh() {
  try {
    const res = await fetch('/api/quotes', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const quotes = payload.quotes || [];

    quotes.forEach((q) => {
      let tile = tiles.get(q.symbol);
      if (!tile) {
        tile = buildTile(q);
        tiles.set(q.symbol, tile);
        grid.appendChild(tile);
      }
      updateTile(tile, q);
    });

    symbolCountEl.textContent = `${quotes.length} symbols`;
    if (quotes.length) setMarketState(quotes[0].marketState);

    const ts = new Date(payload.ts || Date.now());
    lastUpdated.textContent = `updated ${ts.toLocaleTimeString()}`;
    setConnection(payload.stale ? 'stale' : 'ok', payload.stale ? 'stale' : 'live');
  } catch (err) {
    console.error('refresh failed', err);
    setConnection('err', 'offline');
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
