// ==========================================
// 1. HYPERLIQUID WEBSOCKET MANAGER
// ==========================================
class HyperliquidWSManager {
    constructor() {
        this.url = 'wss://api.hyperliquid.xyz/ws';
        this.ws = null;
        this.subscribers = {}; // key: "symbol:timeframe" -> array of { paneId, callback, statusCallback }
        this.reconnectTimeout = null;
    }
    
    connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        
        console.log("Connecting to Hyperliquid WebSocket...");
        this.ws = new WebSocket(this.url);
        
        this.ws.onopen = () => {
            console.log("Hyperliquid WebSocket connected.");
            // Resubscribe to all active subscriptions
            for (const key in this.subscribers) {
                const [symbol, timeframe] = key.split(':');
                this._sendSubscribe(symbol, timeframe);
                this.subscribers[key].forEach(sub => sub.statusCallback('connected'));
            }
        };
        
        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.channel === 'candle' && msg.data) {
                    const symbol = msg.data.s;
                    const timeframe = msg.data.i;
                    const key = `${symbol.toUpperCase()}:${timeframe}`;
                    
                    if (this.subscribers[key]) {
                        const tick = {
                            time: Math.floor(msg.data.t / 1000),
                            open: parseFloat(msg.data.o),
                            high: parseFloat(msg.data.h),
                            low: parseFloat(msg.data.l),
                            close: parseFloat(msg.data.c),
                            volume: parseFloat(msg.data.v),
                            price: parseFloat(msg.data.c)
                        };
                        this.subscribers[key].forEach(sub => sub.callback(tick));
                    }
                }
            } catch (err) {
                console.error("Error processing WS message:", err);
            }
        };
        
        this.ws.onclose = () => {
            console.warn("Hyperliquid WebSocket disconnected. Retrying in 5 seconds...");
            for (const key in this.subscribers) {
                this.subscribers[key].forEach(sub => sub.statusCallback('disconnected'));
            }
            this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
        };
        
        this.ws.onerror = (err) => {
            console.error("Hyperliquid WebSocket error:", err);
            this.ws.close();
        };
    }
    
    subscribe(symbol, timeframe, paneId, callback, statusCallback) {
        if (!symbol || !timeframe) return;
        const key = `${symbol.toUpperCase()}:${timeframe}`;
        if (!this.subscribers[key]) {
            this.subscribers[key] = [];
        }
        
        // Prevent duplicate subscription for the same pane
        this.subscribers[key] = this.subscribers[key].filter(sub => sub.paneId !== paneId);
        this.subscribers[key].push({ paneId, callback, statusCallback });
        
        statusCallback(this.ws && this.ws.readyState === WebSocket.OPEN ? 'connected' : 'connecting');
        
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Send subscription message only if we are the first subscriber
            if (this.subscribers[key].length === 1) {
                this._sendSubscribe(symbol, timeframe);
            }
        } else {
            this.connect();
        }
    }
    
    unsubscribe(symbol, timeframe, paneId) {
        if (!symbol || !timeframe) return;
        const key = `${symbol.toUpperCase()}:${timeframe}`;
        if (!this.subscribers[key]) return;
        
        this.subscribers[key] = this.subscribers[key].filter(sub => sub.paneId !== paneId);
        
        if (this.subscribers[key].length === 0) {
            this._sendUnsubscribe(symbol, timeframe);
            delete this.subscribers[key];
        }
    }
    
    _sendSubscribe(symbol, timeframe) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const payload = {
                method: "subscribe",
                subscription: {
                    type: "candle",
                    coin: symbol.toUpperCase(),
                    interval: timeframe
                }
            };
            this.ws.send(JSON.stringify(payload));
        }
    }

    _sendUnsubscribe(symbol, timeframe) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const payload = {
                method: "unsubscribe",
                subscription: {
                    type: "candle",
                    coin: symbol.toUpperCase(),
                    interval: timeframe
                }
            };
            this.ws.send(JSON.stringify(payload));
        }
    }
}

// Global WebSocket manager for Hyperliquid
const hlWSManager = new HyperliquidWSManager();

// ==========================================
// TECHNICAL INDICATOR CALCULATORS
// ==========================================
function calculateEMA(data, period) {
    if (data.length < period) return [];
    const ema = [];
    
    // SMA for the first value
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += data[i].close;
    }
    let prevEma = sum / period;
    ema.push({ time: data[period - 1].time, value: prevEma });
    
    const multiplier = 2 / (period + 1);
    for (let i = period; i < data.length; i++) {
        const val = (data[i].close - prevEma) * multiplier + prevEma;
        ema.push({ time: data[i].time, value: val });
        prevEma = val;
    }
    return ema;
}

