"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;
const VERSION = "8.0.0";

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ============================================================
// ENV
// ============================================================

const BACKEND_URL =
  process.env.BACKEND_URL ||
  "https://era-ai.onrender.com";

const UPSTOX_ACCESS_TOKEN =
  process.env.UPSTOX_ACCESS_TOKEN || "";

const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY || "";

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  "openai/gpt-4o-mini";

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || "";

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || "";

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT ||
  "mailto:admin@era-ai.app";

if (
  VAPID_PUBLIC_KEY &&
  VAPID_PRIVATE_KEY
) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

// ============================================================
// INDEX CONFIGURATION
// ============================================================

const INDICES = {
  NIFTY: {
    symbol: "NSE_INDEX|Nifty 50",
    name: "NIFTY 50",
    exchange: "NSE",
    lotSize: 65
  },

  BANKNIFTY: {
    symbol: "NSE_INDEX|Nifty Bank",
    name: "BANK NIFTY",
    exchange: "NSE",
    lotSize: 30
  },

  FINNIFTY: {
    symbol: "NSE_INDEX|Nifty Fin Service",
    name: "FIN NIFTY",
    exchange: "NSE",
    lotSize: 60
  },

  SENSEX: {
    symbol: "BSE_INDEX|SENSEX",
    name: "SENSEX",
    exchange: "BSE",
    lotSize: 20
  }
};

const EXTRA_SYMBOLS = {
  GIFT_NIFTY: "GLOBAL_INDEX|SGX NIFTY",
  INDIA_VIX: "NSE_INDEX|India VIX"
};

// ============================================================
// STATE
// ============================================================

const state = {
  engineRunning: true,

  lastSuccess: null,
  lastError: null,
  lastScan: null,
  lastNewsFetch: null,

  market: {
    NIFTY: null,
    BANKNIFTY: null,
    FINNIFTY: null,
    SENSEX: null,
    GIFT_NIFTY: null,
    INDIA_VIX: null
  },

  analysis: {},

  activeTrades: [],

  alerts: [],

  news: [],

  history: [],

  pushSubscriptions: [],

  previousPrices: {},

  previousSignals: {},

  notificationHistory: {},

  settings: {
    movementThreshold: 20,
    minConfidence: 60,
    scanIntervalMs: 60000,
    newsIntervalMs: 300000,
    notificationCooldownMs: 15 * 60 * 1000,
    notifications: {
      marketOpen: true,
      movement: true,
      tradeSetup: true,
      news: true,
      marketClose: true
    }
  }
};

// ============================================================
// FILE STORAGE
// ============================================================

const DATA_DIR =
  path.join(__dirname, "data");

const STATE_FILE =
  path.join(DATA_DIR, "era-state.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return;
    }

    const saved =
      JSON.parse(
        fs.readFileSync(
          STATE_FILE,
          "utf8"
        )
      );

    if (
      Array.isArray(
        saved.pushSubscriptions
      )
    ) {
      state.pushSubscriptions =
        saved.pushSubscriptions;
    }

    if (
      Array.isArray(saved.history)
    ) {
      state.history =
        saved.history;
    }

    if (
      Array.isArray(saved.alerts)
    ) {
      state.alerts =
        saved.alerts;
    }

    if (saved.settings && typeof saved.settings === "object") {
      state.settings = {
        ...state.settings,
        ...saved.settings,
        notifications: {
          ...state.settings.notifications,
          ...(saved.settings.notifications || {})
        }
      };
    }

    if (saved.notificationHistory && typeof saved.notificationHistory === "object") {
      state.notificationHistory = saved.notificationHistory;
    }

  } catch (error) {
    console.error(
      "[ERA] State load error:",
      error.message
    );
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          pushSubscriptions:
            state.pushSubscriptions,

          history:
            state.history,

          alerts:
            state.alerts,

          settings:
            state.settings,

          notificationHistory:
            state.notificationHistory
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      "[ERA] State save error:",
      error.message
    );
  }
}

loadState();

// ============================================================
// HELPERS
// ============================================================

function round(
  value,
  decimals = 2
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return 0;
  }

  const factor =
    Math.pow(
      10,
      decimals
    );

  return (
    Math.round(
      number * factor
    ) / factor
  );
}

function safeNumber(
  value,
  fallback = 0
) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function clamp(
  value,
  min,
  max
) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function nowISO() {
  return new Date().toISOString();
}

function normalizeIndex(index) {
  return String(index || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

// ============================================================
// MARKET HOURS
// ============================================================

function getIndiaTimeParts() {
  const formatter =
    new Intl.DateTimeFormat(
      "en-IN",
      {
        timeZone: "Asia/Kolkata",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }
    );

  const parts =
    formatter.formatToParts(
      new Date()
    );

  const map = {};

  for (const part of parts) {
    map[part.type] =
      part.value;
  }

  return {
    weekday: map.weekday,
    hour:
      Number(map.hour),
    minute:
      Number(map.minute)
  };
}

function isMarketHours() {
  const {
    weekday,
    hour,
    minute
  } = getIndiaTimeParts();

  const weekdays = [
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri"
  ];

  if (
    !weekdays.includes(
      weekday
    )
  ) {
    return false;
  }

  const totalMinutes =
    hour * 60 + minute;

  return (
    totalMinutes >= 555 &&
    totalMinutes <= 930
  );
}

// ============================================================
// UPSTOX REQUEST
// ============================================================

async function upstoxRequest(
  url,
  params = {},
  timeout = 20000
) {
  if (
    !UPSTOX_ACCESS_TOKEN
  ) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is not configured"
    );
  }

  const response =
    await axios.get(
      url,
      {
        params,
        timeout,
        headers: {
          Accept:
            "application/json",

          Authorization:
            `Bearer ${UPSTOX_ACCESS_TOKEN}`
        }
      }
    );

  return response.data;
}

// ============================================================
// MARKET QUOTE V3
// ============================================================

async function fetchFullMarketQuotes() {
  const instrumentKeys =
    Object.values(INDICES)
      .map(
        item => item.symbol
      )
      .join(",");

  const response =
    await upstoxRequest(
      "https://api.upstox.com/v3/market-quote/quotes",
      {
        instrument_key:
          instrumentKeys
      }
    );

  return response.data || {};
}

// ============================================================
// FIND QUOTE
// ============================================================

function findQuoteForIndex(
  rawData,
  index
) {
  const config =
    INDICES[index];

  if (
    !config ||
    !rawData
  ) {
    return null;
  }

  const keys = [
    config.symbol,

    config.symbol
      .replace("|", ":"),

    index,

    config.name
  ];

  for (const key of keys) {
    if (
      key &&
      rawData[key]
    ) {
      return rawData[key];
    }
  }

  const target =
    config.symbol
      .toUpperCase();

  const found =
    Object.entries(
      rawData
    ).find(
      ([key]) => {
        const upper =
          String(key)
            .toUpperCase();

        return (
          upper === target ||
          upper.includes(index)
        );
      }
    );

  return found
    ? found[1]
    : null;
}

// ============================================================
// NORMALIZE FULL QUOTE
// ============================================================

function normalizeFullQuote(
  index,
  raw
) {
  if (!raw) {
    return {
      index,
      name:
        INDICES[index]?.name ||
        index,
      instrumentKey:
        INDICES[index]?.symbol ||
        null,
      available: false,
      error:
        "No quote data",
      source:
        "upstox-v3"
    };
  }

  const ltpc =
    raw.ltpc || {};

  const ohlc =
    raw.ohlc || {};

  const ltp =
    safeNumber(
      raw.last_price ??
      raw.lastPrice ??
      ltpc.ltp ??
      raw.ltp ??
      ohlc.close ??
      0
    );

  let previousClose =
    raw.prev_close_price ??
    raw.previous_close ??
    raw.previousClose ??
    ltpc.cp ??
    null;

  let change =
    raw.net_change ??
    raw.netChange ??
    raw.change ??
    null;

  const open =
    raw.open ??
    raw.open_price ??
    ohlc.open ??
    null;

  const high =
    raw.high ??
    raw.high_price ??
    ohlc.high ??
    null;

  const low =
    raw.low ??
    raw.low_price ??
    ohlc.low ??
    null;

  let close =
    raw.close ??
    raw.close_price ??
    ohlc.close ??
    ltp;

  /*
   * Most reliable case:
   * previous close exists.
   */
  if (
    Number.isFinite(
      Number(previousClose)
    ) &&
    Number(previousClose) > 0
  ) {
    previousClose =
      Number(previousClose);

    change =
      ltp -
      previousClose;
  }

  /*
   * Fallback:
   * derive previous close from net change.
   */
  if (
    (!previousClose ||
      Number(previousClose) <= 0) &&
    Number.isFinite(
      Number(change)
    ) &&
    Number(change) !== 0
  ) {
    const calculated =
      ltp -
      Number(change);

    if (
      calculated > 0
    ) {
      previousClose =
        calculated;
    }
  }

  if (
    !Number.isFinite(
      Number(previousClose)
    ) ||
    Number(previousClose) <= 0
  ) {
    previousClose = 0;
  }

  if (
    !Number.isFinite(
      Number(change)
    )
  ) {
    change =
      previousClose > 0
        ? ltp - previousClose
        : 0;
  }

  const changePercent =
    previousClose > 0
      ? (
          change /
          previousClose
        ) * 100
      : 0;

  /*
   * V3 quote timestamp.
   */
  const timestamp =
    raw.timestamp ??
    raw.last_trade_time ??
    ltpc.ltt ??
    nowISO();

  return {
    index,

    name:
      INDICES[index]?.name ||
      index,

    instrumentKey:
      INDICES[index]?.symbol ||
      null,

    available:
      true,

    price:
      round(ltp),

    previousClose:
      round(previousClose),

    change:
      round(change),

    changePercent:
      round(
        changePercent,
        3
      ),

    open:
      open !== null
        ? round(open)
        : null,

    high:
      high !== null
        ? round(high)
        : null,

    low:
      low !== null
        ? round(low)
        : null,

    close:
      close !== null
        ? round(close)
        : round(ltp),

    sessionClose:
      close !== null
        ? round(close)
        : round(ltp),

    volume:
      safeNumber(
        raw.volume ??
        ohlc.volume ??
        0
      ),

    averagePrice:
      safeNumber(
        raw.average_price ??
        raw.averagePrice ??
        0
      ),

    oi:
      safeNumber(
        raw.oi ??
        0
      ),

    lowerCircuit:
      safeNumber(
        raw.lower_circuit_limit ??
        0
      ),

    upperCircuit:
      safeNumber(
        raw.upper_circuit_limit ??
        0
      ),

    timestamp,

    lastTradeTime:
      raw.last_trade_time ??
      ltpc.ltt ??
      null,

    stale: false,

    source:
      "upstox-v3"
  };
}

// ============================================================
// FETCH MAIN MARKET
// ============================================================

async function fetchQuotes() {
  const rawData =
    await fetchFullMarketQuotes();

  const result = {};

  for (
    const index of Object.keys(
      INDICES
    )
  ) {
    const raw =
      findQuoteForIndex(
        rawData,
        index
      );

    result[index] =
      normalizeFullQuote(
        index,
        raw
      );
  }

  return result;
}

// ============================================================
// EXTRA MARKET
// ============================================================

async function fetchExtraMarketData() {
  const result = {
    GIFT_NIFTY: {
      available: false
    },

    INDIA_VIX: {
      available: false
    }
  };

  try {
    const keys =
      Object.values(
        EXTRA_SYMBOLS
      ).join(",");

    const data =
      (
        await upstoxRequest(
          "https://api.upstox.com/v3/market-quote/quotes",
          {
            instrument_key:
              keys
          }
        )
      ).data || {};

    for (
      const [name, symbol]
      of Object.entries(
        EXTRA_SYMBOLS
      )
    ) {
      let raw =
        data[symbol] ||
        data[
          symbol.replace(
            "|",
            ":"
          )
        ] ||
        data[name];

      if (!raw) {
        const found =
          Object.entries(
            data
          ).find(
            ([key]) =>
              String(key)
                .toUpperCase()
                .includes(
                  name
                )
          );

        if (found) {
          raw =
            found[1];
        }
      }

      if (!raw) {
        continue;
      }

      const ltpc =
        raw.ltpc || {};

      const price =
        safeNumber(
          raw.last_price ??
          ltpc.ltp ??
          raw.ltp ??
          raw.close ??
          0
        );

      let previousClose =
        safeNumber(
          raw.prev_close_price ??
          raw.previous_close ??
          ltpc.cp ??
          0
        );

      let change =
        safeNumber(
          raw.net_change ??
          raw.change ??
          0
        );

      if (
        previousClose > 0
      ) {
        change =
          price -
          previousClose;
      } else if (
        change !== 0
      ) {
        previousClose =
          price - change;
      }

      const changePercent =
        previousClose > 0
          ? (
              change /
              previousClose
            ) * 100
          : 0;

      result[name] = {
        available: true,

        price:
          round(price),

        previousClose:
          round(
            previousClose
          ),

        change:
          round(change),

        changePercent:
          round(
            changePercent,
            3
          ),

        timestamp:
          raw.timestamp ??
          raw.last_trade_time ??
          ltpc.ltt ??
          nowISO(),

        source:
          "upstox-v3"
      };
    }

  } catch (error) {
    console.error(
      "[ERA] Extra market error:",
      error.response?.data ||
      error.message
    );
  }

  return result;
}

// ============================================================
// REFRESH MARKET
// ============================================================

async function refreshMarketData() {
  const quotes =
    await fetchQuotes();

  state.market = {
    ...state.market,
    ...quotes
  };

  const extra =
    await fetchExtraMarketData();

  state.market.GIFT_NIFTY =
    extra.GIFT_NIFTY;

  state.market.INDIA_VIX =
    extra.INDIA_VIX;

  state.lastSuccess =
    nowISO();

  state.lastError =
    null;

  return state.market;
}

