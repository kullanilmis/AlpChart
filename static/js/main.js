import {
    fetchState,
    saveState,
    saveDrawings,
    exportBackup,
    importBackup,
} from './modules/api.js';
import { getTheme, applyDocumentTheme } from './modules/themes.js';
import { syncManager } from './modules/syncManager.js';
import { alertManager, showToast } from './modules/alertManager.js';
import { WatchlistPanel } from './modules/watchlistPanel.js';
import { ChartPane } from './modules/chartPane.js';

const LEGACY_LAYOUT_KEY = 'atlas_dashboard_layout_v1';
const LEGACY_DRAWINGS_KEY = 'atlas_drawings_v1';
const VALID_LAYOUTS = new Set([1, 2, 4, 6, 8]);

const activePanes = {};
const cachedPaneConfigs = new Map();

let currentLayoutCount = 4;
let currentThemeName = 'monochrome';
let currentTimezone = 'Europe/Istanbul';
let watchlistOpen = true;
let activePaneId = 1;
let maximizedPaneId = null;
let watchlistPanel = null;
let saveStateTimer = null;
let quickAlertContext = { source: 'hyperliquid', symbol: 'BTC' };

function getDefaultPaneState(paneIndex) {
    if (paneIndex % 2 === 0) {
        return {
            source: 'yfinance',
            symbol: 'THYAO.IS',
            timeframe: '1d',
            indicators: { ema9: false, ema21: false, rsi: false, flow: false },
        };
    }
    return {
        source: 'hyperliquid',
        symbol: 'BTC',
        timeframe: '1m',
        indicators: { ema9: false, ema21: false, rsi: false, flow: false },
    };
}

function getActivePane() {
    if (activePanes[activePaneId]) {
        return activePanes[activePaneId];
    }
    const firstKey = Object.keys(activePanes)[0];
    return firstKey ? activePanes[firstKey] : null;
}

function setFocusedPane(pane) {
    if (!pane) return;
    if (activePaneId === pane.id && pane.paneEl?.classList.contains('active-pane')) {
        return;
    }
    activePaneId = pane.id;
    Object.values(activePanes).forEach((p) => {
        p.setFocused(p.id === pane.id);
    });
}

function resizeAllPanes() {
    Object.values(activePanes).forEach((pane) => {
        pane.resize();
    });
}

function collectDashboardStatePayload() {
    const panes = [];
    for (let i = 1; i <= currentLayoutCount; i++) {
        const pane = activePanes[i];
        if (pane) {
            const cfg = {
                id: pane.id,
                source: pane.state.source,
                symbol: pane.state.symbol,
                timeframe: pane.state.timeframe,
                indicators: {
                    ema9: Boolean(pane.state.indicators?.ema9),
                    ema21: Boolean(pane.state.indicators?.ema21),
                    rsi: Boolean(pane.state.indicators?.rsi),
                    flow: Boolean(pane.state.indicators?.flow),
                },
                scaleMode: pane.state.scaleMode || 'normal',
                autoScale: pane.state.autoScale !== undefined ? Boolean(pane.state.autoScale) : true,
            };
            cachedPaneConfigs.set(i, cfg);
            panes.push(cfg);
        } else if (cachedPaneConfigs.has(i)) {
            panes.push(cachedPaneConfigs.get(i));
        }
    }

    return {
        layout: currentLayoutCount,
        theme: currentThemeName,
        timezone: currentTimezone,
        sync: syncManager.getConfig(),
        watchlistOpen,
        panes,
    };
}

function scheduleSaveState(delay = 250) {
    clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => {
        saveStateTimer = null;
        const payload = collectDashboardStatePayload();
        saveState(payload).catch((err) => {
            console.error('Error saving dashboard state:', err);
        });
    }, delay);
}

