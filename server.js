import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const INDEX_NAMES = {
  '^SPX': 'S&P 500',
  '^DJI': 'Dow Jones',
  '^NDX': 'Nasdaq 100',
  '^RUT': 'Russell 2000',
  '^VIX': 'CBOE Volatility',
  '^VXN': 'Nasdaq Volatility'
};

const FX_NAMES = {
  EURUSD: 'Euro / US Dollar',
  GBPUSD: 'British Pound / USD',
  USDJPY: 'USD / Japanese Yen',
  USDCAD: 'USD / Canadian Dollar',
  AUDUSD: 'Australian Dollar / USD',
  USDCHF: 'USD / Swiss Franc',
  NZDUSD: 'NZ Dollar / USD',
  USDCNH: 'USD / Chinese Yuan'
};

const CRYPTO_META = {
  bitcoin:        { ticker: 'BTC',  name: 'Bitcoin' },
  ethereum:       { ticker: 'ETH',  name: 'Ethereum' },
  solana:         { ticker: 'SOL',  name: 'Solana' },
  ripple:         { ticker: 'XRP',  name: 'XRP' },
  cardano:        { ticker: 'ADA',  name: 'Cardano' },
  dogecoin:       { ticker: 'DOGE', name: 'Dogecoin' },
  chainlink:      { ticker: 'LINK', name: 'Chainlink' },
  polkadot:       { ticker: 'DOT',  name: 'Polkadot' },
  'avalanche-2':  { ticker: 'AVAX', name: 'Avalanche' },
  litecoin:       { ticker: 'LTC',  name: 'Litecoin' }
};

const DEFAULT_SYMBOLS = [
  // Indices (6) — CBOE
  '^SPX', '^DJI', '^NDX', '^RUT', '^VIX', '^VXN',

  // Mega-cap & popular stocks (45) — Stooq
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'AVGO', 'ORCL', 'CRM',
  'ADBE', 'CSCO', 'AMD', 'INTC', 'NFLX', 'QCOM', 'IBM', 'PYPL', 'UBER', 'ABNB',
  'BRK-B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'AXP', 'BLK',
  'UNH', 'JNJ', 'LLY', 'ABBV', 'PFE',
  'WMT', 'COST', 'HD', 'MCD', 'KO', 'PEP', 'NKE',
  'XOM', 'CVX', 'CAT',

  // Broad/sector ETFs (15) — Stooq
  'SPY', 'QQQ', 'DIA', 'IWM', 'VOO', 'VTI', 'EFA', 'EEM', 'ARKK',
  'VEA', 'XLF', 'XLE', 'XLK', 'XLV', 'XLY',

  // Bonds (8) — Stooq
  'TLT', 'IEF', 'SHY', 'LQD', 'HYG', 'AGG', 'BND', 'TIP',

  // Commodities (8) — Stooq
  'GLD', 'SLV', 'USO', 'UNG', 'DBC', 'DBA', 'CORN', 'WEAT',

  // Currencies (8) — Stooq FX
  'fx:EURUSD', 'fx:GBPUSD', 'fx:USDJPY', 'fx:USDCAD',
  'fx:AUDUSD', 'fx:USDCHF', 'fx:NZDUSD', 'fx:USDCNH',

  // Crypto (10) — Coingecko
  'c:bitcoin', 'c:ethereum', 'c:solana', 'c:ripple', 'c:cardano',
  'c:dogecoin', 'c:chainlink', 'c:polkadot', 'c:avalanche-2', 'c:litecoin'
];

const SYMBOLS = (process.env.SYMBOLS
  ? process.env.SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_SYMBOLS);

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5000;
const FETCH_TIMEOUT_MS = 10000;

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

function classify(symbol) {
  if (symbol.startsWith('^')) {
    return {
      kind: 'cboe',
      code: '_' + symbol.slice(1),
      display: symbol,
      name: INDEX_NAMES[symbol] || symbol
    };
  }
  if (symbol.startsWith('fx:')) {
    const pair = symbol.slice(3).toUpperCase();
    const display = pair.length === 6 ? `${pair.slice(0, 3)}/${pair.slice(3)}` : pair;
    return {
      kind: 'stooq-fx',
      code: pair.toLowerCase(),
      display,
      name: FX_NAMES[pair] || pair
    };
  }
  if (symbol.startsWith('c:')) {
    const id = symbol.slice(2).toLowerCase();
    const meta = CRYPTO_META[id];
    return {
      kind: 'coingecko',
      code: id,
      display: meta ? meta.ticker : id.toUpperCase(),
      name: meta ? meta.name : id
    };
  }
  return {
    kind: 'stooq-stock',
    code: symbol.toLowerCase() + (symbol.includes('.') ? '' : '.us'),
    display: symbol,
    name: symbol
  };
}