// ============================================================
// INTRADAY CANDLES V3
// ============================================================

async function fetchIntradayCandles(
  index,
  interval = 5
) {
  const config =
    INDICES[index];

  if (!config) {
    return [];
  }

  try {
    const response =
      await upstoxRequest(
        `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(
          config.symbol
        )}/minutes/${interval}`
      );

    let candles =
      response.data?.candles ||
      [];

    candles =
      candles.filter(
        candle =>
          Array.isArray(candle) &&
          candle.length >= 6 &&
          Number.isFinite(
            Number(candle[4])
          )
      );

    candles.sort(
      (a, b) =>
        new Date(a[0]).getTime() -
        new Date(b[0]).getTime()
    );

    console.log(
      `[ERA] ${index} intraday candles: ${candles.length}`
    );

    return candles;

  } catch (error) {
    console.error(
      `[ERA] Intraday candle error ${index}:`,
      error.response?.data ||
      error.message
    );

    return [];
  }
}

// ============================================================
// HISTORICAL CANDLES
// Used for technical fallback when intraday is unavailable.
// ============================================================

async function fetchHistoricalCandles(
  index,
  interval = 5
) {
  const config =
    INDICES[index];

  if (!config) {
    return [];
  }

  try {
    const endDate =
      new Date();

    const startDate =
      new Date(
        endDate.getTime() -
        7 *
          24 *
          60 *
          60 *
          1000
      );

    const to =
      endDate
        .toISOString()
        .slice(0, 10);

    const from =
      startDate
        .toISOString()
        .slice(0, 10);

    const response =
      await upstoxRequest(
        `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(
          config.symbol
        )}/minutes/${interval}/${to}/${from}`
      );

    let candles =
      response.data?.candles ||
      [];

    candles =
      candles.filter(
        candle =>
          Array.isArray(candle) &&
          candle.length >= 6
      );

    candles.sort(
      (a, b) =>
        new Date(a[0]).getTime() -
        new Date(b[0]).getTime()
    );

    return candles;

  } catch (error) {
    console.error(
      `[ERA] Historical candle error ${index}:`,
      error.response?.data ||
      error.message
    );

    return [];
  }
}

// ============================================================
// CANDLE SYNC WITH LIVE PRICE
// ============================================================

function syncLatestCandle(
  candles,
  livePrice
) {
  if (
    !Array.isArray(candles) ||
    candles.length === 0 ||
    !Number.isFinite(
      Number(livePrice)
    )
  ) {
    return candles || [];
  }

  const result =
    candles.map(
      candle => [...candle]
    );

  const last =
    result[
      result.length - 1
    ];

  if (
    !last ||
    last.length < 5
  ) {
    return result;
  }

  const price =
    Number(livePrice);

  last[4] =
    price;

  if (
    Number(last[2]) < price
  ) {
    last[2] =
      price;
  }

  if (
    Number(last[3]) > price
  ) {
    last[3] =
      price;
  }

  return result;
}

// ============================================================
// EMA
// ============================================================

function ema(
  values,
  period
) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const first =
    values
      .slice(0, period)
      .reduce(
        (a, b) =>
          a + Number(b),
        0
      ) / period;

  const multiplier =
    2 / (period + 1);

  let result =
    first;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      (
        Number(values[i]) -
        result
      ) *
        multiplier +
      result;
  }

  return result;
}

// ============================================================
// RSI
// ============================================================