async function migrateFromLegacyLocalStorage(state) {
    if (state?.migratedFromLocalStorage) {
        return state;
    }

    const patch = { migratedFromLocalStorage: true };
    let legacyLayout = null;
    let legacyDrawings = null;

    try {
        const rawLayout = localStorage.getItem(LEGACY_LAYOUT_KEY);
        if (rawLayout) {
            legacyLayout = JSON.parse(rawLayout);
        }
    } catch (err) {
        console.warn('Could not parse legacy localStorage layout:', err);
    }

    try {
        const rawDrawings = localStorage.getItem(LEGACY_DRAWINGS_KEY);
        if (rawDrawings) {
            legacyDrawings = JSON.parse(rawDrawings);
        }
    } catch (err) {
        console.warn('Could not parse legacy localStorage drawings:', err);
    }

    if (legacyLayout && typeof legacyLayout === 'object' && (!state.panes || state.panes.length === 0)) {
        const parsedCount = parseInt(legacyLayout.layout, 10);
        if (VALID_LAYOUTS.has(parsedCount)) {
            patch.layout = parsedCount;
        }
        if (Array.isArray(legacyLayout.panes) && legacyLayout.panes.length > 0) {
            patch.panes = legacyLayout.panes;
        }
    }

    if (legacyDrawings && typeof legacyDrawings === 'object') {
        for (const [symbolKey, list] of Object.entries(legacyDrawings)) {
            if (!symbolKey || !Array.isArray(list) || list.length === 0) continue;
            try {
                await saveDrawings(symbolKey, list);
            } catch (err) {
                console.error(`Failed migrating legacy drawings for ${symbolKey}:`, err);
            }
        }
    }

    try {
        return await saveState(patch);
    } catch (err) {
        console.error('Failed persisting localStorage migration flag:', err);
        return { ...state, ...patch };
    }
}

function toggleMaximizePane(pane) {
    const gridContainer = document.getElementById('chart-grid-container');
    if (!pane) return;

    if (maximizedPaneId === pane.id) {
        pane.setMaximized(false);
        maximizedPaneId = null;
        gridContainer?.classList.remove('has-maximized');
    } else {
        if (maximizedPaneId !== null && activePanes[maximizedPaneId]) {
            activePanes[maximizedPaneId].setMaximized(false);
        }
        maximizedPaneId = pane.id;
        pane.setMaximized(true);
        gridContainer?.classList.add('has-maximized');
        setFocusedPane(pane);
    }

    resizeAllPanes();
}

function exitMaximizeIfActive() {
    if (maximizedPaneId === null) return false;
    const pane = activePanes[maximizedPaneId];
    if (pane) {
        toggleMaximizePane(pane);
    } else {
        maximizedPaneId = null;
        document.getElementById('chart-grid-container')?.classList.remove('has-maximized');
    }
    return true;
}

function destroyAllPanes() {
    exitMaximizeIfActive();
    for (const id of Object.keys(activePanes)) {
        try {
            activePanes[id]?.destroy();
        } catch (err) {
            console.error(`Error destroying pane ${id}:`, err);
        }
        delete activePanes[id];
    }
    cachedPaneConfigs.clear();
}

function applyLayout(count, initialPanes = null, shouldPersist = true) {
    const gridContainer = document.getElementById('chart-grid-container');
    if (!gridContainer) return;

    const targetCount = VALID_LAYOUTS.has(Number(count)) ? Number(count) : 4;
    if (maximizedPaneId !== null) {
        exitMaximizeIfActive();
    }

    currentLayoutCount = targetCount;

    if (Array.isArray(initialPanes)) {
        for (const p of initialPanes) {
            if (p && p.id != null) {
                cachedPaneConfigs.set(Number(p.id), p);
            }
        }
    }

    document.querySelectorAll('.btn-layout').forEach((btn) => {
        const btnCount = parseInt(btn.getAttribute('data-panes'), 10);
        btn.classList.toggle('active', btnCount === targetCount);
    });

    gridContainer.className = `chart-grid grid-${targetCount}`;

    // Destroy excess panes
    for (const idKey of Object.keys(activePanes)) {
        const paneId = parseInt(idKey, 10);
        if (paneId > targetCount && activePanes[paneId]) {
            const p = activePanes[paneId];
            cachedPaneConfigs.set(paneId, {
                id: p.id,
                source: p.state.source,
                symbol: p.state.symbol,
                timeframe: p.state.timeframe,
                indicators: { ...p.state.indicators },
                scaleMode: p.state.scaleMode,
                autoScale: p.state.autoScale,
            });
            try {
                p.destroy();
            } catch (err) {
                console.error(`Error destroying pane ${paneId}:`, err);
            }
            delete activePanes[paneId];
        }
    }

    // Remove stray pane DOM nodes > targetCount
    gridContainer.querySelectorAll('.chart-pane').forEach((el) => {
        const match = el.id.match(/pane-(\d+)/);
        if (match && parseInt(match[1], 10) > targetCount) {
            el.parentNode?.removeChild(el);
        }
    });

    const themeObj = getTheme(currentThemeName);

    // Create missing panes
    for (let i = 1; i <= targetCount; i++) {
        if (!activePanes[i]) {
            const paneConfig = cachedPaneConfigs.get(i) || getDefaultPaneState(i);
            try {
                activePanes[i] = new ChartPane(i, gridContainer, paneConfig, {
                    theme: themeObj,
                    timezone: currentTimezone,
                    isFocused: () => activePaneId === i,
                    onFocus: (pane) => setFocusedPane(pane),
                    onStateChange: () => scheduleSaveState(),
                    onMaximizeToggle: (pane) => toggleMaximizePane(pane),
                    onOpenQuickAlert: (source, symbol, currentPrice) => {
                        openQuickAlertModal(source, symbol, currentPrice);
                    },
                });
            } catch (err) {
                console.error(`Error initializing chart pane ${i}:`, err);
            }
        }
    }

    if (!activePanes[activePaneId]) {
        const fallbackPane = activePanes[1] || Object.values(activePanes)[0];
        if (fallbackPane) {
            setFocusedPane(fallbackPane);
        }
    } else {
        setFocusedPane(activePanes[activePaneId]);
    }

    if (shouldPersist) {
        scheduleSaveState();
    }
}

