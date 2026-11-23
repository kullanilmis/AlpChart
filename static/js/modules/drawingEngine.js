// ==========================================
// HTML5 CANVAS DRAWING ENGINE MODULE
// ==========================================

const DEFAULT_THEME = {
    mode: 'dark',
    drawing: {
        defaultColor: '#e4e4e7',
        selectedColor: '#3b82f6',
        previewColor: 'rgba(228, 228, 231, 0.65)',
        handleFill: '#3b82f6',
        handleStroke: '#ffffff',
        lockStroke: '#f59e0b',
        labelBg: 'rgba(18, 18, 20, 0.90)',
        labelText: '#f4f4f5',
        alertColor: '#f59e0b',
        measureBg: 'rgba(59, 130, 246, 0.14)',
        measureBorder: 'rgba(59, 130, 246, 0.85)',
        measureTextBg: 'rgba(15, 23, 42, 0.92)',
        measureText: '#e2e8f0',
        toolbarBg: 'rgba(18, 18, 20, 0.94)',
        toolbarBorder: '#2a2a30',
        toolbarText: '#e4e4e7',
        toolbarMuted: '#71717a',
    },
    flow: {
        longFill: 'rgba(34, 197, 94, 0.04)',
        longBorder: 'rgba(34, 197, 94, 0.20)',
        shortFill: 'rgba(239, 68, 68, 0.04)',
        shortBorder: 'rgba(239, 68, 68, 0.20)',
        fib25: 'rgba(113, 113, 122, 0.35)',
        fib50: 'rgba(113, 113, 122, 0.55)',
        fib75: 'rgba(113, 113, 122, 0.35)',
        closeLine: 'rgba(160, 160, 160, 0.55)',
        sweepLine: 'rgba(239, 68, 68, 0.65)',
        zigzag: '#5b86e5',
    },
};

const SWATCH_COLORS = ['#e4e4e7', '#3b82f6', '#22c55e', '#ef4444', '#f59e0b', '#a855f7'];
const LINE_WIDTHS = [1, 2, 3];
const LINE_STYLES = [
    { id: 'solid', label: '—', title: 'Solid Line' },
    { id: 'dashed', label: '--', title: 'Dashed Line' },
    { id: 'dotted', label: '···', title: 'Dotted Line' },
];
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const MAX_HISTORY_ENTRIES = 50;
const HIT_TOLERANCE_PX = 8;
const HANDLE_HIT_RADIUS_PX = 10;

const TIMEFRAME_SECONDS = {
    '1m': 60,
    '3m': 180,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '45m': 2700,
    '1h': 3600,
    '2h': 7200,
    '4h': 14400,
    '1d': 86400,
    '1w': 604800,
};

/**
 * Deep-merge an incoming theme object with DEFAULT_THEME.
 * Supports optional flow/drawing subkey aliases gracefully.
 */
function mergeTheme(themeObj) {
    const incoming = themeObj && typeof themeObj === 'object' ? themeObj : {};
    const incDrawing = incoming.drawing && typeof incoming.drawing === 'object' ? incoming.drawing : {};
    const incFlow = incoming.flow && typeof incoming.flow === 'object' ? incoming.flow : {};

    return {
        ...DEFAULT_THEME,
        ...incoming,
        drawing: {
            ...DEFAULT_THEME.drawing,
            ...incDrawing,
        },
        flow: {
            ...DEFAULT_THEME.flow,
            ...incFlow,
            longFill: incFlow.longFill || incFlow.boxLongFill || DEFAULT_THEME.flow.longFill,
            longBorder: incFlow.longBorder || incFlow.boxLongBorder || DEFAULT_THEME.flow.longBorder,
            shortFill: incFlow.shortFill || incFlow.boxShortFill || DEFAULT_THEME.flow.shortFill,
            shortBorder: incFlow.shortBorder || incFlow.boxShortBorder || DEFAULT_THEME.flow.shortBorder,
            closeLine: incFlow.closeLine || incFlow.closeLineColor || DEFAULT_THEME.flow.closeLine,
            sweepLine: incFlow.sweepLine || incFlow.sweepLineColor || DEFAULT_THEME.flow.sweepLine,
            zigzag: incFlow.zigzag || incFlow.zigzagColor || DEFAULT_THEME.flow.zigzag,
        },
    };
}

/**
 * Convert a CSS hex or rgb(a) string to rgba(...) with the specified alpha.
 */
function colorWithAlpha(color, alpha) {
    if (!color || typeof color !== 'string') return `rgba(228, 228, 231, ${alpha})`;
    const trimmed = color.trim();
    if (trimmed.startsWith('#')) {
        let hex = trimmed.slice(1);
        if (hex.length === 3) {
            hex = hex.split('').map(c => c + c).join('');
        }
        if (hex.length >= 6) {
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
                return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            }
        }
    }
    const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgbMatch) {
        return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
    }
    return trimmed;
}

/**
 * Pick dark or light text color based on background hex luminance.
 */
function getContrastTextColor(bgColor) {
    if (!bgColor || typeof bgColor !== 'string') return '#0b0b0c';
    const trimmed = bgColor.trim();
    let r = 228, g = 228, b = 231;
    if (trimmed.startsWith('#')) {
        let hex = trimmed.slice(1);
        if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
        if (hex.length >= 6) {
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
        }
    } else {
        const m = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (m) {
            r = parseInt(m[1], 10);
            g = parseInt(m[2], 10);
            b = parseInt(m[3], 10);
        }
    }
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? '#0b0b0c' : '#ffffff';
}

function getDashPattern(lineStyle) {
    if (lineStyle === 'dashed') return [6, 4];
    if (lineStyle === 'dotted') return [2, 3];
    return [];
}

function drawRoundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, width, height, r);
        return;
    }
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function isPointNearSegment(p, a, b, tolerance = HIT_TOLERANCE_PX) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y) < tolerance;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return Math.hypot(p.x - projX, p.y - projY) < tolerance;
}

