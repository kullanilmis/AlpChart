import {
    fetchHistory,
    fetchSymbols,
    fetchDrawings,
    saveDrawings,
} from './api.js';
import { getTheme } from './themes.js';
import { hlWSManager } from './wsManager.js';
import { calculateEMA, calculateRSI, computeFlowJS } from './indicators.js';
import { syncManager } from './syncManager.js';
import { DrawingEngine } from './drawingEngine.js';
import { alertManager } from './alertManager.js';

const TIMEFRAME_SECONDS = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '45m': 2700,
    '1h': 3600,
    '4h': 14400,
    '1d': 86400,
    '1w': 604800,
};

const TOOL_DEFINITIONS = [
    { id: 'select', label: 'Cursor', title: 'Seç / Düzenle' },
    { id: 'trend', label: 'Trend', title: 'Trend Çizgisi (Alt+T)' },
    { id: 'horizontal', label: 'Yatay', title: 'Yatay Çizgi (Alt+H)' },
    { id: 'ray', label: 'Işın', title: 'Yatay Işın' },
    { id: 'channel', label: 'Kanal', title: 'Paralel Kanal' },
    { id: 'rectangle', label: 'Kutu', title: 'Dikdörtgen Kutu' },
    { id: 'fib', label: 'Fib Retracement', title: 'Fibonacci Düzeltmesi (Alt+F)' },
    { id: 'long', label: 'Long R:R', title: 'Long Pozisyon R:R' },
    { id: 'short', label: 'Short R:R', title: 'Short Pozisyon R:R' },
    { id: 'measure', label: 'Ölçüm', title: 'Fiyat / Tarih Ölçümü (Shift+Sürükle)' },
];

/**
 * Determine dynamic Lightweight Charts priceFormat from candle price levels.
 */
export function computePriceFormat(candles) {
    if (!Array.isArray(candles) || candles.length === 0) {
        return { type: 'price', precision: 2, minMove: 0.01 };
    }

    const closes = [];
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        if (c && typeof c.close === 'number' && Number.isFinite(c.close) && c.close > 0) {
            closes.push(c.close);
        }
    }
    if (closes.length === 0) {
        return { type: 'price', precision: 2, minMove: 0.01 };
    }

    closes.sort((a, b) => a - b);
    const refPrice = closes[Math.floor(closes.length / 2)];

    if (refPrice < 0.001) {
        return { type: 'price', precision: 6, minMove: 0.000001 };
    }
    if (refPrice < 0.1) {
        return { type: 'price', precision: 5, minMove: 0.00001 };
    }
    if (refPrice < 1) {
        return { type: 'price', precision: 4, minMove: 0.0001 };
    }
    if (refPrice < 100) {
        return { type: 'price', precision: 3, minMove: 0.001 };
    }
    if (refPrice < 10000) {
        return { type: 'price', precision: 2, minMove: 0.01 };
    }
    return { type: 'price', precision: 2, minMove: 0.01 };
}

function formatCompactVolume(vol) {
    if (typeof vol !== 'number' || !Number.isFinite(vol)) return '—';
    const abs = Math.abs(vol);
    if (abs >= 1e9) return `${(vol / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(vol / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(vol / 1e3).toFixed(2)}K`;
    return abs >= 100 ? vol.toFixed(0) : vol.toFixed(2);
}

function formatCountdown(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const mm = String(mins).padStart(2, '0');
    const ss = String(secs).padStart(2, '0');
    if (hrs > 0) {
        return `${String(hrs).padStart(2, '0')}:${mm}:${ss}`;
    }
    return `${mm}:${ss}`;
}

function toDateFromLwcTime(time) {
    if (typeof time === 'number' && Number.isFinite(time)) {
        return new Date(time * 1000);
    }
    if (time && typeof time === 'object' && typeof time.year === 'number') {
        return new Date(Date.UTC(time.year, time.month - 1, time.day));
    }
    return null;
}

/**
 * Individual chart pane managing Lightweight Charts price/RSI series,
 * live WebSocket/SSE streaming, lazy history loading, indicators, sync, and drawings.
 */
export class ChartPane {
    constructor(id, container, initialState = null, callbacks = {}) {
        this.id = id;
        this.container = container;
        this.callbacks = callbacks || {};

        const rawState = initialState && typeof initialState === 'object' ? initialState : {};
        this.state = {
            source: String(rawState.source || 'hyperliquid').trim().toLowerCase() || 'hyperliquid',
            symbol: String(rawState.symbol || 'BTC').trim().toUpperCase() || 'BTC',
            timeframe: rawState.timeframe || '1m',
            indicators: {
                ema9: Boolean(rawState.indicators?.ema9),
                ema21: Boolean(rawState.indicators?.ema21),
                rsi: Boolean(rawState.indicators?.rsi),
                flow: Boolean(rawState.indicators?.flow),
            },
            scaleMode: rawState.scaleMode || 'normal',
            autoScale: rawState.autoScale !== undefined ? Boolean(rawState.autoScale) : true,
        };

        this.theme = this.callbacks.theme && typeof this.callbacks.theme === 'object'
            ? this.callbacks.theme
            : getTheme('monochrome');
        this.timezone = this.callbacks.timezone === 'UTC' ? 'UTC' : 'Europe/Istanbul';

        this.chart = null;
        this.series = null;
        this.resizeObserver = null;

        // Indicators
        this.ema9Series = null;
        this.ema21Series = null;
        this.rsiChart = null;
        this.rsiSeries = null;
        this.ema9Map = new Map();
        this.ema21Map = new Map();
        this.rsiMap = new Map();

        // Candles & history pagination
        this.activeCandles = [];
        this.hasMoreHistory = true;
        this.isLoadingMore = false;
        this.isLoadingInitial = false;
        this.pricePrecision = 2;
        this.hoveredTime = null;
        this._loadRequestId = 0;

        // 45m aggregation state
        this.sub45mMap = new Map();
        this.sub45mSeeded45m = null;
        this.initial45mBase = null;

        // Stream & lifecycle
        this.sseSource = null;
        this.lastPrice = null;
        this.lastCandleTime = null;
        this.currentSubscription = null;
        this.isMaximized = false;
        this._destroyed = false;

        // Sync / range feedback loop guards
        this._isApplyingCrosshairSync = false;
        this._isApplyingTimeSync = false;
        this._isAdjustingRange = false;
        this._isSyncingRsi = false;

        // Flow V2.5 state
        this.flowData = null;
        this.flowComputeTimeout = null;
        this.autocompleteTimeout = null;
        this.countdownTimer = null;

        // DOM references
        this.paneEl = null;
        this.tickerValEl = null;
        this.statusDotEl = null;
        this.sourceBadge = null;
        this.metaText = null;
        this.quickAlertBtn = null;
        this.maximizeBtn = null;
        this.sourceSelect = null;
        this.symbolInput = null;
        this.submitBtn = null;
        this.symbolDatalist = null;
        this.timeframeSelect = null;
        this.indicatorPanel = null;
        this.indicatorBtn = null;
        this.toolPanel = null;
        this.toolBtn = null;
        this.magnetBtn = null;
        this.contentWrapper = null;
        this.chartWrapper = null;
        this.chartContainer = null;
        this.rsiContainer = null;
        this.loaderEl = null;
        this.legendEl = null;
        this.scaleBarEl = null;
        this.scaleLogBtn = null;
        this.scalePctBtn = null;
        this.scaleAutoBtn = null;
        this.countdownEl = null;

        this.drawingEngine = null;

        this.createDOM();
        this.initChart();
        this.drawingEngine = new DrawingEngine(this);
        this.setTimezone(this.timezone);
        this._applyScaleOptions();
        this._startCountdownTimer();

        syncManager.registerPane(this);
        this.loadData();
    }