function updateThemeUI(themeName) {
    currentThemeName = themeName === 'classic' ? 'classic' : 'monochrome';
    const themeObj = applyDocumentTheme(currentThemeName);

    const btn = document.getElementById('btn-theme-toggle');
    if (btn) {
        const labelEl = btn.querySelector('.btn-label');
        if (labelEl) {
            labelEl.textContent = themeObj.label;
        } else {
            btn.textContent = themeObj.label;
        }
        btn.dataset.theme = currentThemeName;
        btn.classList.toggle('active', currentThemeName === 'classic');
        btn.title = `Tema: ${themeObj.label}`;
    }
    return themeObj;
}

function updateTimezoneUI(tz) {
    currentTimezone = tz === 'UTC' ? 'UTC' : 'Europe/Istanbul';
    const label = currentTimezone === 'UTC' ? 'UTC' : 'UTC+3';
    const btn = document.getElementById('btn-timezone-toggle');
    if (btn) {
        const labelEl = btn.querySelector('.btn-label');
        if (labelEl) {
            labelEl.textContent = label;
        } else {
            btn.textContent = label;
        }
        btn.dataset.timezone = currentTimezone;
        btn.title = `Saat Dilimi: ${currentTimezone}`;
    }
}

function updateSyncUI(cfg) {
    const mapping = [
        ['sync-crosshair', cfg.crosshair],
        ['sync-time', cfg.time],
        ['sync-symbol', cfg.symbol],
    ];
    for (const [id, enabled] of mapping) {
        const btn = document.getElementById(id);
        if (btn) {
            btn.classList.toggle('active', Boolean(enabled));
            btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        }
    }
}

function updateWatchlistVisibilityUI(open) {
    watchlistOpen = Boolean(open);
    const sidebar = document.getElementById('watchlist-sidebar');
    const btn = document.getElementById('btn-watchlist-toggle');
    if (watchlistPanel && typeof watchlistPanel.setOpen === 'function') {
        watchlistPanel.setOpen(watchlistOpen);
    } else if (sidebar) {
        sidebar.classList.toggle('collapsed', !watchlistOpen);
        sidebar.setAttribute('aria-hidden', String(!watchlistOpen));
    }
    if (btn) {
        btn.classList.toggle('active', watchlistOpen);
        btn.setAttribute('aria-pressed', watchlistOpen ? 'true' : 'false');
    }
}

function setModalOpen(modal, open) {
    if (!modal) return;
    modal.classList.toggle('open', Boolean(open));
    modal.classList.toggle('hidden', !open);
}

function isModalOpen(modal) {
    return Boolean(modal && modal.classList.contains('open') && !modal.classList.contains('hidden'));
}

function setFieldValue(el, value) {
    if (!el) return;
    if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) {
        el.value = value;
    } else {
        el.textContent = value;
    }
}

function getFieldValue(el, fallback = '') {
    if (!el) return fallback;
    if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) {
        return el.value;
    }
    return el.textContent || fallback;
}

