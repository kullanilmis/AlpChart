import concurrent.futures
import json
import os
import queue
import sys
import threading
import time
import requests
from flask import Flask, jsonify, request, Response, render_template

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

# Import our persistence and pluggable data source layers
import storage
from data_source import get_source, get_quotes
from flow_indicator import compute_flow

# Initialize Flask with template and static folders pointing to the project root
base_dir = os.path.abspath(os.path.dirname(_BACKEND_DIR))
template_dir = os.path.join(base_dir, 'templates')
static_dir = os.path.join(base_dir, 'static')

app = Flask(__name__, template_folder=template_dir, static_folder=static_dir)

# Ensure SQLite schema and default watchlist are initialized on startup
storage.init_db()


class YFinancePoller:
    """
    Background worker that polls yfinance for requested symbols at a regular interval.
    Deduplicates requests so we only poll Yahoo Finance once per symbol even if multiple
    panes or clients are viewing the same symbol.
    """
    def __init__(self, interval_seconds=3):
        self.interval = interval_seconds
        self.subscribers = {}  # symbol -> list of queue.Queue
        self.lock = threading.Lock()
        self.thread = None
        self.running = False

    def start(self):
        with self.lock:
            if not self.running:
                self.running = True
                self.thread = threading.Thread(target=self._poll_loop, daemon=True)
                self.thread.start()

    def register(self, symbol: str, q: queue.Queue):
        with self.lock:
            if symbol not in self.subscribers:
                self.subscribers[symbol] = []
            self.subscribers[symbol].append(q)
        self.start()

    def unregister(self, symbol: str, q: queue.Queue):
        with self.lock:
            if symbol in self.subscribers:
                if q in self.subscribers[symbol]:
                    self.subscribers[symbol].remove(q)
                if not self.subscribers[symbol]:
                    del self.subscribers[symbol]

    @staticmethod
    def _fetch_symbol_tick(symbol: str):
        import yfinance as yf
        try:
            ticker = yf.Ticker(symbol)
            # Pull 1m data for the last day to get the latest candle
            df = ticker.history(period="1d", interval="1m")
            if df.empty:
                # Fallback for when the market is closed or on weekends
                df = ticker.history(period="5d", interval="1m")

            if df.empty:
                return symbol, None, None

            last_row = df.iloc[-1]
            current_time = int(df.index[-1].timestamp())

            data = {
                'time': current_time,
                'open': float(last_row['Open']),
                'high': float(last_row['High']),
                'low': float(last_row['Low']),
                'close': float(last_row['Close']),
                'volume': float(last_row['Volume']),
                'price': float(last_row['Close'])  # Current market price
            }
            return symbol, data, None
        except Exception as e:
            print(f"Error polling yfinance symbol '{symbol}': {e}", flush=True)
            return symbol, None, str(e)

    def _dispatch_to_subscribers(self, symbol: str, payload: dict):
        with self.lock:
            queues = list(self.subscribers.get(symbol, []))
        for q in queues:
            try:
                # Put without blocking, discard oldest if full
                if q.full():
                    q.get_nowait()
                q.put_nowait(payload)
            except Exception:
                pass

    def _poll_loop(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            while True:
                # Check if we should stop running due to no active subscribers
                with self.lock:
                    if not self.subscribers:
                        self.running = False
                        self.thread = None
                        break
                    active_symbols = list(self.subscribers.keys())

                futures = [
                    executor.submit(self._fetch_symbol_tick, sym)
                    for sym in active_symbols
                ]
                for fut in concurrent.futures.as_completed(futures):
                    try:
                        symbol, data, err = fut.result()
                    except Exception:
                        continue
                    if err is not None:
                        self._dispatch_to_subscribers(symbol, {'error': err})
                    elif data is not None:
                        self._dispatch_to_subscribers(symbol, data)

                time.sleep(self.interval)


# Global instances
yfinance_poller = YFinancePoller(interval_seconds=3)


# Cache for Hyperliquid symbols/assets to prevent hitting API limits
hl_symbols_cache = {
    'assets': [],  # List of dicts: {'symbol': str, 'name': str, 'search_key': str}
    'last_updated': 0
}


def get_hyperliquid_assets():
    now = time.time()
    # Cache for 1 hour (3600 seconds)
    if not hl_symbols_cache['assets'] or (now - hl_symbols_cache['last_updated'] > 3600):
        try:
            url = "https://api.hyperliquid.xyz/info"
            headers = {"Content-Type": "application/json"}
            assets = []

            # Fetch Perp Meta
            perp_res = requests.post(url, json={"type": "meta"}, headers=headers, timeout=5)
            if perp_res.status_code == 200:
                universe = perp_res.json().get("universe", [])
                for u in universe:
                    name = u.get("name")
                    if name:
                        assets.append({
                            'symbol': name,
                            'name': f"{name}-PERP",
                            'search_key': name.upper()
                        })

            # Fetch Spot Meta
            spot_res = requests.post(url, json={"type": "spotMeta"}, headers=headers, timeout=5)
            if spot_res.status_code == 200:
                spot_data = spot_res.json()
                tokens = spot_data.get("tokens", [])
                universe = spot_data.get("universe", [])

                # Map token index to token name
                token_map = {t["index"]: t["name"] for t in tokens if "index" in t and "name" in t}

                for pair in universe:
                    pair_name = pair.get("name")  # e.g., '@1' or 'PURR/USDC'
                    pair_tokens = pair.get("tokens", [])
                    if len(pair_tokens) >= 2:
                        base_idx, quote_idx = pair_tokens[0], pair_tokens[1]
                        base_name = token_map.get(base_idx, str(base_idx))
                        quote_name = token_map.get(quote_idx, str(quote_idx))

                        # Friendly display name
                        display_name = f"{base_name}/{quote_name} (Spot)"
                        # Search key allows matching by base name, pair, or index name
                        search_key = f"{base_name} {base_name}/{quote_name} {pair_name}".upper()

                        assets.append({
                            'symbol': pair_name,
                            'name': display_name,
                            'search_key': search_key
                        })

            if assets:
                hl_symbols_cache['assets'] = assets
                hl_symbols_cache['last_updated'] = now
        except Exception as e:
            print(f"Error updating Hyperliquid assets cache: {e}", flush=True)
            # Fallback list if API fails
            if not hl_symbols_cache['assets']:
                hl_symbols_cache['assets'] = [
                    {'symbol': 'BTC', 'name': 'BTC-PERP', 'search_key': 'BTC'},
                    {'symbol': 'ETH', 'name': 'ETH-PERP', 'search_key': 'ETH'},
                    {'symbol': 'SOL', 'name': 'SOL-PERP', 'search_key': 'SOL'},
                    {'symbol': 'PURR/USDC', 'name': 'PURR/USDC (Spot)', 'search_key': 'PURR'}
                ]

    return hl_symbols_cache['assets']


@app.route('/api/symbols', methods=['GET'])
def api_symbols():
    """
    Endpoint to retrieve symbol suggestions based on source and search query.
    Params:
        source: 'hyperliquid' | 'yfinance'
        q: query string (optional)
    """
    source_name = request.args.get('source')
    query = request.args.get('q', '').strip()

    if not source_name:
        return jsonify({'error': 'Missing required parameter: source'}), 400

    if source_name.lower() == 'hyperliquid':
        assets = get_hyperliquid_assets()
        if query:
            query_upper = query.upper()
            # Filter assets by search_key or symbol
            filtered = [
                a for a in assets
                if query_upper in a['search_key'] or query_upper in a['symbol'].upper()
            ]
            # Prioritize symbols starting with query
            starts = [
                a for a in filtered
                if a['symbol'].upper().startswith(query_upper)
                or a['name'].upper().startswith(query_upper)
            ]
            others = [a for a in filtered if a not in starts]
            results = (starts + others)[:20]
        else:
            results = assets[:20]

        return jsonify([{'symbol': r['symbol'], 'name': r['name']} for r in results])

    elif source_name.lower() == 'yfinance':
        if not query:
            # Default Turkish stocks suggestions
            defaults = [
                {'symbol': 'THYAO.IS', 'name': 'THYAO.IS (THY)'},
                {'symbol': 'EREGL.IS', 'name': 'EREGL.IS (Eregli)'},
                {'symbol': 'ASELS.IS', 'name': 'ASELS.IS (Aselsan)'},
                {'symbol': 'TUPRS.IS', 'name': 'TUPRS.IS (Tupras)'},
                {'symbol': 'GARAN.IS', 'name': 'GARAN.IS (Garanti)'},
                {'symbol': 'XU100.IS', 'name': 'BIST 100 Index'},
                {'symbol': 'USDTRY=X', 'name': 'USD/TRY'}
            ]
            return jsonify(defaults)

        try:
            url = "https://query2.finance.yahoo.com/v1/finance/search"
            params = {
                "q": query,
                "quotesCount": 15,
                "newsCount": 0
            }
            headers = {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                )
            }
            res = requests.get(url, params=params, headers=headers, timeout=5)
            if res.status_code != 200:
                raise Exception(f"Yahoo Search returned status {res.status_code}")

            data = res.json()
            results = []
            for item in data.get('quotes', []):
                symbol = item.get('symbol')
                shortname = item.get('shortname') or item.get('longname') or ''
                if symbol:
                    results.append({
                        'symbol': symbol,
                        'name': f"{symbol} ({shortname})" if shortname else symbol
                    })
            return jsonify(results)
        except Exception as e:
            return jsonify({'error': str(e)}), 400

    else:
        return jsonify({'error': f"Unknown source: {source_name}"}), 400