function isPointInQuad(p, q1, q2, q3, q4) {
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

function formatPrice(price) {
    if (typeof price !== 'number' || !Number.isFinite(price)) return '—';
    const abs = Math.abs(price);
    if (abs === 0) return '0.00';
    if (abs < 0.0001) return price.toFixed(8);
    if (abs < 0.01) return price.toFixed(6);
    if (abs < 1) return price.toFixed(4);
    if (abs < 100) return price.toFixed(3);
    if (abs < 10000) return price.toFixed(2);
    return price.toFixed(1);
}

function formatDuration(seconds) {
    const absSec = Math.abs(Math.round(seconds));
    if (!Number.isFinite(absSec) || absSec === 0) return '0dk';
    const days = Math.floor(absSec / 86400);
    const hours = Math.floor((absSec % 86400) / 3600);
    const mins = Math.floor((absSec % 3600) / 60);
    const secs = absSec % 60;

    if (days > 0) {
        return hours > 0 ? `${days}g ${hours}s` : `${days}g`;
    }
    if (hours > 0) {
        return mins > 0 ? `${hours}s ${mins}dk` : `${hours}s`;
    }
    if (mins > 0) {
        return `${mins}dk`;
    }
    return `${secs}sn`;
}

/**
 * Upgraded HTML5 Canvas DrawingEngine handling time-anchored user drawings,
 * Flow V2.5 overlay, price alert lines, magnet snapping, R:R tools, Fibonacci,
 * temporary measure ruler, undo/redo history, and floating style toolbar.
 */
export class DrawingEngine {
    constructor(pane) {
        this.pane = pane;

        // Theme setup
        const initialTheme = typeof this.pane?.getTheme === 'function' ? this.pane.getTheme() : null;
        this.theme = mergeTheme(initialTheme);

        // Drawings & tools state
        this.drawings = [];
        this.activeTool = 'select';
        this.selectedDrawing = null;
        this.drawingPoints = [];
        this.magnetEnabled = false;

        // History stacks (deep clones capped at 50)
        this.undoStack = [];
        this.redoStack = [];

        // Dragging & hover state
        this.draggedDrawing = null;
        this.draggedHandleIndex = -1;
        this.dragStartLogical = null;
        this.dragStartPrice = null;
        this.dragOriginalPoints = [];
        this._preDragSnapshot = null;
        this._didDragMove = false;
        this.lastMousePos = null;
        this.snapPixel = null;

        // Temporary measure ruler state (never persisted)
        this.measureState = null;

        // DOM & lifecycle refs
        this.canvas = null;
        this.styleToolbar = null;
        this._toolbarRefs = null;
        this._cleanupListeners = null;
        this._rangeChangeHandler = null;
        this._resizeObserver = null;

        this._initDOM();
        this._initEvents();
    }

    // ==========================================
    // LIFECYCLE & DOM SETUP
    // ==========================================

    _initDOM() {
        const container = this.pane?.chartContainer;
        if (!container || typeof document === 'undefined') return;

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'pane-drawing-canvas';
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.zIndex = '4';
        this.canvas.style.pointerEvents = 'none';
        container.appendChild(this.canvas);

        this._createStyleToolbar(container);
    }

    _createStyleToolbar(container) {
        const toolbar = document.createElement('div');
        toolbar.className = 'drawing-style-toolbar';
        toolbar.style.position = 'absolute';
        toolbar.style.top = '8px';
        toolbar.style.left = '50%';
        toolbar.style.transform = 'translateX(-50%)';
        toolbar.style.zIndex = '20';
        toolbar.style.display = 'none';
        toolbar.style.alignItems = 'center';
        toolbar.style.gap = '6px';
        toolbar.style.padding = '4px 8px';
        toolbar.style.borderRadius = '6px';
        toolbar.style.backgroundColor = this.theme.drawing.toolbarBg;
        toolbar.style.border = `1px solid ${this.theme.drawing.toolbarBorder}`;
        toolbar.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.45)';
        toolbar.style.backdropFilter = 'blur(6px)';
        toolbar.style.fontFamily = "'JetBrains Mono', monospace";
        toolbar.style.fontSize = '11px';
        toolbar.style.userSelect = 'none';
        toolbar.style.maxWidth = 'calc(100% - 16px)';
        toolbar.style.pointerEvents = 'auto';

        // Stop event propagation so clicking toolbar never pans chart or deselects
        const stopEvents = ['mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'touchstart'];
        stopEvents.forEach(evt => {
            toolbar.addEventListener(evt, (e) => {
                e.stopPropagation();
            });
        });

        const makeSep = () => {
            const sep = document.createElement('span');
            sep.style.width = '1px';
            sep.style.height = '16px';
            sep.style.backgroundColor = this.theme.drawing.toolbarBorder;
            sep.style.flexShrink = '0';
            return sep;
        };

        const makeBtn = (text, title) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = text;
            btn.title = title;
            btn.style.background = 'transparent';
            btn.style.border = `1px solid transparent`;
            btn.style.borderRadius = '4px';
            btn.style.color = this.theme.drawing.toolbarText;
            btn.style.fontFamily = 'inherit';
            btn.style.fontSize = '10px';
            btn.style.lineHeight = '1';
            btn.style.padding = '4px 5px';
            btn.style.cursor = 'pointer';
            btn.style.display = 'inline-flex';
            btn.style.alignItems = 'center';
            btn.style.justifyContent = 'center';
            btn.style.flexShrink = '0';
            return btn;
        };

        // 6 Color Swatches
        const swatchBtns = SWATCH_COLORS.map(hex => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'toolbar-swatch-btn';
            btn.dataset.color = hex;
            btn.title = `Color ${hex}`;
            btn.style.width = '14px';
            btn.style.height = '14px';
            btn.style.borderRadius = '50%';
            btn.style.backgroundColor = hex;
            btn.style.border = '1px solid rgba(255,255,255,0.2)';
            btn.style.cursor = 'pointer';
            btn.style.padding = '0';
            btn.style.flexShrink = '0';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this._updateSelectedStyle({ color: hex });
            });
            toolbar.appendChild(btn);
            return btn;
        });

        toolbar.appendChild(makeSep());

        // Line Width buttons (1px, 2px, 3px)
        const widthBtns = LINE_WIDTHS.map(w => {
            const btn = makeBtn(`${w}px`, `Line Width ${w}px`);
            btn.className = 'toolbar-width-btn';
            btn.dataset.width = String(w);
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this._updateSelectedStyle({ lineWidth: w });
            });
            toolbar.appendChild(btn);
            return btn;
        });

        toolbar.appendChild(makeSep());

        // Line Style buttons (solid, dashed, dotted)
        const styleBtns = LINE_STYLES.map(ls => {
            const btn = makeBtn(ls.label, ls.title);
            btn.className = 'toolbar-style-btn';
            btn.dataset.lineStyle = ls.id;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this._updateSelectedStyle({ lineStyle: ls.id });
            });
            toolbar.appendChild(btn);
            return btn;
        });

        toolbar.appendChild(makeSep());

        // Lock / Unlock toggle button
        const lockBtn = makeBtn('🔓', 'Lock / Unlock Drawing');
        lockBtn.className = 'toolbar-lock-btn';
        lockBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this._toggleSelectedLock();
        });
        toolbar.appendChild(lockBtn);

        // Delete button
        const deleteBtn = makeBtn('🗑', 'Delete Drawing');
        deleteBtn.className = 'toolbar-delete-btn';
        deleteBtn.style.color = '#ef4444';
        deleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this.deleteSelected();
        });
        toolbar.appendChild(deleteBtn);

        container.appendChild(toolbar);
        this.styleToolbar = toolbar;
        this._toolbarRefs = { swatchBtns, widthBtns, styleBtns, lockBtn, deleteBtn };
    }

    _initEvents() {
        const container = this.pane?.chartContainer;
        if (!container) return;

        const onMouseDown = (e) => this._onMouseDown(e);
        const onMouseMove = (e) => this._onMouseMove(e);
        const onMouseLeave = () => this._onMouseLeave();
        const onMouseUp = (e) => this._onMouseUp(e);

        container.addEventListener('mousedown', onMouseDown, true);
        container.addEventListener('mousemove', onMouseMove, true);
        container.addEventListener('mouseleave', onMouseLeave);
        if (typeof window !== 'undefined') {
            window.addEventListener('mouseup', onMouseUp, true);
        }

        // Keep canvas aligned with chart scroll/zoom
        const timeScale = this.pane?.chart?.timeScale?.();
        if (timeScale && typeof timeScale.subscribeVisibleLogicalRangeChange === 'function') {
            this._rangeChangeHandler = () => this.redraw();
            try {
                timeScale.subscribeVisibleLogicalRangeChange(this._rangeChangeHandler);
            } catch (err) {
                console.error('Error subscribing to logical range change:', err);
            }
        }

        // Resize observer on chart container
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => {
                this.redraw();
            });
            this._resizeObserver.observe(container);
        }

        this._cleanupListeners = () => {
            container.removeEventListener('mousedown', onMouseDown, true);
            container.removeEventListener('mousemove', onMouseMove, true);
            container.removeEventListener('mouseleave', onMouseLeave);
            if (typeof window !== 'undefined') {
                window.removeEventListener('mouseup', onMouseUp, true);
            }
        };
    }

    destroy() {
        if (this._cleanupListeners) {
            this._cleanupListeners();
            this._cleanupListeners = null;
        }
        if (this._rangeChangeHandler && this.pane?.chart?.timeScale) {
            try {
                this.pane.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this._rangeChangeHandler);
            } catch (e) { /* chart may already be disposed */ }
            this._rangeChangeHandler = null;
        }
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this.styleToolbar && this.styleToolbar.parentNode) {
            this.styleToolbar.parentNode.removeChild(this.styleToolbar);
        }
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this.styleToolbar = null;
        this._toolbarRefs = null;
        this.canvas = null;
        this.selectedDrawing = null;
        this.draggedDrawing = null;
        this.measureState = null;
    }

    // ==========================================
    // THEME, TOOLS, MAGNET & DATA STATE
    // ==========================================

    setTheme(themeObj) {
        this.theme = mergeTheme(themeObj);
        if (this.styleToolbar) {
            this.styleToolbar.style.backgroundColor = this.theme.drawing.toolbarBg;
            this.styleToolbar.style.borderColor = this.theme.drawing.toolbarBorder;
            this.updateStyleToolbar();
        }
        this.redraw();
    }

    setActiveTool(tool) {
        const nextTool = tool || 'select';
        this.activeTool = nextTool;
        this.drawingPoints = [];
        this.snapPixel = null;

        if (nextTool !== 'measure') {
            this.measureState = null;
        }
        if (nextTool !== 'select') {
            this.selectedDrawing = null;
            this.updateStyleToolbar();
        }

        if (this.pane?.chartContainer) {
            this.pane.chartContainer.style.cursor = nextTool === 'select' ? 'default' : 'crosshair';
        }
        if (typeof this.pane?.onToolChange === 'function') {
            this.pane.onToolChange(nextTool);
        }
        this.redraw();
    }

    setTool(tool) {
        this.setActiveTool(tool);
    }

    getActiveTool() {
        return this.activeTool;
    }

    setMagnet(enabled) {
        this.magnetEnabled = Boolean(enabled);
        if (!this.magnetEnabled) {
            this.snapPixel = null;
        }
        if (typeof this.pane?.onMagnetChange === 'function') {
            this.pane.onMagnetChange(this.magnetEnabled);
        }
        this.redraw();
        return this.magnetEnabled;
    }

    toggleMagnet() {
        return this.setMagnet(!this.magnetEnabled);
    }

    isMagnetEnabled() {
        return this.magnetEnabled;
    }

    isMagnetActive(e = null) {
        return this.magnetEnabled || Boolean(e && (e.ctrlKey || e.metaKey));
    }

    setDrawings(list) {
        this.drawings = Array.isArray(list)
            ? this._cloneDrawings(list).map(d => ({ ...d, locked: Boolean(d?.locked) }))
            : [];
        this.selectedDrawing = null;
        this.drawingPoints = [];
        this.draggedDrawing = null;
        this.draggedHandleIndex = -1;
        this.undoStack = [];
        this.redoStack = [];
        this.snapPixel = null;
        this.updateStyleToolbar();
        this.migrateLegacyDrawings();
        this.redraw();
    }

    getDrawings() {
        return this.drawings;
    }

    onDataUpdated() {
        this.migrateLegacyDrawings();
        this.redraw();
    }

    // ==========================================
    // UNDO / REDO & PERSISTENCE
    // ==========================================

    _cloneDrawings(drawings) {
        try {
            return JSON.parse(JSON.stringify(drawings || []));
        } catch (e) {
            return [];
        }
    }

    pushHistory(snapshot = null) {
        const entry = snapshot ? this._cloneDrawings(snapshot) : this._cloneDrawings(this.drawings);
        this.undoStack.push(entry);
        if (this.undoStack.length > MAX_HISTORY_ENTRIES) {
            this.undoStack.shift();
        }
        this.redoStack = [];
    }

    undo() {
        if (this.undoStack.length === 0) return false;
        this.redoStack.push(this._cloneDrawings(this.drawings));
        if (this.redoStack.length > MAX_HISTORY_ENTRIES) {
            this.redoStack.shift();
        }
        this.drawings = this.undoStack.pop();
        this.selectedDrawing = null;
        this.draggedDrawing = null;
        this.draggedHandleIndex = -1;
        this.drawingPoints = [];
        this.updateStyleToolbar();
        this.persist();
        this.redraw();
        return true;
    }

    redo() {
        if (this.redoStack.length === 0) return false;
        this.undoStack.push(this._cloneDrawings(this.drawings));
        if (this.undoStack.length > MAX_HISTORY_ENTRIES) {
            this.undoStack.shift();
        }
        this.drawings = this.redoStack.pop();
        this.selectedDrawing = null;
        this.draggedDrawing = null;
        this.draggedHandleIndex = -1;
        this.drawingPoints = [];
        this.updateStyleToolbar();
        this.persist();
        this.redraw();
        return true;
    }

    persist() {
        if (typeof this.pane?.persistDrawings !== 'function') return;
        try {
            const res = this.pane.persistDrawings(this._cloneDrawings(this.drawings));
            if (res && typeof res.catch === 'function') {
                res.catch(err => console.error('Error persisting drawings:', err));
            }
        } catch (err) {
            console.error('Error persisting drawings:', err);
        }
    }

    deleteSelected() {
        if (!this.selectedDrawing) return false;
        this.pushHistory();
        const targetId = this.selectedDrawing.id;
        this.drawings = this.drawings.filter(d => d.id !== targetId);
        this.selectedDrawing = null;
        this.draggedDrawing = null;
        this.draggedHandleIndex = -1;
        this.updateStyleToolbar();
        this.persist();
        this.redraw();
        return true;
    }

    clearAll() {
        if (this.drawings.length > 0) {
            this.pushHistory();
        }
        this.drawings = [];
        this.selectedDrawing = null;
        this.drawingPoints = [];
        this.draggedDrawing = null;
        this.draggedHandleIndex = -1;
        this.snapPixel = null;
        this.updateStyleToolbar();
        this.persist();
        this.redraw();
    }

    clearAllDrawings() {
        this.clearAll();
    }

    handleEscape() {
        if (this.measureState) {
            this.measureState = null;
            this.snapPixel = null;
            this.redraw();
            return true;
        }
        if (this.drawingPoints.length > 0) {
            this.drawingPoints = [];
            this.snapPixel = null;
            this.redraw();
            return true;
        }
        if (this.activeTool !== 'select') {
            this.setActiveTool('select');
            return true;
        }
        if (this.selectedDrawing) {
            this.selectedDrawing = null;
            this.updateStyleToolbar();
            this.redraw();
            return true;
        }
        return false;
    }

    escapeAction() {
        return this.handleEscape();
    }

    // ==========================================
    // TIME-BASED ANCHOR COORDINATE CONVERSIONS
    // ==========================================

    getActiveCandles() {
        const candles = this.pane?.activeCandles;
        return Array.isArray(candles) ? candles : [];
    }

    /**
     * Binary search on ascending pane.activeCandles by timestamp.
     * Returns exact match index or closest candle index (-1 if empty).
     */
    findCandleIndexByTime(time) {
        const candles = this.getActiveCandles();
        const n = candles.length;
        if (n === 0 || time === undefined || time === null) return -1;
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

    anchorToLogical(pt) {
        if (!pt) return null;
        const candles = this.getActiveCandles();
        if (pt.time !== undefined && pt.time !== null && candles.length > 0) {
            const baseIdx = this.findCandleIndexByTime(pt.time);
            return baseIdx + (pt.barOffset || 0);
        }
        return typeof pt.logical === 'number' && Number.isFinite(pt.logical) ? pt.logical : null;
    }

    logicalToAnchor(logical, price) {
        const candles = this.getActiveCandles();
        const rounded = Math.round(logical);
        if (candles.length === 0) {
            return { logical: rounded, price };
        }
        if (rounded >= 0 && rounded < candles.length) {
            return { time: candles[rounded].time, price, barOffset: 0 };
        }
        if (rounded >= candles.length) {
            const lastIdx = candles.length - 1;
            return { time: candles[lastIdx].time, price, barOffset: rounded - lastIdx };
        }
        return { time: candles[0].time, price, barOffset: rounded };
    }

    pixelToData(x, y, useMagnet = false) {
        try {
            const chart = this.pane?.chart;
            const series = this.pane?.series;
            if (!chart || !series) return null;

            const rawLogical = chart.timeScale().coordinateToLogical(x);
            let price = series.coordinateToPrice(y);
            if (
                rawLogical === null || rawLogical === undefined || !Number.isFinite(rawLogical)
                || price === null || price === undefined || !Number.isFinite(price)
            ) {
                return null;
            }

            const logical = Math.round(rawLogical);
            const candles = this.getActiveCandles();

            if (useMagnet && candles.length > 0) {
                const idx = Math.max(0, Math.min(candles.length - 1, logical));
                const c = candles[idx];
                const ohlc = [c.open, c.high, c.low, c.close].filter(v => typeof v === 'number' && Number.isFinite(v));
                if (ohlc.length > 0) {
                    let bestPrice = ohlc[0];
                    let bestDist = Math.abs(ohlc[0] - price);
                    for (let i = 1; i < ohlc.length; i++) {
                        const dist = Math.abs(ohlc[i] - price);
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestPrice = ohlc[i];
                        }
                    }
                    price = bestPrice;

                    const snapX = chart.timeScale().logicalToCoordinate(logical);
                    const snapY = series.priceToCoordinate(price);
                    if (snapX !== null && snapY !== null && Number.isFinite(snapX) && Number.isFinite(snapY)) {
                        this.snapPixel = { x: snapX, y: snapY, price, candleIndex: idx };
                    }
                }
            } else if (!useMagnet) {
                this.snapPixel = null;
            }

            return this.logicalToAnchor(logical, price);
        } catch (e) {
            return null;
        }
    }

    dataToPixel(pt) {
        if (!pt) return null;
        try {
            const chart = this.pane?.chart;
            const series = this.pane?.series;
            if (!chart || !series) return null;

            const logical = this.anchorToLogical(pt);
            if (logical === null) return null;

            const x = chart.timeScale().logicalToCoordinate(logical);
            const y = series.priceToCoordinate(pt.price);
            if (
                x === null || y === null
                || x === undefined || y === undefined
                || !Number.isFinite(x) || !Number.isFinite(y)
            ) {
                return null;
            }
            return { x, y };
        } catch (e) {
            return null;
        }
    }

    moveAnchorByDelta(origPt, deltaLogical, deltaPrice) {
        if (!origPt) return null;
        const origLogical = this.anchorToLogical(origPt);
        if (origLogical === null) {
            return { ...origPt, price: origPt.price + deltaPrice };
        }
        const newLogical = Math.round(origLogical + deltaLogical);
        const newPrice = origPt.price + deltaPrice;
        return this.logicalToAnchor(newLogical, newPrice);
    }

    migrateLegacyDrawings() {
        const candles = this.getActiveCandles();
        if (candles.length === 0 || !Array.isArray(this.drawings) || this.drawings.length === 0) {
            return false;
        }

        let migrated = false;
        for (const drawing of this.drawings) {
            if (!drawing || !Array.isArray(drawing.points)) continue;
            for (let i = 0; i < drawing.points.length; i++) {
                const pt = drawing.points[i];
                if (pt && pt.time === undefined && pt.logical !== undefined && pt.logical !== null) {
                    drawing.points[i] = this.logicalToAnchor(Math.round(pt.logical), pt.price);
                    migrated = true;
                }
            }
        }

        if (migrated) {
            this.persist();
        }
        return migrated;
    }

    getPlotAreaRect() {
        const container = this.pane?.chartContainer;
        if (!container) return { left: 0, top: 0, width: 0, height: 0 };

        const width = container.clientWidth;
        const height = container.clientHeight;

        let priceScaleWidth = 0;
        let timeScaleHeight = 26;
        try {
            priceScaleWidth = this.pane.chart?.priceScale?.('right')?.width?.() || 0;
            timeScaleHeight = this.pane.chart?.timeScale?.()?.height?.() || 26;
        } catch (e) { /* ignore */ }

        const canvases = Array.from(container.querySelectorAll('canvas'));
        const mainCanvas = canvases.find(c => {
            return c !== this.canvas && c.clientWidth > 50 && c.clientHeight > 50 && c.clientWidth < width;
        });
        if (mainCanvas) {
            return {
                left: 0,
                top: 0,
                width: mainCanvas.clientWidth,
                height: mainCanvas.clientHeight,
            };
        }

        return {
            left: 0,
            top: 0,
            width: Math.max(0, width - priceScaleWidth),
            height: Math.max(0, height - timeScaleHeight),
        };
    }

    _isInPlotArea(x, y, plotRect = this.getPlotAreaRect()) {
        return x >= plotRect.left
            && x <= plotRect.left + plotRect.width
            && y >= plotRect.top
            && y <= plotRect.top + plotRect.height;
    }

    // ==========================================
    // STYLE TOOLBAR & DRAWING STYLE HELPERS
    // ==========================================

    _createDefaultStyle() {
        return {
            color: this.theme.drawing.defaultColor,
            lineWidth: 1.5,
            lineStyle: 'solid',
        };
    }

    _getDrawingStyle(drawing) {
        const style = drawing?.style || {};
        return {
            color: style.color || this.theme.drawing.defaultColor,
            lineWidth: typeof style.lineWidth === 'number' ? style.lineWidth : 1.5,
            lineStyle: style.lineStyle || 'solid',
        };
    }

    _updateSelectedStyle(patch) {
        if (!this.selectedDrawing) return;
        this.pushHistory();
        const current = this._getDrawingStyle(this.selectedDrawing);
        this.selectedDrawing.style = { ...current, ...patch };
        this.updateStyleToolbar();
        this.persist();
        this.redraw();
    }

    _toggleSelectedLock() {
        if (!this.selectedDrawing) return;
        this.pushHistory();
        this.selectedDrawing.locked = !this.selectedDrawing.locked;
        if (this.selectedDrawing.locked && this.draggedDrawing === this.selectedDrawing) {
            this.draggedDrawing = null;
            this.draggedHandleIndex = -1;
        }
        this.updateStyleToolbar();
        this.persist();
        this.redraw();
    }

    updateStyleToolbar() {
        if (!this.styleToolbar || !this._toolbarRefs) return;

        if (!this.selectedDrawing) {
            this.styleToolbar.style.display = 'none';
            this.styleToolbar.classList.remove('visible');
            return;
        }

        const style = this._getDrawingStyle(this.selectedDrawing);
        const locked = Boolean(this.selectedDrawing.locked);

        this.styleToolbar.style.display = 'flex';
        this.styleToolbar.classList.add('visible');

        const { swatchBtns, widthBtns, styleBtns, lockBtn } = this._toolbarRefs;

        swatchBtns.forEach(btn => {
            const active = btn.dataset.color?.toLowerCase() === style.color.toLowerCase();
            btn.style.boxShadow = active
                ? `0 0 0 2px ${this.theme.drawing.toolbarBg}, 0 0 0 3.5px #f4f4f5`
                : 'none';
        });

        widthBtns.forEach(btn => {
            const w = Number(btn.dataset.width);
            const active = style.lineWidth === w;
            btn.style.borderColor = active ? '#3b82f6' : 'transparent';
            btn.style.backgroundColor = active ? 'rgba(59, 130, 246, 0.22)' : 'transparent';
            btn.style.color = active ? '#ffffff' : this.theme.drawing.toolbarText;
        });

        styleBtns.forEach(btn => {
            const active = btn.dataset.lineStyle === style.lineStyle;
            btn.style.borderColor = active ? '#3b82f6' : 'transparent';
            btn.style.backgroundColor = active ? 'rgba(59, 130, 246, 0.22)' : 'transparent';
            btn.style.color = active ? '#ffffff' : this.theme.drawing.toolbarText;
        });

        lockBtn.textContent = locked ? '🔒' : '🔓';
        lockBtn.title = locked ? 'Unlock Drawing' : 'Lock Drawing';
        lockBtn.style.borderColor = locked ? '#f59e0b' : 'transparent';
        lockBtn.style.backgroundColor = locked ? 'rgba(245, 158, 11, 0.18)' : 'transparent';
    }

    // ==========================================
    // HANDLE GEOMETRY & HIT-TESTING
    // ==========================================

    getHandlePoints(drawing, rect = this.getPlotAreaRect()) {
        if (!drawing || !Array.isArray(drawing.points)) return [];

        if (drawing.type === 'horizontal') {
            const p1 = this.dataToPixel(drawing.points[0]);
            return p1 ? [{ x: rect.left + rect.width / 2, y: p1.y }] : [];
        }

        const pts = drawing.points.map(pt => this.dataToPixel(pt));
        if (drawing.type === 'channel') {
            const [p1, p2, p3] = pts;
            if (p1 && p2 && p3) {
                pts.push({ x: p2.x + (p3.x - p1.x), y: p2.y + (p3.y - p1.y) });
            }
        }
        return pts;
    }

    isPointNearDrawing(p, drawing) {
        if (!drawing || !Array.isArray(drawing.points)) return false;
        const rect = this.getPlotAreaRect();

        if (drawing.type === 'trend') {
            const a = this.dataToPixel(drawing.points[0]);
            const b = this.dataToPixel(drawing.points[1]);
            if (!a || !b) return false;
            return isPointNearSegment(p, a, b);
        }

        if (drawing.type === 'horizontal') {
            const a = this.dataToPixel(drawing.points[0]);
            if (!a) return false;
            return Math.abs(p.y - a.y) < HIT_TOLERANCE_PX && p.x >= rect.left && p.x <= rect.left + rect.width;
        }

        if (drawing.type === 'ray') {
            const a = this.dataToPixel(drawing.points[0]);
            if (!a) return false;
            return Math.abs(p.y - a.y) < HIT_TOLERANCE_PX && p.x >= a.x - 6 && p.x <= rect.left + rect.width;
        }

        if (drawing.type === 'rectangle') {
            const a = this.dataToPixel(drawing.points[0]);
            const b = this.dataToPixel(drawing.points[1]);
            if (!a || !b) return false;
            const minX = Math.min(a.x, b.x);
            const maxX = Math.max(a.x, b.x);
            const minY = Math.min(a.y, b.y);
            const maxY = Math.max(a.y, b.y);
            return p.x >= minX - 4 && p.x <= maxX + 4 && p.y >= minY - 4 && p.y <= maxY + 4;
        }

        if (drawing.type === 'channel') {
            const p1 = this.dataToPixel(drawing.points[0]);
            const p2 = this.dataToPixel(drawing.points[1]);
            const p3 = this.dataToPixel(drawing.points[2]);
            if (!p1 || !p2 || !p3) return false;
            const p4 = { x: p2.x + (p3.x - p1.x), y: p2.y + (p3.y - p1.y) };

            if (isPointNearSegment(p, p1, p2)) return true;
            if (isPointNearSegment(p, p3, p4)) return true;
            return isPointInQuad(p, p1, p2, p4, p3);
        }

        if (drawing.type === 'fib') {
            const p1 = this.dataToPixel(drawing.points[0]);
            const p2 = this.dataToPixel(drawing.points[1]);
            if (!p1 || !p2) return false;
            const xLeft = Math.min(p1.x, p2.x);
            const xRight = Math.max(p1.x, p2.x);
            if (p.x < xLeft - 6 || p.x > xRight + 6) return false;

            const price0 = drawing.points[0].price;
            const price1 = drawing.points[1].price;
            for (const lvl of FIB_LEVELS) {
                const lvlPrice = price1 + (price0 - price1) * lvl;
                const y = this.pane.series.priceToCoordinate(lvlPrice);
                if (y !== null && Math.abs(p.y - y) < HIT_TOLERANCE_PX) {
                    return true;
                }
            }
            const y382 = this.pane.series.priceToCoordinate(price1 + (price0 - price1) * 0.382);
            const y618 = this.pane.series.priceToCoordinate(price1 + (price0 - price1) * 0.618);
            if (y382 !== null && y618 !== null) {
                const bandTop = Math.min(y382, y618);
                const bandBot = Math.max(y382, y618);
                if (p.y >= bandTop && p.y <= bandBot) return true;
            }
            return isPointNearSegment(p, p1, p2);
        }

        if (drawing.type === 'long' || drawing.type === 'short') {
            const pEntry = this.dataToPixel(drawing.points[0]);
            const pSl = this.dataToPixel(drawing.points[1]);
            const pTp = this.dataToPixel(drawing.points[2]);
            if (!pEntry || !pSl || !pTp) return false;

            const xLeft = Math.min(pEntry.x, pSl.x, pTp.x);
            const xRight = Math.max(pEntry.x, pSl.x, pTp.x, xLeft + 24);
            const minY = Math.min(pEntry.y, pSl.y, pTp.y);
            const maxY = Math.max(pEntry.y, pSl.y, pTp.y);
            return p.x >= xLeft - 4 && p.x <= xRight + 4 && p.y >= minY - 6 && p.y <= maxY + 6;
        }

        return false;
    }

    // ==========================================
    // RENDERING PIPELINE
    // ==========================================

    redraw() {
        if (!this.canvas || !this.pane?.chartContainer) return;

        const container = this.pane.chartContainer;
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (width === 0 || height === 0) return;

        if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
            this.canvas.width = Math.round(width * dpr);
            this.canvas.height = Math.round(height * dpr);
            this.canvas.style.width = `${width}px`;
            this.canvas.style.height = `${height}px`;
        }

        const ctx = this.canvas.getContext('2d');
        if (!ctx) return;

        ctx.resetTransform();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        const rect = this.getPlotAreaRect();

        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.left, rect.top, rect.width, rect.height);
        ctx.clip();

        // Layer 1: Flow V2.5 overlay
        if (this.pane.state?.indicators?.flow && this.pane.flowData) {
            this._renderFlowOverlay(ctx, rect);
        }

        // Layer 2: Active Price Alerts
        this._renderAlerts(ctx, rect);

        // Layer 3: User drawings
        for (const drawing of this.drawings) {
            const isSelected = this.selectedDrawing === drawing;
            this._renderShape(ctx, drawing, isSelected, rect);
        }

        // Layer 4: Active preview shape, temporary measure ruler, and Magnet snap ring
        if (this.lastMousePos) {
            if (
                this.drawingPoints.length > 0
                || this.activeTool === 'horizontal'
                || this.activeTool === 'ray'
            ) {
                this._renderPreview(ctx, rect);
            }
        }
        if (this.measureState) {
            this._renderMeasure(ctx, rect);
        }
        if (this.snapPixel) {
            this._renderMagnetSnap(ctx, this.snapPixel);
        }

        ctx.restore();

        // Layer 5: Selection handles (outside clip, guarded by plot area)
        if (this.selectedDrawing) {
            this._renderHandles(ctx, this.selectedDrawing, rect);
        }
    }

    redrawDrawings() {
        this.redraw();
    }

    _renderFlowOverlay(ctx, rect) {
        const data = this.pane?.flowData;
        if (!data || !this.pane?.chart || !this.pane?.series) return;

        const flowTheme = this.theme.flow;
        const candles = this.getActiveCandles();
        const timeMap = Object.create(null);
        for (let i = 0; i < candles.length; i++) {
            timeMap[candles[i].time] = i;
        }

        const timeScale = this.pane.chart.timeScale();
        const series = this.pane.series;

        const toPixel = (time, price) => {
            const logical = timeMap[time];
            let x = null;
            if (logical !== undefined) {
                x = timeScale.logicalToCoordinate(logical);
            } else {
                try {
                    x = timeScale.timeToCoordinate(time);
                } catch (e) { /* ignore */ }
            }
            const y = series.priceToCoordinate(price);
            if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
            return { x, y };
        };

        // 1. Structural boxes
        if (Array.isArray(data.boxes) && data.boxes.length > 0) {
            for (const box of data.boxes) {
                let rightTime = box.right_time;
                if (box.is_current && candles.length > 0) {
                    rightTime = candles[candles.length - 1].time;
                }
                const tl = toPixel(box.left_time, box.top);
                const br = toPixel(rightTime, box.bottom);
                if (!tl || !br) continue;

                const bx = Math.min(tl.x, br.x);
                const by = Math.min(tl.y, br.y);
                const bw = Math.abs(br.x - tl.x);
                const bh = Math.abs(br.y - tl.y);
                if (bw < 1 || bh < 1) continue;

                ctx.fillStyle = box.is_long ? flowTheme.longFill : flowTheme.shortFill;
                ctx.fillRect(bx, by, bw, bh);

                ctx.strokeStyle = box.is_long ? flowTheme.longBorder : flowTheme.shortBorder;
                ctx.lineWidth = 1;
                ctx.setLineDash([]);
                ctx.strokeRect(bx, by, bw, bh);

                if (box.fib_levels) {
                    const fibDefs = [
                        { key: '0.25', color: flowTheme.fib25, width: 1 },
                        { key: '0.50', color: flowTheme.fib50, width: 1.5 },
                        { key: '0.75', color: flowTheme.fib75, width: 1 },
                    ];
                    ctx.setLineDash([3, 4]);
                    for (const { key, color, width } of fibDefs) {
                        const price = box.fib_levels[key];
                        if (price === undefined) continue;
                        const ly = series.priceToCoordinate(price);
                        if (ly === null || !Number.isFinite(ly)) continue;
                        ctx.strokeStyle = color;
                        ctx.lineWidth = width;
                        ctx.beginPath();
                        ctx.moveTo(bx, ly);
                        ctx.lineTo(bx + bw, ly);
                        ctx.stroke();
                    }
                }
            }
        }

        ctx.setLineDash([]);

        const drawSegments = (segments, color, lineWidth, dash) => {
            if (!Array.isArray(segments) || segments.length === 0) return;
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.setLineDash(dash);
            for (const seg of segments) {
                const p1 = toPixel(seg.x1_time, seg.y1);
                const p2 = toPixel(seg.x2_time, seg.y2);
                if (!p1 || !p2) continue;
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.stroke();
            }
        };

        // 2. Close lines
        drawSegments(data.close_lines, flowTheme.closeLine, 1, []);
        // 3. Sweep lines
        drawSegments(data.sweep_lines, flowTheme.sweepLine, 1, [3, 3]);
        // 4. Zigzag segments
        drawSegments(data.zigzag_segments, flowTheme.zigzag, 1, [2, 3]);

        ctx.setLineDash([]);
    }

    _renderAlerts(ctx, rect) {
        if (typeof this.pane?.getAlertsForSymbol !== 'function' || !this.pane?.series) return;
        let alerts;
        try {
            alerts = this.pane.getAlertsForSymbol();
        } catch (e) {
            return;
        }
        if (!Array.isArray(alerts) || alerts.length === 0) return;

        const alertColor = this.theme.drawing.alertColor || '#f59e0b';

        for (const alert of alerts) {
            if (!alert || alert.active === false || typeof alert.price !== 'number') continue;
            const y = this.pane.series.priceToCoordinate(alert.price);
            if (y === null || y === undefined || !Number.isFinite(y)) continue;

            ctx.save();
            ctx.strokeStyle = alertColor;
            ctx.lineWidth = 1.25;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(rect.left, y);
            ctx.lineTo(rect.left + rect.width, y);
            ctx.stroke();
            ctx.restore();

            this._renderPricePill(ctx, rect, y, `🔔 ${formatPrice(alert.price)}`, alertColor);
        }
    }

    _renderPricePill(ctx, rect, y, text, bgColor) {
        ctx.save();
        ctx.font = "500 10px 'JetBrains Mono', monospace";
        const padX = 6;
        const pillH = 16;
        const textW = ctx.measureText(text).width;
        const pillW = Math.ceil(textW + padX * 2);
        const x = rect.left + rect.width - pillW - 4;
        const clampedY = Math.max(rect.top + pillH / 2 + 2, Math.min(rect.top + rect.height - pillH / 2 - 2, y));
        const topY = clampedY - pillH / 2;

        drawRoundedRectPath(ctx, x, topY, pillW, pillH, 3);
        ctx.fillStyle = bgColor;
        ctx.fill();

        ctx.fillStyle = getContrastTextColor(bgColor);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + padX, clampedY + 0.5);
        ctx.restore();
    }

    _strokePathWithSelection(ctx, tracePathFn, style, isSelected) {
        const dash = getDashPattern(style.lineStyle);

        if (isSelected) {
            ctx.save();
            ctx.strokeStyle = colorWithAlpha(this.theme.drawing.selectedColor, 0.35);
            ctx.lineWidth = style.lineWidth + 4;
            ctx.setLineDash(dash);
            tracePathFn();
            ctx.stroke();
            ctx.restore();
        }

        ctx.save();
        ctx.strokeStyle = style.color;
        ctx.lineWidth = style.lineWidth;
        ctx.setLineDash(dash);
        tracePathFn();
        ctx.stroke();
        ctx.restore();
    }

    _renderShape(ctx, drawing, isSelected, rect) {
        if (!drawing || !Array.isArray(drawing.points)) return;
        const style = this._getDrawingStyle(drawing);

        if (drawing.type === 'trend') {
            const p1 = this.dataToPixel(drawing.points[0]);
            const p2 = this.dataToPixel(drawing.points[1]);
            if (!p1 || !p2) return;
            this._strokePathWithSelection(ctx, () => {
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
            }, style, isSelected);
            return;
        }

        if (drawing.type === 'horizontal') {
            const p1 = this.dataToPixel(drawing.points[0]);
            if (!p1) return;
            this._strokePathWithSelection(ctx, () => {
                ctx.beginPath();
                ctx.moveTo(rect.left, p1.y);
                ctx.lineTo(rect.left + rect.width, p1.y);
            }, style, isSelected);
            this._renderPricePill(ctx, rect, p1.y, formatPrice(drawing.points[0].price), style.color);
            return;
        }

        if (drawing.type === 'ray') {
            const p1 = this.dataToPixel(drawing.points[0]);
            if (!p1) return;
            this._strokePathWithSelection(ctx, () => {
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(rect.left + rect.width, p1.y);
            }, style, isSelected);
            this._renderPricePill(ctx, rect, p1.y, formatPrice(drawing.points[0].price), style.color);
            return;
        }

        if (drawing.type === 'rectangle') {
            const p1 = this.dataToPixel(drawing.points[0]);
            const p2 = this.dataToPixel(drawing.points[1]);
            if (!p1 || !p2) return;
            const x = Math.min(p1.x, p2.x);
            const y = Math.min(p1.y, p2.y);
            const w = Math.abs(p1.x - p2.x);
            const h = Math.abs(p1.y - p2.y);

            ctx.save();
            ctx.fillStyle = colorWithAlpha(style.color, isSelected ? 0.12 : 0.05);
            ctx.fillRect(x, y, w, h);
            ctx.restore();

            this._strokePathWithSelection(ctx, () => {
                ctx.beginPath();
                ctx.rect(x, y, w, h);
            }, style, isSelected);
            return;
        }

        if (drawing.type === 'channel') {
            const p1 = this.dataToPixel(drawing.points[0]);
            const p2 = this.dataToPixel(drawing.points[1]);
            const p3 = this.dataToPixel(drawing.points[2]);
            if (!p1 || !p2 || !p3) return;
            const p4 = { x: p2.x + (p3.x - p1.x), y: p2.y + (p3.y - p1.y) };

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.lineTo(p4.x, p4.y);
            ctx.lineTo(p3.x, p3.y);
            ctx.closePath();
            ctx.fillStyle = colorWithAlpha(style.color, isSelected ? 0.12 : 0.05);
            ctx.fill();
            ctx.restore();

            this._strokePathWithSelection(ctx, () => {
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.moveTo(p3.x, p3.y);
                ctx.lineTo(p4.x, p4.y);
            }, style, isSelected);

            const m1 = { x: (p1.x + p3.x) / 2, y: (p1.y + p3.y) / 2 };
            const m2 = { x: (p2.x + p4.x) / 2, y: (p2.y + p4.y) / 2 };
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(m1.x, m1.y);
            ctx.lineTo(m2.x, m2.y);
            ctx.strokeStyle = colorWithAlpha(style.color, 0.65);
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.restore();
            return;
        }

        if (drawing.type === 'fib') {
            const p1 = this.dataToPixel(drawing.points[0]);
            const p2 = this.dataToPixel(drawing.points[1]);
            if (!p1 || !p2) return;
            this._renderFib(ctx, drawing.points[0], drawing.points[1], p1, p2, style, isSelected, rect);
            return;
        }

        if (drawing.type === 'long' || drawing.type === 'short') {
            const pEntry = this.dataToPixel(drawing.points[0]);
            const pSl = this.dataToPixel(drawing.points[1]);
            const pTp = this.dataToPixel(drawing.points[2]);
            if (!pEntry || !pSl || !pTp) return;
            this._renderPositionRR(
                ctx,
                drawing.type,
                drawing.points[0],
                drawing.points[1],
                drawing.points[2],
                pEntry,
                pSl,
                pTp,
                style,
                isSelected,
                rect
            );
        }
    }

    _renderFib(ctx, pt0, pt1, p0, p1, style, isSelected, rect) {
        const series = this.pane?.series;
        if (!series) return;

        const xLeft = Math.min(p0.x, p1.x);
        const xRight = Math.max(p0.x, p1.x);
        const spanW = Math.max(1, xRight - xLeft);

        // Soft shaded band between 0.382 and 0.618
        const p382 = pt1.price + (pt0.price - pt1.price) * 0.382;
        const p618 = pt1.price + (pt0.price - pt1.price) * 0.618;
        const y382 = series.priceToCoordinate(p382);
        const y618 = series.priceToCoordinate(p618);
        if (y382 !== null && y618 !== null && Number.isFinite(y382) && Number.isFinite(y618)) {
            const bandTop = Math.min(y382, y618);
            const bandH = Math.abs(y618 - y382);
            ctx.save();
            ctx.fillStyle = colorWithAlpha(style.color, isSelected ? 0.14 : 0.08);
            ctx.fillRect(xLeft, bandTop, spanW, bandH);
            ctx.restore();
        }

        // Subtle diagonal anchor line
        ctx.save();
        ctx.strokeStyle = colorWithAlpha(style.color, 0.35);
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        ctx.restore();

        // Draw each Fib level & label
        const keyLevels = new Set([0, 0.5, 0.618, 1]);
        const drawnLabelYs = [];
        ctx.save();
        ctx.font = "500 10px 'JetBrains Mono', monospace";
        ctx.textBaseline = 'middle';

        for (const lvl of FIB_LEVELS) {
            const lvlPrice = pt1.price + (pt0.price - pt1.price) * lvl;
            const y = series.priceToCoordinate(lvlPrice);
            if (y === null || !Number.isFinite(y)) continue;

            const isKey = keyLevels.has(lvl);
            const lineStyle = {
                color: isKey ? style.color : colorWithAlpha(style.color, 0.68),
                lineWidth: isKey ? style.lineWidth : Math.max(1, style.lineWidth - 0.5),
                lineStyle: style.lineStyle,
            };

            this._strokePathWithSelection(ctx, () => {
                ctx.beginPath();
                ctx.moveTo(xLeft, y);
                ctx.lineTo(xRight, y);
            }, lineStyle, isSelected && isKey);

            // Prevent overlapping text labels when zoomed tightly vertically
            const overlaps = drawnLabelYs.some(prevY => Math.abs(prevY - y) < 12);
            if (!overlaps || isKey) {
                drawnLabelYs.push(y);
                const label = `${lvl} (${formatPrice(lvlPrice)})`;
                const textW = ctx.measureText(label).width;
                const labelX = Math.max(rect.left + 4, Math.min(rect.left + rect.width - textW - 8, xLeft + 4));
                const labelY = y - 8 < rect.top + 8 ? y + 8 : y - 8;

                drawRoundedRectPath(ctx, labelX - 3, labelY - 7, textW + 6, 14, 3);
                ctx.fillStyle = this.theme.drawing.labelBg;
                ctx.fill();

                ctx.fillStyle = isKey ? style.color : colorWithAlpha(style.color, 0.85);
                ctx.fillText(label, labelX, labelY);
            }
        }
        ctx.restore();
    }

    _renderPositionRR(ctx, type, entryPt, slPt, tpPt, pEntry, pSl, pTp, style, isSelected, rect) {
        const xLeft = Math.min(pEntry.x, pSl.x, pTp.x);
        const xRight = Math.max(pEntry.x, pSl.x, pTp.x, xLeft + 60);
        const width = xRight - xLeft;

        const isLong = type === 'long';
        const E = entryPt.price;
        const S = slPt.price;
        const T = tpPt.price;

        // Profit zone (entry..tp)
        const tpTop = Math.min(pEntry.y, pTp.y);
        const tpH = Math.abs(pTp.y - pEntry.y);
        ctx.save();
        ctx.fillStyle = isSelected ? 'rgba(34, 197, 94, 0.22)' : 'rgba(34, 197, 94, 0.14)';
        ctx.fillRect(xLeft, tpTop, width, tpH);
        ctx.strokeStyle = isSelected ? '#4ade80' : 'rgba(34, 197, 94, 0.78)';
        ctx.lineWidth = style.lineWidth;
        ctx.setLineDash(getDashPattern(style.lineStyle));
        ctx.strokeRect(xLeft, tpTop, width, tpH);
        ctx.restore();

        // Loss zone (entry..sl)
        const slTop = Math.min(pEntry.y, pSl.y);
        const slH = Math.abs(pSl.y - pEntry.y);
        ctx.save();
        ctx.fillStyle = isSelected ? 'rgba(239, 68, 68, 0.22)' : 'rgba(239, 68, 68, 0.14)';
        ctx.fillRect(xLeft, slTop, width, slH);
        ctx.strokeStyle = isSelected ? '#f87171' : 'rgba(239, 68, 68, 0.78)';
        ctx.lineWidth = style.lineWidth;
        ctx.setLineDash(getDashPattern(style.lineStyle));
        ctx.strokeRect(xLeft, slTop, width, slH);
        ctx.restore();

        // Center Entry line
        this._strokePathWithSelection(ctx, () => {
            ctx.beginPath();
            ctx.moveTo(xLeft, pEntry.y);
            ctx.lineTo(xRight, pEntry.y);
        }, style, isSelected);

        // Metrics
        const tpPnlPct = E !== 0 ? ((isLong ? (T - E) : (E - T)) / E) * 100 : 0;
        const slPnlPct = E !== 0 ? ((isLong ? (S - E) : (E - S)) / E) * 100 : 0;
        const rawReward = isLong ? (T - E) : (E - T);
        const rawRisk = isLong ? (E - S) : (S - E);
        let rrText = '—';
        if (rawRisk > 0 && rawReward >= 0) {
            rrText = (rawReward / rawRisk).toFixed(2);
        } else if (Math.abs(E - S) > 0) {
            rrText = (Math.abs(T - E) / Math.abs(E - S)).toFixed(2);
        }

        const formatSignedPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

        const drawBadge = (text, targetY, bgColor, textColor) => {
            ctx.save();
            ctx.font = "600 10px 'JetBrains Mono', monospace";
            const textW = ctx.measureText(text).width;
            const padX = 6;
            const pillW = textW + padX * 2;
            const pillH = 16;
            const bx = Math.max(rect.left + 4, Math.min(rect.left + rect.width - pillW - 4, xLeft + (width - pillW) / 2));
            const by = Math.max(rect.top + 2, Math.min(rect.top + rect.height - pillH - 2, targetY - pillH / 2));
            drawRoundedRectPath(ctx, bx, by, pillW, pillH, 3);
            ctx.fillStyle = bgColor;
            ctx.fill();
            ctx.fillStyle = textColor;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, bx + padX, by + pillH / 2 + 0.5);
            ctx.restore();
        };

        const tpLabel = `TP: ${formatPrice(T)} (${formatSignedPct(tpPnlPct)})`;
        const slLabel = `SL: ${formatPrice(S)} (${formatSignedPct(slPnlPct)})`;
        const entryLabel = `${isLong ? 'LONG' : 'SHORT'} ${formatPrice(E)} · R:R ${rrText}`;

        const tpLabelY = pTp.y < pEntry.y ? pTp.y - 11 : pTp.y + 11;
        const slLabelY = pSl.y > pEntry.y ? pSl.y + 11 : pSl.y - 11;

        drawBadge(tpLabel, tpLabelY, 'rgba(22, 163, 74, 0.90)', '#ffffff');
        drawBadge(slLabel, slLabelY, 'rgba(220, 38, 38, 0.90)', '#ffffff');
        drawBadge(entryLabel, pEntry.y, this.theme.drawing.labelBg, this.theme.drawing.labelText);
    }

    _renderPreview(ctx, rect) {
        const mouse = this.lastMousePos;
        if (!mouse) return;

        const previewColor = this.theme.drawing.previewColor;
        const mouseData = this.pixelToData(mouse.x, mouse.y, false);

        if (this.activeTool === 'horizontal') {
            ctx.save();
            ctx.strokeStyle = previewColor;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(rect.left, mouse.y);
            ctx.lineTo(rect.left + rect.width, mouse.y);
            ctx.stroke();
            ctx.restore();
            return;
        }

        if (this.activeTool === 'ray') {
            ctx.save();
            ctx.strokeStyle = previewColor;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(mouse.x, mouse.y);
            ctx.lineTo(rect.left + rect.width, mouse.y);
            ctx.stroke();
            ctx.restore();
            return;
        }

        if (this.drawingPoints.length === 0) return;
        const p1 = this.dataToPixel(this.drawingPoints[0]);
        if (!p1) return;

        ctx.save();
        ctx.strokeStyle = previewColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);

        if (this.activeTool === 'trend') {
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(mouse.x, mouse.y);
            ctx.stroke();
        } else if (this.activeTool === 'rectangle') {
            ctx.beginPath();
            ctx.rect(p1.x, p1.y, mouse.x - p1.x, mouse.y - p1.y);
            ctx.stroke();
            ctx.fillStyle = 'rgba(228, 228, 231, 0.04)';
            ctx.fill();
        } else if (this.activeTool === 'channel') {
            if (this.drawingPoints.length === 1) {
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(mouse.x, mouse.y);
                ctx.stroke();
            } else if (this.drawingPoints.length === 2) {
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
                    ctx.fillStyle = 'rgba(228, 228, 231, 0.04)';
                    ctx.fill();
                }
            }
        } else if (this.activeTool === 'fib' && mouseData) {
            ctx.restore();
            this._renderFib(ctx, this.drawingPoints[0], mouseData, p1, mouse, this._createDefaultStyle(), false, rect);
            return;
        } else if ((this.activeTool === 'long' || this.activeTool === 'short') && mouseData) {
            ctx.restore();
            const isLong = this.activeTool === 'long';
            const style = this._createDefaultStyle();
            if (this.drawingPoints.length === 1) {
                // Preview entry + live SL zone
                const xLeft = Math.min(p1.x, mouse.x);
                const xRight = Math.max(p1.x, mouse.x, xLeft + 80);
                const slTop = Math.min(p1.y, mouse.y);
                const slH = Math.abs(mouse.y - p1.y);
                ctx.save();
                ctx.fillStyle = 'rgba(239, 68, 68, 0.14)';
                ctx.fillRect(xLeft, slTop, xRight - xLeft, slH);
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.78)';
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 3]);
                ctx.strokeRect(xLeft, slTop, xRight - xLeft, slH);
                ctx.strokeStyle = style.color;
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.moveTo(xLeft, p1.y);
                ctx.lineTo(xRight, p1.y);
                ctx.stroke();
                ctx.restore();
            } else if (this.drawingPoints.length === 2) {
                const pSl = this.dataToPixel(this.drawingPoints[1]);
                if (pSl) {
                    this._renderPositionRR(
                        ctx,
                        this.activeTool,
                        this.drawingPoints[0],
                        this.drawingPoints[1],
                        mouseData,
                        p1,
                        pSl,
                        mouse,
                        style,
                        false,
                        rect
                    );
                }
            }
            return;
        }

        ctx.restore();
    }

    _estimateBarIntervalSeconds() {
        const candles = this.getActiveCandles();
        if (candles.length >= 2) {
            const deltas = [];
            const start = Math.max(1, candles.length - 20);
            for (let i = start; i < candles.length; i++) {
                const diff = candles[i].time - candles[i - 1].time;
                if (diff > 0) deltas.push(diff);
            }
            if (deltas.length > 0) {
                deltas.sort((a, b) => a - b);
                return deltas[Math.floor(deltas.length / 2)];
            }
        }
        const tf = this.pane?.state?.timeframe;
        return TIMEFRAME_SECONDS[tf] || 60;
    }

    _renderMeasure(ctx, rect) {
        const { start, end } = this.measureState || {};
        if (!start || !end) return;
        const p1 = this.dataToPixel(start);
        const p2 = this.dataToPixel(end);
        if (!p1 || !p2) return;

        const x = Math.min(p1.x, p2.x);
        const y = Math.min(p1.y, p2.y);
        const w = Math.abs(p2.x - p1.x);
        const h = Math.abs(p2.y - p1.y);

        ctx.save();

        // Translucent blue box
        ctx.fillStyle = this.theme.drawing.measureBg;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = this.theme.drawing.measureBorder;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.strokeRect(x, y, w, h);

        // Diagonal line
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = '#60a5fa';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Center horizontal & vertical axis guides
        if (w > 12) {
            ctx.beginPath();
            ctx.moveTo(x, y + h / 2);
            ctx.lineTo(x + w, y + h / 2);
            ctx.strokeStyle = 'rgba(96, 165, 250, 0.45)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        if (h > 12) {
            ctx.beginPath();
            ctx.moveTo(x + w / 2, y);
            ctx.lineTo(x + w / 2, y + h);
            ctx.strokeStyle = 'rgba(96, 165, 250, 0.45)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Endpoint dots
        [p1, p2].forEach(pt => {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = '#3b82f6';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
        });

        // Metrics computation
        const deltaPrice = end.price - start.price;
        const pct = start.price !== 0 ? (deltaPrice / start.price) * 100 : 0;
        const sign = deltaPrice >= 0 ? '+' : '';

        const l1 = this.anchorToLogical(start);
        const l2 = this.anchorToLogical(end);
        const barCount = (l1 !== null && l2 !== null) ? Math.abs(l2 - l1) : 0;

        const barSec = this._estimateBarIntervalSeconds();
        let durationSec = barCount * barSec;
        if (start.time !== undefined && end.time !== undefined) {
            const t1 = start.time + (start.barOffset || 0) * barSec;
            const t2 = end.time + (end.barOffset || 0) * barSec;
            durationSec = Math.abs(t2 - t1);
        }

        const line1 = `Δ ${sign}${formatPrice(deltaPrice)} (${sign}${pct.toFixed(2)}%)`;
        const line2 = `${barCount} bar · ${formatDuration(durationSec)}`;

        ctx.font = "500 11px 'JetBrains Mono', monospace";
        const boxW = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 18;
        const boxH = 40;
        const cardX = Math.max(rect.left + 6, Math.min(rect.left + rect.width - boxW - 6, x + w / 2 - boxW / 2));
        const preferAbove = p2.y <= p1.y;
        let cardY = preferAbove ? y - boxH - 8 : y + h + 8;
        if (cardY < rect.top + 6) cardY = y + h + 8;
        if (cardY + boxH > rect.top + rect.height - 6) cardY = Math.max(rect.top + 6, y - boxH - 8);

        drawRoundedRectPath(ctx, cardX, cardY, boxW, boxH, 5);
        ctx.fillStyle = this.theme.drawing.measureTextBg;
        ctx.fill();
        ctx.strokeStyle = this.theme.drawing.measureBorder;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = deltaPrice >= 0 ? '#4ade80' : '#f87171';
        ctx.fillText(line1, cardX + boxW / 2, cardY + 13);

        ctx.fillStyle = this.theme.drawing.measureText;
        ctx.font = "400 10px 'JetBrains Mono', monospace";
        ctx.fillText(line2, cardX + boxW / 2, cardY + 28);

        ctx.restore();
    }

    _renderMagnetSnap(ctx, snap) {
        if (!snap) return;
        ctx.save();
        // Outer glow ring
        ctx.beginPath();
        ctx.arc(snap.x, snap.y, 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(59, 130, 246, 0.25)';
        ctx.fill();

        // Crisp inner snap ring
        ctx.beginPath();
        ctx.arc(snap.x, snap.y, 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1.75;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(snap.x, snap.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.restore();
    }

    _renderHandles(ctx, drawing, rect) {
        const points = this.getHandlePoints(drawing, rect);
        const locked = Boolean(drawing.locked);

        ctx.save();
        for (const pt of points) {
            if (!pt) continue;
            if (
                pt.x < rect.left - 6 || pt.x > rect.left + rect.width + 6
                || pt.y < rect.top - 6 || pt.y > rect.top + rect.height + 6
            ) {
                continue;
            }

            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 5, 0, 2 * Math.PI);
            if (locked) {
                // Hollow lock ring
                ctx.fillStyle = 'rgba(11, 11, 12, 0.75)';
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.strokeStyle = this.theme.drawing.lockStroke;
                ctx.stroke();
            } else {
                ctx.fillStyle = this.theme.drawing.handleFill;
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = this.theme.drawing.handleStroke;
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    // ==========================================
    // MOUSE INTERACTION HANDLERS
    // ==========================================

    _getMousePos(e) {
        const rect = this.pane.chartContainer.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        };
    }

    _onMouseDown(e) {
        if (typeof this.pane?.onFocus === 'function') {
            this.pane.onFocus();
        }
        if (e.button !== 0) return;

        // Do not intercept clicks on the floating style toolbar
        if (this.styleToolbar && this.styleToolbar.contains(e.target)) {
            return;
        }

        const mousePixel = this._getMousePos(e);
        const plotRect = this.getPlotAreaRect();
        if (!this._isInPlotArea(mousePixel.x, mousePixel.y, plotRect)) {
            return;
        }

        const useMagnet = this.isMagnetActive(e);

        // Shift + Mousedown in select mode launches temporary Measure ruler
        if (this.activeTool === 'select' && e.shiftKey) {
            const dataPt = this.pixelToData(mousePixel.x, mousePixel.y, useMagnet);
            if (!dataPt) return;
            e.stopPropagation();
            e.preventDefault();
            this.measureState = {
                start: dataPt,
                end: dataPt,
                frozen: false,
                viaShift: true,
                startPixel: mousePixel,
            };
            this.redraw();
            return;
        }

        // Dismiss frozen ruler when clicking normally in select mode
        if (this.activeTool === 'select' && this.measureState?.frozen) {
            this.measureState = null;
            this.redraw();
        }

        // Measure tool mode
        if (this.activeTool === 'measure') {
            e.stopPropagation();
            e.preventDefault();
            if (this.measureState && this.measureState.frozen) {
                this.measureState = null;
                this.snapPixel = null;
                this.redraw();
                return;
            }
            const dataPt = this.pixelToData(mousePixel.x, mousePixel.y, useMagnet);
            if (!dataPt) return;
            if (!this.measureState) {
                this.measureState = {
                    start: dataPt,
                    end: dataPt,
                    frozen: false,
                    viaShift: false,
                    startPixel: mousePixel,
                };
            } else {
                this.measureState.end = dataPt;
                this.measureState.frozen = true;
                this.snapPixel = null;
            }
            this.redraw();
            return;
        }

        const dataPt = this.pixelToData(mousePixel.x, mousePixel.y, useMagnet);
        if (!dataPt) return;

        // Active drawing tool placement
        if (this.activeTool !== 'select') {
            e.stopPropagation();
            e.preventDefault();

            this.drawingPoints.push(dataPt);

            if (this.activeTool === 'horizontal' || this.activeTool === 'ray') {
                this._commitNewDrawing(this.activeTool, [this.drawingPoints[0]]);
                return;
            }
            if (
                (this.activeTool === 'trend' || this.activeTool === 'rectangle' || this.activeTool === 'fib')
                && this.drawingPoints.length === 2
            ) {
                this._commitNewDrawing(this.activeTool, [...this.drawingPoints]);
                return;
            }
            if (this.activeTool === 'channel' && this.drawingPoints.length === 3) {
                this._commitNewDrawing('channel', [...this.drawingPoints]);
                return;
            }
            if ((this.activeTool === 'long' || this.activeTool === 'short') && this.drawingPoints.length === 3) {
                const pts = [...this.drawingPoints];
                const l0 = this.anchorToLogical(pts[0]);
                const l1 = this.anchorToLogical(pts[1]);
                const l2 = this.anchorToLogical(pts[2]);
                if (l0 !== null && l1 !== null && l2 !== null) {
                    const span = Math.max(l0, l1, l2) - Math.min(l0, l1, l2);
                    if (span < 3) {
                        pts[2] = this.logicalToAnchor(l0 + 15, pts[2].price);
                    }
                }
                this._commitNewDrawing(this.activeTool, pts);
                return;
            }

            this.redraw();
            return;
        }

        // Select mode: check handles on currently selected drawing first
        if (this.selectedDrawing) {
            const handlePoints = this.getHandlePoints(this.selectedDrawing, plotRect);
            let clickedHandleIdx = -1;
            for (let i = 0; i < handlePoints.length; i++) {
                const hp = handlePoints[i];
                if (!hp) continue;
                if (Math.hypot(mousePixel.x - hp.x, mousePixel.y - hp.y) < HANDLE_HIT_RADIUS_PX) {
                    clickedHandleIdx = i;
                    break;
                }
            }

            if (clickedHandleIdx >= 0) {
                e.stopPropagation();
                e.preventDefault();
                if (this.selectedDrawing.locked) {
                    return;
                }
                this.draggedDrawing = this.selectedDrawing;
                this.draggedHandleIndex = clickedHandleIdx;
                this.dragStartLogical = this.anchorToLogical(dataPt);
                this.dragStartPrice = dataPt.price;
                this.dragOriginalPoints = this.selectedDrawing.points.map(pt => ({ ...pt }));
                this._preDragSnapshot = this._cloneDrawings(this.drawings);
                this._didDragMove = false;
                return;
            }
        }

        // Check drawing bodies top-to-bottom
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
            this.updateStyleToolbar();

            if (!clickedDrawing.locked) {
                this.draggedDrawing = clickedDrawing;
                this.draggedHandleIndex = -1;
                this.dragStartLogical = this.anchorToLogical(dataPt);
                this.dragStartPrice = dataPt.price;
                this.dragOriginalPoints = clickedDrawing.points.map(pt => ({ ...pt }));
                this._preDragSnapshot = this._cloneDrawings(this.drawings);
                this._didDragMove = false;
            }
            this.redraw();
            return;
        }

        if (this.selectedDrawing) {
            this.selectedDrawing = null;
            this.updateStyleToolbar();
            this.redraw();
        }
    }

    _commitNewDrawing(type, points) {
        this.pushHistory();
        const drawing = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type,
            points,
            style: this._createDefaultStyle(),
            locked: false,
        };
        this.drawings.push(drawing);
        this.snapPixel = null;
        this.persist();
        this.setActiveTool('select');
    }

    _onMouseMove(e) {
        if (this.styleToolbar && this.styleToolbar.contains(e.target) && !this.draggedDrawing) {
            return;
        }

        const mousePixel = this._getMousePos(e);
        this.lastMousePos = mousePixel;

        const useMagnet = this.isMagnetActive(e);
        const shouldSnap = useMagnet && (this.activeTool !== 'select' || this.draggedDrawing !== null || (this.measureState && !this.measureState.frozen));
        const dataPt = this.pixelToData(mousePixel.x, mousePixel.y, shouldSnap);
        if (!dataPt) return;

        // Active temporary measure ruler update
        if (this.measureState && !this.measureState.frozen) {
            e.stopPropagation();
            e.preventDefault();
            this.measureState.end = dataPt;
            this.redraw();
            return;
        }

        // Active dragging of a handle or drawing body
        if (this.draggedDrawing) {
            e.stopPropagation();
            e.preventDefault();

            const currLogical = this.anchorToLogical(dataPt);
            const deltaLogical = currLogical - this.dragStartLogical;
            const deltaPrice = dataPt.price - this.dragStartPrice;

            if (deltaLogical !== 0 || deltaPrice !== 0) {
                this._didDragMove = true;
            }

            if (this.draggedHandleIndex >= 0) {
                if (this.draggedDrawing.type === 'horizontal') {
                    this.draggedDrawing.points[0] = {
                        ...this.dragOriginalPoints[0],
                        price: dataPt.price,
                    };
                } else if (this.draggedDrawing.type === 'channel' && this.draggedHandleIndex === 3) {
                    const l1 = this.anchorToLogical(this.draggedDrawing.points[0]);
                    const l2 = this.anchorToLogical(this.draggedDrawing.points[1]);
                    if (l1 !== null && l2 !== null) {
                        const newL3 = currLogical - l2 + l1;
                        const newP3 = dataPt.price - this.draggedDrawing.points[1].price + this.draggedDrawing.points[0].price;
                        this.draggedDrawing.points[2] = this.logicalToAnchor(newL3, newP3);
                    }
                } else {
                    this.draggedDrawing.points[this.draggedHandleIndex] = { ...dataPt };
                }
            } else {
                this.draggedDrawing.points = this.dragOriginalPoints.map(orig =>
                    this.moveAnchorByDelta(orig, deltaLogical, deltaPrice)
                );
            }

            this.redraw();
            return;
        }

        // Active drawing tool preview
        if (this.activeTool !== 'select') {
            e.stopPropagation();
            e.preventDefault();
            this.redraw();
            return;
        }

        // Hover cursor feedback in select mode
        const container = this.pane.chartContainer;
        const plotRect = this.getPlotAreaRect();
        if (!this._isInPlotArea(mousePixel.x, mousePixel.y, plotRect)) {
            container.style.cursor = 'default';
            return;
        }

        let cursorStyle = 'default';
        if (this.selectedDrawing) {
            const handlePoints = this.getHandlePoints(this.selectedDrawing, plotRect);
            for (const hp of handlePoints) {
                if (hp && Math.hypot(mousePixel.x - hp.x, mousePixel.y - hp.y) < HANDLE_HIT_RADIUS_PX) {
                    cursorStyle = this.selectedDrawing.locked ? 'not-allowed' : 'pointer';
                    break;
                }
            }
        }

        if (cursorStyle === 'default') {
            for (let i = this.drawings.length - 1; i >= 0; i--) {
                if (this.isPointNearDrawing(mousePixel, this.drawings[i])) {
                    cursorStyle = this.drawings[i].locked ? 'pointer' : 'move';
                    break;
                }
            }
        }

        container.style.cursor = cursorStyle;
    }

    _onMouseUp(e) {
        if (this.measureState && !this.measureState.frozen && this.measureState.startPixel) {
            const container = this.pane?.chartContainer;
            if (container) {
                const mousePixel = this._getMousePos(e);
                const movedDist = Math.hypot(
                    mousePixel.x - this.measureState.startPixel.x,
                    mousePixel.y - this.measureState.startPixel.y
                );
                if (movedDist > 8) {
                    const dataPt = this.pixelToData(mousePixel.x, mousePixel.y, this.isMagnetActive(e));
                    if (dataPt) {
                        this.measureState.end = dataPt;
                    }
                    this.measureState.frozen = true;
                    this.snapPixel = null;
                    this.redraw();
                }
            }
        }

        if (this.draggedDrawing) {
            e.stopPropagation();
            e.preventDefault();

            if (this._didDragMove && this._preDragSnapshot) {
                this.pushHistory(this._preDragSnapshot);
                this.persist();
            }

            this.draggedDrawing = null;
            this.draggedHandleIndex = -1;
            this.dragStartLogical = null;
            this.dragStartPrice = null;
            this.dragOriginalPoints = [];
            this._preDragSnapshot = null;
            this._didDragMove = false;
            this.snapPixel = null;
            this.redraw();
        }
    }

    _onMouseLeave() {
        this.lastMousePos = null;
        this.snapPixel = null;
        if (
            this.drawingPoints.length > 0
            || this.activeTool === 'horizontal'
            || this.activeTool === 'ray'
        ) {
            this.redraw();
        }
    }
}

export default DrawingEngine;