    createDOM() {
        const existing = document.getElementById(`pane-${this.id}`);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }

        this.paneEl = document.createElement('div');
        this.paneEl.className = 'chart-pane';
        this.paneEl.id = `pane-${this.id}`;
        if (this.callbacks.isFocused?.()) {
            this.paneEl.classList.add('active-pane');
        }
        this.paneEl.addEventListener('mousedown', () => this.onFocus(), true);

        // 1. Header Bar
        const header = document.createElement('div');
        header.className = 'pane-header';

        const meta = document.createElement('div');
        meta.className = 'pane-meta';

        this.sourceBadge = document.createElement('span');
        this.sourceBadge.className = 'pane-source-badge';
        this.sourceBadge.textContent = this.state.source;

        this.metaText = document.createElement('span');
        this.metaText.className = 'pane-symbol-timeframe';
        this.metaText.textContent = `${this.state.symbol} [${this.state.timeframe}]`;

        meta.appendChild(this.sourceBadge);
        meta.appendChild(this.metaText);

        this.tickerValEl = document.createElement('div');
        this.tickerValEl.className = 'pane-ticker';
        this.tickerValEl.textContent = '—';

        const rightGroup = document.createElement('div');
        rightGroup.className = 'pane-header-actions';
        rightGroup.style.display = 'flex';
        rightGroup.style.alignItems = 'center';
        rightGroup.style.gap = '6px';

        const status = document.createElement('div');
        status.className = 'pane-status';
        this.statusDotEl = document.createElement('div');
        this.statusDotEl.className = 'status-dot';
        status.appendChild(this.statusDotEl);