function rsi(
  values,
  period = 14
) {
  if (
    !Array.isArray(values) ||
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const previous =
      Number(values[i - 1]);

    const current =
      Number(values[i]);

    const diff =
      current - previous;

    if (diff > 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  const avgGain =
    gains / period;

  const avgLoss =
    losses / period;

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

// ============================================================
// VWAP
// ============================================================

function calculateVWAP(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length === 0
  ) {
    return null;
  }

  let totalPV = 0;
  let totalVolume = 0;

  /*
   * Calculate latest trading session only.
   */
  const last =
    candles[
      candles.length - 1
    ];

  const lastDate =
    new Date(
      last[0]
    ).toLocaleDateString(
      "en-IN",
      {
        timeZone:
          "Asia/Kolkata"
      }
    );

  for (
    const candle of candles
  ) {
    const date =
      new Date(
        candle[0]
      ).toLocaleDateString(
        "en-IN",
        {
          timeZone:
            "Asia/Kolkata"
        }
      );

    if (
      date !== lastDate
    ) {
      continue;
    }

    const high =
      Number(candle[2]);

    const low =
      Number(candle[3]);

    const close =
      Number(candle[4]);

    const volume =
      Number(candle[5]);

    if (
      !Number.isFinite(
        high
      ) ||
      !Number.isFinite(
        low
      ) ||
      !Number.isFinite(
        close
      ) ||
      !Number.isFinite(
        volume
      ) ||
      volume <= 0
    ) {
      continue;
    }

    const typical =
      (
        high +
        low +
        close
      ) / 3;

    totalPV +=
      typical * volume;

    totalVolume +=
      volume;
  }

  if (
    totalVolume <= 0
  ) {
    return null;
  }

  return (
    totalPV /
    totalVolume
  );
}

// ============================================================
// MARKET STRUCTURE
// ============================================================

function detectStructure(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 10
  ) {
    return {
      label: "RANGE",
      bos: false,
      choch: false,
      details: null
    };
  }

  const recent =
    candles.slice(-10);

  const previous =
    candles.slice(-20, -10);

  const recentHigh =
    Math.max(
      ...recent.map(
        c => Number(c[2])
      )
    );

  const recentLow =
    Math.min(
      ...recent.map(
        c => Number(c[3])
      )
    );

  const previousHigh =
    previous.length
      ? Math.max(
          ...previous.map(
            c => Number(c[2])
          )
        )
      : recentHigh;

  const previousLow =
    previous.length
      ? Math.min(
          ...previous.map(
            c => Number(c[3])
          )
        )
      : recentLow;

  let label =
    "RANGE";

  if (
    recentHigh >
      previousHigh &&
    recentLow >
      previousLow
  ) {
    label =
      "HH_HL";
  } else if (
    recentHigh <
      previousHigh &&
    recentLow <
      previousLow
  ) {
    label =
      "LH_LL";
  }

  const lastClose =
    Number(
      candles[
        candles.length - 1
      ][4]
    );

  const bosUp =
    lastClose >
    previousHigh;

  const bosDown =
    lastClose <
    previousLow;

  return {
    label,

    bos:
      bosUp ||
      bosDown,

    choch:
      (
        label === "HH_HL" &&
        bosDown
      ) ||
      (
        label === "LH_LL" &&
        bosUp
      ),

    details: {
      recentHigh:
        round(recentHigh),

      recentLow:
        round(recentLow),

      previousHigh:
        round(previousHigh),

      previousLow:
        round(previousLow)
    }
  };
}

// ============================================================
// TECHNICAL ANALYSIS
// ============================================================

function technicalAnalysis(
  candles,
  price
) {
  if (
    !Array.isArray(candles) ||
    candles.length === 0
  ) {
    return {
      candleCount: 0,
      ema9: null,
      ema20: null,
      ema50: null,
      rsi: null,
      vwap: null,
      support: null,
      resistance: null,
      trend: "UNKNOWN",
      structure: "RANGE",
      structureDetails: null
    };
  }

  const closes =
    candles.map(
      c => Number(c[4])
    );

  const ema9 =
    ema(closes, 9);

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  const current =
    Number(price);

  let trend =
    "SIDEWAYS";

  if (
    ema9 !== null &&
    ema20 !== null &&
    ema50 !== null
  ) {
    if (
      current > ema9 &&
      ema9 > ema20 &&
      ema20 > ema50
    ) {
      trend =
        "BULLISH";
    } else if (
      current < ema9 &&
      ema9 < ema20 &&
      ema20 < ema50
    ) {
      trend =
        "BEARISH";
    }
  } else if (
    ema9 !== null &&
    ema20 !== null
  ) {
    if (
      current > ema9 &&
      ema9 > ema20
    ) {
      trend =
        "BULLISH";
    } else if (
      current < ema9 &&
      ema9 < ema20
    ) {
      trend =
        "BEARISH";
    }
  }

  const recent =
    candles.slice(-20);

  const support =
    Math.min(
      ...recent.map(
        c => Number(c[3])
      )
    );

  const resistance =
    Math.max(
      ...recent.map(
        c => Number(c[2])
      )
    );

  const structure =
    detectStructure(
      candles
    );

  return {
    candleCount:
      candles.length,

    ema9:
      ema9 !== null
        ? round(ema9)
        : null,

    ema20:
      ema20 !== null
        ? round(ema20)
        : null,

    ema50:
      ema50 !== null
        ? round(ema50)
        : null,

    rsi:
      rsiValue(
        closes
      ),

    vwap:
      calculateVWAP(
        candles
      ),

    support:
      round(support),

    resistance:
      round(resistance),

    trend,

    structure:
      structure.label,

    structureDetails:
      structure.details,

    bos:
      structure.bos,

    choch:
      structure.choch
  };
}

function rsiValue(
  closes
) {
  const value =
    rsi(
      closes,
      14
    );

  return value !== null
    ? round(value, 2)
    : null;
}

// ============================================================
// OPTION CONTRACTS
// KEEPING EXISTING WORKING FLOW
// ============================================================

async function fetchOptionContracts(
  index
) {
  const config =
    INDICES[index];

  if (!config) {
    throw new Error(
      `Invalid index: ${index}`
    );
  }

  const response =
    await upstoxRequest(
      "https://api.upstox.com/v2/option/contract",
      {
        instrument_key:
          config.symbol
      }
    );

  return response.data || [];
}

// ============================================================
// NEAREST EXPIRY
// ============================================================

async function findNearestExpiry(
  index
) {
  const contracts =
    await fetchOptionContracts(
      index
    );

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  const expiries =
    [
      ...new Set(
        contracts
          .map(
            item =>
              item.expiry
          )
          .filter(Boolean)
      )
    ]
      .filter(
        expiry =>
          expiry >= today
      )
      .sort();

  return (
    expiries[0] ||
    null
  );
}

// ============================================================
// OPTION CHAIN
// ============================================================

async function fetchOptionChain(
  index,
  expiryDate = null
) {
  const config =
    INDICES[index];

  let expiry =
    expiryDate;

  if (!expiry) {
    expiry =
      await findNearestExpiry(
        index
      );
  }

  if (!expiry) {
    throw new Error(
      `No expiry found for ${index}`
    );
  }

  const response =
    await upstoxRequest(
      "https://api.upstox.com/v2/option/chain",
      {
        instrument_key:
          config.symbol,

        expiry_date:
          expiry
      }
    );

  return {
    expiry,

    data:
      response.data || []
  };
}

// ============================================================
// OPTION GREEKS
// ============================================================

async function fetchOptionGreeks(
  instrumentKeys
) {
  if (
    !Array.isArray(
      instrumentKeys
    ) ||
    instrumentKeys.length === 0
  ) {
    return {};
  }

  const unique =
    [
      ...new Set(
        instrumentKeys.filter(
          Boolean
        )
      )
    ].slice(0, 50);

  if (!unique.length) {
    return {};
  }

  try {
    const response =
      await upstoxRequest(
        "https://api.upstox.com/v3/market-quote/option-greek",
        {
          instrument_key:
            unique.join(",")
        }
      );

    return response.data || {};

  } catch (error) {
    console.error(
      "[ERA] Greeks error:",
      error.response?.data ||
      error.message
    );

    return {};
  }
}

// ============================================================
// NORMALIZE OPTION SIDE
// ============================================================

function normalizeOptionSide(
  side,
  strikeFallback
) {
  if (!side) {
    return null;
  }

  const marketData =
    side.market_data ||
    side.marketData ||
    side;

  const greeks =
    side.option_greeks ||
    side.optionGreeks ||
    side.greeks ||
    {};

  const instrumentKey =
    side.instrument_key ||
    side.instrumentKey ||
    marketData.instrument_key ||
    marketData.instrumentKey ||
    null;

  const strike =
    safeNumber(
      side.strike_price ??
      side.strikePrice ??
      strikeFallback
    );

  return {
    type: side.type ||
      side.option_type ||
      side.optionType ||
      null,

    strike,

    instrumentKey,

    ltp:
      safeNumber(
        marketData.ltp ??
        marketData.last_price ??
        marketData.lastPrice ??
        side.ltp ??
        0
      ),

    oi:
      safeNumber(
        marketData.oi ??
        marketData.open_interest ??
        side.oi ??
        0
      ),

    changeOI:
      safeNumber(
        marketData.change_oi ??
        marketData.changeOi ??
        side.change_oi ??
        0
      ),

    volume:
      safeNumber(
        marketData.volume ??
        side.volume ??
        0
      ),

    iv:
      safeNumber(
        greeks.iv ??
        greeks.implied_volatility ??
        side.iv ??
        0
      ),

    delta:
      safeNumber(
        greeks.delta ??
        side.delta ??
        0
      ),

    gamma:
      safeNumber(
        greeks.gamma ??
        side.gamma ??
        0
      ),

    theta:
      safeNumber(
        greeks.theta ??
        side.theta ??
        0
      ),

    vega:
      safeNumber(
        greeks.vega ??
        side.vega ??
        0
      ),

    rho:
      safeNumber(
        greeks.rho ??
        side.rho ??
        0
      )
  };
}

// ============================================================
// NORMALIZE OPTION CHAIN
// ============================================================

function normalizeOptionChain(
  chainData
) {
  const rows = [];

  for (
    const item of chainData || []
  ) {
    const strike =
      safeNumber(
        item.strike_price ??
        item.strikePrice ??
        item.strike
      );

    const callRaw =
      item.call_options ||
      item.callOptions ||
      item.CE ||
      item.ce ||
      null;

    const putRaw =
      item.put_options ||
      item.putOptions ||
      item.PE ||
      item.pe ||
      null;

    const call =
      normalizeOptionSide(
        callRaw,
        strike
      );

    const put =
      normalizeOptionSide(
        putRaw,
        strike
      );

    if (
      !call &&
      !put
    ) {
      continue;
    }

    rows.push({
      strike,

      expiry:
        item.expiry ||
        item.expiry_date ||
        null,

      call,

      put
    });
  }

  rows.sort(
    (a, b) =>
      a.strike -
      b.strike
  );

  return rows;
}

// ============================================================
// MERGE GREEKS
// ============================================================

function mergeGreeks(
  rows,
  greeks
) {
  for (
    const row of rows
  ) {
    for (
      const sideName of [
        "call",
        "put"
      ]
    ) {
      const side =
        row[sideName];

      if (
        !side ||
        !side.instrumentKey
      ) {
        continue;
      }

      const data =
        greeks[
          side.instrumentKey
        ];

      if (!data) {
        continue;
      }

      side.iv =
        safeNumber(
          data.iv ??
          data.implied_volatility ??
          side.iv
        );

      side.delta =
        safeNumber(
          data.delta ??
          side.delta
        );

      side.gamma =
        safeNumber(
          data.gamma ??
          side.gamma
        );

      side.theta =
        safeNumber(
          data.theta ??
          side.theta
        );

      side.vega =
        safeNumber(
          data.vega ??
          side.vega
        );

      side.rho =
        safeNumber(
          data.rho ??
          side.rho
        );
    }
  }

  return rows;
}

// ============================================================
// OPTION SUMMARY
// ============================================================

function calculateOptionSummary(
  rows,
  spot
) {
  let callOI = 0;
  let putOI = 0;

  let maxCallOI = null;
  let maxPutOI = null;

  let atm = null;
  let atmDistance =
    Infinity;

  for (
    const row of rows
  ) {
    const callOIValue =
      safeNumber(
        row.call?.oi
      );

    const putOIValue =
      safeNumber(
        row.put?.oi
      );

    callOI +=
      callOIValue;

    putOI +=
      putOIValue;

    if (
      !maxCallOI ||
      callOIValue >
        maxCallOI.oi
    ) {
      maxCallOI = {
        strike:
          row.strike,
        oi:
          callOIValue
      };
    }

    if (
      !maxPutOI ||
      putOIValue >
        maxPutOI.oi
    ) {
      maxPutOI = {
        strike:
          row.strike,
        oi:
          putOIValue
      };
    }

    const distance =
      Math.abs(
        row.strike -
        spot
      );

    if (
      distance <
      atmDistance
    ) {
      atmDistance =
        distance;

      atm =
        row.strike;
    }
  }

  const pcr =
    callOI > 0
      ? putOI / callOI
      : 0;

  let sentiment =
    "NEUTRAL";

  if (
    pcr >= 1.05
  ) {
    sentiment =
      "BULLISH";
  } else if (
    pcr <= 0.80
  ) {
    sentiment =
      "BEARISH";
  }

  return {
    callOI,
    putOI,

    pcr:
      round(pcr, 3),

    sentiment,

    atm,

    maxCallOI,

    maxPutOI
  };
}

// ============================================================
// MOVEMENT ENGINE
// ============================================================

function movementFromPrevious(
  index,
  currentPrice
) {
  const previous =
    state.previousPrices[index];

  if (
    !Number.isFinite(
      Number(previous)
    )
  ) {
    state.previousPrices[index] =
      currentPrice;

    return {
      points: 0,
      percent: 0,
      significant: false,
      direction: "NONE"
    };
  }

  const points =
    currentPrice -
    previous;

  const percent =
    previous !== 0
      ? (
          points /
          previous
        ) * 100
      : 0;

  state.previousPrices[index] =
    currentPrice;

  const threshold =
    Number(
      state.settings
        .movementThreshold
    );

  return {
    points:
      round(points),

    percent:
      round(
        percent,
        3
      ),

    significant:
      Math.abs(points) >=
      threshold,

    direction:
      points > 0
        ? "UP"
        : points < 0
          ? "DOWN"
          : "FLAT"
  };
}

// ============================================================
// CONFIDENCE ENGINE
// ============================================================

function calculateConfidence(
  market,
  technical,
  movement,
  optionSummary
) {
  let confidence = 50;

  const reasons = [];
  const risks = [];

  if (
    movement.significant
  ) {
    confidence += 8;

    reasons.push(
      `${Math.abs(
        movement.points
      )} point movement confirmed`
    );
  }

  if (
    movement.direction ===
    "UP"
  ) {
    if (
      technical.trend ===
      "BULLISH"
    ) {
      confidence += 10;
      reasons.push(
        "EMA trend supports upside"
      );
    }

    if (
      technical.trend ===
      "BEARISH"
    ) {
      confidence -= 10;
      risks.push(
        "EMA trend conflicts with upside"
      );
    }

    if (
      technical.structure ===
      "HH_HL"
    ) {
      confidence += 8;
      reasons.push(
        "Higher-high / higher-low structure"
      );
    }

    if (
      optionSummary?.sentiment ===
      "BULLISH"
    ) {
      confidence += 8;
      reasons.push(
        "Option sentiment supports upside"
      );
    }

    if (
      optionSummary?.sentiment ===
      "BEARISH"
    ) {
      confidence -= 6;
      risks.push(
        "Option sentiment conflicts with upside"
      );
    }
  }

  if (
    movement.direction ===
    "DOWN"
  ) {
    if (
      technical.trend ===
      "BEARISH"
    ) {
      confidence += 10;
      reasons.push(
        "EMA trend supports downside"
      );
    }

    if (
      technical.trend ===
      "BULLISH"
    ) {
      confidence -= 10;
      risks.push(
        "EMA trend conflicts with downside"
      );
    }

    if (
      technical.structure ===
      "LH_LL"
    ) {
      confidence += 8;
      reasons.push(
        "Lower-high / lower-low structure"
      );
    }

    if (
      optionSummary?.sentiment ===
      "BEARISH"
    ) {
      confidence += 8;
      reasons.push(
        "Option sentiment supports downside"
      );
    }

    if (
      optionSummary?.sentiment ===
      "BULLISH"
    ) {
      confidence -= 6;
      risks.push(
        "Option sentiment conflicts with downside"
      );
    }
  }

  if (
    technical.vwap !== null
  ) {
    confidence += 3;
  }

  if (
    technical.rsi !== null
  ) {
    if (
      movement.direction ===
        "UP" &&
      technical.rsi >= 50 &&
      technical.rsi <= 70
    ) {
      confidence += 6;
      reasons.push(
        "RSI confirms bullish momentum"
      );
    }

    if (
      movement.direction ===
        "DOWN" &&
      technical.rsi <= 50 &&
      technical.rsi >= 30
    ) {
      confidence += 6;
      reasons.push(
        "RSI confirms bearish momentum"
      );
    }

    if (
      technical.rsi > 75
    ) {
      confidence -= 4;
      risks.push(
        "RSI is overheated"
      );
    }

    if (
      technical.rsi < 25
    ) {
      confidence -= 4;
      risks.push(
        "RSI is deeply oversold"
      );
    }
  }

  const threshold =
    Number(
      state.settings
        .movementThreshold
    );

  if (
    !movement.significant
  ) {
    risks.push(
      `${threshold}+ point movement not confirmed`
    );
  }

  confidence =
    clamp(
      confidence,
      20,
      95
    );

  let suggestion;

  if (
    confidence >= 75 &&
    movement.significant
  ) {
    suggestion =
      "TRADE CONSIDER";
  } else if (
    confidence >= 60
  ) {
    suggestion =
      "WAIT FOR CONFIRMATION";
  } else {
    suggestion =
      "AVOID / NO TRADE";
  }

  return {
    confidence:
      Math.round(
        confidence
      ),

    suggestion,

    reasons,

    risks
  };
}

// ============================================================
// OPTION TRADE SETUP
// ============================================================

function createOptionTrades(
  index,
  market,
  movement,
  confidenceData,
  rows
) {
  if (
    !market ||
    !market.available
  ) {
    return [];
  }

  if (
    !movement.significant
  ) {
    return [];
  }

  if (
    confidenceData.confidence <=
    60
  ) {
    return [];
  }

  const direction =
    movement.direction;

  const optionType =
    direction === "UP"
      ? "CE"
      : direction === "DOWN"
        ? "PE"
        : null;

  if (!optionType) {
    return [];
  }

  const spot =
    Number(
      market.price
    );

  const sorted =
    [...rows]
      .sort(
        (a, b) =>
          Math.abs(
            a.strike -
            spot
          ) -
          Math.abs(
            b.strike -
            spot
          )
      )
      .slice(0, 9);

  const trades = [];

  for (
    const row of sorted
  ) {
    const side =
      optionType === "CE"
        ? row.call
        : row.put;

    if (
      !side ||
      !side.instrumentKey
    ) {
      continue;
    }

    const entry =
      Number(
        side.ltp
      );

    if (
      !Number.isFinite(
        entry
      ) ||
      entry <= 0
    ) {
      continue;
    }

    const stopLoss =
      entry *
      (
        confidenceData.confidence >=
        75
          ? 0.83
          : 0.80
      );

    const risk =
      entry -
      stopLoss;

    if (
      risk <= 0
    ) {
      continue;
    }

    const target1 =
      entry +
      risk * 1.5;

    const target2 =
      entry +
      risk * 2.5;

    const target3 =
      entry +
      risk * 3.5;

    trades.push({
      index,

      instrumentKey:
        side.instrumentKey,

      optionType,

      strike:
        row.strike,

      signal:
        "BUY",

      direction,

      entry:
        round(entry),

      stopLoss:
        round(stopLoss),

      targets: [
        round(target1),
        round(target2),
        round(target3)
      ],

      rr: 3.5,

      confidence:
        confidenceData.confidence,

      status:
        confidenceData.confidence >=
        75
          ? "CONFIRMED"
          : "SETUP",

      invalidation:
        `Option price below ${round(
          stopLoss
        )}`,

      generatedAt:
        nowISO()
    });
  }

  return trades.slice(0, 3);
}

// ============================================================
// COMPLETE INDEX ANALYSIS
// ============================================================

async function analyzeIndex(
  index
) {
  const market =
    state.market[index];

  if (
    !market ||
    !market.available
  ) {
    return {
      index,
      available: false,
      error:
        "Market data unavailable",
      generatedAt:
        nowISO()
    };
  }

  let candles =
    await fetchIntradayCandles(
      index,
      5
    );

  /*
   * If intraday candles are unavailable,
   * fallback to historical candles.
   */
  if (
    candles.length === 0
  ) {
    candles =
      await fetchHistoricalCandles(
        index,
        5
      );
  }

  candles =
    syncLatestCandle(
      candles,
      market.price
    );

  const technical =
    technicalAnalysis(
      candles,
      market.price
    );

  let optionRows = [];
  let optionSummary = null;
  let expiry = null;

  /*
   * Existing working Option Chain flow.
   */
  try {
    const chain =
      await fetchOptionChain(
        index
      );

    expiry =
      chain.expiry;

    optionRows =
      normalizeOptionChain(
        chain.data
      );

    if (
      optionRows.length
    ) {
      const relevant =
        [...optionRows]
          .sort(
            (a, b) =>
              Math.abs(
                a.strike -
                market.price
              ) -
              Math.abs(
                b.strike -
                market.price
              )
          )
          .slice(0, 25);

      const instrumentKeys =
        [];

      for (
        const row of relevant
      ) {
        if (
          row.call?.instrumentKey
        ) {
          instrumentKeys.push(
            row.call.instrumentKey
          );
        }

        if (
          row.put?.instrumentKey
        ) {
          instrumentKeys.push(
            row.put.instrumentKey
          );
        }
      }

      const greeks =
        await fetchOptionGreeks(
          instrumentKeys
        );

      optionRows =
        mergeGreeks(
          optionRows,
          greeks
        );

      optionSummary =
        calculateOptionSummary(
          optionRows,
          market.price
        );
    }

  } catch (error) {
    console.error(
      `[ERA] Option analysis error ${index}:`,
      error.response?.data ||
      error.message
    );

    optionSummary = null;
  }

  const movement =
    movementFromPrevious(
      index,
      market.price
    );

  let signal =
    "NONE";

  if (
    movement.significant
  ) {
    if (
      movement.direction ===
      "UP"
    ) {
      signal =
        "BUY";
    } else if (
      movement.direction ===
      "DOWN"
    ) {
      signal =
        "SELL";
    }
  }

  const confidenceData =
    calculateConfidence(
      market,
      technical,
      movement,
      optionSummary
    );

  const trades =
    createOptionTrades(
      index,
      market,
      movement,
      confidenceData,
      optionRows
    );

  recordGeneratedTrades(trades);

  return {
    index,

    available: true,

    market,

    candles: {
      interval: 5,

      count:
        candles.length,

      latest:
        candles.length
          ? candles[
              candles.length - 1
            ]
          : null,

      source:
        candles.length
          ? "upstox-v3"
          : "none"
    },

    movement,

    technical,

    options: {
      expiry,

      summary:
        optionSummary,

      rows:
        optionRows
    },

    signal,

    confidence:
      confidenceData.confidence,

    reasons:
      confidenceData.reasons,

    risks:
      confidenceData.risks,

    suggestion:
      confidenceData.suggestion,

    trades,

    generatedAt:
      nowISO()
  };
}

// ============================================================
// GENERATED TRADE HISTORY
// ============================================================

function recordGeneratedTrades(trades) {
  if (!Array.isArray(trades) || !trades.length) {
    return;
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let changed = false;

  for (const trade of trades) {
    const key = [
      trade.index,
      trade.optionType,
      trade.strike,
      trade.signal,
      trade.entry
    ].join("|");

    const exists = state.history.some(item =>
      item.type === "trade" &&
      item.historyKey === key &&
      new Date(item.createdAt || 0).getTime() >= cutoff
    );

    if (exists) {
      continue;
    }

    state.history.unshift({
      type: "trade",
      historyKey: key,
      ...trade,
      createdAt: trade.generatedAt || nowISO()
    });
    changed = true;
  }

  if (changed) {
    state.history = state.history.slice(0, 500);
    saveState();
  }
}

// ============================================================
// ALERT FINGERPRINT
// ============================================================

function tradeFingerprint(
  trade
) {
  return [
    trade.index,
    trade.strike,
    trade.optionType,
    trade.signal
  ].join("|");
}

// ============================================================
// PUSH NOTIFICATION
// ============================================================

async function sendPush(
  payload
) {
  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY
  ) {
    return;
  }

  const subscriptions =
    Array.isArray(
      state.pushSubscriptions
    )
      ? state.pushSubscriptions
      : [];

  for (
    const subscription
    of subscriptions
  ) {
    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify(
          payload
        )
      );

    } catch (error) {
      if (
        error.statusCode ===
          404 ||
        error.statusCode ===
          410
      ) {
        state.pushSubscriptions =
          state.pushSubscriptions.filter(
            item =>
              item.endpoint !==
              subscription.endpoint
          );

        saveState();
      }
    }
  }
}