function quoteFromValues({ display, name, open, high, low, close, prev, volume, asOf, source }) {
  const price = num(close);
  const previousClose = num(prev);
  const change = price != null && previousClose != null ? price - previousClose : null;
  const changePercent = change != null && previousClose ? (change / previousClose) * 100 : null;
  return {
    symbol: display,
    name: name || display,
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

async function fetchStooqBatch(entries) {
  if (entries.length === 0) return [];
  const codes = entries.map((e) => e.code).join('+');
  const url = `https://stooq.com/q/l/?s=${codes}&f=snd2t2ohlcpv&e=csv`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`stooq HTTP ${res.status}`);
  const text = await res.text();
  const rows = text.trim().split(/\r?\n/).filter(Boolean);
  const byCode = new Map();
  for (const line of rows) {
    const cols = parseCsvRow(line);
    if (cols.length < 10) continue;
    const [code, name, date, time, open, high, low, close, prev, volume] = cols;
    byCode.set((code || '').toLowerCase(), {
      name, date, time, open, high, low, close, prev, volume
    });
  }
  return entries.map((e) => {
    const row = byCode.get(e.code.toLowerCase());
    if (!row) {
      return { symbol: e.display, name: e.name, price: null, previousClose: null, change: null, changePercent: null, source: 'stooq', error: 'no data' };
    }
    return quoteFromValues({
      display: e.display,
      name: e.name || row.name,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      prev: row.prev,
      volume: row.volume,
      asOf: row.date && row.time ? `${row.date} ${row.time}` : null,
      source: 'stooq'
    });
  });
}

async function fetchCboeOne(entry) {
  try {
    const url = `https://cdn.cboe.com/api/global/delayed_quotes/quotes/${entry.code}.json`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`cboe HTTP ${res.status}`);
    const json = await res.json();
    const d = json && json.data;
    if (!d) throw new Error('cboe no data');
    const price = num(d.current_price);
    const previousClose = num(d.prev_day_close);
    const reportedChange = num(d.price_change);
    const reportedPct = num(d.price_change_percent);
    const change = reportedChange != null ? reportedChange
      : (price != null && previousClose != null ? price - previousClose : null);
    const changePercent = reportedPct != null ? reportedPct
      : (change != null && previousClose ? (change / previousClose) * 100 : null);
    return {
      symbol: entry.display,
      name: entry.name,
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
  } catch (err) {
    return { symbol: entry.display, name: entry.name, price: null, previousClose: null, change: null, changePercent: null, source: 'cboe', error: err.message };
  }
}

async function fetchCoingeckoBatch(entries) {
  if (entries.length === 0) return [];
  const ids = entries.map((e) => e.code).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
    const json = await res.json();
    return entries.map((e) => {
      const row = json[e.code];
      if (!row || row.usd == null) {
        return { symbol: e.display, name: e.name, price: null, previousClose: null, change: null, changePercent: null, source: 'coingecko', error: 'no data' };
      }
      const price = num(row.usd);
      const changePercent = num(row.usd_24h_change);
      const previousClose = (price != null && changePercent != null && (1 + changePercent / 100) !== 0)
        ? price / (1 + changePercent / 100)
        : null;
      const change = (price != null && previousClose != null) ? price - previousClose : null;
      return {
        symbol: e.display,
        name: e.name,
        price,
        previousClose,
        change,
        changePercent,
        open: null,
        dayHigh: null,
        dayLow: null,
        volume: null,
        asOf: new Date().toISOString(),
        source: 'coingecko'
      };
    });
  } catch (err) {
    return entries.map((e) => ({
      symbol: e.display, name: e.name, price: null, previousClose: null, change: null, changePercent: null, source: 'coingecko', error: err.message
    }));
  }
}

async function fetchAll() {
  const classified = SYMBOLS.map(classify);
  const cboe = classified.filter((c) => c.kind === 'cboe');
  const stooq = classified.filter((c) => c.kind === 'stooq-stock' || c.kind === 'stooq-fx');
  const crypto = classified.filter((c) => c.kind === 'coingecko');

  const [cboeResults, stooqResults, cryptoResults] = await Promise.all([
    Promise.all(cboe.map(fetchCboeOne)),
    fetchStooqBatch(stooq).catch((err) => {
      console.error('stooq batch failed:', err.message);
      return stooq.map((e) => ({ symbol: e.display, name: e.name, price: null, previousClose: null, change: null, changePercent: null, source: 'stooq', error: err.message }));
    }),
    fetchCoingeckoBatch(crypto)
  ]);

  const byDisplay = new Map();
  for (const q of cboeResults) byDisplay.set(q.symbol, q);
  for (const q of stooqResults) byDisplay.set(q.symbol, q);
  for (const q of cryptoResults) byDisplay.set(q.symbol, q);

  return classified.map((c) => byDisplay.get(c.display) || {
    symbol: c.display, name: c.name, price: null, previousClose: null, change: null, changePercent: null, error: 'unrouted'
  });
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
  res.json({ symbols: SYMBOLS, count: SYMBOLS.length });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Stock dashboard listening on http://localhost:${PORT}`);
  console.log(`Tracking ${SYMBOLS.length} symbols`);
});