function openQuickAlertModal(source, symbol, currentPrice) {
    const modal = document.getElementById('quick-alert-modal');
    if (!modal) return;

    const normSource = String(source || 'hyperliquid').trim().toLowerCase();
    const normSymbol = String(symbol || '').trim().toUpperCase();
    quickAlertContext = { source: normSource, symbol: normSymbol };

    const labelEl = document.getElementById('qa-symbol-label');
    if (labelEl) {
        labelEl.textContent = `${normSymbol} (${normSource})`;
    }
    setFieldValue(document.getElementById('qa-source'), normSource);
    setFieldValue(document.getElementById('qa-symbol'), normSymbol);

    const priceEl = document.getElementById('qa-price');
    if (priceEl) {
        priceEl.value = typeof currentPrice === 'number' && Number.isFinite(currentPrice)
            ? String(currentPrice)
            : '';
    }

    const condEl = document.getElementById('qa-condition');
    if (condEl) {
        condEl.value = 'cross_above';
    }

    const msgEl = document.getElementById('qa-message');
    if (msgEl) {
        msgEl.value = '';
    }

    setModalOpen(modal, true);
    priceEl?.focus();
    priceEl?.select?.();
}

function closeQuickAlertModal() {
    setModalOpen(document.getElementById('quick-alert-modal'), false);
}

function closeAllModals() {
    let closed = false;
    const shortcutsModal = document.getElementById('shortcuts-modal');
    if (isModalOpen(shortcutsModal)) {
        setModalOpen(shortcutsModal, false);
        closed = true;
    }
    const quickAlertModal = document.getElementById('quick-alert-modal');
    if (isModalOpen(quickAlertModal)) {
        setModalOpen(quickAlertModal, false);
        closed = true;
    }
    return closed;
}

async function applyFullDashboardState(state, shouldPersist = false) {
    const safeState = state && typeof state === 'object' ? state : {};
    const themeObj = updateThemeUI(safeState.theme || 'monochrome');
    updateTimezoneUI(safeState.timezone || 'Europe/Istanbul');
    const syncCfg = syncManager.setConfig(safeState.sync || { crosshair: false, time: false, symbol: false });
    updateSyncUI(syncCfg);
    updateWatchlistVisibilityUI(safeState.watchlistOpen !== undefined ? safeState.watchlistOpen : true);

    activePaneId = 1;
    applyLayout(safeState.layout || 4, safeState.panes || [], shouldPersist);

    Object.values(activePanes).forEach((pane) => {
        pane.applyTheme(themeObj);
        pane.setTimezone(currentTimezone);
    });
}