// ============================================================
// TRADE ALERT
// ============================================================

async function notifyTrade(
  trade
) {
  if (!state.settings.notifications?.tradeSetup) {
    return;
  }

  const fingerprint =
    tradeFingerprint(
      trade
    );

  const existing =
    state.alerts.find(
      alert =>
        alert.fingerprint ===
        fingerprint
    );

  const cooldownMs = Number(state.settings.notificationCooldownMs || 900000);
  const lastSent = Number(state.notificationHistory[`trade:${fingerprint}`] || 0);
  if (lastSent && Date.now() - lastSent < cooldownMs) {
    return;
  }

  if (existing && existing.confidence === trade.confidence && lastSent) {
    return;
  }

  state.notificationHistory[`trade:${fingerprint}`] = Date.now();

  const alert = {
    id:
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,

    type:
      "TRADE",

    fingerprint,

    trade,

    confidence:
      trade.confidence,

    createdAt:
      nowISO()
  };

  state.alerts.unshift(
    alert
  );

  state.alerts =
    state.alerts.slice(
      0,
      100
    );

  saveState();

  await sendPush({
    title:
      `Era AI — ${trade.index}`,

    body:
      `${trade.optionType} ${trade.strike} | ${trade.signal} | Confidence ${trade.confidence}%`,

    data:
      trade
  });
}

// ============================================================
// MARKET MOVE NOTIFICATION
// ============================================================

async function notifyMarketMove(
  index,
  movement,
  market
) {
  if (
    !movement.significant
  ) {
    return;
  }

  const bucket =
    Math.floor(
      Math.abs(
        movement.points
      ) /
        Number(
          state.settings
            .movementThreshold
        )
    );

  const key =
    `${index}|${movement.direction}|${bucket}`;

  if (!state.settings.notifications?.movement) {
    return;
  }

  const moveCooldownKey = `${index}:move:${movement.direction}`;
  const lastMoveAlert = Number(state.notificationHistory[moveCooldownKey] || 0);
  if (Date.now() - lastMoveAlert < Number(state.settings.notificationCooldownMs || 900000)) {
    return;
  }

  if (state.previousSignals[`${index}:move`] === key && lastMoveAlert) {
    return;
  }

  state.previousSignals[`${index}:move`] = key;
  state.notificationHistory[moveCooldownKey] = Date.now();
  saveState();

  await sendPush({
    title:
      `${index} Market Move`,

    body:
      `${movement.direction} ${Math.abs(
        movement.points
      )} points | ${round(
        market.price
      )}`,

    data: {
      index,
      movement,
      market
    }
  });
}

// ============================================================
// MONITOR MARKET
// ============================================================

let scannerBusy = false;

async function monitorMarketState() {
  if (
    scannerBusy
  ) {
    return;
  }

  scannerBusy = true;

  try {
    await refreshMarketData();

    if (
      !isMarketHours()
    ) {
      state.lastScan =
        nowISO();

      return;
    }

    const indices =
      Object.keys(
        INDICES
      );

    for (
      const index of indices
    ) {
      try {
        const analysis =
          await analyzeIndex(
            index
          );

        state.analysis[index] =
          analysis;

        await notifyMarketMove(
          index,
          analysis.movement,
          analysis.market
        );

        if (
          Array.isArray(
            analysis.trades
          )
        ) {
          for (
            const trade
            of analysis.trades
          ) {
            await notifyTrade(
              trade
            );
          }
        }

      } catch (error) {
        console.error(
          `[ERA] Analysis error ${index}:`,
          error.response?.data ||
          error.message
        );
      }
    }

    state.activeTrades =
      Object.values(
        state.analysis
      )
        .flatMap(
          item =>
            item?.trades || []
        );

    state.lastScan =
      nowISO();

    state.lastSuccess =
      nowISO();

    state.lastError =
      null;

  } catch (error) {
    state.lastError = {
      message:
        error.message,

      at:
        nowISO(),

      details:
        error.response?.data ||
        null
    };

    console.error(
      "[ERA] Scanner error:",
      error.response?.data ||
      error.message
    );

  } finally {
    scannerBusy =
      false;
  }
}

// ============================================================
// NEWS
// ============================================================

async function fetchNews() {
  try {
    const query =
      encodeURIComponent(
        "Nifty BankNifty Sensex stock market India"
      );

    const url =
      `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`;

    const response =
      await axios.get(
        url,
        {
          timeout: 20000
        }
      );

    const xml =
      response.data || "";

    const items =
      xml.match(
        /<item>[\s\S]*?<\/item>/g
      ) || [];

    const news =
      items
        .slice(0, 20)
        .map(
          item => {
            const title =
              (
                item.match(
                  /<title>([\s\S]*?)<\/title>/
                ) || []
              )[1];

            const link =
              (
                item.match(
                  /<link>([\s\S]*?)<\/link>/
                ) || []
              )[1];

            const pubDate =
              (
                item.match(
                  /<pubDate>([\s\S]*?)<\/pubDate>/
                ) || []
              )[1];

            return {
              title:
                title
                  ? title
                      .replace(
                        /<!\[CDATA\[/g,
                        ""
                      )
                      .replace(
                        /\]\]>/g,
                        ""
                      )
                      .trim()
                  : "",

              link:
                link
                  ? link.trim()
                  : "",

              pubDate:
                pubDate
                  ? pubDate.trim()
                  : ""
            };
          }
        )
        .filter(
          item =>
            item.title
        );

    state.news =
      news;

    state.lastNewsFetch =
      nowISO();

    return news;

  } catch (error) {
    console.error(
      "[ERA] News error:",
      error.message
    );

    return state.news;
  }
}

// ============================================================
// PRE-MARKET WATCHLIST
// ============================================================

let lastPreMarketDate =
  null;

async function preMarketCheck() {
  const {
    weekday,
    hour,
    minute
  } =
    getIndiaTimeParts();

  const weekdays = [
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri"
  ];

  if (
    !weekdays.includes(
      weekday
    )
  ) {
    return;
  }

  const total =
    hour * 60 + minute;

  if (
    total < 540 ||
    total >= 555
  ) {
    return;
  }

  const dateKey =
    new Date()
      .toLocaleDateString(
        "en-CA",
        {
          timeZone:
            "Asia/Kolkata"
        }
      );

  if (
    lastPreMarketDate ===
    dateKey
  ) {
    return;
  }

  lastPreMarketDate =
    dateKey;

  await sendPush({
    title:
      "Era AI — Pre-Market Watchlist",

    body:
      "Market opens at 09:15 IST. Check NIFTY, BANKNIFTY, FINNIFTY and SENSEX setup.",

    data: {
      type:
        "PRE_MARKET"
    }
  });
}

// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,

      app:
        "Era AI",

      version:
        VERSION,

      status:
        "running",

      marketOpen:
        isMarketHours(),

      backend:
        BACKEND_URL,

      updatedAt:
        nowISO()
    });
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      engineRunning:
        state.engineRunning,

      marketOpen:
        isMarketHours(),

      lastSuccess:
        state.lastSuccess,

      lastError:
        state.lastError,

      lastScan:
        state.lastScan,

      lastNewsFetch:
        state.lastNewsFetch,

      timestamp:
        nowISO()
    });
  }
);

// ============================================================
// MARKET
// ============================================================

app.get(
  "/api/market",
  async (req, res) => {
    try {
      await refreshMarketData();

      res.json({
        ok: true,

        version:
          VERSION,

        market:
          state.market,

        markets:
          state.market,

        marketOpen:
          isMarketHours(),

        updatedAt:
          nowISO()
      });

    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message,

        market:
          state.market,

        marketOpen:
          isMarketHours(),

        updatedAt:
          nowISO()
      });
    }
  }
);

// ============================================================
// ANALYSIS
// ============================================================

app.get(
  "/api/analysis",
  async (req, res) => {
    try {
      await refreshMarketData();

      const results = {};

      for (
        const index of Object.keys(
          INDICES
        )
      ) {
        results[index] =
          await analyzeIndex(
            index
          );

        state.analysis[index] =
          results[index];
      }

      state.activeTrades =
        Object.values(
          results
        )
          .flatMap(
            item =>
              item?.trades || []
          );

      state.lastScan =
        nowISO();

      res.json({
        ok: true,

        version:
          VERSION,

        market:
          state.market,

        markets:
          state.market,

        analysis:
          results,

        indexes:
          results,

        selectedIndex:
          normalizeIndex(req.query.index) || "NIFTY",

        selected:
          results[normalizeIndex(req.query.index) || "NIFTY"] || null,

        activeTrades:
          state.activeTrades,

        marketOpen:
          isMarketHours(),

        updatedAt:
          nowISO()
      });

    } catch (error) {
      state.lastError = {
        message:
          error.message,

        at:
          nowISO()
      };

      res.status(500).json({
        ok: false,

        error:
          error.message,

        market:
          state.market,

        analysis:
          state.analysis,

        updatedAt:
          nowISO()
      });
    }
  }
);

// ============================================================
// OPTIONS CONTRACTS
// ============================================================