        this.quickAlertBtn = document.createElement('button');
        this.quickAlertBtn.type = 'button';
        this.quickAlertBtn.className = 'pane-btn-icon pane-header-btn pane-btn-alert';
        this.quickAlertBtn.textContent = '🔔+';
        this.quickAlertBtn.title = 'Hızlı Alarm Ekle';
        this.quickAlertBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.onFocus();
            this.callbacks.onOpenQuickAlert?.(this.state.source, this.state.symbol, this.lastPrice);
        });

        this.maximizeBtn = document.createElement('button');
        this.maximizeBtn.type = 'button';
        this.maximizeBtn.className = 'pane-btn-icon pane-header-btn pane-btn-maximize';
        this.maximizeBtn.textContent = '⤢';
        this.maximizeBtn.title = 'Büyüt / Küçült (Alt+Enter)';
        this.maximizeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.onFocus();
            this.callbacks.onMaximizeToggle?.(this);
        });

        rightGroup.appendChild(status);
        rightGroup.appendChild(this.quickAlertBtn);
        rightGroup.appendChild(this.maximizeBtn);

        header.appendChild(meta);
        header.appendChild(this.tickerValEl);
        header.appendChild(rightGroup);

        // 2. Controls Bar
        const controls = document.createElement('div');
        controls.className = 'pane-controls';

        this.sourceSelect = document.createElement('select');
        this.sourceSelect.className = 'pane-select';
        this.sourceSelect.id = `select-source-${this.id}`;
        this.sourceSelect.innerHTML = `
            <option value="hyperliquid">Hyperliquid</option>
            <option value="yfinance">Yahoo Finance</option>
        `;
        this.sourceSelect.value = this.state.source;
        if (!this.sourceSelect.value) {
            this.sourceSelect.value = 'hyperliquid';
            this.state.source = 'hyperliquid';
        }
        this.sourceSelect.addEventListener('change', () => this.handleSourceChange());

        this.symbolInput = document.createElement('input');
        this.symbolInput.type = 'text';
        this.symbolInput.className = 'pane-select';
        this.symbolInput.id = `input-symbol-${this.id}`;
        this.symbolInput.setAttribute('list', `datalist-symbol-${this.id}`);
        this.symbolInput.value = this.state.symbol;
        this.symbolInput.placeholder = 'Symbol (e.g. BTC)';
        this.symbolInput.addEventListener('change', () => this.handleSymbolChange(false));
        this.symbolInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.handleSymbolChange(true);
                this.symbolInput.blur();
            }
        });

        this.submitBtn = document.createElement('button');
        this.submitBtn.type = 'button';
        this.submitBtn.className = 'pane-btn-submit';
        this.submitBtn.textContent = '⚡';
        this.submitBtn.title = 'Load / Refresh Symbol';
        this.submitBtn.addEventListener('click', () => this.handleSymbolChange(true));

        this.symbolDatalist = document.createElement('datalist');
        this.symbolDatalist.id = `datalist-symbol-${this.id}`;

        this.symbolInput.addEventListener('input', () => {
            const val = this.symbolInput.value.trim().toUpperCase();
            const options = Array.from(this.symbolDatalist.options).map((opt) => opt.value.toUpperCase());
            if (val && options.includes(val) && val !== this.state.symbol) {
                this.handleSymbolChange(false);
            }

            clearTimeout(this.autocompleteTimeout);
            this.autocompleteTimeout = setTimeout(() => {
                this.populateSymbols(this.symbolInput.value);
            }, 300);
        });

        this.populateSymbols(this.state.symbol);

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
            this.state.timeframe = this.timeframeSelect.value;
        }
        this.timeframeSelect.addEventListener('change', () => this.handleTimeframeChange());

        this.indicatorBtn = document.createElement('button');
        this.indicatorBtn.type = 'button';
        this.indicatorBtn.className = 'pane-btn-submit';
        this.indicatorBtn.textContent = 'IND';
        this.indicatorBtn.title = 'Indicators';
        this.indicatorBtn.addEventListener('click', () => this.toggleIndicatorPanel());

        this.toolBtn = document.createElement('button');
        this.toolBtn.type = 'button';
        this.toolBtn.className = 'pane-btn-submit';
        this.toolBtn.textContent = 'TOOL';
        this.toolBtn.title = 'Drawing Tools';
        this.toolBtn.addEventListener('click', () => this.toggleToolPanel());

        controls.appendChild(this.sourceSelect);
        controls.appendChild(this.symbolInput);
        controls.appendChild(this.submitBtn);
        controls.appendChild(this.symbolDatalist);
        controls.appendChild(this.timeframeSelect);
        controls.appendChild(this.indicatorBtn);
        controls.appendChild(this.toolBtn);

        // 3. Content Wrapper (Drawers + Charts)
        this.contentWrapper = document.createElement('div');
        this.contentWrapper.className = 'pane-content-wrapper';

        // 3a. IND Drawer (strictly ONLY 4 indicators)
        this.indicatorPanel = document.createElement('div');
        this.indicatorPanel.className = 'pane-indicator-panel';
        this.indicatorPanel.innerHTML = `
            <div class="indicator-title">Indicators</div>
            <label class="indicator-item"><input type="checkbox" id="chk-ema9-${this.id}" ${this.state.indicators.ema9 ? 'checked' : ''}> EMA 9</label>
            <label class="indicator-item"><input type="checkbox" id="chk-ema21-${this.id}" ${this.state.indicators.ema21 ? 'checked' : ''}> EMA 21</label>
            <label class="indicator-item"><input type="checkbox" id="chk-rsi-${this.id}" ${this.state.indicators.rsi ? 'checked' : ''}> RSI 14</label>
            <label class="indicator-item"><input type="checkbox" id="chk-flow-${this.id}" ${this.state.indicators.flow ? 'checked' : ''}> Flow V2.5</label>
        `;

        const bindIndicatorToggle = (selector, key, onDisable = null) => {
            const chk = this.indicatorPanel.querySelector(selector);
            if (!chk) return;
            chk.addEventListener('change', (e) => {
                this.state.indicators[key] = e.target.checked;
                if (!e.target.checked && typeof onDisable === 'function') {
                    onDisable();
                }
                this.callbacks.onStateChange?.();
                this.updateIndicators(false);
                this._updateLegend(null);
            });
        };

        bindIndicatorToggle(`#chk-ema9-${this.id}`, 'ema9');
        bindIndicatorToggle(`#chk-ema21-${this.id}`, 'ema21');
        bindIndicatorToggle(`#chk-rsi-${this.id}`, 'rsi');
        bindIndicatorToggle(`#chk-flow-${this.id}`, 'flow', () => {
            this.flowData = null;
        });

        // 3b. TOOL Drawer
        this.toolPanel = document.createElement('div');
        this.toolPanel.className = 'pane-tool-panel';
        this.toolPanel.style.overflowY = 'auto';

        const toolTitle = document.createElement('div');
        toolTitle.className = 'indicator-title';
        toolTitle.textContent = 'Drawings';
        this.toolPanel.appendChild(toolTitle);

        for (const def of TOOL_DEFINITIONS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `tool-btn${def.id === 'select' ? ' active' : ''}`;
            btn.setAttribute('data-tool', def.id);
            btn.id = `btn-tool-${def.id}-${this.id}`;
            btn.title = def.title;
            btn.textContent = def.label;
            btn.addEventListener('click', () => {
                this.drawingEngine?.setActiveTool(def.id);
            });
            this.toolPanel.appendChild(btn);
        }

        const divider = document.createElement('div');
        divider.className = 'tool-drawer-divider';
        divider.style.borderTop = '1px solid var(--border-color)';
        divider.style.margin = '4px 0';
        this.toolPanel.appendChild(divider);

        this.magnetBtn = document.createElement('button');
        this.magnetBtn.type = 'button';
        this.magnetBtn.className = 'tool-btn tool-action-btn';
        this.magnetBtn.id = `btn-tool-magnet-${this.id}`;
        this.magnetBtn.title = 'OHLC Mıknatıs Modu (M)';
        this.magnetBtn.textContent = '🧲 Mıknatıs';
        this.magnetBtn.addEventListener('click', () => {
            this.drawingEngine?.toggleMagnet();
        });
        this.toolPanel.appendChild(this.magnetBtn);

        const undoBtn = document.createElement('button');
        undoBtn.type = 'button';
        undoBtn.className = 'tool-btn tool-action-btn';
        undoBtn.id = `btn-tool-undo-${this.id}`;
        undoBtn.title = 'Geri Al (Ctrl+Z)';
        undoBtn.textContent = '↶ Geri';
        undoBtn.addEventListener('click', () => {
            this.drawingEngine?.undo();
        });
        this.toolPanel.appendChild(undoBtn);

        const redoBtn = document.createElement('button');
        redoBtn.type = 'button';
        redoBtn.className = 'tool-btn tool-action-btn';
        redoBtn.id = `btn-tool-redo-${this.id}`;
        redoBtn.title = 'İleri Al (Ctrl+Y)';
        redoBtn.textContent = '↷ İleri';
        redoBtn.addEventListener('click', () => {
            this.drawingEngine?.redo();
        });
        this.toolPanel.appendChild(redoBtn);

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'tool-btn action-btn-clear';
        clearBtn.id = `btn-tool-clear-${this.id}`;
        clearBtn.title = 'Tüm Çizimleri Temizle';
        clearBtn.textContent = 'Temizle';
        clearBtn.addEventListener('click', () => {
            if (confirm('Tüm çizimleri silmek istediğinize emin misiniz?')) {
                this.drawingEngine?.clearAll();
            }
        });
        this.toolPanel.appendChild(clearBtn);

        // 3c. Chart Wrapper & Overlays
        this.chartWrapper = document.createElement('div');
        this.chartWrapper.className = 'chart-wrapper';

        this.chartContainer = document.createElement('div');
        this.chartContainer.className = 'pane-chart-container';

        this.rsiContainer = document.createElement('div');
        this.rsiContainer.className = 'pane-rsi-container';

        this.loaderEl = document.createElement('div');
        this.loaderEl.className = 'pane-loader';
        this.loaderEl.textContent = 'Syncing...';
        this.chartContainer.appendChild(this.loaderEl);

        // Top-left OHLCV + Indicator legend
        this.legendEl = document.createElement('div');
        this.legendEl.className = 'pane-legend';
        this.chartContainer.appendChild(this.legendEl);

        // Bottom-left Scale Bar (Log, %, Auto + live candle countdown)
        this.scaleBarEl = document.createElement('div');
        this.scaleBarEl.className = 'pane-scale-bar';
        ['mousedown', 'mouseup', 'click', 'dblclick'].forEach((evt) => {
            this.scaleBarEl.addEventListener(evt, (e) => e.stopPropagation());
        });

        this.scaleLogBtn = document.createElement('button');
        this.scaleLogBtn.type = 'button';
        this.scaleLogBtn.className = 'scale-btn';
        this.scaleLogBtn.dataset.scale = 'log';
        this.scaleLogBtn.textContent = 'Log';
        this.scaleLogBtn.title = 'Logaritmik Ölçek';
        this.scaleLogBtn.addEventListener('click', () => this._toggleScaleMode('log'));

        this.scalePctBtn = document.createElement('button');
        this.scalePctBtn.type = 'button';
        this.scalePctBtn.className = 'scale-btn';
        this.scalePctBtn.dataset.scale = 'percentage';
        this.scalePctBtn.textContent = '%';
        this.scalePctBtn.title = 'Yüzde Ölçek';
        this.scalePctBtn.addEventListener('click', () => this._toggleScaleMode('percentage'));

        this.scaleAutoBtn = document.createElement('button');
        this.scaleAutoBtn.type = 'button';
        this.scaleAutoBtn.className = 'scale-btn';
        this.scaleAutoBtn.dataset.scale = 'auto';
        this.scaleAutoBtn.textContent = 'Auto';
        this.scaleAutoBtn.title = 'Otomatik Ölçek';
        this.scaleAutoBtn.addEventListener('click', () => this._toggleAutoScale());

        this.countdownEl = document.createElement('span');
        this.countdownEl.className = 'pane-countdown';
        this.countdownEl.textContent = '--:--';

        this.scaleBarEl.appendChild(this.scaleLogBtn);
        this.scaleBarEl.appendChild(this.scalePctBtn);
        this.scaleBarEl.appendChild(this.scaleAutoBtn);
        this.scaleBarEl.appendChild(this.countdownEl);
        this.chartContainer.appendChild(this.scaleBarEl);

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
            const symbols = await fetchSymbols(source, query);
            if (this._destroyed || !Array.isArray(symbols)) return;
            this.symbolDatalist.innerHTML = '';
            const frag = document.createDocumentFragment();
            for (const item of symbols) {
                if (!item || !item.symbol) continue;
                const opt = document.createElement('option');
                opt.value = item.symbol;
                opt.textContent = item.name || item.symbol;
                frag.appendChild(opt);
            }
            this.symbolDatalist.appendChild(frag);
        } catch (err) {
            console.error('Error populating symbols autocomplete:', err);
        }
    }

    initChart() {
        const t = this.theme;
        this.chart = LightweightCharts.createChart(this.chartContainer, {
            layout: {
                background: { type: LightweightCharts.ColorType.Solid, color: t.chartBackground },
                textColor: t.textColor,
                fontSize: 10,
                fontFamily: "'JetBrains Mono', monospace",
            },
            grid: {
                vertLines: { color: t.gridColor },
                horzLines: { color: t.gridColor },
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
                vertLine: {
                    color: t.crosshairColor,
                    width: 1,
                    style: LightweightCharts.LineStyle.Dash,
                },
                horzLine: {
                    color: t.crosshairColor,
                    width: 1,
                    style: LightweightCharts.LineStyle.Dash,
                },
            },
            rightPriceScale: {
                borderColor: t.borderColor,
            },
            timeScale: {
                borderColor: t.borderColor,
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
            },
        });

        this.series = this.chart.addCandlestickSeries({
            ...t.candle,
        });

        this.resizeObserver = new ResizeObserver(() => {
            this._resizeCharts();
            this.drawingEngine?.redraw();
        });
        this.resizeObserver.observe(this.chartWrapper);

        this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
            this.drawingEngine?.redraw();

            if (this._isApplyingTimeSync || this._isAdjustingRange) {
                return;
            }

            if (
                range
                && range.from < 15
                && !this.isLoadingMore
                && this.hasMoreHistory
                && this.activeCandles.length > 0
                && !this.isLoadingInitial
            ) {
                this.loadMoreHistory();
            }

            if (this.activeCandles.length > 0 && !this.isLoadingInitial) {
                try {
                    const visibleRange = this.chart.timeScale().getVisibleRange();
                    if (visibleRange && visibleRange.from != null && visibleRange.to != null) {
                        syncManager.broadcastTimeRange(this, visibleRange);
                    }
                } catch (_) {
                    // Ignore when chart range is not ready
                }
            }
        });

        this.chart.subscribeCrosshairMove((param) => {
            if (!param || !param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
                this.hoveredTime = null;
                this._updateLegend(null);
                if (!this._isApplyingCrosshairSync) {
                    syncManager.clearCrosshair(this);
                }
                return;
            }

            const candle = this._findCandleByTime(param.time);
            this.hoveredTime = candle ? candle.time : param.time;
            this._updateLegend(candle);

            if (!this._isApplyingCrosshairSync) {
                syncManager.broadcastCrosshair(this, param.time);
            }
        });
    }

    initRsiChart() {
        const t = this.theme;
        this.rsiChart = LightweightCharts.createChart(this.rsiContainer, {
            layout: {
                background: { type: LightweightCharts.ColorType.Solid, color: t.chartBackground },
                textColor: t.textColor,
                fontSize: 9,
                fontFamily: "'JetBrains Mono', monospace",
            },
            grid: {
                vertLines: { color: t.gridColor },
                horzLines: { color: t.gridColor },
            },
            rightPriceScale: {
                borderColor: t.borderColor,
            },
            timeScale: {
                visible: false,
            },
            handleScale: false,
            handleScroll: false,
        });

        this.rsiSeries = this.rsiChart.addLineSeries({
            color: '#c084fc',
            lineWidth: 1.5,
            priceLineVisible: false,
            lastValueVisible: true,
        });

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

        const rsiTimeScale = this.rsiChart.timeScale();
        const priceTimeScale = this.chart.timeScale();

        priceTimeScale.subscribeVisibleLogicalRangeChange((range) => {
            if (this._isSyncingRsi || !this.rsiChart) return;
            if (range) {
                this._isSyncingRsi = true;
                try {
                    rsiTimeScale.setVisibleLogicalRange(range);
                } catch (_) {
                    // Ignore transient scale sync errors
                } finally {
                    this._isSyncingRsi = false;
                }
            }
        });

        rsiTimeScale.subscribeVisibleLogicalRangeChange((range) => {
            if (this._isSyncingRsi || !this.rsiChart) return;
            if (range) {
                this._isSyncingRsi = true;
                try {
                    priceTimeScale.setVisibleLogicalRange(range);
                } catch (_) {
                    // Ignore transient scale sync errors
                } finally {
                    this._isSyncingRsi = false;
                }
            }
        });
    }

    _resizeCharts() {
        if (!this.chartWrapper || !this.chart) return;
        const width = this.chartWrapper.clientWidth || this.chartWrapper.offsetWidth;
        const height = this.chartWrapper.clientHeight || this.chartWrapper.offsetHeight;
        if (width <= 0 || height <= 0) return;

        const hasRsi = Boolean(this.state.indicators?.rsi);
        if (hasRsi) {
            const priceHeight = Math.floor(height * 0.7);
            const rsiHeight = Math.max(0, height - priceHeight);
            this.chart.resize(width, priceHeight);
            if (this.rsiChart && rsiHeight > 0) {
                this.rsiChart.resize(width, rsiHeight);
            }
        } else {
            this.chart.resize(width, height);
        }
    }

    setTimezone(tz) {
        this.timezone = tz === 'UTC' ? 'UTC' : 'Europe/Istanbul';
        if (!this.chart) return;

        const optsBase = { timeZone: this.timezone };
        const fullFmt = new Intl.DateTimeFormat('tr-TR', {
            ...optsBase,
            day: '2-digit',
            month: '2-digit',
            year: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            hourCycle: 'h23',
        });
        const yearFmt = new Intl.DateTimeFormat('tr-TR', { ...optsBase, year: 'numeric' });
        const monthFmt = new Intl.DateTimeFormat('tr-TR', { ...optsBase, month: 'short', year: '2-digit' });
        const dayFmt = new Intl.DateTimeFormat('tr-TR', { ...optsBase, day: '2-digit', month: 'short' });
        const timeFmt = new Intl.DateTimeFormat('tr-TR', {
            ...optsBase,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            hourCycle: 'h23',
        });
        const timeSecFmt = new Intl.DateTimeFormat('tr-TR', {
            ...optsBase,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            hourCycle: 'h23',
        });

        const TMT = LightweightCharts.TickMarkType || {
            Year: 0,
            Month: 1,
            DayOfMonth: 2,
            Time: 3,
            TimeWithSeconds: 4,
        };

        this.chart.applyOptions({
            localization: {
                timeFormatter: (time) => {
                    const d = toDateFromLwcTime(time);
                    return d ? fullFmt.format(d) : '';
                },
            },
            timeScale: {
                tickMarkFormatter: (time, tickMarkType) => {
                    const d = toDateFromLwcTime(time);
                    if (!d) return '';
                    switch (tickMarkType) {
                        case TMT.Year:
                        case 0:
                            return yearFmt.format(d);
                        case TMT.Month:
                        case 1:
                            return monthFmt.format(d);
                        case TMT.DayOfMonth:
                        case 2:
                            return dayFmt.format(d);
                        case TMT.TimeWithSeconds:
                        case 4:
                            return timeSecFmt.format(d);
                        case TMT.Time:
                        case 3:
                        default:
                            return timeFmt.format(d);
                    }
                },
            },
        });
    }

    applyTheme(themeObj) {
        this.theme = themeObj && typeof themeObj === 'object' ? themeObj : getTheme('monochrome');
        const t = this.theme;

        if (this.chart) {
            this.chart.applyOptions({
                layout: {
                    background: { type: LightweightCharts.ColorType.Solid, color: t.chartBackground },
                    textColor: t.textColor,
                },
                grid: {
                    vertLines: { color: t.gridColor },
                    horzLines: { color: t.gridColor },
                },
                crosshair: {
                    vertLine: { color: t.crosshairColor },
                    horzLine: { color: t.crosshairColor },
                },
                rightPriceScale: {
                    borderColor: t.borderColor,
                },
                timeScale: {
                    borderColor: t.borderColor,
                },
            });
        }

        if (this.series) {
            this.series.applyOptions({ ...t.candle });
        }

        if (this.rsiChart) {
            this.rsiChart.applyOptions({
                layout: {
                    background: { type: LightweightCharts.ColorType.Solid, color: t.chartBackground },
                    textColor: t.textColor,
                },
                grid: {
                    vertLines: { color: t.gridColor },
                    horzLines: { color: t.gridColor },
                },
                rightPriceScale: {
                    borderColor: t.borderColor,
                },
            });
        }

        this.drawingEngine?.setTheme(t);
    }

    _toggleScaleMode(modeKey) {
        this.state.scaleMode = this.state.scaleMode === modeKey ? 'normal' : modeKey;
        this._applyScaleOptions();
        this.callbacks.onStateChange?.();
    }

    _toggleAutoScale() {
        this.state.autoScale = !this.state.autoScale;
        this._applyScaleOptions();
        this.callbacks.onStateChange?.();
    }

    _applyScaleOptions() {
        const modeEnum = LightweightCharts.PriceScaleMode || {
            Normal: 0,
            Logarithmic: 1,
            Percentage: 2,
        };
        let mode = modeEnum.Normal;
        if (this.state.scaleMode === 'log') mode = modeEnum.Logarithmic;
        else if (this.state.scaleMode === 'percentage') mode = modeEnum.Percentage;

        if (this.chart) {
            this.chart.priceScale('right').applyOptions({
                mode,
                autoScale: this.state.autoScale,
            });
        }

        this.scaleLogBtn?.classList.toggle('active', this.state.scaleMode === 'log');
        this.scalePctBtn?.classList.toggle('active', this.state.scaleMode === 'percentage');
        this.scaleAutoBtn?.classList.toggle('active', this.state.autoScale);
    }

    _startCountdownTimer() {
        clearInterval(this.countdownTimer);
        this.countdownTimer = setInterval(() => this._updateCountdown(), 1000);
        this._updateCountdown();
    }

    _updateCountdown() {
        if (!this.countdownEl) return;
        const tfSec = TIMEFRAME_SECONDS[this.state.timeframe] || 60;
        if (!this.activeCandles || this.activeCandles.length === 0) {
            this.countdownEl.textContent = '--:--';
            return;
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const lastCandleStart = this.activeCandles[this.activeCandles.length - 1].time;
        let nextClose = lastCandleStart + tfSec;

        if (this.state.source === 'yfinance') {
            if (nowSec - lastCandleStart > tfSec * 1.5) {
                this.countdownEl.textContent = '--:--';
                return;
            }
            if (nextClose <= nowSec) {
                this.countdownEl.textContent = '00:00';
                return;
            }
        } else {
            while (nextClose <= nowSec) {
                nextClose += tfSec;
            }
        }

        this.countdownEl.textContent = formatCountdown(nextClose - nowSec);
    }

    _findCandleByTime(time) {
        if (!this.activeCandles || this.activeCandles.length === 0 || time == null) return null;
        const idx = this._binarySearchNearestIndex(time);
        if (idx < 0) return null;
        return this.activeCandles[idx].time === time ? this.activeCandles[idx] : null;
    }

    _findNearestCandle(time) {
        if (!this.activeCandles || this.activeCandles.length === 0 || time == null) return null;
        const idx = this._binarySearchNearestIndex(time);
        return idx >= 0 ? this.activeCandles[idx] : null;
    }

    _binarySearchNearestIndex(time) {
        const candles = this.activeCandles;
        const n = candles.length;
        if (n === 0 || typeof time !== 'number') return -1;
        if (time <= candles[0].time) return 0;
        if (time >= candles[n - 1].time) return n - 1;

        let lo = 0;
        let hi = n - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const midTime = candles[mid].time;
            if (midTime === time) return mid;
            if (midTime < time) lo = mid + 1;
            else hi = mid - 1;
        }

        const diffLo = Math.abs(candles[lo].time - time);
        const diffHi = Math.abs(time - candles[hi].time);
        return diffLo < diffHi ? lo : hi;
    }

    _updateLegend(candle = null) {
        if (!this.legendEl) return;
        const target = candle || (this.activeCandles.length > 0 ? this.activeCandles[this.activeCandles.length - 1] : null);
        if (!target) {
            this.legendEl.innerHTML = '';
            return;
        }

        const p = this.pricePrecision;
        const pct = target.open !== 0 ? ((target.close - target.open) / target.open) * 100 : 0;
        const sign = pct >= 0 ? '+' : '';
        const pctClass = pct >= 0 ? 'legend-up' : 'legend-down';

        const ohlcRow = `<div class="legend-row">`
            + `<span class="legend-item"><span class="legend-label">O</span> ${target.open.toFixed(p)}</span>`
            + `<span class="legend-item"><span class="legend-label">H</span> ${target.high.toFixed(p)}</span>`
            + `<span class="legend-item"><span class="legend-label">L</span> ${target.low.toFixed(p)}</span>`
            + `<span class="legend-item"><span class="legend-label">C</span> ${target.close.toFixed(p)} <span class="${pctClass}">(${sign}${pct.toFixed(2)}%)</span></span>`
            + `<span class="legend-item"><span class="legend-label">V</span> ${formatCompactVolume(target.volume)}</span>`
            + `</div>`;

        const indItems = [];
        if (this.state.indicators?.ema9 && this.ema9Map.has(target.time)) {
            indItems.push(`<span class="legend-item" style="color:#3b82f6">EMA9 ${this.ema9Map.get(target.time).toFixed(p)}</span>`);
        }
        if (this.state.indicators?.ema21 && this.ema21Map.has(target.time)) {
            indItems.push(`<span class="legend-item" style="color:#ef4444">EMA21 ${this.ema21Map.get(target.time).toFixed(p)}</span>`);
        }
        if (this.state.indicators?.rsi && this.rsiMap.has(target.time)) {
            indItems.push(`<span class="legend-item" style="color:#c084fc">RSI14 ${this.rsiMap.get(target.time).toFixed(2)}</span>`);
        }

        const indRow = indItems.length > 0 ? `<div class="legend-row">${indItems.join('')}</div>` : '';
        this.legendEl.innerHTML = ohlcRow + indRow;
    }

    async loadData(fitChart = true) {
        const reqId = ++this._loadRequestId;
        this.isLoadingInitial = true;
        this.isLoadingMore = false;
        this.hasMoreHistory = true;
        this.hoveredTime = null;

        this.loaderEl.classList.add('active');
        this.statusDotEl.className = 'status-dot connecting';

        this.unsubscribeLive();

        if (this.series) {
            this.series.setData([]);
        }
        this.activeCandles = [];
        this.flowData = null;
        this.sub45mMap.clear();
        this.sub45mSeeded45m = null;
        this.initial45mBase = null;
        clearTimeout(this.flowComputeTimeout);

        this.drawingEngine?.setDrawings([]);

        const source = this.state.source;
        const symbol = this.state.symbol;
        const timeframe = this.state.timeframe;
        const symbolKey = `${source}:${symbol}`;

        this.sourceBadge.textContent = source;
        this.metaText.textContent = `${symbol} [${timeframe}]`;

        try {
            const sub15mPromise = (timeframe === '45m' && source === 'hyperliquid')
                ? fetchHistory(source, symbol, '15m', null, 6).catch(() => null)
                : Promise.resolve(null);

            const [data, drawings, sub15mData] = await Promise.all([
                fetchHistory(source, symbol, timeframe),
                fetchDrawings(symbolKey).catch((err) => {
                    console.error(`Error loading drawings for ${symbolKey}:`, err);
                    return [];
                }),
                sub15mPromise,
            ]);

            if (this._destroyed || reqId !== this._loadRequestId) {
                return;
            }
            if (data?.error) {
                throw new Error(data.error);
            }

            const rawHistory = Array.isArray(data?.history) ? data.history : [];
            const seenTimes = new Set();
            const cleanHistory = [];
            for (const c of rawHistory) {
                if (c && typeof c.time === 'number' && !seenTimes.has(c.time)) {
                    seenTimes.add(c.time);
                    cleanHistory.push(c);
                }
            }
            cleanHistory.sort((a, b) => a.time - b.time);

            this.activeCandles = cleanHistory;
            this.hasMoreHistory = data?.has_more !== false;

            const priceFormat = computePriceFormat(this.activeCandles);
            this.pricePrecision = priceFormat.precision;
            this.series.applyOptions({ priceFormat });
            this.series.setData(this.activeCandles);

            if (this.activeCandles.length > 0) {
                const lastCandle = this.activeCandles[this.activeCandles.length - 1];
                this.lastPrice = lastCandle.close;
                this.lastCandleTime = lastCandle.time;
                this.updateTickerDisplay(this.lastPrice);

                if (timeframe === '45m') {
                    this.initial45mBase = { ...lastCandle };
                    const subCandles = Array.isArray(sub15mData?.history) ? sub15mData.history : [];
                    for (const sc of subCandles) {
                        if (sc && typeof sc.time === 'number' && Math.floor(sc.time / 2700) * 2700 === lastCandle.time) {
                            this.sub45mMap.set(sc.time, { ...sc });
                            this.sub45mSeeded45m = lastCandle.time;
                        }
                    }
                }
            } else {
                this.lastPrice = null;
                this.lastCandleTime = null;
                this.updateTickerDisplay(null);
            }

            if (fitChart) {
                this.chart.timeScale().fitContent();
            }

            this.updateIndicators(false);
            this.drawingEngine?.setDrawings(Array.isArray(drawings) ? drawings : []);
            this._updateLegend(null);
            this._updateCountdown();

            this.subscribeLive(data?.streaming_config);

            this.tickerValEl.title = '';
            this.statusDotEl.title = '';
        } catch (err) {
            if (this._destroyed || reqId !== this._loadRequestId) return;
            console.error(`Error loading data for pane ${this.id}:`, err);
            this.tickerValEl.textContent = 'ERR';
            this.tickerValEl.title = err.message;
            this.statusDotEl.className = 'status-dot disconnected';
            this.statusDotEl.title = err.message;
        } finally {
            if (reqId === this._loadRequestId) {
                this.isLoadingInitial = false;
                this.loaderEl?.classList.remove('active');
            }
        }
    }

    async loadMoreHistory() {
        if (
            this._destroyed
            || this.isLoadingMore
            || !this.hasMoreHistory
            || this.isLoadingInitial
            || !this.activeCandles
            || this.activeCandles.length === 0
        ) {
            return;
        }

        const reqId = this._loadRequestId;
        const source = this.state.source;
        const symbol = this.state.symbol;
        const timeframe = this.state.timeframe;
        const earliest = this.activeCandles[0].time;

        this.isLoadingMore = true;

        try {
            const res = await fetchHistory(source, symbol, timeframe, earliest);
            if (this._destroyed || reqId !== this._loadRequestId) {
                return;
            }

            const rawOlder = Array.isArray(res?.history) ? res.history : [];
            if (rawOlder.length === 0) {
                this.hasMoreHistory = false;
                return;
            }

            const existingTimes = new Set(this.activeCandles.map((c) => c.time));
            const olderCandles = [];
            for (const c of rawOlder) {
                if (c && typeof c.time === 'number' && c.time < earliest && !existingTimes.has(c.time)) {
                    existingTimes.add(c.time);
                    olderCandles.push(c);
                }
            }
            olderCandles.sort((a, b) => a.time - b.time);

            if (olderCandles.length === 0) {
                this.hasMoreHistory = false;
                return;
            }

            if (res?.has_more === false) {
                this.hasMoreHistory = false;
            }

            const prevRange = this.chart.timeScale().getVisibleLogicalRange();
            const addedCount = olderCandles.length;
            this.activeCandles = [...olderCandles, ...this.activeCandles];

            this._isAdjustingRange = true;
            try {
                this.series.setData(this.activeCandles);
                this.updateIndicators(false);

                if (prevRange) {
                    const adjusted = {
                        from: prevRange.from + addedCount,
                        to: prevRange.to + addedCount,
                    };
                    this.chart.timeScale().setVisibleLogicalRange(adjusted);
                    if (this.rsiChart) {
                        this._isSyncingRsi = true;
                        try {
                            this.rsiChart.timeScale().setVisibleLogicalRange(adjusted);
                        } finally {
                            this._isSyncingRsi = false;
                        }
                    }
                }
            } finally {
                this._isAdjustingRange = false;
            }

            this.drawingEngine?.onDataUpdated();
            if (!this.hoveredTime) {
                this._updateLegend(null);
            }
        } catch (err) {
            console.error(`Error lazy-loading history for pane ${this.id}:`, err);
        } finally {
            if (reqId === this._loadRequestId) {
                this.isLoadingMore = false;
            }
        }
    }

    updateTickerDisplay(price) {
        if (typeof price === 'number' && Number.isFinite(price)) {
            this.tickerValEl.textContent = price.toFixed(this.pricePrecision);
        } else {
            this.tickerValEl.textContent = '—';
        }
    }

    flashTicker(direction) {
        this.tickerValEl.classList.remove('flash-up', 'flash-down');
        void this.tickerValEl.offsetWidth;
        if (direction === 'up') {
            this.tickerValEl.classList.add('flash-up');
        } else if (direction === 'down') {
            this.tickerValEl.classList.add('flash-down');
        }
    }

    _aggregate45mCandle(tick) {
        const tickTime = tick.time;
        const bucket45 = Math.floor(tickTime / 2700) * 2700;

        this.sub45mMap.set(tickTime, {
            time: tickTime,
            open: tick.open ?? tick.close,
            high: tick.high ?? tick.close,
            low: tick.low ?? tick.close,
            close: tick.close,
            volume: typeof tick.volume === 'number' && Number.isFinite(tick.volume) ? tick.volume : 0,
        });

        for (const t of this.sub45mMap.keys()) {
            if (t < bucket45 - 2700) {
                this.sub45mMap.delete(t);
            }
        }

        const bucketEntries = [];
        for (const [t, entry] of this.sub45mMap.entries()) {
            if (Math.floor(t / 2700) * 2700 === bucket45) {
                bucketEntries.push(entry);
            }
        }
        bucketEntries.sort((a, b) => a.time - b.time);

        const agg = {
            time: bucket45,
            open: bucketEntries[0].open,
            high: bucketEntries[0].high,
            low: bucketEntries[0].low,
            close: bucketEntries[bucketEntries.length - 1].close,
            volume: 0,
        };
        for (const item of bucketEntries) {
            if (item.high > agg.high) agg.high = item.high;
            if (item.low < agg.low) agg.low = item.low;
            agg.volume += item.volume || 0;
        }

        if (
            this.initial45mBase
            && bucket45 === this.initial45mBase.time
            && this.sub45mSeeded45m !== bucket45
        ) {
            return {
                time: bucket45,
                open: this.initial45mBase.open,
                high: Math.max(this.initial45mBase.high, agg.high),
                low: Math.min(this.initial45mBase.low, agg.low),
                close: agg.close,
                volume: Math.max(this.initial45mBase.volume || 0, agg.volume),
            };
        }

        return agg;
    }

    handleLiveTick(tick) {
        if (this._destroyed) return;
        if (!tick || tick.error) {
            console.error('Live tick payload error:', tick);
            this.statusDotEl.className = 'status-dot disconnected';
            return;
        }

        const tickTime = tick.time;
        if (typeof tickTime !== 'number' || !Number.isFinite(tickTime)) return;

        let finalCandle = null;
        if (this.state.timeframe === '45m') {
            finalCandle = this._aggregate45mCandle(tick);
        } else if (this.state.source === 'yfinance' && this.state.timeframe !== '1m' && this.activeCandles.length > 0) {
            const tfSec = TIMEFRAME_SECONDS[this.state.timeframe] || 60;
            const lastActive = this.activeCandles[this.activeCandles.length - 1];
            if (tickTime < lastActive.time) {
                return;
            }
            if (tickTime < lastActive.time + tfSec) {
                finalCandle = {
                    time: lastActive.time,
                    open: lastActive.open,
                    high: Math.max(lastActive.high, tick.high ?? tick.close),
                    low: Math.min(lastActive.low, tick.low ?? tick.close),
                    close: tick.close,
                    volume: Math.max(lastActive.volume || 0, tick.volume || 0),
                };
            } else {
                finalCandle = {
                    time: tickTime,
                    open: tick.open ?? tick.close,
                    high: tick.high ?? tick.close,
                    low: tick.low ?? tick.close,
                    close: tick.close,
                    volume: tick.volume || 0,
                };
            }
        } else {
            if (this.lastCandleTime !== null && tickTime < this.lastCandleTime) {
                return;
            }
            finalCandle = {
                time: tickTime,
                open: tick.open,
                high: tick.high,
                low: tick.low,
                close: tick.close,
                volume: tick.volume || 0,
            };
        }

        const lastActive = this.activeCandles.length > 0
            ? this.activeCandles[this.activeCandles.length - 1]
            : null;
        if (lastActive && finalCandle.time < lastActive.time) {
            return;
        }

        this.series.update(finalCandle);

        if (lastActive) {
            if (finalCandle.time === lastActive.time) {
                this.activeCandles[this.activeCandles.length - 1] = { ...finalCandle };
            } else {
                this.activeCandles.push({ ...finalCandle });
                if (this.activeCandles.length > 2000) {
                    this.activeCandles.shift();
                }
            }
        } else {
            this.activeCandles = [{ ...finalCandle }];
        }

        this.lastCandleTime = finalCandle.time;

        this.updateIndicators(true);

        const currentPrice = Number(tick.price ?? tick.close ?? finalCandle.close);
        if (Number.isFinite(currentPrice)) {
            if (this.lastPrice !== null && currentPrice !== this.lastPrice) {
                this.flashTicker(currentPrice > this.lastPrice ? 'up' : 'down');
            }
            this.lastPrice = currentPrice;
            this.updateTickerDisplay(currentPrice);
            alertManager?.checkTick?.(this.state.source, this.state.symbol, currentPrice);
        }

        if (!this.hoveredTime) {
            this._updateLegend(null);
        }
        this._updateCountdown();
        this.drawingEngine?.redraw();
    }

    subscribeLive(config) {
        if (!config) return;

        let subSymbol = this.state.symbol;
        const subInterval = config.subscription?.subscription?.interval || this.state.timeframe;
        if (config.type === 'websocket' && config.subscription?.subscription?.coin) {
            subSymbol = config.subscription.subscription.coin;
        }

        this.currentSubscription = {
            source: this.state.source,
            symbol: subSymbol,
            interval: subInterval,
        };

        if (config.type === 'websocket') {
            hlWSManager.subscribe(
                subSymbol,
                subInterval,
                this.id,
                (tick) => this.handleLiveTick(tick),
                (status) => {
                    if (this.statusDotEl) {
                        this.statusDotEl.className = `status-dot ${status}`;
                    }
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
                    console.error('SSE parsing error:', err);
                    this.statusDotEl.className = 'status-dot disconnected';
                }
            };

            this.sseSource.onerror = () => {
                this.statusDotEl.className = 'status-dot disconnected';
            };
        }
    }

    unsubscribeLive() {
        if (this.currentSubscription) {
            const { source, symbol, interval } = this.currentSubscription;
            if (source === 'hyperliquid') {
                hlWSManager.unsubscribe(symbol, interval, this.id);
            } else if (source === 'yfinance' && this.sseSource) {
                this.sseSource.close();
                this.sseSource = null;
            }
            this.currentSubscription = null;
        } else {
            const fallbackInterval = this.state.timeframe === '45m' ? '15m' : this.state.timeframe;
            hlWSManager.unsubscribe(this.state.symbol, fallbackInterval, this.id);
            if (this.sseSource) {
                this.sseSource.close();
                this.sseSource = null;
            }
        }
        if (this.statusDotEl) {
            this.statusDotEl.className = 'status-dot';
        }
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

    updateIndicators(isLiveTick = false) {
        if (!this.activeCandles || this.activeCandles.length === 0) return;

        // 1. EMA 9
        if (this.state.indicators?.ema9) {
            const ema9Data = calculateEMA(this.activeCandles, 9);
            this.ema9Map = new Map(ema9Data.map((d) => [d.time, d.value]));
            if (!this.ema9Series) {
                this.ema9Series = this.chart.addLineSeries({
                    color: '#3b82f6',
                    lineWidth: 1.5,
                    title: 'EMA 9',
                });
            }
            this.ema9Series.setData(ema9Data);
        } else {
            this.ema9Map.clear();
            if (this.ema9Series) {
                try {
                    this.chart.removeSeries(this.ema9Series);
                } catch (_) {}
                this.ema9Series = null;
            }
        }

        // 2. EMA 21
        if (this.state.indicators?.ema21) {
            const ema21Data = calculateEMA(this.activeCandles, 21);
            this.ema21Map = new Map(ema21Data.map((d) => [d.time, d.value]));
            if (!this.ema21Series) {
                this.ema21Series = this.chart.addLineSeries({
                    color: '#ef4444',
                    lineWidth: 1.5,
                    title: 'EMA 21',
                });
            }
            this.ema21Series.setData(ema21Data);
        } else {
            this.ema21Map.clear();
            if (this.ema21Series) {
                try {
                    this.chart.removeSeries(this.ema21Series);
                } catch (_) {}
                this.ema21Series = null;
            }
        }

        // 3. RSI 14
        if (this.state.indicators?.rsi) {
            const rsiData = calculateRSI(this.activeCandles, 14);
            this.rsiMap = new Map(rsiData.map((d) => [d.time, d.value]));

            this.rsiContainer.style.display = 'block';
            this.chartContainer.style.height = '70%';

            if (!this.rsiChart) {
                this.initRsiChart();
            }

            const rsiSeriesData = this.activeCandles.map((c) => {
                const val = this.rsiMap.get(c.time);
                return val !== undefined ? { time: c.time, value: val } : { time: c.time };
            });
            this.rsiSeries.setData(rsiSeriesData);

            this._resizeCharts();
            try {
                const range = this.chart.timeScale().getVisibleLogicalRange();
                if (range) {
                    this._isSyncingRsi = true;
                    this.rsiChart.timeScale().setVisibleLogicalRange(range);
                }
            } catch (_) {
            } finally {
                this._isSyncingRsi = false;
            }
        } else {
            this.rsiMap.clear();
            if (this.rsiChart) {
                try {
                    this.rsiChart.remove();
                } catch (_) {}
                this.rsiSeries = null;
                this.rsiChart = null;
                this.rsiContainer.innerHTML = '';
            }
            this.rsiContainer.style.display = 'none';
            this.chartContainer.style.height = '100%';
            this._resizeCharts();
        }

        // 4. Flow V2.5 (Client-side calculation)
        if (this.state.indicators?.flow) {
            clearTimeout(this.flowComputeTimeout);
            if (!isLiveTick) {
                this.flowData = computeFlowJS(this.activeCandles, {
                    history_box_count: 3,
                    show_fib_levels: true,
                });
                this.drawingEngine?.redraw();
            } else {
                this.flowComputeTimeout = setTimeout(() => {
                    if (this._destroyed || !this.state.indicators?.flow) return;
                    this.flowData = computeFlowJS(this.activeCandles, {
                        history_box_count: 3,
                        show_fib_levels: true,
                    });
                    this.drawingEngine?.redraw();
                }, 50);
            }
        } else {
            clearTimeout(this.flowComputeTimeout);
            if (this.flowData !== null) {
                this.flowData = null;
                this.drawingEngine?.redraw();
            }
        }
    }

    async handleSourceChange() {
        this.state.source = this.sourceSelect.value;
        const defaultSymbol = this.state.source === 'hyperliquid' ? 'BTC' : 'THYAO.IS';
        this.symbolInput.value = defaultSymbol;
        this.state.symbol = defaultSymbol;

        await this.populateSymbols(defaultSymbol);
        this.callbacks.onStateChange?.();
        this.loadData();
        syncManager.broadcastSymbol(this, this.state.source, this.state.symbol);
    }

    handleSymbolChange(forceReload = false) {
        const symbolVal = this.symbolInput.value.trim().toUpperCase();
        if (!symbolVal) return;
        this.symbolInput.value = symbolVal;

        if (!forceReload && symbolVal === this.state.symbol) {
            return;
        }

        this.state.symbol = symbolVal;
        this.callbacks.onStateChange?.();
        this.loadData();
        syncManager.broadcastSymbol(this, this.state.source, this.state.symbol);
    }

    handleTimeframeChange() {
        this.state.timeframe = this.timeframeSelect.value;
        this.callbacks.onStateChange?.();
        this.loadData();
    }

    loadSymbol(source, symbol) {
        const normSource = String(source || 'hyperliquid').trim().toLowerCase();
        const normSymbol = String(symbol || '').trim().toUpperCase();
        if (!normSource || !normSymbol) return;

        this.state.source = normSource;
        this.state.symbol = normSymbol;
        this.sourceSelect.value = normSource;
        this.symbolInput.value = normSymbol;

        this.populateSymbols(normSymbol);
        this.callbacks.onStateChange?.();
        this.loadData();
        syncManager.broadcastSymbol(this, normSource, normSymbol);
    }

    // ==========================================
    // SYNC MANAGER TARGET METHODS
    // ==========================================

    applySyncedCrosshair(time) {
        if (!this.chart || !this.series || !this.activeCandles || this.activeCandles.length === 0) return;
        const candle = this._findNearestCandle(time);
        if (!candle) return;

        this._isApplyingCrosshairSync = true;
        try {
            this.chart.setCrosshairPosition(candle.close, candle.time, this.series);
        } catch (_) {
            // Ignore when coordinate is outside chart bounds
        } finally {
            this._isApplyingCrosshairSync = false;
        }

        this.hoveredTime = candle.time;
        this._updateLegend(candle);
    }

    clearSyncedCrosshair() {
        if (!this.chart) return;
        this._isApplyingCrosshairSync = true;
        try {
            this.chart.clearCrosshairPosition();
        } catch (_) {
            // Ignore errors during teardown
        } finally {
            this._isApplyingCrosshairSync = false;
        }
        this.hoveredTime = null;
        this._updateLegend(null);
    }

    applySyncedTimeRange(visibleRange) {
        if (
            !this.chart
            || !this.activeCandles
            || this.activeCandles.length === 0
            || !visibleRange
            || visibleRange.from == null
            || visibleRange.to == null
            || visibleRange.from >= visibleRange.to
        ) {
            return;
        }

        const firstTime = this.activeCandles[0].time;
        const lastTime = this.activeCandles[this.activeCandles.length - 1].time;
        if (visibleRange.to < firstTime || visibleRange.from > lastTime) {
            return;
        }

        this._isApplyingTimeSync = true;
        try {
            this.chart.timeScale().setVisibleRange(visibleRange);
        } catch (_) {
            // Ignore out-of-range sync requests
        } finally {
            this._isApplyingTimeSync = false;
        }
    }

    applySyncedSymbol(source, symbol) {
        const normSource = String(source || '').trim().toLowerCase();
        const normSymbol = String(symbol || '').trim().toUpperCase();
        if (!normSource || !normSymbol) return;
        if (normSource === this.state.source && normSymbol === this.state.symbol) return;

        this.state.source = normSource;
        this.state.symbol = normSymbol;
        this.sourceSelect.value = normSource;
        this.symbolInput.value = normSymbol;

        this.populateSymbols(normSymbol);
        this.callbacks.onStateChange?.();
        this.loadData(true);
    }

    // ==========================================
    // INTEGRATION HOOKS (DrawingEngine, Main, Alerts)
    // ==========================================

    onFocus() {
        this.callbacks.onFocus?.(this);
    }

    setFocused(bool) {
        this.paneEl?.classList.toggle('active-pane', Boolean(bool));
    }

    setMaximized(bool) {
        this.isMaximized = Boolean(bool);
        this.paneEl?.classList.toggle('maximized', this.isMaximized);
        if (this.maximizeBtn) {
            this.maximizeBtn.textContent = this.isMaximized ? '⤡' : '⤢';
            this.maximizeBtn.title = this.isMaximized ? 'Küçült (Esc)' : 'Büyüt (Alt+Enter)';
        }
        this.resize();
    }

    resize() {
        this._resizeCharts();
        this.drawingEngine?.redraw();
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                if (this._destroyed) return;
                this._resizeCharts();
                this.drawingEngine?.redraw();
            });
        }
    }

    onToolChange(tool) {
        if (!this.toolPanel) return;
        const buttons = this.toolPanel.querySelectorAll('.tool-btn[data-tool]');
        buttons.forEach((btn) => {
            btn.classList.toggle('active', btn.getAttribute('data-tool') === tool);
        });
    }

    onMagnetChange(enabled) {
        this.magnetBtn?.classList.toggle('active', Boolean(enabled));
    }

    getTheme() {
        return this.theme;
    }

    getAlertsForSymbol() {
        if (typeof alertManager?.getAlertsForSymbol === 'function') {
            return alertManager.getAlertsForSymbol(this.state.source, this.state.symbol);
        }
        return [];
    }

    persistDrawings(drawings) {
        const key = `${this.state.source}:${this.state.symbol}`;
        return saveDrawings(key, drawings);
    }

    destroy() {
        this._destroyed = true;
        clearInterval(this.countdownTimer);
        clearTimeout(this.flowComputeTimeout);
        clearTimeout(this.autocompleteTimeout);

        syncManager.unregisterPane(this);
        this.unsubscribeLive();

        this.drawingEngine?.destroy();
        this.drawingEngine = null;

        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.rsiChart) {
            try {
                this.rsiChart.remove();
            } catch (_) {}
            this.rsiSeries = null;
            this.rsiChart = null;
        }
        if (this.chart) {
            try {
                this.chart.remove();
            } catch (_) {}
            this.chart = null;
            this.series = null;
        }
        if (this.paneEl && this.paneEl.parentNode) {
            this.paneEl.parentNode.removeChild(this.paneEl);
        }
    }
}