function calculateRSI(data, period = 14) {
    if (data.length < period + 1) return [];
    const rsi = [];
    
    let gains = 0;
    let losses = 0;
    
    // First RSI (SMA basis)
    for (let i = 1; i <= period; i++) {
        const diff = data[i].close - data[i - 1].close;
        if (diff > 0) gains += diff;
        else losses -= diff;
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;
    
    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push({ time: data[period].time, value: 100 - (100 / (1 + rs)) });
    
    // Wilders smoothing
    for (let i = period + 1; i < data.length; i++) {
        const diff = data[i].close - data[i - 1].close;
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        
        rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi.push({ time: data[i].time, value: 100 - (100 / (1 + rs)) });
    }
    return rsi;
}


// ==========================================
// 2. CHART PANE CLASS DEFINITION
// ==========================================
class ChartPane {
    constructor(id, container, initialState = null) {
        this.id = id;
        this.container = container;
        
        // Default state if none loaded
        this.state = initialState || {
            source: 'hyperliquid',
            symbol: 'BTC',
            timeframe: '1m',
            indicators: { ema9: false, ema21: false, rsi: false, flow: false }
        };
        
        if (!this.state.indicators) {
            this.state.indicators = { ema9: false, ema21: false, rsi: false, flow: false };
        }
        if (this.state.indicators.flow === undefined) {
            this.state.indicators.flow = false;
        }
        
        this.chart = null;
        this.series = null;
        this.resizeObserver = null;
        
        // Indicators
        this.ema9Series = null;
        this.ema21Series = null;
        this.rsiChart = null;
        this.rsiSeries = null;
        this.activeCandles = [];
        this.current45mCandle = null;
        
        // Stream connections
        this.sseSource = null;
        this.lastPrice = null;
        this.lastCandleTime = null;
        this.currentSubscription = null;
        
        // DOM Elements
        this.paneEl = null;
        this.tickerValEl = null;
        this.statusDotEl = null;
        this.sourceBadge = null;
        this.metaText = null;
        this.sourceSelect = null;
        this.symbolInput = null;
        this.symbolDatalist = null;
        this.timeframeSelect = null;
        this.chartContainer = null;
        this.rsiContainer = null;
        this.loaderEl = null;
        this.contentWrapper = null;
        this.chartWrapper = null;
        this.indicatorPanel = null;
        this.indicatorBtn = null;
        
        // Drawings state
        this.drawings = [];
        this.activeTool = 'select'; // 'select', 'trend', 'horizontal', 'ray', 'channel', 'rectangle'
        this.selectedDrawing = null;
        this.drawingPoints = [];
        
        // Dragging state
        this.draggedDrawing = null;
        this.draggedHandleIndex = -1;
        this.dragStartPoint = null;
        this.dragOriginalPoints = [];
        this.lastMousePos = null;
        
        // Flow V2.5 indicator state
        this.flowData = null;
        this.flowFetchTimeout = null;
        this.flowFetching = false;
        
        this.createDOM();
        this.initChart();
        this.initCanvasEvents();
        this.loadData();
    }
    
    createDOM() {
        // Prevent duplicate DOM elements for the same pane ID
        const existing = document.getElementById(`pane-${this.id}`);
        if (existing) {
            try {
                existing.parentNode.removeChild(existing);
            } catch (e) {
                console.error("Error removing duplicate pane DOM:", e);
            }
        }

        // Create the pane container
        this.paneEl = document.createElement('div');
        this.paneEl.className = 'chart-pane';
        this.paneEl.id = `pane-${this.id}`;
        
        // Ticker / header bar
        const header = document.createElement('div');
        header.className = 'pane-header';
        
        const meta = document.createElement('div');
        meta.className = 'pane-meta';
        
        this.sourceBadge = document.createElement('span');
        this.sourceBadge.className = 'pane-source-badge';
        this.sourceBadge.innerText = this.state.source;
        
        this.metaText = document.createElement('span');
        this.metaText.className = 'pane-symbol-timeframe';
        this.metaText.innerText = `${this.state.symbol} [${this.state.timeframe}]`;
        
        meta.appendChild(this.sourceBadge);
        meta.appendChild(this.metaText);
        
        this.tickerValEl = document.createElement('div');
        this.tickerValEl.className = 'pane-ticker';
        this.tickerValEl.innerText = '—';
        
        const status = document.createElement('div');
        status.className = 'pane-status';
        this.statusDotEl = document.createElement('div');
        this.statusDotEl.className = 'status-dot';
        status.appendChild(this.statusDotEl);
        
        header.appendChild(meta);
        header.appendChild(this.tickerValEl);
        header.appendChild(status);
        
        // Controls bar
        const controls = document.createElement('div');
        controls.className = 'pane-controls';
        
        // Source select
        this.sourceSelect = document.createElement('select');
        this.sourceSelect.className = 'pane-select';
        this.sourceSelect.id = `select-source-${this.id}`;
        this.sourceSelect.innerHTML = `
            <option value="hyperliquid">Hyperliquid</option>
            <option value="yfinance">Yahoo Finance</option>
        `;
        this.sourceSelect.value = this.state.source;
        this.sourceSelect.addEventListener('change', () => this.handleSourceChange());
        
        // Symbol input with datalist suggestions
        this.symbolInput = document.createElement('input');
        this.symbolInput.type = 'text';
        this.symbolInput.className = 'pane-select';
        this.symbolInput.id = `input-symbol-${this.id}`;
        this.symbolInput.setAttribute('list', `datalist-symbol-${this.id}`);
        this.symbolInput.value = this.state.symbol || '';
        this.symbolInput.placeholder = 'Symbol (e.g. BTC)';
        this.symbolInput.addEventListener('change', () => this.handleSymbolChange());
        this.symbolInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.symbolInput.blur();
            }
        });
        
        // Go / Submit button next to input
        this.submitBtn = document.createElement('button');
        this.submitBtn.className = 'pane-btn-submit';
        this.submitBtn.innerHTML = '⚡';
        this.submitBtn.title = 'Load / Refresh Symbol';
        this.submitBtn.addEventListener('click', () => this.handleSymbolChange());

        // Debounce timer for dynamic query autocomplete suggestions + auto-load on exact match
        this.autocompleteTimeout = null;
        this.symbolInput.addEventListener('input', () => {
            const val = this.symbolInput.value.trim().toUpperCase();
            const options = Array.from(this.symbolDatalist.options).map(opt => opt.value.toUpperCase());
            if (val && options.includes(val)) {
                this.handleSymbolChange();
            }
            
            clearTimeout(this.autocompleteTimeout);
            this.autocompleteTimeout = setTimeout(() => {
                this.populateSymbols(this.symbolInput.value);
            }, 300);
        });
        
        this.symbolDatalist = document.createElement('datalist');
        this.symbolDatalist.id = `datalist-symbol-${this.id}`;
        this.populateSymbols(this.state.symbol);
        
        // Timeframe select
        this.timeframeSelect = document.createElement('select');
        this.timeframeSelect.className = 'pane-select';
        this.timeframeSelect.id = `select-timeframe-${this.id}`;
        this.timeframeSelect.innerHTML = `
            <option value="1m">1m</option>
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="45m">45m</option>
            <option value="1h">1h</option>
            <option value="4h">4h</option>
            <option value="1d">1d</option>
            <option value="1w">1w</option>
        `;
        this.timeframeSelect.value = this.state.timeframe;
        if (!this.timeframeSelect.value) {
            this.timeframeSelect.selectedIndex = 0;
        }
        this.timeframeSelect.addEventListener('change', () => this.handleTimeframeChange());
        
        // Indicator panel button
        this.indicatorBtn = document.createElement('button');
        this.indicatorBtn.className = 'pane-btn-submit';
        this.indicatorBtn.innerText = 'IND';
        this.indicatorBtn.title = 'Indicators';
        this.indicatorBtn.addEventListener('click', () => this.toggleIndicatorPanel());

        // Tool panel button
        this.toolBtn = document.createElement('button');
        this.toolBtn.className = 'pane-btn-submit';
        this.toolBtn.innerText = 'TOOL';
        this.toolBtn.title = 'Drawing Tools';
        this.toolBtn.addEventListener('click', () => this.toggleToolPanel());

        // Sync values back to this.state to prevent undefined values going into URLs
        this.state.source = this.sourceSelect.value;
        this.state.symbol = this.symbolInput.value;
        this.state.timeframe = this.timeframeSelect.value;
        
        controls.appendChild(this.sourceSelect);
        controls.appendChild(this.symbolInput);
        controls.appendChild(this.submitBtn);
        controls.appendChild(this.symbolDatalist);
        controls.appendChild(this.timeframeSelect);
        controls.appendChild(this.indicatorBtn);
        controls.appendChild(this.toolBtn);

        // Create Content Layout Wrappers
        this.contentWrapper = document.createElement('div');
        this.contentWrapper.className = 'pane-content-wrapper';
        
        // Sliding indicator panel
        this.indicatorPanel = document.createElement('div');
        this.indicatorPanel.className = 'pane-indicator-panel';
        this.indicatorPanel.innerHTML = `
            <div class="indicator-title">Indicators</div>
            <label class="indicator-item"><input type="checkbox" id="chk-ema9-${this.id}" ${this.state.indicators.ema9 ? 'checked' : ''}> EMA 9</label>
            <label class="indicator-item"><input type="checkbox" id="chk-ema21-${this.id}" ${this.state.indicators.ema21 ? 'checked' : ''}> EMA 21</label>
            <label class="indicator-item"><input type="checkbox" id="chk-rsi-${this.id}" ${this.state.indicators.rsi ? 'checked' : ''}> RSI 14</label>
            <label class="indicator-item"><input type="checkbox" id="chk-flow-${this.id}" ${this.state.indicators.flow ? 'checked' : ''}> Flow V2.5</label>
        `;
        
        // Add event listeners to checkboxes
        this.indicatorPanel.querySelector(`#chk-ema9-${this.id}`).addEventListener('change', (e) => {
            this.state.indicators.ema9 = e.target.checked;
            saveDashboardState();
            this.updateIndicators();
        });
        this.indicatorPanel.querySelector(`#chk-ema21-${this.id}`).addEventListener('change', (e) => {
            this.state.indicators.ema21 = e.target.checked;
            saveDashboardState();
            this.updateIndicators();
        });
        this.indicatorPanel.querySelector(`#chk-rsi-${this.id}`).addEventListener('change', (e) => {
            this.state.indicators.rsi = e.target.checked;
            saveDashboardState();
            this.updateIndicators();
        });
        this.indicatorPanel.querySelector(`#chk-flow-${this.id}`).addEventListener('change', (e) => {
            this.state.indicators.flow = e.target.checked;
            if (!e.target.checked) {
                this.flowData = null;
            }
            saveDashboardState();
            this.updateIndicators();
        });

        // Sliding tool panel
        this.toolPanel = document.createElement('div');
        this.toolPanel.className = 'pane-tool-panel';
        this.toolPanel.innerHTML = `
            <div class="indicator-title">Drawings</div>
            <button class="tool-btn active" data-tool="select" id="btn-tool-select-${this.id}" title="Select/Edit (Cursor)">Cursor</button>
            <button class="tool-btn" data-tool="trend" id="btn-tool-trend-${this.id}" title="Trend Line">Trend Line</button>
            <button class="tool-btn" data-tool="horizontal" id="btn-tool-horizontal-${this.id}" title="Horizontal Line">Horiz Line</button>
            <button class="tool-btn" data-tool="ray" id="btn-tool-ray-${this.id}" title="Horizontal Ray">Horiz Ray</button>
            <button class="tool-btn" data-tool="channel" id="btn-tool-channel-${this.id}" title="Parallel Channel">Channel</button>
            <button class="tool-btn" data-tool="rectangle" id="btn-tool-rectangle-${this.id}" title="Rectangle Box">Rectangle</button>
            <button class="tool-btn action-btn-clear" id="btn-tool-clear-${this.id}" title="Clear All Drawings">Clear All</button>
        `;

        const toolBtns = this.toolPanel.querySelectorAll('.tool-btn:not(.action-btn-clear)');
        toolBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const tool = btn.getAttribute('data-tool');
                this.setActiveTool(tool);
            });
        });
        
        this.toolPanel.querySelector(`#btn-tool-clear-${this.id}`).addEventListener('click', () => {
            if (confirm('Tüm çizimleri silmek istediğinize emin misiniz?')) {
                this.clearAllDrawings();
            }
        });
        
        // Chart Wrapper
        this.chartWrapper = document.createElement('div');
        this.chartWrapper.className = 'chart-wrapper';
        
        // Chart canvas (Price)
        this.chartContainer = document.createElement('div');
        this.chartContainer.className = 'pane-chart-container';
        
        // RSI sub-pane container
        this.rsiContainer = document.createElement('div');
        this.rsiContainer.className = 'pane-rsi-container';
        
        // Loader overlay
        this.loaderEl = document.createElement('div');
        this.loaderEl.className = 'pane-loader';
        this.loaderEl.innerText = 'Syncing...';
        this.chartContainer.appendChild(this.loaderEl);
        
        // Drawing canvas overlay
        this.drawingCanvas = document.createElement('canvas');
        this.drawingCanvas.style.position = 'absolute';
        this.drawingCanvas.style.top = '0';
        this.drawingCanvas.style.left = '0';
        this.drawingCanvas.style.width = '100%';
        this.drawingCanvas.style.height = '100%';
        this.drawingCanvas.style.zIndex = '4';
        this.drawingCanvas.style.pointerEvents = 'none';
        this.chartContainer.appendChild(this.drawingCanvas);

        this.chartWrapper.appendChild(this.chartContainer);
        this.chartWrapper.appendChild(this.rsiContainer);
        
        this.contentWrapper.appendChild(this.indicatorPanel);
        this.contentWrapper.appendChild(this.toolPanel);
        this.contentWrapper.appendChild(this.chartWrapper);
        
        this.paneEl.appendChild(header);
        this.paneEl.appendChild(controls);
        this.paneEl.appendChild(this.contentWrapper);
        
        this.container.appendChild(this.paneEl);
    }
    
    async populateSymbols(query = '') {
        const source = this.sourceSelect.value;
        try {
            const url = `/api/symbols?source=${source}&q=${encodeURIComponent(query)}`;
            const res = await fetch(url);
            if (!res.ok) return;
            const symbols = await res.json();
            
            if (Array.isArray(symbols)) {
                let options = symbols.map(s => `<option value="${s.symbol}">${s.name}</option>`).join('');
                this.symbolDatalist.innerHTML = options;
            }
        } catch (err) {
            console.error("Error populating symbols autocomplete:", err);
        }
    }
    
    initChart() {
        this.chart = LightweightCharts.createChart(this.chartContainer, {
            layout: {
                background: { type: LightweightCharts.ColorType.Solid, color: '#0b0b0c' },
                textColor: '#71717a',
                fontSize: 10,
                fontFamily: "'JetBrains Mono', monospace",
            },
            grid: {
                vertLines: { color: '#161618' },
                horzLines: { color: '#161618' },
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
                vertLine: {
                    color: '#3f3f46',
                    width: 1,
                    style: LightweightCharts.LineStyle.Dash,
                },
                horzLine: {
                    color: '#3f3f46',
                    width: 1,
                    style: LightweightCharts.LineStyle.Dash,
                },
            },
            rightPriceScale: {
                borderColor: '#222226',
            },
            timeScale: {
                borderColor: '#222226',
                timeVisible: true,
                secondsVisible: false,
            },
            handleScale: {
                axisPressedMouseMove: true,
                mouseWheel: true,
                pinch: true,
            },
            handleScroll: {
                mouseWheel: true,
                pressedMouseMove: true,
            }
        });
        
        // Editorial monochrome e-ink design: 
        // light-grey body for up, dark-grey for down
        this.series = this.chart.addCandlestickSeries({
            upColor: '#e4e4e7',
            downColor: '#18181b',
            borderUpColor: '#e4e4e7',
            borderDownColor: '#3f3f46',
            wickUpColor: '#e4e4e7',
            wickDownColor: '#3f3f46',
        });
        
        // Auto-fit resizing structure
        this.resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    const hasRsi = this.state.indicators && this.state.indicators.rsi;
                    if (hasRsi) {
                        const priceHeight = Math.floor(height * 0.7);
                        const rsiHeight = height - priceHeight;
                        this.chart.resize(width, priceHeight);
                        if (this.rsiChart) {
                            this.rsiChart.resize(width, rsiHeight);
                        }
                    } else {
                        this.chart.resize(width, height);
                    }
                }
            }
            this.redrawDrawings();
        });
        this.resizeObserver.observe(this.chartWrapper);

        this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
            this.redrawDrawings();
        });
    }
    
    async loadData() {
        this.loaderEl.classList.add('active');
        this.statusDotEl.className = 'status-dot connecting';
        
        this.unsubscribeLive();
        
        // Clear old chart candles while loading to prevent visual glitches or stretching
        if (this.series) {
            this.series.setData([]);
        }
        
        // Clear flow overlay data when loading new symbol/timeframe
        this.flowData = null;
        clearTimeout(this.flowFetchTimeout);
        
        const source = this.state.source;
        const symbol = this.state.symbol;
        const timeframe = this.state.timeframe;
        
        this.sourceBadge.innerText = source;
        this.metaText.innerText = `${symbol} [${timeframe}]`;
        
        try {
            const url = `/api/history?source=${source}&symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`;
            const res = await fetch(url);
            if (!res.ok) {
                let errorMsg = `History endpoint returned status ${res.status}`;
                try {
                    const errData = await res.json();
                    if (errData && errData.error) {
                        errorMsg = errData.error;
                    }
                } catch(_) {}
                throw new Error(errorMsg);
            }
            const data = await res.json();
            if (data.error) {
                throw new Error(data.error);
            }
            
            // Set history candles
            this.series.setData(data.history);
            
            // Keep history in active candles list
            this.activeCandles = data.history || [];
            
            if (data.history.length > 0) {
                const lastCandle = data.history[data.history.length - 1];
                this.lastPrice = lastCandle.close;
                this.lastCandleTime = lastCandle.time;
                this.updateTickerDisplay(this.lastPrice);
                
                // Track current 45m candle if timeframe is 45m
                if (timeframe === '45m') {
                    this.current45mCandle = { ...lastCandle };
                } else {
                    this.current45mCandle = null;
                }
            } else {
                this.lastCandleTime = null;
                this.current45mCandle = null;
            }
            
            this.chart.timeScale().fitContent();
            
            // Connect to subscription stream
            this.subscribeLive(data.streaming_config);
            
            // Draw overlays/oscillators
            this.updateIndicators();
            
            // Load and draw drawings
            this.loadDrawings();
            
            // Clear any error tooltips
            this.tickerValEl.title = '';
            this.statusDotEl.title = '';
            
        } catch (err) {
            console.error(`Error loading data for pane ${this.id}:`, err);
            this.tickerValEl.innerText = 'ERR';
            this.tickerValEl.title = err.message;
            this.statusDotEl.className = 'status-dot disconnected';
            this.statusDotEl.title = err.message;
        } finally {
            this.loaderEl.classList.remove('active');
        }
    }
    
    updateTickerDisplay(price) {
        if (typeof price === 'number') {
            let decimals = 2;
            if (price < 1.0) decimals = 6;
            else if (price > 10000) decimals = 0;
            
            this.tickerValEl.innerText = price.toFixed(decimals);
        } else {
            this.tickerValEl.innerText = '—';
        }
    }
    
    flashTicker(direction) {
        this.tickerValEl.classList.remove('flash-up', 'flash-down');
        void this.tickerValEl.offsetWidth; // Reflow reset
        
        if (direction === 'up') {
            this.tickerValEl.classList.add('flash-up');
        } else if (direction === 'down') {
            this.tickerValEl.classList.add('flash-down');
        }
    }
    
    handleLiveTick(tick) {
        if (!tick || tick.error) {
            console.error("Live tick payload error:", tick);
            this.statusDotEl.className = 'status-dot disconnected';
            return;
        }
        
        const tickTime = tick.time;
        if (this.lastCandleTime !== null && tickTime < this.lastCandleTime) {
            // Ignore older ticks to prevent Lightweight Charts crash
            return;
        }
        
        let finalCandle = null;
        if (this.state.timeframe === '45m') {
            const interval = 45 * 60;
            const alignedTime = Math.floor(tickTime / interval) * interval;
            
            if (this.current45mCandle && this.current45mCandle.time === alignedTime) {
                // Update existing 45m candle
                this.current45mCandle.high = Math.max(this.current45mCandle.high, tick.high || tick.close);
                this.current45mCandle.low = Math.min(this.current45mCandle.low, tick.low || tick.close);
                this.current45mCandle.close = tick.close;
                this.current45mCandle.volume = (this.current45mCandle.volume || 0) + (tick.volume || 0);
            } else {
                // Start a new 45m candle
                this.current45mCandle = {
                    time: alignedTime,
                    open: tick.open || tick.close,
                    high: tick.high || tick.close,
                    low: tick.low || tick.close,
                    close: tick.close,
                    volume: tick.volume || 0
                };
            }
            finalCandle = { ...this.current45mCandle };
        } else {
            finalCandle = {
                time: tick.time,
                open: tick.open,
                high: tick.high,
                low: tick.low,
                close: tick.close,
                volume: tick.volume || 0
            };
        }
        
        // Update price series
        this.series.update(finalCandle);
        
        // Maintain activeCandles array
        if (this.activeCandles && this.activeCandles.length > 0) {
            const lastActive = this.activeCandles[this.activeCandles.length - 1];
            if (finalCandle.time === lastActive.time) {
                this.activeCandles[this.activeCandles.length - 1] = { ...finalCandle };
            } else if (finalCandle.time > lastActive.time) {
                this.activeCandles.push({ ...finalCandle });
                if (this.activeCandles.length > 1500) {
                    this.activeCandles.shift();
                }
            }
        } else {
            this.activeCandles = [finalCandle];
        }
        
        // Recalculate indicators overlays and sub-panes
        this.updateIndicators();
        
        // Update last candle time reference
        if (this.lastCandleTime === null || tickTime > this.lastCandleTime) {
            this.lastCandleTime = tickTime;
        }
        
        const currentPrice = tick.price || tick.close;
        if (this.lastPrice !== null && currentPrice !== this.lastPrice) {
            const direction = currentPrice > this.lastPrice ? 'up' : 'down';
            this.flashTicker(direction);
        }
        this.lastPrice = currentPrice;
        this.updateTickerDisplay(currentPrice);
        this.redrawDrawings();
    }
    
    subscribeLive(config) {
        if (!config) return;
        
        let subSymbol = this.state.symbol;
        if (config.type === 'websocket' && config.subscription && config.subscription.subscription) {
            subSymbol = config.subscription.subscription.coin || this.state.symbol;
        }
        
        // Record what we are subscribing to so we can unsubscribe correctly later
        this.currentSubscription = {
            source: this.state.source,
            symbol: subSymbol,
            timeframe: this.state.timeframe
        };
        
        if (config.type === 'websocket') {
            hlWSManager.subscribe(
                subSymbol,
                this.state.timeframe,
                this.id,
                (tick) => this.handleLiveTick(tick),
                (status) => {
                    this.statusDotEl.className = `status-dot ${status}`;
                }
            );
        } else if (config.type === 'sse') {
            this.statusDotEl.className = 'status-dot connecting';
            
            this.sseSource = new EventSource(config.url);
            
            this.sseSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.connected) {
                        this.statusDotEl.className = 'status-dot connected';
                        return;
                    }
                    if (data.ping || data.keepalive) {
                        return;
                    }
                    if (data.error) {
                        throw new Error(data.error);
                    }
                    this.handleLiveTick(data);
                } catch (err) {
                    console.error("SSE parsing error:", err);
                    this.statusDotEl.className = 'status-dot disconnected';
                }
            };
            
            this.sseSource.onerror = (err) => {
                console.error("SSE stream error:", err);
                this.statusDotEl.className = 'status-dot disconnected';
                this.sseSource.close();
            };
        }
    }
    
    unsubscribeLive() {
        if (this.currentSubscription) {
            const { source, symbol, timeframe } = this.currentSubscription;
            if (source === 'hyperliquid') {
                hlWSManager.unsubscribe(symbol, timeframe, this.id);
            } else if (source === 'yfinance') {
                if (this.sseSource) {
                    this.sseSource.close();
                    this.sseSource = null;
                }
            }
            this.currentSubscription = null;
        } else {
            // Fallback safety cleanup
            hlWSManager.unsubscribe(this.state.symbol, this.state.timeframe, this.id);
            if (this.sseSource) {
                this.sseSource.close();
                this.sseSource = null;
            }
        }
        this.statusDotEl.className = 'status-dot';
    }
    
    toggleIndicatorPanel() {
        if (this.toolPanel.classList.contains('active')) {
            this.toolPanel.classList.remove('active');
            this.toolBtn.classList.remove('active');
        }
        this.indicatorPanel.classList.toggle('active');
        this.indicatorBtn.classList.toggle('active');
    }
    
    toggleToolPanel() {
        if (this.indicatorPanel.classList.contains('active')) {
            this.indicatorPanel.classList.remove('active');
            this.indicatorBtn.classList.remove('active');
        }
        this.toolPanel.classList.toggle('active');
        this.toolBtn.classList.toggle('active');
    }
    
    updateIndicators() {
        if (!this.activeCandles || this.activeCandles.length === 0) return;
        
        // 1. EMA 9
        if (this.state.indicators && this.state.indicators.ema9) {
            const ema9Data = calculateEMA(this.activeCandles, 9);
            if (!this.ema9Series) {
                this.ema9Series = this.chart.addLineSeries({
                    color: '#3b82f6', // blue
                    lineWidth: 1.5,
                    title: 'EMA 9'
                });
            }
            this.ema9Series.setData(ema9Data);
        } else {
            if (this.ema9Series) {
                try {
                    this.chart.removeSeries(this.ema9Series);
                } catch(e) {}
                this.ema9Series = null;
            }
        }
        
        // 2. EMA 21
        if (this.state.indicators && this.state.indicators.ema21) {
            const ema21Data = calculateEMA(this.activeCandles, 21);
            if (!this.ema21Series) {
                this.ema21Series = this.chart.addLineSeries({
                    color: '#ef4444', // red
                    lineWidth: 1.5,
                    title: 'EMA 21'
                });
            }
            this.ema21Series.setData(ema21Data);
        } else {
            if (this.ema21Series) {
                try {
                    this.chart.removeSeries(this.ema21Series);
                } catch(e) {}
                this.ema21Series = null;
            }
        }
        
        // 3. RSI
        if (this.state.indicators && this.state.indicators.rsi) {
            const rsiData = calculateRSI(this.activeCandles, 14);
            
            // Show RSI container and adjust Price chart height
            this.rsiContainer.style.display = 'block';
            this.chartContainer.style.height = '70%';
            
            if (!this.rsiChart) {
                this.initRsiChart();
            }
            
            this.rsiSeries.setData(rsiData);
            
            // Sync ranges
            try {
                const rsiTimeScale = this.rsiChart.timeScale();
                const priceTimeScale = this.chart.timeScale();
                const range = priceTimeScale.getVisibleLogicalRange();
                if (range) {
                    rsiTimeScale.setVisibleLogicalRange(range);
                }
            } catch (e) {
                console.error("Error syncing logical scales:", e);
            }
        } else {
            if (this.rsiChart) {
                try {
                    this.rsiChart.removeSeries(this.rsiSeries);
                } catch(e) {}
                this.rsiSeries = null;
                this.rsiContainer.innerHTML = '';
                this.rsiChart = null;
            }
            this.rsiContainer.style.display = 'none';
            this.chartContainer.style.height = '100%';
        }
        
        // Trigger manual resize call to align scales after layout adjustment
        if (this.chartWrapper) {
            const width = this.chartWrapper.offsetWidth;
            const height = this.chartWrapper.offsetHeight;
            if (width > 0 && height > 0) {
                const hasRsi = this.state.indicators && this.state.indicators.rsi;
                if (hasRsi) {
                    const priceHeight = Math.floor(height * 0.7);
                    const rsiHeight = height - priceHeight;
                    this.chart.resize(width, priceHeight);
                    if (this.rsiChart) {
                        this.rsiChart.resize(width, rsiHeight);
                    }
                } else {
                    this.chart.resize(width, height);
                }
            }
        }
        
        // 4. Flow V2.5
        if (this.state.indicators && this.state.indicators.flow) {
            if (!this.flowData) {
                // First load – fetch immediately
                this.fetchFlowData();
            } else {
                // Live tick updates – debounce to avoid flooding the backend
                clearTimeout(this.flowFetchTimeout);
                this.flowFetchTimeout = setTimeout(() => this.fetchFlowData(), 500);
            }
        } else {
            if (this.flowData) {
                this.flowData = null;
                this.redrawDrawings();
            }
        }
    }
    
    initRsiChart() {
        this.rsiChart = LightweightCharts.createChart(this.rsiContainer, {
            layout: {
                background: { type: LightweightCharts.ColorType.Solid, color: '#0b0b0c' },
                textColor: '#71717a',
                fontSize: 9,
                fontFamily: "'JetBrains Mono', monospace",
            },
            grid: {
                vertLines: { color: '#161618' },
                horzLines: { color: '#161618' },
            },
            rightPriceScale: {
                borderColor: '#222226',
            },
            timeScale: {
                visible: false,
            },
            handleScale: false,
            handleScroll: false,
        });
        
        this.rsiSeries = this.rsiChart.addLineSeries({
            color: '#c084fc', // purple
            lineWidth: 1.5,
            priceLineVisible: false,
            lastValueVisible: true,
        });
        
        // Add 30, 50, 70 guidelines
        this.rsiSeries.createPriceLine({
            price: 70,
            color: '#ef4444',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: '70',
        });
        this.rsiSeries.createPriceLine({
            price: 50,
            color: '#3f3f46',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: '50',
        });
        this.rsiSeries.createPriceLine({
            price: 30,
            color: '#10b981',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: '30',
        });
        
        // Sync logical range (indexes and whitespace) between price and RSI charts with a feedback loop guard
        let isSyncing = false;
        const rsiTimeScale = this.rsiChart.timeScale();
        const priceTimeScale = this.chart.timeScale();
        
        priceTimeScale.subscribeVisibleLogicalRangeChange((range) => {
            if (isSyncing) return;
            if (range) {
                isSyncing = true;
                rsiTimeScale.setVisibleLogicalRange(range);
                isSyncing = false;
            }
        });
        rsiTimeScale.subscribeVisibleLogicalRangeChange((range) => {
            if (isSyncing) return;
            if (range) {
                isSyncing = true;
                priceTimeScale.setVisibleLogicalRange(range);
                isSyncing = false;
            }
        });
    }

    async handleSourceChange() {
        this.state.source = this.sourceSelect.value;
        const defaultSymbol = this.state.source === 'hyperliquid' ? 'BTC' : 'THYAO.IS';
        this.symbolInput.value = defaultSymbol;
        this.state.symbol = defaultSymbol;
        
        await this.populateSymbols(defaultSymbol);
        saveDashboardState();
        this.loadData();
    }
    
    handleSymbolChange() {
        let symbolVal = this.symbolInput.value.trim().toUpperCase();
        this.symbolInput.value = symbolVal;
        
        this.state.symbol = symbolVal;
        saveDashboardState();
        this.loadData();
    }
    
    handleTimeframeChange() {
        this.state.timeframe = this.timeframeSelect.value;
        saveDashboardState();
        this.loadData();
    }
    
    setActiveTool(tool) {
        this.activeTool = tool;
        this.drawingPoints = [];
        
        const buttons = this.toolPanel.querySelectorAll('.tool-btn:not(.action-btn-clear)');
        buttons.forEach(btn => {
            if (btn.getAttribute('data-tool') === tool) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        
        if (tool === 'select') {
            this.chartContainer.style.cursor = 'default';
        } else {
            this.chartContainer.style.cursor = 'crosshair';
        }
        
        this.selectedDrawing = null;
        this.redrawDrawings();
    }
    
    clearAllDrawings() {
        this.drawings = [];
        this.selectedDrawing = null;
        this.drawingPoints = [];
        this.saveDrawings();
        this.redrawDrawings();
    }
    
    loadDrawings() {
        const key = `${this.state.source}:${this.state.symbol}`;
        try {
            const raw = localStorage.getItem('atlas_drawings_v1');
            if (raw) {
                const allDrawings = JSON.parse(raw);
                this.drawings = allDrawings[key] || [];
            } else {
                this.drawings = [];
            }
        } catch (e) {
            console.error("Error loading drawings:", e);
            this.drawings = [];
        }
        this.selectedDrawing = null;
        this.drawingPoints = [];
        this.redrawDrawings();
    }
    
    saveDrawings() {
        const key = `${this.state.source}:${this.state.symbol}`;
        try {
            const raw = localStorage.getItem('atlas_drawings_v1');
            const allDrawings = raw ? JSON.parse(raw) : {};
            allDrawings[key] = this.drawings;
            localStorage.setItem('atlas_drawings_v1', JSON.stringify(allDrawings));
        } catch (e) {
            console.error("Error saving drawings:", e);
        }
    }
    
    getPlotAreaRect() {
        const container = this.chartContainer;
        const width = container.clientWidth;
        const height = container.clientHeight;
        
        let priceScaleWidth = 0;
        try {
            priceScaleWidth = this.chart.priceScale('right').width() || 0;
        } catch(e) {}
        
        let timeScaleHeight = 26;
        
        const canvases = Array.from(container.querySelectorAll('canvas'));
        if (canvases.length > 0) {
            const mainCanvas = canvases.find(c => {
                return c.clientWidth > 50 && c.clientHeight > 50 && c.clientWidth < width;
            });
            if (mainCanvas) {
                return {
                    left: 0,
                    top: 0,
                    width: mainCanvas.clientWidth,
                    height: mainCanvas.clientHeight
                };
            }
        }
        
        return {
            left: 0,
            top: 0,
            width: width - priceScaleWidth,
            height: height - timeScaleHeight
        };
    }
    
    dataToPixel(point) {
        if (!point) return null;
        try {
            const x = this.chart.timeScale().logicalToCoordinate(point.logical);
            const y = this.series.priceToCoordinate(point.price);
            if (x === null || y === null) return null;
            return { x, y };
        } catch (e) {
            return null;
        }
    }
    
    pixelToData(x, y) {
        try {
            const logical = this.chart.timeScale().coordinateToLogical(x);
            const price = this.series.coordinateToPrice(y);
            if (logical === null || price === null) return null;
            return { logical, price };
        } catch (e) {
            return null;
        }
    }
    
    redrawDrawings() {
        if (!this.drawingCanvas) return;
        
        const dpr = window.devicePixelRatio || 1;
        const width = this.chartContainer.clientWidth;
        const height = this.chartContainer.clientHeight;
        
        if (width === 0 || height === 0) return;
        
        if (this.drawingCanvas.width !== width * dpr || this.drawingCanvas.height !== height * dpr) {
            this.drawingCanvas.width = width * dpr;
            this.drawingCanvas.height = height * dpr;
            this.drawingCanvas.style.width = `${width}px`;
            this.drawingCanvas.style.height = `${height}px`;
        }
        
        const ctx = this.drawingCanvas.getContext('2d');
        ctx.resetTransform();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);
        
        const rect = this.getPlotAreaRect();
        
        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.left, rect.top, rect.width, rect.height);
        ctx.clip();
        
        // ---- Flow V2.5 overlay (rendered behind user drawings) ----
        if (this.state.indicators && this.state.indicators.flow && this.flowData) {
            this.renderFlowOverlay(ctx, rect);
        }
        
        // ---- User drawings ----
        this.drawings.forEach(drawing => {
            const isSelected = (this.selectedDrawing === drawing);
            this.drawShape(ctx, drawing, isSelected, rect);
        });
        
        if (this.drawingPoints.length > 0 && this.lastMousePos) {
            this.drawPreview(ctx, rect);
        }
        
        ctx.restore();
        
        if (this.selectedDrawing) {
            this.drawHandles(ctx, this.selectedDrawing);
        }
    }
    
    setLineStyle(ctx, isSelected) {
        if (isSelected) {
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2.0;
        } else {
            ctx.strokeStyle = '#e4e4e7';
            ctx.lineWidth = 1.5;
        }
        ctx.setLineDash([]);
    }
    
    drawShape(ctx, drawing, isSelected, rect) {
        if (drawing.type === 'trend') {
            const p1 = this.dataToPixel(drawing.points[0]);
            const p2 = this.dataToPixel(drawing.points[1]);
            if (p1 && p2) {
                this.setLineStyle(ctx, isSelected);
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.stroke();
            }
        } else if (drawing.type === 'horizontal') {
            const p1 = this.dataToPixel(drawing.points[0]);
            if (p1) {
                this.setLineStyle(ctx, isSelected);
                ctx.beginPath();
                ctx.moveTo(rect.left, p1.y);
                ctx.lineTo(rect.left + rect.width, p1.y);
                ctx.stroke();
            }
        } else if (drawing.type === 'ray') {
            const p1 = this.dataToPixel(drawing.points[0]);
            if (p1) {
                this.setLineStyle(ctx, isSelected);
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(rect.left + rect.width, p1.y);
                ctx.stroke();
            }
        } else if (drawing.type === 'rectangle') {
            const p1 = this.dataToPixel(drawing.points[0]);
            const p2 = this.dataToPixel(drawing.points[1]);
            if (p1 && p2) {
                this.setLineStyle(ctx, isSelected);
                const x = Math.min(p1.x, p2.x);
                const y = Math.min(p1.y, p2.y);
                const w = Math.abs(p1.x - p2.x);
                const h = Math.abs(p1.y - p2.y);
                
                ctx.beginPath();
                ctx.rect(x, y, w, h);
                ctx.stroke();
                
                ctx.fillStyle = isSelected ? 'rgba(59, 130, 246, 0.08)' : 'rgba(228, 228, 231, 0.04)';
                ctx.fill();
            }
        } else if (drawing.type === 'channel') {
            const p1 = this.dataToPixel(drawing.points[0]);
            const p2 = this.dataToPixel(drawing.points[1]);
            const p3 = this.dataToPixel(drawing.points[2]);
            if (p1 && p2 && p3) {
                const dx = p3.x - p1.x;
                const dy = p3.y - p1.y;
                const p4 = { x: p2.x + dx, y: p2.y + dy };
                
                this.setLineStyle(ctx, isSelected);
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.stroke();
                
                ctx.beginPath();
                ctx.moveTo(p3.x, p3.y);
                ctx.lineTo(p4.x, p4.y);
                ctx.stroke();
                
                const m1 = { x: (p1.x + p3.x) / 2, y: (p1.y + p3.y) / 2 };
                const m2 = { x: (p2.x + p4.x) / 2, y: (p2.y + p4.y) / 2 };
                ctx.beginPath();
                ctx.moveTo(m1.x, m1.y);
                ctx.lineTo(m2.x, m2.y);
                ctx.strokeStyle = isSelected ? '#3b82f6' : '#a1a1aa';
                ctx.lineWidth = 1.0;
                ctx.setLineDash([4, 4]);
                ctx.stroke();
                ctx.setLineDash([]);
                
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.lineTo(p4.x, p4.y);
                ctx.lineTo(p3.x, p3.y);
                ctx.closePath();
                ctx.fillStyle = isSelected ? 'rgba(59, 130, 246, 0.08)' : 'rgba(228, 228, 231, 0.04)';
                ctx.fill();
            }
        }
    }
    
    drawHandles(ctx, drawing) {
        const rect = this.getPlotAreaRect();
        let points = [];
        
        if (drawing.type === 'horizontal') {
            const p1 = this.dataToPixel(drawing.points[0]);
            if (p1) {
                points.push({ x: rect.left + rect.width / 2, y: p1.y });
            }
        } else if (drawing.type === 'channel') {
            drawing.points.forEach(pt => {
                const pixel = this.dataToPixel(pt);
                if (pixel) points.push(pixel);
            });
            const p1 = points[0];
            const p2 = points[1];
            const p3 = points[2];
            if (p1 && p2 && p3) {
                const dx = p3.x - p1.x;
                const dy = p3.y - p1.y;
                points.push({ x: p2.x + dx, y: p2.y + dy });
            }
        } else {
            drawing.points.forEach(pt => {
                const pixel = this.dataToPixel(pt);
                if (pixel) points.push(pixel);
            });
        }
        
        points.forEach(pt => {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 5, 0, 2 * Math.PI);
            ctx.fillStyle = '#3b82f6';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
        });
    }
    
    drawPreview(ctx, rect) {
        const mouse = this.lastMousePos;
        if (!mouse) return;
        
        ctx.strokeStyle = 'rgba(228, 228, 231, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        
        const p1 = this.dataToPixel(this.drawingPoints[0]);
        
        if (this.activeTool === 'trend' && p1) {
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(mouse.x, mouse.y);
            ctx.stroke();
        } else if (this.activeTool === 'rectangle' && p1) {
            ctx.beginPath();
            ctx.rect(p1.x, p1.y, mouse.x - p1.x, mouse.y - p1.y);
            ctx.stroke();
            ctx.fillStyle = 'rgba(228, 228, 231, 0.02)';
            ctx.fill();
        } else if (this.activeTool === 'channel') {
            if (this.drawingPoints.length === 1 && p1) {
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(mouse.x, mouse.y);
                ctx.stroke();
            } else if (this.drawingPoints.length === 2 && p1) {
                const p2 = this.dataToPixel(this.drawingPoints[1]);
                if (p2) {
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.stroke();
                    
                    const dx = mouse.x - p1.x;
                    const dy = mouse.y - p1.y;
                    ctx.beginPath();
                    ctx.moveTo(mouse.x, mouse.y);
                    ctx.lineTo(p2.x + dx, p2.y + dy);
                    ctx.stroke();
                    
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.lineTo(p2.x + dx, p2.y + dy);
                    ctx.lineTo(mouse.x, mouse.y);
                    ctx.closePath();
                    ctx.fillStyle = 'rgba(228, 228, 231, 0.02)';
                    ctx.fill();
                }
            }
        }
        ctx.setLineDash([]);
    }
    
    // ==========================================
    // FLOW V2.5 – DATA FETCH
    // ==========================================
    async fetchFlowData() {
        if (this.flowFetching) return;
        if (!(this.state.indicators && this.state.indicators.flow)) return;
        
        this.flowFetching = true;
        try {
            const url = `/api/flow?source=${this.state.source}&symbol=${encodeURIComponent(this.state.symbol)}&timeframe=${this.state.timeframe}`;
            const res = await fetch(url);
            if (!res.ok) {
                console.error(`Flow API returned ${res.status}`);
                return;
            }
            const data = await res.json();
            if (data.error) {
                console.error('Flow API error:', data.error);
                return;
            }
            this.flowData = data;
            this.redrawDrawings();
        } catch (err) {
            console.error('Error fetching flow data:', err);
        } finally {
            this.flowFetching = false;
        }
    }
    
    // ==========================================
    // FLOW V2.5 – CANVAS RENDERING
    // ==========================================
    renderFlowOverlay(ctx, rect) {
        const data = this.flowData;
        if (!data) return;
        
        // Build time → logical-index map from active candles
        const timeMap = {};
        if (this.activeCandles) {
            this.activeCandles.forEach((c, idx) => {
                timeMap[c.time] = idx;
            });
        }
        
        // Helper: convert (time, price) → pixel coordinates
        const toPixel = (time, price) => {
            const logical = timeMap[time];
            let x = null;
            if (logical !== undefined) {
                x = this.chart.timeScale().logicalToCoordinate(logical);
            } else {
                // Fallback for times not in our candle set
                try { x = this.chart.timeScale().timeToCoordinate(time); } catch(e) {}
            }
            const y = this.series.priceToCoordinate(price);
            if (x === null || y === null) return null;
            return { x, y };
        };
        
        // Helper: price → y coordinate only
        const priceToY = (price) => {
            return this.series.priceToCoordinate(price);
        };
        
        // --------------------------------------------------
        // 1. Draw structural boxes (background layer)
        // --------------------------------------------------
        if (data.boxes && data.boxes.length > 0) {
            data.boxes.forEach(box => {
                // For the current (active) box, extend right to latest candle
                let rightTime = box.right_time;
                if (box.is_current && this.activeCandles && this.activeCandles.length > 0) {
                    rightTime = this.activeCandles[this.activeCandles.length - 1].time;
                }
                
                const tl = toPixel(box.left_time, box.top);
                const br = toPixel(rightTime, box.bottom);
                if (!tl || !br) return;
                
                const bx = Math.min(tl.x, br.x);
                const by = Math.min(tl.y, br.y);
                const bw = Math.abs(br.x - tl.x);
                const bh = Math.abs(br.y - tl.y);
                
                if (bw < 1 || bh < 1) return;
                
                // Box fill
                ctx.fillStyle = box.is_long
                    ? 'rgba(34, 197, 94, 0.04)'
                    : 'rgba(239, 68, 68, 0.04)';
                ctx.fillRect(bx, by, bw, bh);
                
                // Box border
                ctx.strokeStyle = box.is_long
                    ? 'rgba(34, 197, 94, 0.20)'
                    : 'rgba(239, 68, 68, 0.20)';
                ctx.lineWidth = 1;
                ctx.setLineDash([]);
                ctx.strokeRect(bx, by, bw, bh);
                
                // Fibonacci levels inside the box
                if (box.fib_levels) {
                    const levels = [
                        { key: '0.25', color: 'rgba(113,113,122,0.35)', width: 1 },
                        { key: '0.50', color: 'rgba(113,113,122,0.55)', width: 1.5 },
                        { key: '0.75', color: 'rgba(113,113,122,0.35)', width: 1 },
                    ];
                    ctx.setLineDash([3, 4]);
                    levels.forEach(({ key, color, width }) => {
                        const price = box.fib_levels[key];
                        if (price === undefined) return;
                        const ly = priceToY(price);
                        if (ly === null) return;
                        ctx.strokeStyle = color;
                        ctx.lineWidth = width;
                        ctx.beginPath();
                        ctx.moveTo(bx, ly);
                        ctx.lineTo(bx + bw, ly);
                        ctx.stroke();
                    });
                }
            });
        }
        
        ctx.setLineDash([]);
        
        // --------------------------------------------------
        // 2. Draw close lines (structural level markers)
        // --------------------------------------------------
        if (data.close_lines && data.close_lines.length > 0) {
            ctx.strokeStyle = 'rgba(160, 160, 160, 0.55)';
            ctx.lineWidth = 1;
            ctx.setLineDash([]);
            data.close_lines.forEach(seg => {
                const p1 = toPixel(seg.x1_time, seg.y1);
                const p2 = toPixel(seg.x2_time, seg.y2);
                if (p1 && p2) {
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.stroke();
                }
            });
        }
        
        // --------------------------------------------------
        // 3. Draw sweep lines (failed break markers)
        // --------------------------------------------------
        if (data.sweep_lines && data.sweep_lines.length > 0) {
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            data.sweep_lines.forEach(seg => {
                const p1 = toPixel(seg.x1_time, seg.y1);
                const p2 = toPixel(seg.x2_time, seg.y2);
                if (p1 && p2) {
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.stroke();
                }
            });
        }
        
        ctx.setLineDash([]);
        
        // --------------------------------------------------
        // 4. Draw zigzag lines (structural skeleton)
        // --------------------------------------------------
        if (data.zigzag_segments && data.zigzag_segments.length > 0) {
            ctx.strokeStyle = '#5b86e5';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 3]);
            data.zigzag_segments.forEach(seg => {
                const p1 = toPixel(seg.x1_time, seg.y1);
                const p2 = toPixel(seg.x2_time, seg.y2);
                if (p1 && p2) {
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.stroke();
                }
            });
        }
        
        ctx.setLineDash([]);
    }
    
    isPointNearSegment(p, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const l2 = dx * dx + dy * dy;
        if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y) < 8;
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
        const projX = a.x + t * dx;
        const projY = a.y + t * dy;
        return Math.hypot(p.x - projX, p.y - projY) < 8;
    }
    
    isPointInQuad(p, q1, q2, q3, q4) {
        const pts = [q1, q2, q3, q4];
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i].x, yi = pts[i].y;
            const xj = pts[j].x, yj = pts[j].y;
            const intersect = ((yi > p.y) !== (yj > p.y))
                && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    
    isPointNearDrawing(p, drawing) {
        const rect = this.getPlotAreaRect();
        
        if (drawing.type === 'trend') {
            const a = this.dataToPixel(drawing.points[0]);
            const b = this.dataToPixel(drawing.points[1]);
            if (!a || !b) return false;
            return this.isPointNearSegment(p, a, b);
        }
        
        if (drawing.type === 'horizontal') {
            const a = this.dataToPixel(drawing.points[0]);
            if (!a) return false;
            return Math.abs(p.y - a.y) < 8 && p.x >= rect.left && p.x <= rect.left + rect.width;
        }
        
        if (drawing.type === 'ray') {
            const a = this.dataToPixel(drawing.points[0]);
            if (!a) return false;
            return Math.abs(p.y - a.y) < 8 && p.x >= a.x - 4 && p.x <= rect.left + rect.width;
        }
        
        if (drawing.type === 'rectangle') {
            const a = this.dataToPixel(drawing.points[0]);
            const b = this.dataToPixel(drawing.points[1]);
            if (!a || !b) return false;
            
            const topL = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
            const botR = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
            
            const nearTop = this.isPointNearSegment(p, topL, { x: botR.x, y: topL.y });
            const nearBottom = this.isPointNearSegment(p, { x: topL.x, y: botR.y }, botR);
            const nearLeft = this.isPointNearSegment(p, topL, { x: topL.x, y: botR.y });
            const nearRight = this.isPointNearSegment(p, { x: botR.x, y: topL.y }, botR);
            
            if (nearTop || nearBottom || nearLeft || nearRight) return true;
            
            return p.x >= topL.x && p.x <= botR.x && p.y >= topL.y && p.y <= botR.y;
        }
        
        if (drawing.type === 'channel') {
            const p1 = this.dataToPixel(drawing.points[0]);
            const p2 = this.dataToPixel(drawing.points[1]);
            const p3 = this.dataToPixel(drawing.points[2]);
            if (!p1 || !p2 || !p3) return false;
            
            const dx = p3.x - p1.x;
            const dy = p3.y - p1.y;
            const p4 = { x: p2.x + dx, y: p2.y + dy };
            
            if (this.isPointNearSegment(p, p1, p2)) return true;
            if (this.isPointNearSegment(p, p3, p4)) return true;
            
            return this.isPointInQuad(p, p1, p2, p4, p3);
        }
        
        return false;
    }
    
    initCanvasEvents() {
        const container = this.chartContainer;
        
        container.addEventListener('mousedown', (e) => {
            const rect = container.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            
            const dataPt = this.pixelToData(mouseX, mouseY);
            if (!dataPt) return;
            
            dataPt.logical = Math.round(dataPt.logical);
            const mousePixel = { x: mouseX, y: mouseY };
            
            if (this.activeTool !== 'select') {
                e.stopPropagation();
                e.preventDefault();
                
                this.drawingPoints.push(dataPt);
                
                if (this.activeTool === 'horizontal') {
                    this.drawings.push({
                        id: Date.now() + Math.random(),
                        type: 'horizontal',
                        points: [this.drawingPoints[0]]
                    });
                    this.saveDrawings();
                    this.setActiveTool('select');
                } else if (this.activeTool === 'ray') {
                    this.drawings.push({
                        id: Date.now() + Math.random(),
                        type: 'ray',
                        points: [this.drawingPoints[0]]
                    });
                    this.saveDrawings();
                    this.setActiveTool('select');
                } else if (this.activeTool === 'trend' && this.drawingPoints.length === 2) {
                    this.drawings.push({
                        id: Date.now() + Math.random(),
                        type: 'trend',
                        points: [...this.drawingPoints]
                    });
                    this.saveDrawings();
                    this.setActiveTool('select');
                } else if (this.activeTool === 'rectangle' && this.drawingPoints.length === 2) {
                    this.drawings.push({
                        id: Date.now() + Math.random(),
                        type: 'rectangle',
                        points: [...this.drawingPoints]
                    });
                    this.saveDrawings();
                    this.setActiveTool('select');
                } else if (this.activeTool === 'channel' && this.drawingPoints.length === 3) {
                    this.drawings.push({
                        id: Date.now() + Math.random(),
                        type: 'channel',
                        points: [...this.drawingPoints]
                    });
                    this.saveDrawings();
                    this.setActiveTool('select');
                }
                
                this.redrawDrawings();
                return;
            }
            
            if (this.selectedDrawing) {
                const plotRect = this.getPlotAreaRect();
                let handlePoints = [];
                
                if (this.selectedDrawing.type === 'horizontal') {
                    const p1 = this.dataToPixel(this.selectedDrawing.points[0]);
                    if (p1) {
                        handlePoints.push({ x: plotRect.left + plotRect.width / 2, y: p1.y });
                    }
                } else if (this.selectedDrawing.type === 'channel') {
                    this.selectedDrawing.points.forEach(pt => {
                        const pixel = this.dataToPixel(pt);
                        if (pixel) handlePoints.push(pixel);
                    });
                    const p1 = handlePoints[0];
                    const p2 = handlePoints[1];
                    const p3 = handlePoints[2];
                    if (p1 && p2 && p3) {
                        const dx = p3.x - p1.x;
                        const dy = p3.y - p1.y;
                        handlePoints.push({ x: p2.x + dx, y: p2.y + dy });
                    }
                } else {
                    this.selectedDrawing.points.forEach(pt => {
                        const pixel = this.dataToPixel(pt);
                        if (pixel) handlePoints.push(pixel);
                    });
                }
                
                let clickedHandleIdx = -1;
                for (let i = 0; i < handlePoints.length; i++) {
                    const dist = Math.hypot(mouseX - handlePoints[i].x, mouseY - handlePoints[i].y);
                    if (dist < 10) {
                        clickedHandleIdx = i;
                        break;
                    }
                }
                
                if (clickedHandleIdx >= 0) {
                    e.stopPropagation();
                    e.preventDefault();
                    
                    this.draggedDrawing = this.selectedDrawing;
                    this.draggedHandleIndex = clickedHandleIdx;
                    this.dragStartPoint = dataPt;
                    this.dragOriginalPoints = this.selectedDrawing.points.map(pt => ({ ...pt }));
                    return;
                }
            }
            
            let clickedDrawing = null;
            for (let i = this.drawings.length - 1; i >= 0; i--) {
                if (this.isPointNearDrawing(mousePixel, this.drawings[i])) {
                    clickedDrawing = this.drawings[i];
                    break;
                }
            }
            
            if (clickedDrawing) {
                e.stopPropagation();
                e.preventDefault();
                
                this.selectedDrawing = clickedDrawing;
                this.draggedDrawing = clickedDrawing;
                this.draggedHandleIndex = -1;
                this.dragStartPoint = dataPt;
                this.dragOriginalPoints = clickedDrawing.points.map(pt => ({ ...pt }));
                this.redrawDrawings();
                return;
            }
            
            if (this.selectedDrawing) {
                this.selectedDrawing = null;
                this.redrawDrawings();
            }
            
        }, true);
        
        container.addEventListener('mousemove', (e) => {
            const rect = container.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const mousePixel = { x: mouseX, y: mouseY };
            
            this.lastMousePos = mousePixel;
            
            const dataPt = this.pixelToData(mouseX, mouseY);
            if (!dataPt) return;
            dataPt.logical = Math.round(dataPt.logical);
            
            if (this.draggedDrawing) {
                e.stopPropagation();
                e.preventDefault();
                
                const deltaLogical = dataPt.logical - this.dragStartPoint.logical;
                const deltaPrice = dataPt.price - this.dragStartPoint.price;
                
                if (this.draggedHandleIndex >= 0) {
                    if (this.draggedDrawing.type === 'horizontal') {
                        this.draggedDrawing.points[0].price = dataPt.price;
                    } else if (this.draggedDrawing.type === 'channel') {
                        if (this.draggedHandleIndex === 3) {
                            const p1 = this.draggedDrawing.points[0];
                            const p2 = this.draggedDrawing.points[1];
                            this.draggedDrawing.points[2].logical = dataPt.logical - p2.logical + p1.logical;
                            this.draggedDrawing.points[2].price = dataPt.price - p2.price + p1.price;
                        } else {
                            const pt = this.draggedDrawing.points[this.draggedHandleIndex];
                            pt.logical = dataPt.logical;
                            pt.price = dataPt.price;
                        }
                    } else {
                        const pt = this.draggedDrawing.points[this.draggedHandleIndex];
                        pt.logical = dataPt.logical;
                        pt.price = dataPt.price;
                    }
                } else {
                    this.draggedDrawing.points.forEach((pt, idx) => {
                        const orig = this.dragOriginalPoints[idx];
                        pt.logical = orig.logical + deltaLogical;
                        pt.price = orig.price + deltaPrice;
                    });
                }
                
                this.redrawDrawings();
                return;
            }
            
            if (this.activeTool !== 'select') {
                e.stopPropagation();
                e.preventDefault();
                this.redrawDrawings();
                return;
            }
            
            if (this.activeTool === 'select') {
                let cursorStyle = 'default';
                if (this.selectedDrawing) {
                    const plotRect = this.getPlotAreaRect();
                    let handlePoints = [];
                    
                    if (this.selectedDrawing.type === 'horizontal') {
                        const p1 = this.dataToPixel(this.selectedDrawing.points[0]);
                        if (p1) {
                            handlePoints.push({ x: plotRect.left + plotRect.width / 2, y: p1.y });
                        }
                    } else if (this.selectedDrawing.type === 'channel') {
                        this.selectedDrawing.points.forEach(pt => {
                            const pixel = this.dataToPixel(pt);
                            if (pixel) handlePoints.push(pixel);
                        });
                        const p1 = handlePoints[0];
                        const p2 = handlePoints[1];
                        const p3 = handlePoints[2];
                        if (p1 && p2 && p3) {
                            const dx = p3.x - p1.x;
                            const dy = p3.y - p1.y;
                            handlePoints.push({ x: p2.x + dx, y: p2.y + dy });
                        }
                    } else {
                        this.selectedDrawing.points.forEach(pt => {
                            const pixel = this.dataToPixel(pt);
                            if (pixel) handlePoints.push(pixel);
                        });
                    }
                    
                    for (let i = 0; i < handlePoints.length; i++) {
                        if (Math.hypot(mouseX - handlePoints[i].x, mouseY - handlePoints[i].y) < 10) {
                            cursorStyle = 'pointer';
                            break;
                        }
                    }
                }
                
                if (cursorStyle === 'default') {
                    for (let i = this.drawings.length - 1; i >= 0; i--) {
                        if (this.isPointNearDrawing(mousePixel, this.drawings[i])) {
                            cursorStyle = 'move';
                            break;
                        }
                    }
                }
                
                container.style.cursor = cursorStyle;
            }
        }, true);
        
        const mouseUpHandler = (e) => {
            if (this.draggedDrawing) {
                e.stopPropagation();
                e.preventDefault();
                
                this.saveDrawings();
                this.draggedDrawing = null;
                this.draggedHandleIndex = -1;
                this.dragStartPoint = null;
                this.dragOriginalPoints = [];
                this.redrawDrawings();
            }
        };
        
        window.addEventListener('mouseup', mouseUpHandler, true);
        
        const keyDownHandler = (e) => {
            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') {
                return;
            }
            
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedDrawing) {
                e.preventDefault();
                this.drawings = this.drawings.filter(d => d.id !== this.selectedDrawing.id);
                this.selectedDrawing = null;
                this.saveDrawings();
                this.redrawDrawings();
            }
        };
        
        window.addEventListener('keydown', keyDownHandler);
        
        this.cleanUpEventListeners = () => {
            window.removeEventListener('mouseup', mouseUpHandler, true);
            window.removeEventListener('keydown', keyDownHandler);
        };
    }
    
    destroy() {
        this.unsubscribeLive();
        if (this.cleanUpEventListeners) {
            this.cleanUpEventListeners();
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        if (this.rsiChart) {
            try {
                this.rsiChart.removeSeries(this.rsiSeries);
            } catch(e) {}
            this.rsiSeries = null;
            this.rsiChart = null;
        }
        if (this.chart) {
            this.chart.remove();
        }
        if (this.paneEl && this.paneEl.parentNode) {
            this.paneEl.parentNode.removeChild(this.paneEl);
        }
    }
}


