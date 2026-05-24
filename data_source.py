import time
import requests
import yfinance as yf
from abc import ABC, abstractmethod

class BaseDataSource(ABC):
    """
    Standard interface for all data sources in the multi-chart application.
    Any new data source (e.g. Alpaca, Binance, Polygon) must inherit from this
    class and implement the abstract methods below.
    """

    @abstractmethod
    def get_historical_data(self, symbol: str, timeframe: str):
        """
        Fetch historical candle data.
        
        Args:
            symbol (str): Symbol name (e.g., 'BTC', 'THYAO.IS')
            timeframe (str): Timeframe ('1m', '5m', '15m', '1h', '1d')
            
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

    def _update_spot_cache(self):
        now = time.time()
        if not self.spot_cache or (now - self.last_cache_update > 3600):
            try:
                headers = {"Content-Type": "application/json"}
                spot_res = requests.post(self.INFO_API_URL, json={"type": "spotMeta"}, headers=headers, timeout=5)
                if spot_res.status_code == 200:
                    spot_data = spot_res.json()
                    tokens = spot_data.get("tokens", [])
                    universe = spot_data.get("universe", [])
                    
                    token_map = {t["index"]: t["name"].upper() for t in tokens if "index" in t and "name" in t}
                    
                    new_cache = {}
                    for pair in universe:
                        pair_name = pair.get("name")  # e.g., '@1' or 'PURR/USDC'
                        pair_tokens = pair.get("tokens", [])
                        if len(pair_tokens) >= 2:
                            base_idx = pair_tokens[0]
                            base_name = token_map.get(base_idx)
                            if base_name:
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

    def get_historical_data(self, symbol: str, timeframe: str):
        resolved_symbol = self.resolve_symbol(symbol)
        
        # Calculate start and end times to request ~500-1000 candles
        now_ms = int(time.time() * 1000)
        
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
        
        # Pull 1000 candles back
        interval_ms = tf_ms.get(timeframe, 60 * 1000)
        
        # If timeframe is 45m, request 15m candles
        request_interval = '15m' if timeframe == '45m' else timeframe
        
        start_time_ms = now_ms - (1000 * interval_ms)
        
        payload = {
            "type": "candleSnapshot",
            "req": {
                "coin": resolved_symbol,
                "interval": request_interval,
                "startTime": start_time_ms,
                "endTime": now_ms
            }
        }
        
        headers = {"Content-Type": "application/json"}
        response = requests.post(self.INFO_API_URL, json=payload, headers=headers)
        
        if response.status_code != 200:
            raise Exception(f"Hyperliquid API error: {response.text}")
            
        data = response.json()
        if not isinstance(data, list):
            raise Exception(f"Unexpected response format from Hyperliquid: {data}")
            
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


class YFinanceDataSource(BaseDataSource):
    """
    Data source abstraction for Yahoo Finance (e.g. Turkish stocks like THYAO.IS).
    Fetches historical data via yfinance, and provides streaming configuration directing
    the frontend to the local Flask SSE endpoint.
    """

    def get_historical_data(self, symbol: str, timeframe: str):
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
        
        try:
            ticker = yf.Ticker(symbol)
            df = ticker.history(period=period, interval=interval)
            
            if df is None or df.empty:
                raise Exception(f"No historical data returned for symbol: {symbol}")
                
            candles = []
            for index, row in df.iterrows():
                candles.append({
                    'time': int(index.timestamp()),
                    'open': float(row['Open']),
                    'high': float(row['High']),
                    'low': float(row['Low']),
                    'close': float(row['Close']),
                    'volume': float(row['Volume'])
                })
                
            candles.sort(key=lambda x: x['time'])
            
            if timeframe == '45m':
                candles = aggregate_candles(candles, 45)
                
            return candles
        except Exception as e:
            raise Exception(f"Yahoo Finance error for symbol {symbol}: {str(e)}")

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