@app.route('/')
def index():
    """Render the dashboard application homepage."""
    return render_template('index.html')


@app.route('/api/history', methods=['GET'])
def api_history():
    """
    Endpoint to retrieve historical candle data and streaming configuration.
    Params:
        source: 'hyperliquid' | 'yfinance'
        symbol: symbol name (e.g. BTC, THYAO.IS)
        timeframe: timeframe code (e.g. 1m, 5m, 15m, 1h, 1d)
        end_time: optional UNIX timestamp (seconds) exclusive upper bound
        limit: optional candle count limit (default 1000)
    """
    source_name = request.args.get('source')
    symbol = request.args.get('symbol')
    timeframe = request.args.get('timeframe')
    end_time = request.args.get('end_time', type=int)
    limit = request.args.get('limit', default=1000, type=int)

    if not source_name or not symbol or not timeframe:
        return jsonify({'error': 'Missing required parameters: source, symbol, timeframe'}), 400

    source = get_source(source_name)
    if not source:
        return jsonify({'error': f"Unknown data source: {source_name}"}), 404

    try:
        # Fetch historical candles
        history = source.get_historical_data(symbol, timeframe, end_time=end_time, limit=limit)
        # Fetch dynamic streaming config
        streaming_config = source.get_streaming_config(symbol, timeframe)

        return jsonify({
            'history': history,
            'streaming_config': streaming_config,
            'has_more': len(history) >= 2
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 400


# ==========================================
# FLOW V2.5 INDICATOR ENDPOINT
# ==========================================
flow_cache = {}  # key: "source:symbol:timeframe" -> {"data": result, "ts": timestamp}
FLOW_CACHE_TTL = 3  # seconds


@app.route('/api/flow', methods=['GET'])
def api_flow():
    """
    Compute the Flow V2.5 indicator (ZigZag + Structural Boxes + Fibonacci).
    Params:
        source: 'hyperliquid' | 'yfinance'
        symbol: symbol name
        timeframe: timeframe code
    """
    source_name = request.args.get('source')
    symbol = request.args.get('symbol')
    timeframe = request.args.get('timeframe')

    if not source_name or not symbol or not timeframe:
        return jsonify({'error': 'Missing required parameters: source, symbol, timeframe'}), 400

    cache_key = f"{source_name}:{symbol}:{timeframe}"
    now = time.time()

    # Return cached result if fresh enough
    if cache_key in flow_cache:
        cached = flow_cache[cache_key]
        if now - cached['ts'] < FLOW_CACHE_TTL:
            return jsonify(cached['data'])

    source = get_source(source_name)
    if not source:
        return jsonify({'error': f'Unknown data source: {source_name}'}), 404

    try:
        candles = source.get_historical_data(symbol, timeframe)
        result = compute_flow(candles, {
            'history_box_count': 3,
            'show_fib_levels': True,
        })
        flow_cache[cache_key] = {'data': result, 'ts': now}
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


# ==========================================
# PERSISTENCE, QUOTES & BACKUP ENDPOINTS
# ==========================================
@app.route('/api/state', methods=['GET'])
def api_get_state():
    """Return persisted dashboard state."""
    return jsonify(storage.get_state())


@app.route('/api/state', methods=['PUT'])
def api_put_state():
    """Merge and persist dashboard state."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Request body must be a JSON object'}), 400
    try:
        updated = storage.save_state(payload)
        return jsonify(updated)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/drawings', methods=['GET'])
def api_get_drawings():
    """Return saved drawings for a symbol key (e.g. ?key=hyperliquid:BTC)."""
    key = request.args.get('key', '').strip()
    if not key:
        return jsonify({'error': 'Missing required parameter: key'}), 400
    return jsonify({'key': key, 'drawings': storage.get_drawings(key)})


@app.route('/api/drawings', methods=['PUT'])
def api_put_drawings():
    """Save drawings list for a symbol key."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Request body must be a JSON object'}), 400
    key = str(payload.get('key') or '').strip()
    drawings = payload.get('drawings')
    if not key or not isinstance(drawings, list):
        return jsonify({'error': 'Invalid payload: key and drawings list required'}), 400
    try:
        saved = storage.save_drawings(key, drawings)
        return jsonify({'key': key, 'drawings': saved})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/watchlist', methods=['GET'])
def api_get_watchlist():
    """Return ordered watchlist items."""
    return jsonify({'items': storage.get_watchlist()})


@app.route('/api/watchlist', methods=['POST'])
def api_add_watchlist():
    """Add or update a watchlist item."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Request body must be a JSON object'}), 400
    try:
        item = storage.add_watchlist_item(
            payload.get('source'),
            payload.get('symbol'),
            payload.get('label', ''),
        )
        return jsonify(item), 201
    except ValueError as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/watchlist/<int:item_id>', methods=['DELETE'])
def api_delete_watchlist(item_id: int):
    """Remove a watchlist item by ID."""
    if not storage.delete_watchlist_item(item_id):
        return jsonify({'error': 'Watchlist item not found'}), 404
    return jsonify({'deleted': True})


@app.route('/api/alerts', methods=['GET'])
def api_get_alerts():
    """Return all configured alerts."""
    return jsonify({'alerts': storage.get_alerts()})


@app.route('/api/alerts', methods=['POST'])
def api_create_alert():
    """Validate and create a new price alert."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Request body must be a JSON object'}), 400
    try:
        alert = storage.create_alert(payload)
        return jsonify(alert), 201
    except ValueError as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/alerts/<alert_id>', methods=['PATCH'])
def api_update_alert(alert_id: str):
    """Update an existing alert."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Request body must be a JSON object'}), 400
    try:
        updated = storage.update_alert(alert_id, payload)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    if updated is None:
        return jsonify({'error': 'Alert not found'}), 404
    return jsonify(updated)


@app.route('/api/alerts/<alert_id>', methods=['DELETE'])
def api_delete_alert(alert_id: str):
    """Delete an alert by ID."""
    if not storage.delete_alert(alert_id):
        return jsonify({'error': 'Alert not found'}), 404
    return jsonify({'deleted': True})


@app.route('/api/quotes', methods=['POST'])
def api_quotes():
    """Batch fetch current quotes for a list of {source, symbol} items."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get('items'), list):
        return jsonify({'error': 'Invalid payload: items list required'}), 400
    quotes = get_quotes(payload['items'])
    return jsonify({'quotes': quotes})


@app.route('/api/backup/export', methods=['GET'])
def api_backup_export():
    """Export all persisted dashboard state, drawings, watchlist, and alerts."""
    return jsonify(storage.export_all())


@app.route('/api/backup/import', methods=['POST'])
def api_backup_import():
    """Restore dashboard state, drawings, watchlist, and alerts from backup JSON."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Request body must be a JSON object'}), 400
    try:
        summary = storage.import_all(payload)
        return jsonify({'ok': True, 'summary': summary})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/stream/yfinance', methods=['GET'])
def stream_yfinance():
    """
    SSE stream endpoint for yfinance stock ticks.
    Subscribes to the yfinance poller and feeds events to the client.
    """
    symbol = request.args.get('symbol')
    if not symbol:
        return jsonify({'error': 'Missing required parameter: symbol'}), 400

    # Thread-safe queue for the client connection
    q = queue.Queue(maxsize=15)
    yfinance_poller.register(symbol, q)

    def sse_generator():
        try:
            # Yield initial connect signal
            yield "data: {\"connected\": true}\n\n"
            while True:
                try:
                    # Wait for new data from the poller
                    data = q.get(timeout=15)
                    yield f"data: {json.dumps(data)}\n\n"
                except queue.Empty:
                    # Keepalive ping to prevent connection timeout
                    yield "data: {\"ping\": true}\n\n"
        except GeneratorExit:
            # Standard cleanup when browser closes connection
            pass
        finally:
            yfinance_poller.unregister(symbol, q)

    return Response(sse_generator(), mimetype='text/event-stream')


if __name__ == '__main__':
    # Run server locally on port 5000
    app.run(host='127.0.0.1', port=5000, debug=True)
