from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import math
import threading
import time
import requests
import yfinance as yf


class BaseDataSource(ABC):
    """
    Standard interface for all data sources in the multi-chart application.
    Any new data source (e.g. Alpaca, Binance, Polygon) must inherit from this
    class and implement the abstract methods below.
    """

    @abstractmethod
    def get_historical_data(
        self, symbol: str, timeframe: str, end_time: int = None, limit: int = 1000
    ):
        """
        Fetch historical candle data.

        Args:
            symbol (str): Symbol name (e.g., 'BTC', 'THYAO.IS')
            timeframe (str): Timeframe ('1m', '5m', '15m', '45m', '1h', '4h', '1d', '1w')
            end_time (int, optional): Exclusive upper bound UNIX timestamp in seconds.
            limit (int, optional): Maximum number of candles to return.

        Returns:
            list: List of dicts representing candles, sorted chronologically.
                  Format: [
                      {
                          'time': int (UNIX timestamp in seconds),
                          'open': float,
                          'high': float,
                          'low': float,
                          'close': float,
                          'volume': float
                      },
                      ...
                  ]
        """
        pass

    @abstractmethod
    def get_streaming_config(self, symbol: str, timeframe: str):
        """
        Return streaming configuration details for the frontend to consume.
        This enables a pluggable interface where the frontend dynamically configures
        its WebSocket or SSE connections.

        Args:
            symbol (str): Symbol name
            timeframe (str): Timeframe

        Returns:
            dict: Streaming configuration metadata.
                  Format for WebSockets:
                  {
                      'type': 'websocket',
                      'url': str,
                      'subscription': dict
                  }
                  Format for SSE:
                  {
                      'type': 'sse',
                      'url': str
                  }
        """
        pass