// ==========================================
// 3. LAYOUT & PERSISTENCE MANAGER
// ==========================================
const STORAGE_KEY = 'atlas_dashboard_layout_v1';
const activePanes = {};
let currentLayoutCount = 4;

function saveDashboardState() {
    const paneConfigs = [];
    for (let i = 1; i <= currentLayoutCount; i++) {
        const pane = activePanes[i];
        if (pane) {
            paneConfigs.push({
                id: pane.id,
                source: pane.state.source,
                symbol: pane.state.symbol,
                timeframe: pane.state.timeframe,
                indicators: pane.state.indicators || { ema9: false, ema21: false, rsi: false }
            });
        }
    }
    
    const state = {
        layout: currentLayoutCount,
        panes: paneConfigs
    };
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadDashboardState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.error("Error loading dashboard state from localStorage:", e);
        return null;
    }
}

function applyLayout(count) {
    const gridContainer = document.getElementById('chart-grid-container');
    if (!gridContainer) return;
    
    console.log(`Applying layout with count: ${count}`);
    currentLayoutCount = count;
    
    // Update active class on selector buttons
    const buttons = document.querySelectorAll('.btn-layout');
    buttons.forEach(btn => {
        if (parseInt(btn.getAttribute('data-panes')) === count) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    
    // Update container layout grid class
    gridContainer.className = `chart-grid grid-${count}`;
    
    const savedState = loadDashboardState();
    
    // 1. Destroy excess panes
    for (const id in activePanes) {
        const paneId = parseInt(id);
        if (paneId > count && activePanes[paneId]) {
            try {
                activePanes[paneId].destroy();
            } catch (err) {
                console.error(`Error destroying pane ${paneId}:`, err);
            }
            delete activePanes[paneId];
        }
    }
    
    // Clean up any extra DOM elements that might be lingering in the container
    const existingPanes = gridContainer.querySelectorAll('.chart-pane');
    existingPanes.forEach(pane => {
        const idMatch = pane.id.match(/pane-(\d+)/);
        if (idMatch) {
            const paneId = parseInt(idMatch[1]);
            if (paneId > count) {
                try {
                    pane.parentNode.removeChild(pane);
                } catch (e) {
                    console.error(`Error removing excess DOM element for pane ${paneId}:`, e);
                }
            }
        }
    });
    
    // 2. Create missing panes
    for (let i = 1; i <= count; i++) {
        if (!activePanes[i]) {
            try {
                // Find if there is a saved state for this pane
                let initialPaneState = null;
                if (savedState && Array.isArray(savedState.panes)) {
                    const config = savedState.panes.find(p => p && p.id === i);
                    if (config) {
                        initialPaneState = {
                            source: config.source || 'hyperliquid',
                            symbol: config.symbol || 'BTC',
                            timeframe: config.timeframe || '1m',
                            indicators: config.indicators || { ema9: false, ema21: false, rsi: false }
                        };
                    }
                }
                
                // Default setup for extra charts if no config found
                if (!initialPaneState) {
                    if (i % 2 === 0) {
                        initialPaneState = { source: 'yfinance', symbol: 'THYAO.IS', timeframe: '1d', indicators: { ema9: false, ema21: false, rsi: false } };
                    } else {
                        initialPaneState = { source: 'hyperliquid', symbol: 'BTC', timeframe: '1m', indicators: { ema9: false, ema21: false, rsi: false } };
                    }
                }
                
                activePanes[i] = new ChartPane(i, gridContainer, initialPaneState);
            } catch (err) {
                console.error(`Error initializing chart pane ${i}:`, err);
            }
        }
    }
    
    saveDashboardState();
}


// ==========================================
// 4. INITIALIZATION HANDLER
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    const savedState = loadDashboardState();
    let initialCount = 4;
    
    if (savedState && savedState.layout) {
        initialCount = parseInt(savedState.layout);
    }
    
    // Render and set initial active panes
    applyLayout(initialCount);
    
    // Attach event listeners to layout selector buttons
    const layoutSelector = document.getElementById('layout-selector');
    if (layoutSelector) {
        layoutSelector.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-layout');
            if (!btn) return;
            const panesCount = parseInt(btn.getAttribute('data-panes'));
            applyLayout(panesCount);
        });
    }
});
