import os
import json
import math
import queue
import threading
import time
import requests
from flask import Flask, jsonify, request, Response, render_template

# Import our pluggable data source layer
from data_source import get_source
from flow_indicator import compute_flow

# Initialize Flask with template and static folders
base_dir = os.path.abspath(os.path.dirname(__file__))
template_dir = os.path.join(base_dir, 'templates')
static_dir = os.path.join(base_dir, 'static')

app = Flask(__name__, template_folder=template_dir, static_folder=static_dir)


class YFinancePoller:
    """Background worker that polls yfinance for requested symbols."""
    def __init__(self, interval_seconds=3):
        self.interval = interval_seconds
        self.subscribers = {}
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

    def _poll_loop(self):
        import yfinance as yf
        while True:
            with self.lock:
                if not self.subscribers:
                    self.running = False
                    self.thread = None
                    break
                active_symbols = list(self.subscribers.keys())

            for symbol in active_symbols:
                try:
                    ticker = yf.Ticker(symbol)
                    df = ticker.history(period="1d", interval="1m")
                    if df.empty:
                        df = ticker.history(period="5d", interval="1m")
                    
                    if not df.empty:
                        last_row = df.iloc[-1]
                        current_time = int(df.index[-1].timestamp())
                        data = {
                            'time': current_time,
                            'open': float(last_row['Open']),
                            'high': float(last_row['High']),
                            'low': float(last_row['Low']),
                            'close': float(last_row['Close']),
                            'volume': float(last_row['Volume']),
                            'price': float(last_row['Close'])
                        }
                        with self.lock:
                            if symbol in self.subscribers:
                                for q in self.subscribers[symbol]:
                                    try:
                                        if q.full():
                                            q.get_nowait()
                                        q.put_nowait(data)
                                    except Exception:
                                        pass
                except Exception as e:
                    print(f"Error polling yfinance symbol '{symbol}': {e}", flush=True)
                    with self.lock:
                        if symbol in self.subscribers:
                            for q in self.subscribers[symbol]:
                                try:
                                    q.put_nowait({'error': str(e)})
                                except Exception:
                                        pass
            time.sleep(self.interval)


yfinance_poller = YFinancePoller(interval_seconds=3)


hl_symbols_cache = {
    'assets': [],
    'last_updated': 0
}