def aggregate_candles(candles: list, interval_minutes: int) -> list:
    """
    Aggregate lower-interval candles (e.g. 15m) into a higher custom interval (e.g. 45m).
    """
    if not candles:
        return []

    interval_seconds = interval_minutes * 60
    aggregated = []
    current_group = []
    current_boundary = None

    for c in candles:
        c_time = c['time']
        boundary = (c_time // interval_seconds) * interval_seconds

        if current_boundary is None:
            current_boundary = boundary

        if boundary == current_boundary:
            current_group.append(c)
        else:
            if current_group:
                aggregated.append({
                    'time': current_boundary,
                    'open': current_group[0]['open'],
                    'high': max(x['high'] for x in current_group),
                    'low': min(x['low'] for x in current_group),
                    'close': current_group[-1]['close'],
                    'volume': sum(x['volume'] for x in current_group)
                })
            current_boundary = boundary
            current_group = [c]

    if current_group:
        aggregated.append({
            'time': current_boundary,
            'open': current_group[0]['open'],
            'high': max(x['high'] for x in current_group),
            'low': min(x['low'] for x in current_group),
            'close': current_group[-1]['close'],
            'volume': sum(x['volume'] for x in current_group)
        })

    return aggregated


def _clamp_limit(limit: int | None, default: int = 1000, maximum: int = 1500) -> int:
    """Clamp requested candle limit into [1, maximum]."""
    try:
        val = int(limit) if limit is not None else default
    except (TypeError, ValueError):
        val = default
    return max(1, min(val, maximum))


class HyperliquidDataSource(BaseDataSource):
    """
    Data source abstraction for Hyperliquid Crypto Perpetual / Spot exchange.
    Connects directly to Hyperliquid Info API for history, and guides client to connect
    via client-side WebSockets.
    """

    INFO_API_URL = "https://api.hyperliquid.xyz/info"
    WS_URL = "wss://api.hyperliquid.xyz/ws"

    def __init__(self):
        self.spot_cache = {}  # token_name -> universe_name (e.g. 'HFUN' -> '@1')
        self.last_cache_update = 0
        self._cache_lock = threading.Lock()

    def _update_spot_cache(self):
        with self._cache_lock:
            now = time.time()
            if not self.spot_cache or (now - self.last_cache_update > 3600):
                try:
                    headers = {"Content-Type": "application/json"}
                    spot_res = requests.post(
                        self.INFO_API_URL, json={"type": "spotMeta"}, headers=headers, timeout=5
                    )
                    if spot_res.status_code == 200:
                        spot_data = spot_res.json()
                        tokens = spot_data.get("tokens", [])
                        universe = spot_data.get("universe", [])

                        token_map = {
                            t["index"]: t["name"].upper()
                            for t in tokens
                            if "index" in t and "name" in t
                        }

                        new_cache = {}
                        for pair in universe:
                            pair_name = pair.get("name")  # e.g., '@1' or 'PURR/USDC'
                            pair_tokens = pair.get("tokens", [])
                            if len(pair_tokens) >= 2:
                                base_idx = pair_tokens[0]
                                base_name = token_map.get(base_idx)
                                if base_name and pair_name:
                                    new_cache[base_name] = pair_name

                        self.spot_cache = new_cache
                        self.last_cache_update = now
                except Exception as e:
                    print(f"Error updating Hyperliquid spot cache in data_source: {e}", flush=True)

    def resolve_symbol(self, symbol: str) -> str:
        symbol_upper = symbol.strip().upper()
        # If it is already an index notation or explicit pair, use it directly
        if symbol_upper.startswith('@') or '/' in symbol_upper:
            return symbol_upper

        self._update_spot_cache()
        if symbol_upper in self.spot_cache:
            return self.spot_cache[symbol_upper]

        return symbol_upper

    def get_historical_data(
        self, symbol: str, timeframe: str, end_time: int = None, limit: int = 1000
    ):
        resolved_symbol = self.resolve_symbol(symbol)
        limit_val = _clamp_limit(limit, default=1000, maximum=1500)
        end_ts = int(end_time) if end_time is not None else None
        end_time_ms = end_ts * 1000 if end_ts is not None else int(time.time() * 1000)

        tf_ms = {
            '1m': 60 * 1000,
            '5m': 5 * 60 * 1000,
            '15m': 15 * 60 * 1000,
            '45m': 15 * 60 * 1000,  # Request 15m and aggregate
            '1h': 60 * 60 * 1000,
            '4h': 4 * 60 * 60 * 1000,
            '1d': 24 * 60 * 60 * 1000,
            '1w': 7 * 24 * 60 * 60 * 1000
        }

        interval_ms = tf_ms.get(timeframe, 60 * 1000)
        request_interval = '15m' if timeframe == '45m' else timeframe

        if timeframe == '45m':
            req_count = min(limit_val * 3, 3000)
            start_time_ms = max(0, end_time_ms - (req_count * 15 * 60 * 1000))
        else:
            start_time_ms = max(0, end_time_ms - (limit_val * interval_ms))

        payload = {
            "type": "candleSnapshot",
            "req": {
                "coin": resolved_symbol,
                "interval": request_interval,
                "startTime": start_time_ms,
                "endTime": end_time_ms
            }
        }

        headers = {"Content-Type": "application/json"}
        response = requests.post(self.INFO_API_URL, json=payload, headers=headers, timeout=10)

        if response.status_code != 200:
            raise Exception(f"Hyperliquid API error: {response.text}")

        data = response.json()
        if not isinstance(data, list):
            raise Exception(f"Unexpected response format from Hyperliquid: {data}")

        if not data and end_ts is not None:
            return []

        candles = []
        for c in data:
            candles.append({
                'time': int(c['t'] / 1000),  # convert to seconds
                'open': float(c['o']),
                'high': float(c['h']),
                'low': float(c['l']),
                'close': float(c['c']),
                'volume': float(c['v'])
            })

        # Ensure they are sorted by time ascending
        candles.sort(key=lambda x: x['time'])

        if timeframe == '45m':
            candles = aggregate_candles(candles, 45)

        if end_ts is not None:
            candles = [c for c in candles if c['time'] < end_ts]

        return candles

    def get_streaming_config(self, symbol: str, timeframe: str):
        resolved_symbol = self.resolve_symbol(symbol)
        # If 45m is requested, client subscribes to 15m websocket feed and aggregates in UI
        request_interval = '15m' if timeframe == '45m' else timeframe

        return {
            'type': 'websocket',
            'url': self.WS_URL,
            'subscription': {
                'method': 'subscribe',
                'subscription': {
                    'type': 'candle',
                    'coin': resolved_symbol,
                    'interval': request_interval
                }
            }
        }


def _df_to_candles(df) -> list:
    """Convert a yfinance OHLCV DataFrame into sorted candle dicts."""
    candles = []
    for index, row in df.iterrows():
        open_val = float(row['Open'])
        high_val = float(row['High'])
        low_val = float(row['Low'])
        close_val = float(row['Close'])
        vol_raw = float(row['Volume'])
        vol_val = 0.0 if math.isnan(vol_raw) else vol_raw
        if any(math.isnan(v) for v in (open_val, high_val, low_val, close_val)):
            continue
        candles.append({
            'time': int(index.timestamp()),
            'open': open_val,
            'high': high_val,
            'low': low_val,
            'close': close_val,
            'volume': vol_val
        })
    candles.sort(key=lambda x: x['time'])
    return candles


class YFinanceDataSource(BaseDataSource):
    """
    Data source abstraction for Yahoo Finance (e.g. Turkish stocks like THYAO.IS).
    Fetches historical data via yfinance, and provides streaming configuration directing
    the frontend to the local Flask SSE endpoint.
    """

    def get_historical_data(
        self, symbol: str, timeframe: str, end_time: int = None, limit: int = 1000
    ):
        # Map timeframe to yfinance period and interval parameters
        tf_map = {
            '1m': ('5d', '1m'),
            '5m': ('5d', '5m'),
            '15m': ('5d', '15m'),
            '45m': ('30d', '15m'),  # Request 15m and aggregate
            '1h': ('1mo', '1h'),
            '4h': ('1y', '4h'),
            '1d': ('1y', '1d'),
            '1w': ('5y', '1wk')  # 1w maps to yfinance '1wk'
        }
        period, interval = tf_map.get(timeframe, ('5d', '1m'))

        if end_time is None:
            try:
                ticker = yf.Ticker(symbol)
                df = ticker.history(period=period, interval=interval)

                if df is None or df.empty:
                    raise Exception(f"No historical data returned for symbol: {symbol}")

                candles = _df_to_candles(df)
                if timeframe == '45m':
                    candles = aggregate_candles(candles, 45)
                return candles
            except Exception as e:
                raise Exception(f"Yahoo Finance error for symbol {symbol}: {str(e)}")

        end_ts = int(end_time)
        limit_val = _clamp_limit(limit, default=1000, maximum=1500)
        end_dt = datetime.fromtimestamp(end_ts, tz=timezone.utc)
        now_utc = datetime.now(timezone.utc)

        lookback_days_map = {
            '1m': 6,
            '5m': 30,
            '15m': 30,
            '45m': 30,
            '1h': 180,
            '4h': 365,
            '1d': 730,
            '1w': 1825,
        }
        lookback_days = lookback_days_map.get(timeframe, 30)
        start_dt = end_dt - timedelta(days=lookback_days)

        # Respect yfinance intraday retention windows
        if timeframe == '1m':
            min_allowed = now_utc - timedelta(days=7)
            if end_dt <= min_allowed:
                return []
            if start_dt < min_allowed:
                start_dt = min_allowed + timedelta(minutes=1)
        elif timeframe in ('5m', '15m', '45m'):
            min_allowed = now_utc - timedelta(days=59)
            if end_dt <= min_allowed:
                return []
            if start_dt < min_allowed:
                start_dt = min_allowed
        elif timeframe in ('1h', '4h'):
            min_allowed = now_utc - timedelta(days=729)
            if end_dt <= min_allowed:
                return []
            if start_dt < min_allowed:
                start_dt = min_allowed

        if start_dt >= end_dt:
            return []

        try:
            ticker = yf.Ticker(symbol)
            df = ticker.history(start=start_dt, end=end_dt, interval=interval)
            if df is None or df.empty:
                return []

            candles = _df_to_candles(df)
            if timeframe == '45m':
                candles = aggregate_candles(candles, 45)
            candles = [c for c in candles if c['time'] < end_ts]
            if len(candles) > limit_val:
                candles = candles[-limit_val:]
            return candles
        except Exception:
            return []

    def get_streaming_config(self, symbol: str, timeframe: str):
        # We redirect the client to connect to our local Server-Sent Events stream
        return {
            'type': 'sse',
            'url': f'/api/stream/yfinance?symbol={symbol}'
        }


# Global registry of data sources
SOURCES = {
    'hyperliquid': HyperliquidDataSource(),
    'yfinance': YFinanceDataSource()
}


def get_source(name: str) -> BaseDataSource:
    """Helper to retrieve a data source by name."""
    return SOURCES.get(name.lower())


_HL_QUOTE_TTL = 4.0
_YF_QUOTE_TTL = 10.0

_hl_quote_lock = threading.Lock()
_hl_quote_cache = {
    "perp_ts": 0.0,
    "perp": {},
    "spot_ts": 0.0,
    "spot_by_pair": {},
    "spot_by_token": {},
}

_yf_quote_lock = threading.Lock()
_yf_quote_cache = {}  # symbol_upper -> {"ts": float, "quote": dict}


def _extract_hl_quote(ctx: dict) -> dict | None:
    """Extract {price, changePct} from a Hyperliquid asset context dict."""
    if not isinstance(ctx, dict):
        return None
    raw_price = ctx.get("markPx")
    if raw_price is None or raw_price == "":
        raw_price = ctx.get("midPx")
    if raw_price is None or raw_price == "":
        return None
    try:
        price = float(raw_price)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(price):
        return None

    change_pct = None
    raw_prev = ctx.get("prevDayPx")
    if raw_prev is not None and raw_prev != "":
        try:
            prev_day_px = float(raw_prev)
            if math.isfinite(prev_day_px) and prev_day_px > 0:
                change_pct = ((price - prev_day_px) / prev_day_px) * 100.0
        except (TypeError, ValueError):
            change_pct = None

    return {"price": price, "changePct": change_pct}


def _refresh_hl_quotes_cache():
    """Refresh cached Hyperliquid perp and spot asset context quotes (4s TTL)."""
    now = time.time()
    with _hl_quote_lock:
        need_perp = (now - _hl_quote_cache["perp_ts"]) >= _HL_QUOTE_TTL or not _hl_quote_cache["perp"]
        need_spot = (now - _hl_quote_cache["spot_ts"]) >= _HL_QUOTE_TTL or not _hl_quote_cache["spot_by_pair"]
        if not need_perp and not need_spot:
            return (
                _hl_quote_cache["perp"],
                _hl_quote_cache["spot_by_pair"],
                _hl_quote_cache["spot_by_token"],
            )

        headers = {"Content-Type": "application/json"}
        info_url = HyperliquidDataSource.INFO_API_URL

        if need_perp:
            try:
                res = requests.post(
                    info_url, json={"type": "metaAndAssetCtxs"}, headers=headers, timeout=5
                )
                if res.status_code == 200:
                    data = res.json()
                    if isinstance(data, list) and len(data) >= 2:
                        universe = (data[0] or {}).get("universe", [])
                        asset_ctxs = data[1] or []
                        perp_map = {}
                        for u, ctx in zip(universe, asset_ctxs):
                            name = str((u or {}).get("name") or "").strip().upper()
                            if not name:
                                continue
                            quote = _extract_hl_quote(ctx)
                            if quote is not None:
                                perp_map[name] = quote
                        _hl_quote_cache["perp"] = perp_map
                        _hl_quote_cache["perp_ts"] = time.time()
            except Exception as e:
                print(f"Error fetching Hyperliquid metaAndAssetCtxs: {e}", flush=True)

        if need_spot:
            try:
                res = requests.post(
                    info_url, json={"type": "spotMetaAndAssetCtxs"}, headers=headers, timeout=5
                )
                if res.status_code == 200:
                    data = res.json()
                    if isinstance(data, list) and len(data) >= 2:
                        spot_meta = data[0] or {}
                        asset_ctxs = data[1] or []
                        tokens = spot_meta.get("tokens", [])
                        universe = spot_meta.get("universe", [])
                        token_map = {
                            t["index"]: str(t["name"]).strip().upper()
                            for t in tokens
                            if "index" in t and "name" in t
                        }
                        by_pair = {}
                        by_token = {}
                        for pair, ctx in zip(universe, asset_ctxs):
                            quote = _extract_hl_quote(ctx)
                            if quote is None:
                                continue
                            pair_name = str((pair or {}).get("name") or "").strip().upper()
                            if pair_name:
                                by_pair[pair_name] = quote
                            ctx_coin = str((ctx or {}).get("coin") or "").strip().upper()
                            if ctx_coin:
                                by_pair[ctx_coin] = quote
                            pair_tokens = (pair or {}).get("tokens", [])
                            if len(pair_tokens) >= 2:
                                base_name = token_map.get(pair_tokens[0])
                                quote_name = token_map.get(pair_tokens[1])
                                if base_name and quote_name:
                                    by_pair.setdefault(f"{base_name}/{quote_name}", quote)
                                if base_name:
                                    by_token.setdefault(base_name, quote)
                        _hl_quote_cache["spot_by_pair"] = by_pair
                        _hl_quote_cache["spot_by_token"] = by_token
                        _hl_quote_cache["spot_ts"] = time.time()
            except Exception as e:
                print(f"Error fetching Hyperliquid spotMetaAndAssetCtxs: {e}", flush=True)

        return (
            _hl_quote_cache["perp"],
            _hl_quote_cache["spot_by_pair"],
            _hl_quote_cache["spot_by_token"],
        )


def _fetch_single_yf_quote(symbol: str) -> tuple[str, dict | None]:
    """Fetch a single Yahoo Finance quote (fail-safe)."""
    try:
        ticker = yf.Ticker(symbol)
        df = ticker.history(period="5d", interval="1d")
        if df is None or df.empty or "Close" not in df:
            return symbol, None
        closes = df["Close"].dropna()
        if closes.empty:
            return symbol, None
        price = float(closes.iloc[-1])
        if not math.isfinite(price):
            return symbol, None
        change_pct = None
        if len(closes) >= 2:
            prev_close = float(closes.iloc[-2])
            if math.isfinite(prev_close) and prev_close > 0:
                change_pct = ((price - prev_close) / prev_close) * 100.0
        return symbol, {"price": price, "changePct": change_pct}
    except Exception:
        return symbol, None


def get_quotes(items: list[dict]) -> dict:
    """
    Fetch latest price and daily percent change for a list of {source, symbol} dicts.
    Returns mapping of "source:SYMBOL" -> {"price": float, "changePct": float | None}.
    """
    if not isinstance(items, list):
        return {}

    hl_items = []
    yf_items = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        source_norm = str(entry.get("source") or "").strip().lower()
        symbol_norm = str(entry.get("symbol") or "").strip().upper()
        if not source_norm or not symbol_norm:
            continue
        if source_norm == "hyperliquid":
            hl_items.append((source_norm, symbol_norm))
        elif source_norm == "yfinance":
            yf_items.append((source_norm, symbol_norm))

    quotes = {}

    if hl_items:
        perp_map, spot_by_pair, spot_by_token = _refresh_hl_quotes_cache()
        hl_source = SOURCES["hyperliquid"]
        for source_norm, symbol_norm in hl_items:
            quote = None
            if symbol_norm.startswith("@") or "/" in symbol_norm:
                quote = spot_by_pair.get(symbol_norm)
            else:
                quote = perp_map.get(symbol_norm) or spot_by_token.get(symbol_norm)
                if quote is None:
                    resolved = hl_source.resolve_symbol(symbol_norm)
                    quote = spot_by_pair.get(resolved)
            if quote is not None:
                quotes[f"{source_norm}:{symbol_norm}"] = quote

    if yf_items:
        now = time.time()
        unique_yf_symbols = []
        seen_yf = set()
        for _, symbol_norm in yf_items:
            if symbol_norm not in seen_yf:
                seen_yf.add(symbol_norm)
                unique_yf_symbols.append(symbol_norm)

        stale_symbols = []
        with _yf_quote_lock:
            for symbol_norm in unique_yf_symbols:
                cached = _yf_quote_cache.get(symbol_norm)
                if cached and (now - cached["ts"]) < _YF_QUOTE_TTL:
                    quotes[f"yfinance:{symbol_norm}"] = cached["quote"]
                else:
                    stale_symbols.append(symbol_norm)

        if stale_symbols:
            fetched_results = {}
            with ThreadPoolExecutor(max_workers=6) as executor:
                futures = [executor.submit(_fetch_single_yf_quote, sym) for sym in stale_symbols]
                for fut in as_completed(futures):
                    try:
                        sym, q = fut.result()
                        if q is not None:
                            fetched_results[sym] = q
                    except Exception:
                        pass

            if fetched_results:
                fetched_ts = time.time()
                with _yf_quote_lock:
                    for sym, q in fetched_results.items():
                        _yf_quote_cache[sym] = {"ts": fetched_ts, "quote": q}
                        quotes[f"yfinance:{sym}"] = q

    return quotes