app.get(
  "/api/options/contracts",
  async (req, res) => {
    try {
      const index =
        normalizeIndex(
          req.query.index ||
          "NIFTY"
        );

      if (!INDICES[index]) {
        return res.status(400)
          .json({
            ok: false,
            error:
              "Invalid index"
          });
      }

      const contracts =
        await fetchOptionContracts(
          index
        );

      const today =
        new Date()
          .toISOString()
          .slice(0, 10);

      const expiries =
        [
          ...new Set(
            contracts
              .map(
                item =>
                  item.expiry
              )
              .filter(Boolean)
          )
        ]
          .filter(
            expiry =>
              expiry >= today
          )
          .sort();

      res.json({
        ok: true,

        index,

        contracts,

        expiries,

        nearestExpiry:
          expiries[0] ||
          null
      });

    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// OPTIONS CHAIN
// ============================================================

app.get(
  "/api/options/chain",
  async (req, res) => {
    try {
      const index =
        normalizeIndex(
          req.query.index ||
          "NIFTY"
        );

      const expiry =
        req.query.expiry ||
        null;

      if (!INDICES[index]) {
        return res.status(400)
          .json({
            ok: false,
            error:
              "Invalid index"
          });
      }

      const chain =
        await fetchOptionChain(
          index,
          expiry
        );

      let rows =
        normalizeOptionChain(
          chain.data
        );

      let spot =
        state.market[index]
          ?.price || 0;

      /*
       * If spot missing, fetch it.
       */
      if (
        !spot
      ) {
        try {
          const quotes =
            await fetchQuotes();

          spot =
            quotes[index]
              ?.price || 0;

        } catch (_) {}
      }

      /*
       * Fetch Greeks only for
       * relevant strikes.
       */
      const relevant =
        [...rows]
          .sort(
            (a, b) =>
              Math.abs(
                a.strike -
                spot
              ) -
              Math.abs(
                b.strike -
                spot
              )
          )
          .slice(0, 25);

      const instrumentKeys =
        [];

      for (
        const row of relevant
      ) {
        if (
          row.call?.instrumentKey
        ) {
          instrumentKeys.push(
            row.call.instrumentKey
          );
        }

        if (
          row.put?.instrumentKey
        ) {
          instrumentKeys.push(
            row.put.instrumentKey
          );
        }
      }

      const greeks =
        await fetchOptionGreeks(
          instrumentKeys
        );

      rows =
        mergeGreeks(
          rows,
          greeks
        );

      const summary =
        calculateOptionSummary(
          rows,
          spot
        );

      res.json({
        ok: true,

        index,

        expiry:
          chain.expiry,

        spot:

          spot,

        rows,

        data:
          rows,

        summary,

        updatedAt:
          nowISO()
      });

    } catch (error) {
      console.error(
        "[ERA] Option chain endpoint:",
        error.response?.data ||
        error.message
      );

      res.status(500).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// OPTIONS GREEKS
// ============================================================

app.get(
  "/api/options/greeks",
  async (req, res) => {
    try {
      const keys =
        String(
          req.query.instrument_key ||
          ""
        )
          .split(",")
          .map(
            x => x.trim()
          )
          .filter(Boolean);

      const data =
        await fetchOptionGreeks(
          keys
        );

      res.json({
        ok: true,

        data,

        updatedAt:
          nowISO()
      });

    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// NEWS
// ============================================================

app.get(
  "/api/news",
  async (req, res) => {
    try {
      const news =
        await fetchNews();

      res.json({
        ok: true,

        news,

        updatedAt:
          nowISO()
      });

    } catch (error) {
      res.status(500).json({
        ok: false,

        news:
          state.news,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// AI CHAT
// ============================================================

app.post(
  "/api/chat",
  async (req, res) => {
    try {
      if (
        !OPENROUTER_API_KEY
      ) {
        return res.status(503)
          .json({
            ok: false,

            error:
              "OPENROUTER_API_KEY is not configured"
          });
      }

      const message =
        String(
          req.body?.message ||
          ""
        ).trim();

      if (!message) {
        return res.status(400)
          .json({
            ok: false,

            error:
              "Message is required"
          });
      }

      const systemPrompt = `
You are Era AI, a friendly human-like Indian market assistant.

Reply naturally and conversationally. Use simple Roman Hindi / Hinglish unless the user asks for another language. Do not sound like a code generator or a machine report.

Important style rules:
- Answer the user's actual question first. Do not dump the full market report unless the user asks for a detailed market overview.
- Never return JSON, JavaScript, XML, or code blocks unless the user explicitly asks for code or structured data.
- Do not use a giant markdown report for a simple question. Keep normal answers concise and easy to read.
- If the user asks for a trade/setup, clearly state option type (CE/PE), strike, entry, stop loss, targets, confidence and status when those values are available.
- Always explain WHY Era is giving the setup and WHY it is waiting/no-trade when relevant.
- Never invent live prices, option prices, signals or confirmations.
- If live data is missing or insufficient, say so clearly and prefer WAIT / DATA UNAVAILABLE.
- Do not claim certainty or guaranteed profit.

Use the supplied market and analysis data as the source of truth.`;

      const userContext = {
        market:
          state.market,

        analysis:
          state.analysis,

        message
      };

      const response =
        await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",

          {
            model:
              OPENROUTER_MODEL,

            messages: [
              {
                role:
                  "system",

                content:
                  systemPrompt
              },

              {
                role:
                  "user",

                content:
                  JSON.stringify(
                    userContext
                  )
              }
            ],

            temperature:
              0.2
          },

          {
            timeout:
              30000,

            headers: {
              Authorization:
                `Bearer ${OPENROUTER_API_KEY}`,

              "Content-Type":
                "application/json",

              "HTTP-Referer":
                BACKEND_URL,

              "X-Title":
                "Era AI"
            }
          }
        );

      const answer =
        response.data
          ?.choices?.[0]
          ?.message
          ?.content ||
        "No response.";

      state.history.unshift({
        type: "chat",
        userMessage: message,
        answer,
        index: req.body?.index || null,
        createdAt: nowISO()
      });

      state.history =
        state.history.slice(0, 500);

      saveState();

      res.json({
        ok: true,

        answer
      });

    } catch (error) {
      console.error(
        "[ERA] Chat error:",
        error.response?.data ||
        error.message
      );

      res.status(500).json({
        ok: false,

        error:
          error.response?.data ||
          error.message
      });
    }
  }
);

// ============================================================
// TTS
// ============================================================

app.post(
  "/api/tts",
  (req, res) => {
    res.status(410).json({
      ok: false,

      error:
        "TTS endpoint is currently disabled"
    });
  }
);

// ============================================================
// SETTINGS GET
// ============================================================

app.get(
  "/api/settings",
  (req, res) => {
    res.json({
      ok: true,

      settings:
        state.settings
    });
  }
);

// ============================================================
// SETTINGS POST
// ============================================================

app.post(
  "/api/settings",
  (req, res) => {
    try {
      const body =
        req.body || {};

      if (
        body.movementThreshold !==
        undefined
      ) {
        const value =
          Number(
            body.movementThreshold
          );

        if (
          Number.isFinite(value) &&
          value > 0
        ) {
          state.settings
            .movementThreshold =
            value;
        }
      }

      if (body.notificationCooldownMs !== undefined) {
        const value = Number(body.notificationCooldownMs);
        if (Number.isFinite(value) && value >= 60000 && value <= 86400000) {
          state.settings.notificationCooldownMs = value;
        }
      }

      if (body.notifications && typeof body.notifications === "object") {
        for (const key of Object.keys(state.settings.notifications)) {
          if (body.notifications[key] !== undefined) {
            state.settings.notifications[key] = Boolean(body.notifications[key]);
          }
        }
      }

      if (
        body.minConfidence !==
        undefined
      ) {
        const value =
          Number(
            body.minConfidence
          );

        if (
          Number.isFinite(value) &&
          value >= 1 &&
          value <= 100
        ) {
          state.settings
            .minConfidence =
            value;
        }
      }

      saveState();

      res.json({
        ok: true,

        settings:
          state.settings
      });

    } catch (error) {
      res.status(400).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// HISTORY GET
// ============================================================

app.get(
  "/api/history",
  (req, res) => {
    res.json({
      ok: true,

      history:
        state.history
    });
  }
);

// ============================================================
// HISTORY POST
// ============================================================

app.post(
  "/api/history",
  (req, res) => {
    try {
      const trade =
        req.body || {};

      const record = {
        ...trade,

        id:
          trade.id ||
          `${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,

        createdAt:
          trade.createdAt ||
          nowISO()
      };

      state.history.unshift(
        record
      );

      state.history =
        state.history.slice(
          0,
          500
        );

      saveState();

      res.json({
        ok: true,

        trade:
          record
      });

    } catch (error) {
      res.status(400).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// PUSH PUBLIC KEY
// ============================================================

app.get(
  "/api/push/public-key",
  (req, res) => {
    res.json({
      ok: true,

      publicKey:
        VAPID_PUBLIC_KEY ||
        null
    });
  }
);

// ============================================================
// PUSH SUBSCRIBE
// ============================================================

app.post(
  "/api/subscribe",
  (req, res) => {
    try {
      const subscription =
        req.body?.subscription ||
        req.body;

      if (
        !subscription ||
        !subscription.endpoint
      ) {
        return res.status(400)
          .json({
            ok: false,

            error:
              "Invalid subscription"
          });
      }

      const exists =
        state.pushSubscriptions
          .some(
            item =>
              item.endpoint ===
              subscription.endpoint
          );

      if (!exists) {
        state.pushSubscriptions
          .push(subscription);

        saveState();
      }

      res.json({
        ok: true,
        subscribed: true,
        subscriptions: state.pushSubscriptions.length
      });

    } catch (error) {
      res.status(400).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// PUSH TEST
// ============================================================

app.post(
  "/api/push/test",
  async (req, res) => {
    try {
      if (
        !VAPID_PUBLIC_KEY ||
        !VAPID_PRIVATE_KEY
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "VAPID keys are not configured"
        });
      }

      if (
        !state.pushSubscriptions.length
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "No push subscriptions are registered"
        });
      }

      await sendPush({
        title:
          "Era AI Test",

        body:
          "Push notifications are working.",

        data: {
          type:
            "TEST"
        }
      });

      res.json({
        ok: true,
        subscriptions:
          state.pushSubscriptions.length
      });

    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// ENGINE GET
// ============================================================

app.get(
  "/api/engine",
  (req, res) => {
    res.json({
      ok: true,

      running:
        state.engineRunning,

      lastScan:
        state.lastScan,

      lastSuccess:
        state.lastSuccess,

      lastError:
        state.lastError
    });
  }
);

// ============================================================
// ENGINE START
// ============================================================

app.post(
  "/api/engine/start",
  async (req, res) => {
    state.engineRunning =
      true;

    try {
      await monitorMarketState();
    } catch (_) {}

    res.json({
      ok: true,

      running:
        true
    });
  }
);

// ============================================================
// ENGINE STOP
// ============================================================

app.post(
  "/api/engine/stop",
  (req, res) => {
    state.engineRunning =
      false;

    res.json({
      ok: true,

      running:
        false
    });
  }
);

// ============================================================
// PERIODIC SCANNER
// ============================================================

setInterval(
  async () => {
    if (
      !state.engineRunning
    ) {
      return;
    }

    try {
      await monitorMarketState();
    } catch (error) {
      console.error(
        "[ERA] Periodic scanner:",
        error.message
      );
    }
  },

  state.settings
    .scanIntervalMs
);

// ============================================================
// PERIODIC NEWS
// ============================================================

setInterval(
  async () => {
    try {
      await fetchNews();
    } catch (_) {}
  },

  state.settings
    .newsIntervalMs
);

// ============================================================
// PRE-MARKET CHECK
// ============================================================

setInterval(
  async () => {
    try {
      await preMarketCheck();
    } catch (error) {
      console.error(
        "[ERA] Pre-market:",
        error.message
      );
    }
  },

  5 * 60 * 1000
);

// ============================================================
// INITIALIZATION
// ============================================================

(async () => {
  try {
    console.log(
      `[ERA] Starting Era AI ${VERSION}`
    );

    console.log(
      `[ERA] Backend: ${BACKEND_URL}`
    );

    console.log(
      `[ERA] Market open: ${isMarketHours()}`
    );

    await fetchNews();

  } catch (error) {
    console.error(
      "[ERA] Initial news error:",
      error.message
    );
  }

  setTimeout(
    async () => {
      try {
        if (
          state.engineRunning
        ) {
          await monitorMarketState();
        }
      } catch (error) {
        console.error(
          "[ERA] Initial scan error:",
          error.message
        );
      }
    },

    3000
  );
})();

// ============================================================
// SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Era AI ${VERSION} running on port ${PORT}`
    );
  }
);
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#050914">
<title>ERA AI — Market Intelligence</title>
<style>
:root{--bg:#050914;--bg2:#08111f;--card:#0b1628;--card2:#0e1c31;--line:#18304c;--text:#eef7ff;--muted:#8196b2;--accent:#19e6ff;--accent2:#7657ff;--green:#27e69b;--red:#ff527c;--yellow:#ffc857;--glow:rgba(25,230,255,.25)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 50% -10%,rgba(100,80,255,.20),transparent 35%),radial-gradient(circle at 90% 50%,rgba(0,220,255,.07),transparent 30%),var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh}button,input{font:inherit}button{cursor:pointer;color:inherit}.app{min-height:100vh}.sidebar{width:250px;min-height:100vh;position:fixed;left:0;top:0;padding:22px 16px;border-right:1px solid var(--line);background:rgba(3,8,18,.88);backdrop-filter:blur(20px);z-index:50}.logo{display:flex;align-items:center;gap:11px;margin:3px 8px 28px}.logo-icon{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;font-size:23px;font-weight:1000;background:linear-gradient(135deg,var(--accent2),var(--accent));box-shadow:0 0 22px var(--glow),inset 0 0 15px rgba(255,255,255,.15)}.logo-name{font-size:17px;font-weight:900}.logo-tag{color:var(--muted);font-size:8px;letter-spacing:1px;margin-top:3px}.nav{display:grid;gap:6px}.nav button{border:1px solid transparent;background:transparent;color:#91a5bd;text-align:left;padding:12px;border-radius:12px;font-size:13px}.nav button:hover,.nav button.active{color:#fff;border-color:rgba(25,230,255,.20);background:linear-gradient(90deg,rgba(25,230,255,.10),rgba(118,87,255,.13))}.premium-box{position:absolute;left:16px;right:16px;bottom:20px;padding:15px;border-radius:17px;background:linear-gradient(135deg,rgba(118,87,255,.22),rgba(25,230,255,.07));border:1px solid rgba(118,87,255,.30)}.premium-box small{color:var(--muted)}.premium-btn,.primary{width:100%;border:0;margin-top:10px;padding:10px;border-radius:10px;font-weight:800;color:white;background:linear-gradient(90deg,var(--accent2),var(--accent))}main{margin-left:250px;width:calc(100% - 250px);max-width:1500px;padding:22px 28px 80px}.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:17px}.topbar h1{font-size:23px;margin:0}.live{margin-top:5px;color:var(--green);font-size:11px;display:flex;gap:7px;align-items:center}.live-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 12px var(--green);animation:pulse 1.5s infinite}@keyframes pulse{50%{opacity:.35}}.top-actions{display:flex;gap:8px}.icon-btn{width:39px;height:39px;border-radius:11px;border:1px solid var(--line);background:#091321}.view{display:none}.view.active{display:block}.index-tabs{display:flex;gap:7px;overflow:auto;margin-bottom:15px}.index-tabs button,.subtabs button{border:1px solid var(--line);color:#91a7c2;background:#081321;border-radius:10px;padding:9px 14px;white-space:nowrap;font-size:11px}.index-tabs button.active,.subtabs button.active{color:var(--accent);border-color:var(--accent);background:rgba(25,230,255,.10)}.hero{display:grid;grid-template-columns:1.15fr .85fr;gap:15px}.card{background:linear-gradient(145deg,rgba(13,25,45,.96),rgba(6,13,26,.96));border:1px solid var(--line);border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.25)}.ai-card{min-height:350px;padding:22px;position:relative;overflow:hidden;background:radial-gradient(circle at 80% 25%,rgba(118,87,255,.22),transparent 30%),linear-gradient(145deg,#0d1930,#06101f)}.ai-top,.market-header,.signal-top,.section-title,.panel-head{display:flex;align-items:center;justify-content:space-between}.eyebrow{color:var(--accent);font-size:10px;font-weight:800;letter-spacing:1.8px}.ai-card h2{margin:8px 0 5px;font-size:27px}.ai-card p{margin:0;color:var(--muted);max-width:480px;font-size:12px;line-height:1.6}.online,.pill{padding:6px 9px;border-radius:30px;font-size:9px;font-weight:800}.online{color:var(--green);background:rgba(39,230,155,.08);border:1px solid rgba(39,230,155,.20)}.robot-area{height:190px;display:flex;align-items:center;justify-content:center;position:relative}.robot-glow{position:absolute;width:170px;height:170px;border-radius:50%;background:radial-gradient(circle,var(--glow),transparent 65%);animation:robotGlow 2.5s infinite alternate}@keyframes robotGlow{from{transform:scale(.85);opacity:.5}to{transform:scale(1.1);opacity:1}}.robot{position:relative;width:120px;height:94px;border:2px solid var(--accent);border-radius:30px 30px 25px 25px;background:linear-gradient(145deg,#192c47,#07111e);box-shadow:0 0 35px var(--glow),inset 0 0 25px rgba(118,87,255,.16);animation:floatRobot 3s ease-in-out infinite;z-index:2}@keyframes floatRobot{50%{transform:translateY(-9px)}}.antenna{position:absolute;top:-28px;width:2px;height:26px;background:var(--accent);box-shadow:0 0 10px var(--accent)}.ant-left{left:35px}.ant-right{right:35px}.ant-light{position:absolute;top:-34px;left:-3px;width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 14px var(--accent);animation:blink 1.4s infinite}@keyframes blink{50%{opacity:.2}}.eye{position:absolute;top:30px;width:15px;height:15px;border-radius:50%;background:var(--accent);box-shadow:0 0 14px var(--accent);animation:eyeBlink 4s infinite}@keyframes eyeBlink{0%,46%,50%,100%{transform:scaleY(1)}48%{transform:scaleY(.08)}}.eye-left{left:28px}.eye-right{right:28px}.robot-mouth{position:absolute;left:39px;right:39px;bottom:18px;height:5px;border-radius:5px;background:linear-gradient(90deg,var(--accent2),var(--accent));box-shadow:0 0 12px var(--accent2)}.ear{position:absolute;top:31px;width:17px;height:32px;border:2px solid var(--accent2);border-radius:8px}.ear-left{left:-18px}.ear-right{right:-18px}.robot-body{position:absolute;bottom:-33px;left:45px;width:27px;height:27px;border-radius:50%;background:var(--accent2);box-shadow:0 0 25px var(--accent2)}.chat{display:flex;gap:8px}.chat input,.text-input,.select{flex:1;border:1px solid var(--line);background:#07111f;color:white;padding:12px;border-radius:12px;outline:none}.chat button,.send{border:0;padding:0 18px;border-radius:12px;color:white;font-weight:800;background:linear-gradient(90deg,var(--accent2),var(--accent))}.market{padding:18px}.market-name{font-weight:800}.live-pill{color:var(--green);font-size:10px;padding:5px 8px;border-radius:20px;background:rgba(39,230,155,.08);border:1px solid rgba(39,230,155,.2)}.price{font-size:31px;font-weight:950;margin-top:8px}.change{font-size:12px;margin-top:3px}.chart{height:150px;margin-top:10px;border-radius:13px;overflow:hidden;background:linear-gradient(180deg,rgba(25,230,255,.09),transparent)}.chart svg{width:100%;height:100%}.market-stats,.signal-data{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}.market-stats small,.signal-data div,.label{color:var(--muted);font-size:9px}.section{margin-top:16px}.section-title{margin-bottom:9px}.section-title h3{font-size:14px;margin:0}.section-title span{color:var(--muted);font-size:10px}.movement,.tech,.index-grid,.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.movement-card,.tech-card,.index-card,.stat{padding:15px}.movement-card b{display:block;font-size:17px;margin-top:7px}.movement-card small{display:block;color:var(--muted);margin-top:5px;font-size:10px}.bullish{color:var(--green)!important}.bearish{color:var(--red)!important}.sideways{color:var(--yellow)!important}.tech-card small,.index-card small,.stat small{color:var(--muted);font-size:10px}.tech-value,.stat strong{font-size:20px;font-weight:900;margin:7px 0}.badge,.pill{display:inline-block;color:var(--accent);background:rgba(25,230,255,.08);border:1px solid rgba(25,230,255,.18)}.signal{padding:18px;background:linear-gradient(135deg,rgba(39,230,155,.10),rgba(118,87,255,.13));border-color:rgba(39,230,155,.25)}.signal-name{color:var(--muted);font-size:10px}.signal-type{font-size:24px;font-weight:950;color:var(--green);margin-top:4px}.confidence{color:var(--green);font-size:10px}.signal-data{grid-template-columns:repeat(4,1fr)}.signal-data b{color:white;font-size:12px}.confidence-bar{margin-top:12px;height:7px;background:#16243a;border-radius:10px;overflow:hidden}.confidence-bar span{display:block;height:100%;background:linear-gradient(90deg,var(--accent2),var(--green));border-radius:10px}.panel{padding:18px}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;min-width:620px}.table th,.table td{padding:10px 8px;border-bottom:1px solid rgba(24,48,76,.7);font-size:11px;text-align:right}.table th:first-child,.table td:first-child{text-align:left}.table th{color:var(--muted);font-size:9px}.selected-row{background:rgba(25,230,255,.07)}.subtabs{display:flex;gap:7px;overflow:auto;margin:10px 0}.news-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.news-item{padding:15px}.news-item a{color:white;text-decoration:none;font-weight:700;font-size:12px}.news-item small{display:block;color:var(--muted);margin-top:7px}.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.setting{padding:15px}.setting-row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid rgba(24,48,76,.6)}.setting-row:last-child{border-bottom:0}.toggle{appearance:none;width:40px;height:22px;border-radius:20px;background:#1a2940;position:relative;outline:none}.toggle:before{content:"";position:absolute;width:16px;height:16px;top:3px;left:3px;border-radius:50%;background:#7890ad;transition:.2s}.toggle:checked{background:var(--accent)}.toggle:checked:before{left:21px;background:white}.colors{display:flex;flex-wrap:wrap;gap:9px;margin-top:12px}.color{width:31px;height:31px;border-radius:9px;border:2px solid transparent;box-shadow:0 5px 15px rgba(0,0,0,.3)}.color.active{border-color:white;transform:scale(1.12)}.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.empty{padding:30px;text-align:center;color:var(--muted)}.footer{color:#62758e;text-align:center;font-size:9px;margin-top:25px}.toast-container{position:fixed;right:18px;bottom:18px;z-index:200;display:grid;gap:8px}.toast{padding:12px 15px;border:1px solid var(--line);background:#0b1628;border-radius:12px;box-shadow:0 10px 30px #0008;font-size:11px}.mobile-nav{display:none}@media(max-width:950px){.sidebar{display:none}main{width:100%;margin:0;padding:15px 12px 90px}.hero{grid-template-columns:1fr}.movement,.tech,.index-grid,.stats-grid{grid-template-columns:1fr 1fr}.mobile-nav{position:fixed;left:0;right:0;bottom:0;height:67px;display:flex;justify-content:space-around;align-items:center;background:rgba(4,10,20,.95);backdrop-filter:blur(18px);border-top:1px solid var(--line);z-index:100}.mobile-nav button{border:0;background:none;color:#7288a4;font-size:9px}.mobile-nav button.active{color:var(--accent)}.mobile-nav span{display:block;font-size:19px;margin-bottom:3px}.settings-grid,.news-grid{grid-template-columns:1fr}}@media(max-width:520px){.topbar h1{font-size:19px}.top-actions{display:none}.ai-card h2{font-size:23px}.price{font-size:27px}.movement,.tech,.index-grid,.stats-grid{grid-template-columns:1fr 1fr}.signal-data{grid-template-columns:1fr 1fr}.two{grid-template-columns:1fr}}

.auth-screen{position:fixed;inset:0;z-index:500;background:radial-gradient(circle at 50% 10%,rgba(118,87,255,.22),transparent 35%),#050914;display:grid;place-items:center;padding:20px}.auth-card{width:min(430px,100%);padding:26px;border:1px solid var(--line);border-radius:24px;background:linear-gradient(145deg,rgba(13,25,45,.98),rgba(6,13,26,.98));box-shadow:0 25px 80px #0009}.auth-logo{display:flex;justify-content:center;align-items:center;gap:10px;margin-bottom:18px}.auth-logo .logo-icon{width:52px;height:52px}.auth-card h2{text-align:center;margin:0 0 7px}.auth-card p{text-align:center;color:var(--muted);font-size:12px;line-height:1.6}.auth-tabs{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:18px 0 10px}.auth-tab{border:1px solid var(--line);background:#081321;color:var(--muted);padding:10px;border-radius:10px}.auth-tab.active{color:var(--accent);border-color:var(--accent);background:rgba(25,230,255,.08)}.auth-input{width:100%;margin-top:9px;border:1px solid var(--line);background:#07111f;color:white;padding:13px;border-radius:12px;outline:none}.auth-actions{display:grid;gap:8px;margin-top:12px}.auth-note{font-size:9px!important;color:#667a94!important;margin-top:12px}.logout-btn{margin-top:10px;width:100%;padding:9px;border:1px solid var(--line);border-radius:10px;background:#091321;color:var(--muted)}.why-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.why-card{padding:13px;border:1px solid var(--line);border-radius:14px;background:rgba(7,17,31,.55)}.why-card b{font-size:10px;color:var(--accent)}.why-card div{font-size:11px;color:var(--muted);line-height:1.7;margin-top:7px}.trade-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.trade-card{padding:16px}.trade-card .trade-head{display:flex;justify-content:space-between;gap:8px;align-items:center}.trade-title{font-weight:900;font-size:15px}.trade-meta{color:var(--muted);font-size:10px;margin-top:4px}.trade-fields{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}.trade-fields div{padding:9px;border-radius:10px;background:rgba(255,255,255,.025);font-size:9px;color:var(--muted)}.trade-fields b{display:block;color:white;font-size:11px;margin-top:4px}.history-tabs{display:flex;gap:7px;margin-bottom:10px}.history-tab{border:1px solid var(--line);background:#081321;color:var(--muted);padding:8px 12px;border-radius:10px;font-size:10px}.history-tab.active{color:var(--accent);border-color:var(--accent)}.history-item{padding:13px;border-bottom:1px solid rgba(24,48,76,.7)}.history-item:last-child{border-bottom:0}.history-item b{font-size:11px}.history-item small{display:block;color:var(--muted);font-size:9px;margin-top:5px;line-height:1.5}@media(max-width:700px){.why-grid,.trade-grid{grid-template-columns:1fr}.trade-fields{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body><div id="authScreen" class="auth-screen"><div class="auth-card"><div class="auth-logo"><div class="logo-icon">E</div><div><div class="logo-name">ERA AI</div><div class="logo-tag">MARKET INTELLIGENCE</div></div></div><h2>Welcome to ERA</h2><p>Login to keep your conversations and trade history connected.</p><div class="auth-tabs"><button class="auth-tab active" data-auth="email">Gmail / Email</button><button class="auth-tab" data-auth="mobile">Mobile</button></div><input id="authInput" class="auth-input" placeholder="Enter Gmail / Email" autocomplete="email"><div class="auth-actions"><button class="primary" id="authContinue">Continue</button><button class="logout-btn" id="guestContinue">Continue as Guest</button></div><p class="auth-note">Google OAuth and real SMS OTP require an auth provider configuration. Guest mode keeps the current ERA working until those credentials are connected.</p></div></div>
<div class="app">
<aside class="sidebar">
  <div class="logo"><div class="logo-icon">E</div><div><div class="logo-name">ERA AI</div><div class="logo-tag">SMARTER ANALYSIS. BETTER TRADES.</div></div></div>
  <div class="nav">
    <button class="active" data-view="home">🏠 &nbsp; Home</button>
    <button data-view="market">📊 &nbsp; Market</button>
    <button data-view="signal">⚡ &nbsp; AI Signal</button>
    <button data-view="options">▦ &nbsp; Option Chain</button>
    <button data-view="portfolio">💼 &nbsp; Portfolio</button>
    <button data-view="news">📰 &nbsp; News & Analysis</button>
    <button data-view="trades">▣ &nbsp; Trades</button>
    <button data-view="era">⚙️ &nbsp; Era</button>
  </div>
  <div class="premium-box"><b>ERA PREMIUM</b><div style="font-size:10px;color:var(--muted);margin-top:4px">Advanced AI market intelligence</div><button class="premium-btn">Go Premium →</button></div>
</aside>
<main>
  <div class="topbar"><div><h1 id="greeting">Good Morning, Trader 👋</h1><div class="live"><span class="live-dot"></span><span id="liveStatus">ERA AI is LIVE • Market Intelligence Active</span></div></div><div class="top-actions"><button class="icon-btn" id="bellBtn">🔔</button><button class="icon-btn" id="refreshBtn">↻</button></div></div>

  <div id="view-home" class="view active">
    <div class="index-tabs" id="homeIndices"><button class="active" data-index="NIFTY">NIFTY 50</button><button data-index="BANKNIFTY">BANKNIFTY</button><button data-index="SENSEX">SENSEX</button><button data-index="FINNIFTY">FINNIFTY</button></div>
    <section class="hero">
      <div class="card ai-card"><div class="ai-top"><div><div class="eyebrow">YOUR AI MARKET ASSISTANT</div><h2>Ask ERA anything.</h2><p>Live market context, technical structure, momentum and movement analysis — all from your home screen.</p></div><div class="online">● AI ONLINE</div></div><div class="robot-area"><div class="robot-glow"></div><div class="robot"><div class="antenna ant-left"><span class="ant-light"></span></div><div class="antenna ant-right"><span class="ant-light"></span></div><div class="eye eye-left"></div><div class="eye eye-right"></div><div class="ear ear-left"></div><div class="ear ear-right"></div><div class="robot-mouth"></div><div class="robot-body"></div></div></div><div class="chat"><input id="homeChat" placeholder="Ask ERA: NIFTY ka trend kya hai?"><button id="homeAsk">Ask ERA</button></div><div id="homeReply" style="margin-top:8px;color:var(--muted);font-size:10px">ERA: Live market context ready.</div></div>
      <div class="card market"><div class="market-header"><div class="market-name" id="homeMarketName">NIFTY 50</div><div class="live-pill">● LIVE</div></div><div class="price" id="homePrice">—</div><div class="change" id="homeChange">Waiting for live data…</div><div class="chart"><svg viewBox="0 0 600 150" preserveAspectRatio="none"><defs><linearGradient id="cg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs><path id="homeArea" d="M0 120 L60 100 L120 110 L180 75 L240 90 L300 55 L360 70 L420 42 L480 60 L540 28 L600 20 L600 150 L0 150Z" fill="url(#cg)"/><path id="homeLine" d="M0 120 L60 100 L120 110 L180 75 L240 90 L300 55 L360 70 L420 42 L480 60 L540 28 L600 20" fill="none" stroke="var(--accent)" stroke-width="3"/></svg></div><div class="market-stats"><div><small>OPEN</small><br><b id="homeOpen">—</b></div><div><small>HIGH</small><br><b id="homeHigh">—</b></div><div><small>LOW</small><br><b id="homeLow">—</b></div></div></div>
    </section>
    <section class="section"><div class="section-title"><h3>Market Movement</h3><span>AI detected</span></div><div class="movement"><div class="card movement-card"><div class="label">MARKET STRUCTURE</div><b id="homeStructure">WAITING</b><small id="homeStructureDetail">Waiting for analysis</small></div><div class="card movement-card"><div class="label">MOMENTUM</div><b id="homeMomentum">—</b><small id="homeMomentumDetail">RSI / VWAP</small></div><div class="card movement-card"><div class="label">MOVEMENT</div><b id="homeMovement">—</b><small id="homeMovementDetail">Live change</small></div><div class="card movement-card"><div class="label">MARKET STATUS</div><b id="homeMarketStatus">—</b><small id="homeMarketStatusDetail">Market closed</small></div></div></section>
    <section class="section"><div class="section-title"><h3>Technical Dashboard</h3><span>Live analysis</span></div><div class="tech"><div class="card tech-card"><small>EMA 9 / 20</small><div class="tech-value" id="homeEma">—</div></div><div class="card tech-card"><small>RSI</small><div class="tech-value" id="homeRsi">—</div></div><div class="card tech-card"><small>VWAP</small><div class="tech-value" id="homeVwap">—</div></div><div class="card tech-card"><small>VOLUME</small><div class="tech-value" id="homeVolume">—</div></div></div></section>
    <section class="section"><div class="section-title"><h3>Today's AI Signal</h3><span>ERA Analysis</span></div><div class="card signal"><div class="signal-top"><div><div class="signal-name">ERA SIGNAL</div><div class="signal-type" id="homeSignal">WAIT</div><div class="trade-meta" id="homeOptionName">No option setup yet</div></div><div class="confidence" id="homeConfidence">—</div></div><div class="signal-data"><div>STRIKE<br><b id="homeStrike">—</b></div><div>ENTRY<br><b id="homeEntry">—</b></div><div>STOP LOSS<br><b id="homeSL">—</b></div><div>TARGET<br><b id="homeTarget">—</b></div></div><div class="why-grid"><div class="why-card"><b>WHY?</b><div id="homeWhy">Waiting for confirmation.</div></div><div class="why-card"><b>WHY WAIT?</b><div id="homeWait">—</div></div></div><div class="confidence-bar"><span id="homeConfidenceBar" style="width:0"></span></div></div></section>
  </div>

  <div id="view-market" class="view"><section class="section"><div class="section-title"><h3>Market</h3><span id="marketUpdated">—</span></div><div class="index-tabs"><button class="active market-index" data-index="NIFTY">NIFTY 50</button><button class="market-index" data-index="BANKNIFTY">BANKNIFTY</button><button class="market-index" data-index="SENSEX">SENSEX</button><button class="market-index" data-index="FINNIFTY">FINNIFTY</button></div><div class="card panel"><div class="price" id="marketPrice">—</div><div id="marketChange">—</div><div class="chart"><svg viewBox="0 0 600 150" preserveAspectRatio="none"><path d="M0 120 L50 105 L100 115 L150 70 L200 92 L250 55 L300 72 L350 45 L400 62 L450 35 L500 50 L550 25 L600 18" fill="none" stroke="var(--accent)" stroke-width="3"/></svg></div><div class="stats-grid"><div class="stat"><small>OPEN</small><strong id="marketOpen">—</strong></div><div class="stat"><small>HIGH</small><strong id="marketHigh">—</strong></div><div class="stat"><small>LOW</small><strong id="marketLow">—</strong></div><div class="stat"><small>PREV CLOSE</small><strong id="marketPrev">—</strong></div></div></div></section></div>

  <div id="view-signal" class="view"><section class="section"><div class="section-title"><h3>AI Signal</h3><span>Selected index</span></div><div class="card signal"><div class="signal-top"><div><div class="signal-name">ERA SIGNAL</div><div class="signal-type" id="signalType">WAIT</div><div class="trade-meta" id="signalOptionName">No option setup yet</div></div><div class="confidence" id="signalConfidence">—</div></div><div class="signal-data"><div>STRIKE<br><b id="signalStrike">—</b></div><div>ENTRY<br><b id="signalEntry">—</b></div><div>SL<br><b id="signalSL">—</b></div><div>TARGET 1<br><b id="signalT1">—</b></div></div><div class="confidence-bar"><span id="signalBar"></span></div></div></section><section class="section"><div class="why-grid"><div class="card why-card"><b>WHY ERA GAVE THIS</b><div id="signalReasons">Waiting for analysis…</div></div><div class="card why-card"><b>WHY ERA IS WAITING</b><div id="signalWait">—</div></div></div></section></div>

  <div id="view-options" class="view"><section class="section"><div class="section-title"><h3>Option Chain</h3><span id="optionUpdated">—</span></div><div class="subtabs"><button class="active option-index" data-index="NIFTY">NIFTY</button><button class="option-index" data-index="BANKNIFTY">BANKNIFTY</button><button class="option-index" data-index="FINNIFTY">FINNIFTY</button><button class="option-index" data-index="SENSEX">SENSEX</button></div><div class="card panel"><div class="two"><select class="select" id="expirySelect"><option>Loading expiry…</option></select><div class="pill" id="optionSpot">Spot —</div></div><div class="table-wrap" style="margin-top:12px"><table class="table"><thead><tr><th>CE LTP</th><th>CE OI</th><th>CE ΔOI</th><th>STRIKE</th><th>PE ΔOI</th><th>PE OI</th><th>PE LTP</th></tr></thead><tbody id="optionRows"><tr><td colspan="7" class="empty">Load option chain to view data.</td></tr></tbody></table></div><div class="two" style="margin-top:12px"><div class="pill" id="optionPCR">PCR —</div><div class="pill" id="optionSentiment">Sentiment —</div></div></div></section></div>

  <div id="view-portfolio" class="view"><section class="section"><div class="section-title"><h3>Portfolio</h3><span>Local journal</span></div><div class="stats-grid"><div class="card stat"><small>OPEN POSITIONS</small><strong id="portfolioCount">0</strong></div><div class="card stat"><small>RECENT RECORDS</small><strong id="historyCount">0</strong></div><div class="card stat"><small>ENGINE</small><strong id="portfolioEngine">—</strong></div><div class="card stat"><small>LAST SCAN</small><strong id="portfolioScan">—</strong></div></div></section><section class="section"><div class="card panel"><div class="panel-head"><h3>Positions / Trade Journal</h3><span>Saved locally on server</span></div><div class="table-wrap"><table class="table"><thead><tr><th>INDEX</th><th>TYPE</th><th>STRIKE</th><th>ENTRY</th><th>SL</th><th>TARGET</th><th>CONF.</th></tr></thead><tbody id="portfolioRows"><tr><td colspan="7" class="empty">No active trades.</td></tr></tbody></table></div></div></section></div>

  <div id="view-news" class="view"><section class="section"><div class="section-title"><h3>News & Analysis</h3><span id="newsUpdated">—</span></div><div class="news-grid" id="newsGrid"><div class="card news-item">Loading news…</div></div></section></div>

  <div id="view-trades" class="view"><section class="section"><div class="section-title"><h3>Trades</h3><span>ERA generated setups</span></div><div class="trade-grid" id="tradesGrid"><div class="card trade-card">Waiting for ERA setups…</div></div></section></div>

  <div id="view-era" class="view"><section class="section"><div class="section-title"><h3>Era</h3><span>Settings</span></div><div class="card panel"><div class="eyebrow">ERA AI</div><h2 style="margin:7px 0">Smarter Analysis. Better Trades.</h2><p style="color:var(--muted);font-size:12px">Customize your ERA experience.</p></div></section><section class="section"><div class="settings-grid"><div class="card setting"><div class="panel-head"><b>Appearance</b><span class="pill">12 THEMES</span></div><div style="color:var(--muted);font-size:10px;margin-top:5px">Color Theme</div><div class="colors" id="colorOptions"></div></div><div class="card setting"><div class="panel-head"><b>Trading Settings</b></div><label class="setting-row">Movement threshold <input id="movementThreshold" class="text-input" style="width:100px;flex:0 0 100px;padding:8px" type="number" min="1"></label><label class="setting-row">Minimum confidence <input id="minConfidence" class="text-input" style="width:100px;flex:0 0 100px;padding:8px" type="number" min="1" max="100"></label><button class="primary" id="saveSettings">Save Settings</button></div></div></section><section class="section"><div class="card setting"><div class="panel-head"><b>Notifications</b><span class="pill">PUSH</span></div><label class="setting-row">Market movement <input class="toggle notify" data-key="movement" type="checkbox"></label><label class="setting-row">Trade setup <input class="toggle notify" data-key="tradeSetup" type="checkbox"></label><label class="setting-row">Market open <input class="toggle notify" data-key="marketOpen" type="checkbox"></label><label class="setting-row">News <input class="toggle notify" data-key="news" type="checkbox"></label></div></section><section class="section"><div class="card setting"><div class="panel-head"><b>History</b><button class="pill" id="refreshHistory">Refresh</button></div><div class="history-tabs"><button class="history-tab active" data-history="all">All</button><button class="history-tab" data-history="chat">Chat</button><button class="history-tab" data-history="trade">Trades</button></div><div id="historyList" class="history-item">Loading history…</div></div></section><section class="section"><div class="card setting"><div class="panel-head"><b>Account</b><span class="pill" id="accountStatus">GUEST</span></div><div id="accountInfo" style="color:var(--muted);font-size:11px;margin-top:8px">Guest session</div><button class="logout-btn" id="logoutBtn">Log out</button></div></section></div>

  <footer class="footer">Era AI V8.0 · Autonomous Market Intelligence · Data and signals are informational and require independent verification.</footer>
</main></div>
<nav class="mobile-nav"><button class="active" data-view="home"><span>⌂</span>Home</button><button data-view="trades"><span>▣</span>Trades</button><button data-view="options"><span>▦</span>Options</button><button data-view="news"><span>▤</span>News</button><button data-view="era"><span>✦</span>Era</button></nav>
<div class="toast-container" id="toastContainer"></div>
<script>
'use strict';
const BACKEND='https://era-ai.onrender.com';
const S={index:localStorage.getItem('eraSelectedIndex')||'NIFTY',market:{},analysis:{},activeTrades:[],settings:{},optionIndex:'NIFTY',history:[],historyFilter:'all'};
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const num=v=>Number.isFinite(Number(v))?Number(v):null;
const fmt=v=>num(v)===null?'—':Number(v).toLocaleString('en-IN',{maximumFractionDigits:2});
const pct=v=>num(v)===null?'—':`${Number(v)>0?'+':''}${Number(v).toFixed(2)}%`;
function toast(msg){const d=document.createElement('div');d.className='toast';d.textContent=msg;$('toastContainer').appendChild(d);setTimeout(()=>d.remove(),3500)}
async function api(path,opts={}){const r=await fetch(BACKEND+path,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});let data={};try{data=await r.json()}catch{}if(!r.ok)throw new Error(data.error?.message||data.error||`HTTP ${r.status}`);return data}
function setView(view){document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));$('view-'+view)?.classList.add('active');document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view===view));window.scrollTo({top:0,behavior:'smooth'});if(view==='options')loadOptions();if(view==='news')loadNews();if(view==='era'){loadSettings();loadHistory()}if(view==='trades')renderTrades()}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
function selected(){return S.analysis[S.index]||null}
function marketOf(){return S.market[S.index]||selected()?.market||null}
function whyText(a){const reasons=a?.reasons||[];return reasons.length?reasons.slice(0,3).join(' • '):(a?.suggestion||'No strong confirmation yet.')}
function waitText(a){const risks=a?.risks||[];return risks.length?risks.slice(0,3).join(' • '):(a?.suggestion==='TRADE CONSIDER'?'No major wait condition.':'ERA is waiting for stronger confirmation.')}
function renderHome(){const m=marketOf(),a=selected();if(!m)return;$('homeMarketName').textContent=m.name||S.index;$('homePrice').textContent=fmt(m.price);const ch=num(m.changePercent??m.change_pct);$('homeChange').textContent=ch===null?(m.change||'—'):pct(ch);$('homeChange').className=(ch??0)>=0?'change bullish':'change bearish';$('homeOpen').textContent=fmt(m.open);$('homeHigh').textContent=fmt(m.high);$('homeLow').textContent=fmt(m.low);if(!a)return;const t=a.technical||{};$('homeStructure').textContent=t.structure?.label||a.structure?.label||a.movement?.direction||'WAITING';$('homeStructureDetail').textContent=(t.structure?.bos?'BOS • ':'')+(t.structure?.choch?'CHOCH • ':'')+(t.structure?.label||'Structure');const dir=a.movement?.direction||'NONE';$('homeMovement').textContent=a.movement?.percent!==undefined?pct(a.movement.percent):dir;$('homeMovement').className=dir==='UP'?'bullish':dir==='DOWN'?'bearish':'sideways';$('homeMovementDetail').textContent=dir==='UP'?'Bullish expansion':dir==='DOWN'?'Bearish expansion':'Range / confirmation';$('homeMomentum').textContent=t.rsi>=60?'STRONG':t.rsi<=40?'WEAK':'BALANCED';$('homeMomentumDetail').textContent=`RSI ${fmt(t.rsi)} • VWAP ${fmt(t.vwap)}`;$('homeMarketStatus').textContent=S.marketOpen?'LIVE':'CLOSED';$('homeMarketStatus').className=S.marketOpen?'bullish':'sideways';$('homeMarketStatusDetail').textContent=S.marketOpen?'Market is open':'Market is closed';$('homeEma').textContent=`${fmt(t.ema9)} / ${fmt(t.ema20)}`;$('homeRsi').textContent=fmt(t.rsi);$('homeVwap').textContent=fmt(t.vwap);$('homeVolume').textContent=fmt(t.volume||m.volume);const tr=a.trades?.[0];$('homeSignal').textContent=tr?`${tr.optionType||''} ${tr.signal||'BUY'}`:(a.suggestion||'WAIT');$('homeOptionName').textContent=tr?`${S.index} ${tr.optionType} • Strike ${fmt(tr.strike)}`:'No option setup yet';$('homeConfidence').textContent=`${a.confidence??'—'}% CONFIDENCE`;$('homeConfidenceBar').style.width=`${Math.max(0,Math.min(100,Number(a.confidence)||0))}%`;$('homeStrike').textContent=tr?fmt(tr.strike):'—';$('homeEntry').textContent=tr?fmt(tr.entry):'—';$('homeSL').textContent=tr?fmt(tr.stopLoss):'—';$('homeTarget').textContent=tr?fmt(tr.targets?.[0]):'—';$('homeWhy').textContent=whyText(a);$('homeWait').textContent=waitText(a)}
function renderMarket(){const m=marketOf();if(!m)return;$('marketPrice').textContent=fmt(m.price);const ch=num(m.changePercent??m.change_pct);$('marketChange').textContent=ch===null?(m.change||'—'):pct(ch);$('marketChange').className=(ch??0)>=0?'bullish':'bearish';$('marketOpen').textContent=fmt(m.open);$('marketHigh').textContent=fmt(m.high);$('marketLow').textContent=fmt(m.low);$('marketPrev').textContent=fmt(m.previousClose??m.prevClose)}
function renderSignal(){const a=selected(),tr=a?.trades?.[0];$('signalType').textContent=tr?`${tr.optionType||''} ${tr.signal||'BUY'}`:(a?.suggestion||'WAIT');$('signalOptionName').textContent=tr?`${S.index} ${tr.optionType} • Strike ${fmt(tr.strike)}`:'No option setup yet';$('signalConfidence').textContent=a?`${a.confidence}% CONFIDENCE`:'—';$('signalBar').style.width=`${Math.max(0,Math.min(100,Number(a?.confidence)||0))}%`;$('signalStrike').textContent=tr?fmt(tr.strike):'—';$('signalEntry').textContent=tr?fmt(tr.entry):'—';$('signalSL').textContent=tr?fmt(tr.stopLoss):'—';$('signalT1').textContent=tr?fmt(tr.targets?.[0]):'—';$('signalReasons').textContent=whyText(a);$('signalWait').textContent=waitText(a)}
function renderPortfolio(){const rows=S.activeTrades||[];$('portfolioCount').textContent=rows.length;$('historyCount').textContent=S.history.length;$('portfolioEngine').textContent=S.settings?.engineRunning?'RUNNING':'—';$('portfolioScan').textContent=S.settings?.lastScan?new Date(S.settings.lastScan).toLocaleTimeString('en-IN'):'—';$('portfolioRows').innerHTML=rows.length?rows.slice(0,30).map(t=>`<tr><td>${esc(t.index)}</td><td>${esc(t.optionType)} ${esc(t.signal)}</td><td>${fmt(t.strike)}</td><td>${fmt(t.entry)}</td><td>${fmt(t.stopLoss)}</td><td>${fmt(t.targets?.[0])}</td><td>${esc(t.confidence)}%</td></tr>`).join(''):'<tr><td colspan="7" class="empty">No active trades.</td></tr>'}
function renderTrades(){const rows=S.activeTrades||[];$('tradesGrid').innerHTML=rows.length?rows.map((t,i)=>`<div class="card trade-card"><div class="trade-head"><div><div class="trade-title">${esc(t.index)} ${esc(t.optionType)} • ${esc(t.signal)}</div><div class="trade-meta">${t.status||'SETUP'} • ${esc(t.direction||'')} • ${esc(t.confidence)}% confidence</div></div><span class="pill">${fmt(t.strike)}</span></div><div class="trade-fields"><div>OPTION<b>${esc(t.optionType)}</b></div><div>STRIKE<b>${fmt(t.strike)}</b></div><div>ENTRY<b>${fmt(t.entry)}</b></div><div>STOP LOSS<b>${fmt(t.stopLoss)}</b></div><div>TARGET 1<b>${fmt(t.targets?.[0])}</b></div><div>TARGET 2<b>${fmt(t.targets?.[1])}</b></div></div><div style="margin-top:10px;color:var(--muted);font-size:10px">RR 1:${esc(t.rr)} • ${esc(t.invalidation||'Risk condition defined')}</div></div>`).join(''):'<div class="card trade-card">ERA has no active trade setup right now.</div>'}
async function loadAnalysis(){try{const d=await api('/api/analysis?index='+encodeURIComponent(S.index));S.market=d.market||d.markets||{};S.analysis=d.analysis||d.indexes||{};S.activeTrades=d.activeTrades||[];S.marketOpen=Boolean(d.marketOpen);S.settings={...S.settings,engineRunning:d.engineRunning,lastScan:d.lastScan};renderHome();renderMarket();renderSignal();renderPortfolio();renderTrades();$('marketUpdated').textContent=new Date(d.updatedAt||Date.now()).toLocaleTimeString('en-IN');$('liveStatus').textContent=d.marketOpen?'ERA AI is LIVE • Market Intelligence Active':'ERA AI online • Market closed';}catch(e){$('liveStatus').textContent='ERA AI online • Live data unavailable';toast('Market refresh: '+e.message)}}
async function loadNews(){try{const d=await api('/api/news');$('newsUpdated').textContent=new Date(d.updatedAt||Date.now()).toLocaleTimeString('en-IN');$('newsGrid').innerHTML=(d.news||[]).slice(0,20).map(n=>`<div class="card news-item"><a href="${esc(n.link||'#')}" target="_blank" rel="noopener">${esc(n.title)}</a><small>${esc(n.pubDate||'')}</small></div>`).join('')||'<div class="card news-item">No news available.</div>'}catch(e){toast('News: '+e.message)}}
async function loadOptions(){try{const d=await api(`/api/options/chain?index=${S.optionIndex}`);S.optionData=d;const rows=d.rows||d.data||[];$('optionSpot').textContent='Spot '+fmt(d.spot);$('optionUpdated').textContent=new Date(d.updatedAt||Date.now()).toLocaleTimeString('en-IN');$('optionPCR').textContent=`PCR ${fmt(d.summary?.pcr)}`;$('optionSentiment').textContent=`Sentiment ${d.summary?.sentiment||'—'}`;$('optionRows').innerHTML=rows.map((r,i)=>`<tr class="${i===Math.floor(rows.length/2)?'selected-row':''}"><td>${fmt(r.call?.ltp)}</td><td>${fmt(r.call?.oi)}</td><td>${fmt(r.call?.changeOI)}</td><td><b>${fmt(r.strike)}</b></td><td>${fmt(r.put?.changeOI)}</td><td>${fmt(r.put?.oi)}</td><td>${fmt(r.put?.ltp)}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">No option rows available.</td></tr>';const exp=d.expiry?String(d.expiry):'';$('expirySelect').innerHTML=`<option>${esc(exp||'Current expiry')}</option>`}catch(e){$('optionRows').innerHTML=`<tr><td colspan="7" class="empty">${esc(e.message)}</td></tr>`}}
async function loadSettings(){try{const d=await api('/api/settings');S.settings=d.settings||{};$('movementThreshold').value=S.settings.movementThreshold??20;$('minConfidence').value=S.settings.minConfidence??60;document.querySelectorAll('.notify').forEach(x=>x.checked=S.settings.notifications?.[x.dataset.key]!==false)}catch(e){toast('Settings: '+e.message)}}
async function saveSettings(){try{const notifications={};document.querySelectorAll('.notify').forEach(x=>notifications[x.dataset.key]=x.checked);const d=await api('/api/settings',{method:'POST',body:JSON.stringify({movementThreshold:Number($('movementThreshold').value),minConfidence:Number($('minConfidence').value),notifications})});S.settings=d.settings;toast('ERA settings saved')}catch(e){toast('Save failed: '+e.message)}}
async function loadHistory(){try{const d=await api('/api/history');S.history=d.history||[];renderHistory()}catch(e){toast('History: '+e.message)}}
function renderHistory(){const f=S.historyFilter;const rows=S.history.filter(x=>f==='all'||x.type===f);$('historyList').innerHTML=rows.length?rows.slice(0,200).map(x=>x.type==='chat'?`<div class="history-item"><b>CHAT</b><small>${esc(x.createdAt?new Date(x.createdAt).toLocaleString('en-IN'):'')}<br><strong>You:</strong> ${esc(x.userMessage||'')}<br><strong>ERA:</strong> ${esc(x.answer||'')}</small></div>`:`<div class="history-item"><b>TRADE • ${esc(x.index||'')} ${esc(x.optionType||'')}</b><small>${esc(x.createdAt?new Date(x.createdAt).toLocaleString('en-IN'):'')}<br>Strike ${fmt(x.strike)} • Entry ${fmt(x.entry)} • SL ${fmt(x.stopLoss)} • Target ${fmt(x.targets?.[0])} • Confidence ${esc(x.confidence)}%</small></div>`).join(''):'<div class="history-item">No history yet.</div>'}
async function askEra(){const input=$('homeChat'),q=input.value.trim();if(!q)return;$('homeReply').textContent='ERA: Thinking…';try{const d=await api('/api/chat',{method:'POST',body:JSON.stringify({message:q,index:S.index})});$('homeReply').textContent='ERA: '+(d.answer||'No response');input.value='';loadHistory()}catch(e){$('homeReply').textContent='ERA: '+e.message}}
function selectIndex(k){S.index=k;localStorage.setItem('eraSelectedIndex',k);document.querySelectorAll('[data-index]').forEach(x=>x.classList.toggle('active',x.dataset.index===k));renderHome();renderMarket();renderSignal()}
document.querySelectorAll('#homeIndices button,.market-index').forEach(b=>b.onclick=()=>selectIndex(b.dataset.index));document.querySelectorAll('.option-index').forEach(b=>b.onclick=()=>{S.optionIndex=b.dataset.index;document.querySelectorAll('.option-index').forEach(x=>x.classList.toggle('active',x===b));loadOptions()});$('homeAsk').onclick=askEra;$('homeChat').addEventListener('keydown',e=>{if(e.key==='Enter')askEra()});$('refreshBtn').onclick=loadAnalysis;$('saveSettings').onclick=saveSettings;$('bellBtn').onclick=()=>toast('Notification settings are available in Era → Settings');$('refreshHistory').onclick=loadHistory;document.querySelectorAll('.history-tab').forEach(b=>b.onclick=()=>{S.historyFilter=b.dataset.history;document.querySelectorAll('.history-tab').forEach(x=>x.classList.toggle('active',x===b));renderHistory()});
let authMode='email';
function showApp(){if($('authScreen'))$('authScreen').style.display='none';document.querySelector('.app').style.display='block';const u=localStorage.getItem('eraUser')||'Guest';$('accountStatus').textContent=u==='Guest'?'GUEST':'SIGNED IN';$('accountInfo').textContent=u;}
function showAuth(){if($('authScreen'))$('authScreen').style.display='grid';document.querySelector('.app').style.display='none';}
document.querySelectorAll('.auth-tab').forEach(b=>b.onclick=()=>{authMode=b.dataset.auth;document.querySelectorAll('.auth-tab').forEach(x=>x.classList.toggle('active',x===b));$('authInput').placeholder=authMode==='email'?'Enter Gmail / Email':'Enter mobile number';$('authInput').inputMode=authMode==='email'?'email':'tel'});
$('guestContinue').onclick=()=>{localStorage.setItem('eraUser','Guest');showApp()};
$('authContinue').onclick=()=>{const v=$('authInput').value.trim();if(!v){toast('Enter your Gmail/email or mobile number');return}localStorage.setItem('eraUser',v);showApp();toast('Local session started. Connect Google/SMS provider for verified login.')};
$('logoutBtn').onclick=()=>{localStorage.removeItem('eraUser');showAuth()};
if(localStorage.getItem('eraUser'))showApp();else showAuth();
const themes=[['Cyan','19e6ff','7657ff'],['Violet','9b5cff','ff4fd8'],['Electric Blue','3da5ff','315cff'],['Emerald','28e69b','00b894'],['Lime','b6f36b','20d66b'],['Amber','ffc857','ff7a45'],['Rose','ff5b8a','9b4dff'],['Ice','b8f4ff','5b8cff'],['Aqua','18f1d1','087cff'],['Neon Pink','ff3cac','784ba0'],['Solar','ffcf4a','ff5e5e'],['Royal','6f63ff','00d4ff']];function rgb(h){return[parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)].join(',')}function applyTheme(i){const t=themes[i];document.documentElement.style.setProperty('--accent','#'+t[1]);document.documentElement.style.setProperty('--accent2','#'+t[2]);document.documentElement.style.setProperty('--glow',`rgba(${rgb(t[1])},.25)`);localStorage.setItem('eraTheme',i);document.querySelectorAll('.color').forEach((x,n)=>x.classList.toggle('active',n===i))}themes.forEach((t,i)=>{const b=document.createElement('button');b.className='color';b.title=t[0];b.style.background=`linear-gradient(135deg,#${t[1]},#${t[2]})`;b.onclick=()=>applyTheme(i);$('colorOptions').appendChild(b)});applyTheme(Number(localStorage.getItem('eraTheme')||0));
(async()=>{await loadAnalysis();setInterval(loadAnalysis,15000);setInterval(()=>{if(document.getElementById('view-news').classList.contains('active'))loadNews()},300000)})();
</script>
</body>
</html>