def get_hyperliquid_assets():
    now = time.time()
    if not hl_symbols_cache['assets'] or (now - hl_symbols_cache['last_updated'] > 3600):
        try:
            url = "https://api.hyperliquid.xyz/info"
            headers = {"Content-Type": "application/json"}
            assets = []
            
            perp_res = requests.post(url, json={"type": "meta"}, headers=headers, timeout=5)
            if perp_res.status_code == 200:
                universe = perp_res.json().get("universe", [])
                for u in universe:
                    name = u.get("name")
                    if name:
                        assets.append({'symbol': name, 'name': f"{name}-PERP", 'search_key': name.upper()})
                
            spot_res = requests.post(url, json={"type": "spotMeta"}, headers=headers, timeout=5)
            if spot_res.status_code == 200:
                spot_data = spot_res.json()
                tokens = spot_data.get("tokens", [])
                universe = spot_data.get("universe", [])
                token_map = {t["index"]: t["name"] for t in tokens if "index" in t and "name" in t}
                
                for pair in universe:
                    pair_name = pair.get("name")
                    pair_tokens = pair.get("tokens", [])
                    if len(pair_tokens) >= 2:
                        base_idx, quote_idx = pair_tokens[0], pair_tokens[1]
                        base_name = token_map.get(base_idx, str(base_idx))
                        quote_name = token_map.get(quote_idx, str(quote_idx))
                        display_name = f"{base_name}/{quote_name} (Spot)"
                        search_key = f"{base_name} {base_name}/{quote_name} {pair_name}".upper()
                        assets.append({'symbol': pair_name, 'name': display_name, 'search_key': search_key})
            
            if assets:
                hl_symbols_cache['assets'] = assets
                hl_symbols_cache['last_updated'] = now
        except Exception as e:
            print(f"Error updating Hyperliquid assets cache: {e}", flush=True)
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
    source_name = request.args.get('source')
    query = request.args.get('q', '').strip()
    
    if not source_name:
        return jsonify({'error': 'Missing required parameter: source'}), 400
        
    if source_name.lower() == 'hyperliquid':
        assets = get_hyperliquid_assets()
        if query:
            query_upper = query.upper()
            filtered = [a for a in assets if query_upper in a['search_key'] or query_upper in a['symbol'].upper()]
            starts = [a for a in filtered if a['symbol'].upper().startswith(query_upper) or a['name'].upper().startswith(query_upper)]
            others = [a for a in filtered if a not in starts]
            results = starts + others
            results = results[:20]
        else:
            results = assets[:20]
        return jsonify([{'symbol': r['symbol'], 'name': r['name']} for r in results])
        
    elif source_name.lower() == 'yfinance':
        if not query:
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
            params = {"q": query, "quotesCount": 15, "newsCount": 0}
            headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
            res = requests.get(url, params=params, headers=headers, timeout=5)
            if res.status_code != 200:
                raise Exception(f"Yahoo Search returned status {res.status_code}")
            data = res.json()
            results = []
            for item in data.get('quotes', []):
                symbol = item.get('symbol')
                shortname = item.get('shortname') or item.get('longname') or ''
                if symbol:
                    results.append({'symbol': symbol, 'name': f"{symbol} ({shortname})" if shortname else symbol})
            return jsonify(results)
        except Exception as e:
            return jsonify({'error': str(e)}), 400
    else:
        return jsonify({'error': f"Unknown source: {source_name}"}), 400


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/history', methods=['GET'])
def api_history():
    source_name = request.args.get('source')
    symbol = request.args.get('symbol')
    timeframe = request.args.get('timeframe')

    if not source_name or not symbol or not timeframe:
        return jsonify({'error': 'Missing required parameters: source, symbol, timeframe'}), 400

    source = get_source(source_name)
    if not source:
        return jsonify({'error': f"Unknown data source: {source_name}"}), 404

    try:
        history = source.get_historical_data(symbol, timeframe)
        streaming_config = source.get_streaming_config(symbol, timeframe)
        return jsonify({'history': history, 'streaming_config': streaming_config})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


flow_cache = {}
FLOW_CACHE_TTL = 3

@app.route('/api/flow', methods=['GET'])
def api_flow():
    source_name = request.args.get('source')
    symbol = request.args.get('symbol')
    timeframe = request.args.get('timeframe')

    if not source_name or not symbol or not timeframe:
        return jsonify({'error': 'Missing required parameters: source, symbol, timeframe'}), 400

    cache_key = f"{source_name}:{symbol}:{timeframe}"
    now = time.time()

    if cache_key in flow_cache:
        cached = flow_cache[cache_key]
        if now - cached['ts'] < FLOW_CACHE_TTL:
            return jsonify(cached['data'])

    source = get_source(source_name)
    if not source:
        return jsonify({'error': f'Unknown data source: {source_name}'}), 404

    try:
        candles = source.get_historical_data(symbol, timeframe)
        result = compute_flow(candles, {'history_box_count': 3, 'show_fib_levels': True})
        flow_cache[cache_key] = {'data': result, 'ts': now}
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/stream/yfinance', methods=['GET'])
def stream_yfinance():
    symbol = request.args.get('symbol')
    if not symbol:
        return jsonify({'error': 'Missing required parameter: symbol'}), 400

    q = queue.Queue(maxsize=15)
    yfinance_poller.register(symbol, q)

    def sse_generator():
        try:
            yield "data: {\"connected\": true}\n\n"
            while True:
                try:
                    data = q.get(timeout=15)
                    yield f"data: {json.dumps(data)}\n\n"
                except queue.Empty:
                    yield "data: {\"ping\": true}\n\n"
        except GeneratorExit:
            pass
        finally:
            yfinance_poller.unregister(symbol, q)

    return Response(sse_generator(), mimetype='text/event-stream')


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=True)