function bindHeaderControls() {
    // 1. Layout Selector
    const layoutSelector = document.getElementById('layout-selector');
    if (layoutSelector) {
        layoutSelector.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-layout');
            if (!btn) return;
            const panesCount = parseInt(btn.getAttribute('data-panes'), 10);
            if (VALID_LAYOUTS.has(panesCount)) {
                applyLayout(panesCount, null, true);
            }
        });
    }

    // 2. Sync Controls
    const bindSyncBtn = (elementId, key) => {
        const btn = document.getElementById(elementId);
        if (!btn) return;
        btn.addEventListener('click', () => {
            const current = syncManager.getConfig();
            const updated = syncManager.setConfig({ [key]: !current[key] });
            updateSyncUI(updated);
            scheduleSaveState();
        });
    };
    bindSyncBtn('sync-crosshair', 'crosshair');
    bindSyncBtn('sync-time', 'time');
    bindSyncBtn('sync-symbol', 'symbol');

    // 3. Theme Toggle
    const themeBtn = document.getElementById('btn-theme-toggle');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            const nextTheme = currentThemeName === 'monochrome' ? 'classic' : 'monochrome';
            const themeObj = updateThemeUI(nextTheme);
            Object.values(activePanes).forEach((pane) => pane.applyTheme(themeObj));
            scheduleSaveState();
        });
    }

    // 4. Timezone Toggle
    const tzBtn = document.getElementById('btn-timezone-toggle');
    if (tzBtn) {
        tzBtn.addEventListener('click', () => {
            const nextTz = currentTimezone === 'Europe/Istanbul' ? 'UTC' : 'Europe/Istanbul';
            updateTimezoneUI(nextTz);
            Object.values(activePanes).forEach((pane) => pane.setTimezone(currentTimezone));
            scheduleSaveState();
        });
    }

    // 5. Watchlist Sidebar Toggle
    const watchlistBtn = document.getElementById('btn-watchlist-toggle');
    if (watchlistBtn) {
        watchlistBtn.addEventListener('click', () => {
            updateWatchlistVisibilityUI(!watchlistOpen);
            scheduleSaveState();
            resizeAllPanes();
            setTimeout(resizeAllPanes, 280);
        });
    }

    // 6. Backup Export
    const exportBtn = document.getElementById('btn-backup-export');
    if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
            try {
                const backup = await exportBackup();
                const dateStr = new Date().toISOString().slice(0, 10);
                const filename = `alpg_terminal_backup_${dateStr}.json`;
                const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                showToast?.('Yedek Dışa Aktarıldı', filename, 'success');
            } catch (err) {
                console.error('Error exporting backup:', err);
                showToast?.('Yedek Hatası', err.message, 'error');
            }
        });
    }

    // 7. Backup Import
    const importBtn = document.getElementById('btn-backup-import');
    const importInput = document.getElementById('input-backup-file');
    if (importBtn && importInput) {
        importBtn.addEventListener('click', () => {
            importInput.click();
        });

        importInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                await importBackup(parsed);
                showToast?.('Yedek Geri Yüklendi', 'Ayarlar, çizimler, izleme listesi ve alarmlar güncellendi.', 'success');

                destroyAllPanes();
                const [restoredState] = await Promise.all([
                    fetchState(),
                    alertManager.loadAlerts(),
                    watchlistPanel?.load?.(),
                ]);
                await applyFullDashboardState(restoredState, false);
            } catch (err) {
                console.error('Error importing backup:', err);
                showToast?.('Yedek Hatası', err.message, 'error');
            } finally {
                importInput.value = '';
            }
        });
    }

    // 8. Shortcuts Help Modal
    const shortcutsModal = document.getElementById('shortcuts-modal');
    const shortcutsBtn = document.getElementById('btn-shortcuts-help');
    const closeShortcutsBtn = document.getElementById('btn-close-shortcuts');
    if (shortcutsBtn && shortcutsModal) {
        shortcutsBtn.addEventListener('click', () => {
            setModalOpen(shortcutsModal, !isModalOpen(shortcutsModal));
        });
    }
    if (closeShortcutsBtn && shortcutsModal) {
        closeShortcutsBtn.addEventListener('click', () => {
            setModalOpen(shortcutsModal, false);
        });
    }
    if (shortcutsModal) {
        shortcutsModal.addEventListener('click', (e) => {
            if (e.target === shortcutsModal) {
                setModalOpen(shortcutsModal, false);
            }
        });
    }

    // 9. Quick Alert Modal
    const quickAlertModal = document.getElementById('quick-alert-modal');
    const qaSubmitBtn = document.getElementById('qa-submit');
    const qaForm = document.getElementById('qa-form');

    const handleQuickAlertSubmit = async (e) => {
        if (e) e.preventDefault();
        const source = String(getFieldValue(document.getElementById('qa-source'), quickAlertContext.source)).trim().toLowerCase();
        const symbol = String(getFieldValue(document.getElementById('qa-symbol'), quickAlertContext.symbol)).trim().toUpperCase();
        const condition = String(getFieldValue(document.getElementById('qa-condition'), 'cross_above')).trim();
        const rawPrice = getFieldValue(document.getElementById('qa-price'), '');
        const price = parseFloat(rawPrice);
        const message = String(getFieldValue(document.getElementById('qa-message'), '')).trim();

        if (!source || !symbol) {
            showToast?.('Geçersiz Bilgi', 'Kaynak ve sembol gerekli.', 'error');
            return;
        }
        if (!Number.isFinite(price)) {
            showToast?.('Geçersiz Fiyat', 'Lütfen geçerli bir hedef fiyat girin.', 'error');
            return;
        }

        try {
            await alertManager.createAlert({ source, symbol, condition, price, message });
            closeQuickAlertModal();
            showToast?.('Alarm Oluşturuldu', `${symbol} (${price}) için alarm kuruldu.`, 'success');
        } catch (err) {
            console.error('Error creating alert:', err);
            showToast?.('Alarm Hatası', err.message, 'error');
        }
    };

    if (qaForm) {
        qaForm.addEventListener('submit', handleQuickAlertSubmit);
    }
    if (qaSubmitBtn) {
        qaSubmitBtn.addEventListener('click', (e) => {
            if (!qaForm || qaSubmitBtn.type !== 'submit') {
                handleQuickAlertSubmit(e);
            }
        });
    }

    if (quickAlertModal) {
        quickAlertModal.addEventListener('click', (e) => {
            if (e.target === quickAlertModal) {
                closeQuickAlertModal();
            }
        });
        quickAlertModal
            .querySelectorAll('#qa-cancel, #qa-close, #btn-close-quick-alert, .modal-close')
            .forEach((btn) => {
                btn.addEventListener('click', () => closeQuickAlertModal());
            });
    }
}

function bindGlobalKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (closeAllModals()) {
                e.preventDefault();
                return;
            }
            if (exitMaximizeIfActive()) {
                e.preventDefault();
                return;
            }
            const activePane = getActivePane();
            if (activePane?.drawingEngine?.handleEscape()) {
                e.preventDefault();
            }
            return;
        }

        const activeEl = document.activeElement;
        const tag = activeEl?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || activeEl?.isContentEditable) {
            return;
        }

        const activePane = getActivePane();
        const keyLower = e.key.toLowerCase();
        const hasCtrlOrMeta = e.ctrlKey || e.metaKey;

        if (e.key === '?' && !hasCtrlOrMeta && !e.altKey) {
            e.preventDefault();
            const modal = document.getElementById('shortcuts-modal');
            setModalOpen(modal, !isModalOpen(modal));
            return;
        }

        if (!activePane) return;

        if (e.altKey && !hasCtrlOrMeta) {
            if (keyLower === 'h') {
                e.preventDefault();
                activePane.drawingEngine?.setActiveTool('horizontal');
                return;
            }
            if (keyLower === 't') {
                e.preventDefault();
                activePane.drawingEngine?.setActiveTool('trend');
                return;
            }
            if (keyLower === 'f') {
                e.preventDefault();
                activePane.drawingEngine?.setActiveTool('fib');
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                toggleMaximizePane(activePane);
                return;
            }
        }

        if (hasCtrlOrMeta && !e.altKey) {
            if (keyLower === 'z' && !e.shiftKey) {
                e.preventDefault();
                activePane.drawingEngine?.undo();
                return;
            }
            if (keyLower === 'y' || (keyLower === 'z' && e.shiftKey)) {
                e.preventDefault();
                activePane.drawingEngine?.redo();
                return;
            }
        }

        if (!hasCtrlOrMeta && !e.altKey && !e.shiftKey && keyLower === 'm') {
            e.preventDefault();
            activePane.drawingEngine?.toggleMagnet();
            return;
        }

        if ((e.key === 'Delete' || e.key === 'Backspace') && !hasCtrlOrMeta && !e.altKey) {
            if (activePane.drawingEngine?.deleteSelected()) {
                e.preventDefault();
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    bindHeaderControls();
    bindGlobalKeyboardShortcuts();

    let state = {
        layout: 4,
        theme: 'monochrome',
        timezone: 'Europe/Istanbul',
        sync: { crosshair: false, time: false, symbol: false },
        watchlistOpen: true,
        migratedFromLocalStorage: false,
        panes: [],
    };

    try {
        const [loadedState] = await Promise.all([
            fetchState(),
            alertManager.loadAlerts(),
        ]);
        if (loadedState && typeof loadedState === 'object') {
            state = loadedState;
        }
    } catch (err) {
        console.error('Error during initial state/alerts fetch:', err);
    }

    state = await migrateFromLegacyLocalStorage(state);

    // Apply saved theme, timezone, sync, and watchlist visibility before creating panes
    updateThemeUI(state.theme || 'monochrome');
    updateTimezoneUI(state.timezone || 'Europe/Istanbul');
    const syncCfg = syncManager.setConfig(state.sync || {});
    updateSyncUI(syncCfg);
    updateWatchlistVisibilityUI(state.watchlistOpen !== undefined ? state.watchlistOpen : true);

    const sidebarEl = document.getElementById('watchlist-sidebar');
    if (sidebarEl) {
        watchlistPanel = new WatchlistPanel(sidebarEl, {
            onSelectSymbol: (src, sym) => {
                const targetPane = getActivePane();
                if (targetPane) {
                    targetPane.loadSymbol(src, sym);
                }
            },
        });
        try {
            await watchlistPanel.load();
        } catch (err) {
            console.error('Error loading watchlist panel:', err);
        }
        watchlistPanel.start();
    }

    alertManager.subscribe(() => {
        Object.values(activePanes).forEach((pane) => {
            pane.drawingEngine?.redraw();
        });
    });

    applyLayout(state.layout || 4, state.panes || [], false);
});
