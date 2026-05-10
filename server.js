import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_SYMBOLS = [
  '^SPX', '^DJI', '^NDX', '^RUT', '^VIX',
  'SPY', 'QQQ', 'DIA', 'IWM',
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',
  'JPM', 'XOM', 'GLD', 'TLT'
];

const SYMBOLS = (process.env.SYMBOLS
  ? process.env.SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_SYMBOLS);

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5000;
const FETCH_TIMEOUT_MS = 8000;

let cache = { ts: 0, data: null };

function fetchWithTimeout(url, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'stock-dashboard/1.0' } })
    .finally(() => clearTimeout(timer));
}

function parseCsvRow(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function num(v) {
  if (v == null || v === '' || v === 'N/D') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stooqCode(symbol) {
  return symbol.includes('.') ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
}

function buildQuote({ symbol, name, open, high, low, close, prev, volume, asOf, source }) {
  const price = num(close);
  const previousClose = num(prev);
  const change = price != null && previousClose != null ? price - previousClose : null;
  const changePercent = change != null && previousClose ? (change / previousClose) * 100 : null;
  return {
    symbol,
    name: name || symbol,
    price,
    previousClose,
    change,
    changePercent,
    open: num(open),
    dayHigh: num(high),
    dayLow: num(low),
    volume: num(volume),
    asOf,
    source
  };
}

async function fetchStooqBatch(symbols) {
  if (symbols.length === 0) return new Map();
  const codes = symbols.map(stooqCode).join('+');
  const url = `https://stooq.com/q/l/?s=${codes}&f=snd2t2ohlcpv&e=csv`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`stooq HTTP ${res.status}`);
  const text = await res.text();
  const rows = text.trim().split(/\r?\n/).filter(Boolean);
  const map = new Map();
  for (const line of rows) {
    const cols = parseCsvRow(line);
    if (cols.length < 10) continue;
    const [code, name, date, time, open, high, low, close, prev, volume] = cols;
    const display = symbols.find((s) => stooqCode(s).toUpperCase() === (code || '').toUpperCase()) || code;
    map.set(display, buildQuote({
      symbol: display,
      name,
      open, high, low, close, prev, volume,
      asOf: date && time ? `${date} ${time}` : null,
      source: 'stooq'
    }));
  }
  return map;
}

async function fetchCboe(symbol) {
  const code = '_' + symbol.replace(/^\^/, '');
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/quotes/${code}.json`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`cboe ${symbol} HTTP ${res.status}`);
  const json = await res.json();
  const d = json && json.data;
  if (!d) throw new Error(`cboe ${symbol} no data`);
  const price = num(d.current_price);
  const previousClose = num(d.prev_day_close);
  const reportedChange = num(d.price_change);
  const reportedPct = num(d.price_change_percent);
  const change = reportedChange != null ? reportedChange : (price != null && previousClose != null ? price - previousClose : null);
  const changePercent = reportedPct != null ? reportedPct
    : (change != null && previousClose ? (change / previousClose) * 100 : null);
  return {
    symbol,
    name: d.symbol || symbol,
    price,
    previousClose,
    change,
    changePercent,
    open: num(d.open),
    dayHigh: num(d.high),
    dayLow: num(d.low),
    volume: num(d.volume),
    asOf: json.timestamp || null,
    source: 'cboe'
  };
}

async function fetchAll() {
  const cboeSyms = SYMBOLS.filter((s) => s.startsWith('^'));
  const stooqSyms = SYMBOLS.filter((s) => !s.startsWith('^'));

  const [cboeResults, stooqMap] = await Promise.all([
    Promise.all(cboeSyms.map((s) => fetchCboe(s).catch((err) => ({
      symbol: s, name: s, price: null, previousClose: null, change: null, changePercent: null, error: err.message
    })))),
    fetchStooqBatch(stooqSyms).catch((err) => {
      console.error('stooq batch failed:', err.message);
      return new Map();
    })
  ]);

  const byKey = new Map();
  for (const q of cboeResults) byKey.set(q.symbol, q);
  for (const s of stooqSyms) {
    const q = stooqMap.get(s) || {
      symbol: s, name: s, price: null, previousClose: null, change: null, changePercent: null, error: 'no data'
    };
    byKey.set(s, q);
  }
  return SYMBOLS.map((s) => byKey.get(s));
}

app.get('/api/quotes', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.data && now - cache.ts < CACHE_TTL_MS) {
      return res.json({ ts: cache.ts, cached: true, quotes: cache.data });
    }
    const quotes = await fetchAll();
    cache = { ts: now, data: quotes };
    res.json({ ts: now, cached: false, quotes });
  } catch (err) {
    console.error('quote fetch failed:', err.message);
    if (cache.data) {
      return res.json({ ts: cache.ts, cached: true, stale: true, quotes: cache.data });
    }
    res.status(502).json({ error: 'Failed to fetch quotes', detail: err.message });
  }
});

app.get('/api/symbols', (req, res) => {
  res.json({ symbols: SYMBOLS });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Stock dashboard listening on http://localhost:${PORT}`);
  console.log(`Tracking ${SYMBOLS.length} symbols: ${SYMBOLS.join(', ')}`);
});
