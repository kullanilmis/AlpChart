/**
 * Collapsible right sidebar managing Watchlist live quotes and Price Alerts.
 */

import {
    fetchWatchlist,
    addWatchlistItem,
    deleteWatchlistItem,
    fetchQuotes,
} from './api.js';
import { hlWSManager } from './wsManager.js';
import { alertManager, showToast } from './alertManager.js';

const QUOTE_POLL_INTERVAL_MS = 15000;
const WS_LISTENER_ID = 'watchlist-panel';

/**
 * Format asset prices dynamically based on magnitude.
 */
function formatPrice(price) {
    if (typeof price !== 'number' || !Number.isFinite(price)) {
        return '—';
    }
    const abs = Math.abs(price);
    if (abs >= 1000) {
        return price.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }
    if (abs >= 100) {
        return price.toFixed(2);
    }
    if (abs >= 10) {
        return price.toFixed(3);
    }
    if (abs >= 0.01) {
        return price.toFixed(4);
    }
    return price.toFixed(6);
}

/**
 * Format 24h percentage change pill text and CSS tone class.
 */
function formatChangePct(changePct) {
    if (typeof changePct !== 'number' || !Number.isFinite(changePct)) {
        return { text: '—', cls: 'pct-flat' };
    }
    const sign = changePct > 0 ? '+' : '';
    const cls = changePct > 0 ? 'pct-up' : changePct < 0 ? 'pct-down' : 'pct-flat';
    return { text: `${sign}${changePct.toFixed(2)}%`, cls };
}

/**
 * Canonical "source:SYMBOL" key used across watchlist and quote maps.
 */
function itemKey(source, symbol) {
    return `${String(source || '').trim().toLowerCase()}:${String(symbol || '').trim().toUpperCase()}`;
}

/**
 * Trigger a crisp CSS green/red flash animation on a price element.
 */
function flashPriceElement(el, direction) {
    if (!el || !direction) return;
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(direction === 'up' ? 'flash-up' : 'flash-down');
}

/**
 * Format UNIX seconds timestamp to concise local time string.
 */
function formatAlertTime(unixSeconds) {
    if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '';
    try {
        const d = new Date(unixSeconds * 1000);
        return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}

export class WatchlistPanel {
    constructor(containerEl, { onSelectSymbol } = {}) {
        this.containerEl = containerEl || null;
        this.onSelectSymbol = typeof onSelectSymbol === 'function' ? onSelectSymbol : null;
        this.activeTab = 'watchlist';
        this.items = [];
        this.quotes = new Map(); // "source:SYMBOL" -> { price, changePct, wsUpdatedAt }
        this.alerts = alertManager.getAlerts();
        this._quoteTimer = null;
        this._unsubAlerts = null;
        this._quoteReqId = 0;
        this._isOpen = this.containerEl ? !this.containerEl.classList.contains('collapsed') : true;

        this._refs = {};
        if (this.containerEl) {
            this._buildDOM();
            this._renderWatchlist();
            this._renderAlerts();
        }
    }

    /**
     * Replace watchlist items and refresh the rendered list.
     */
    setItems(items) {
        this.items = Array.isArray(items) ? items.map((item) => ({ ...item })) : [];
        this._renderWatchlist();
    }

    /**
     * Load watchlist items from backend and fetch initial quotes.
     */
    async load() {
        const items = await fetchWatchlist();
        this.setItems(items);
        await this._refreshQuotes();
        return this.items;
    }

    /**
     * Open or collapse the sidebar panel.
     */
    setOpen(isOpen) {
        this._isOpen = Boolean(isOpen);
        if (this.containerEl) {
            this.containerEl.classList.toggle('collapsed', !this._isOpen);
            this.containerEl.setAttribute('aria-hidden', String(!this._isOpen));
        }
    }

    /**
     * Return true when the sidebar is currently expanded.
     */
    isOpen() {
        if (this.containerEl) {
            return !this.containerEl.classList.contains('collapsed');
        }
        return this._isOpen;
    }

    /**
     * Start real-time WebSocket mids listener, alert sync, and 15s quote polling.
     */
    start() {
        hlWSManager.subscribeMids(WS_LISTENER_ID, (mids) => this._handleMidsUpdate(mids));

        if (this._unsubAlerts) {
            this._unsubAlerts();
        }
        this.alerts = alertManager.getAlerts();
        this._renderAlerts();
        this._unsubAlerts = alertManager.subscribe((alerts) => {
            this.alerts = alerts;
            this._renderAlerts();
        });

        this._refreshQuotes();
        if (this._quoteTimer) {
            clearInterval(this._quoteTimer);
        }
        this._quoteTimer = setInterval(() => {
            this._refreshQuotes();
        }, QUOTE_POLL_INTERVAL_MS);
    }

    /**
     * Stop all subscriptions and timers held by this panel.
     */
    destroy() {
        hlWSManager.unsubscribeMids(WS_LISTENER_ID);
        if (this._quoteTimer) {
            clearInterval(this._quoteTimer);
            this._quoteTimer = null;
        }
        if (this._unsubAlerts) {
            this._unsubAlerts();
            this._unsubAlerts = null;
        }
    }

    _buildDOM() {
        this.containerEl.innerHTML = '';

        // Tab bar
        const tabsBar = document.createElement('div');
        tabsBar.className = 'sidebar-tabs';

        const tabWatchlist = document.createElement('button');
        tabWatchlist.type = 'button';
        tabWatchlist.className = 'sidebar-tab active';
        tabWatchlist.dataset.tab = 'watchlist';
        tabWatchlist.textContent = 'Watchlist';

        const tabAlerts = document.createElement('button');
        tabAlerts.type = 'button';
        tabAlerts.className = 'sidebar-tab';
        tabAlerts.dataset.tab = 'alerts';
        const alertsLabel = document.createElement('span');
        alertsLabel.textContent = 'Alarmlar';
        const alertsBadge = document.createElement('span');
        alertsBadge.className = 'tab-badge hidden';
        alertsBadge.textContent = '0';
        tabAlerts.appendChild(alertsLabel);
        tabAlerts.appendChild(alertsBadge);

        tabWatchlist.addEventListener('click', () => this._switchTab('watchlist'));
        tabAlerts.addEventListener('click', () => this._switchTab('alerts'));

        tabsBar.appendChild(tabWatchlist);
        tabsBar.appendChild(tabAlerts);
        this.containerEl.appendChild(tabsBar);

        // Watchlist panel
        const wlPanel = document.createElement('div');
        wlPanel.className = 'sidebar-panel';
        wlPanel.dataset.panel = 'watchlist';

        const wlForm = document.createElement('form');
        wlForm.className = 'wl-add-form';

        const wlRowTop = document.createElement('div');
        wlRowTop.className = 'wl-add-row';

        const wlSourceSelect = document.createElement('select');
        wlSourceSelect.className = 'wl-select';
        wlSourceSelect.name = 'source';
        wlSourceSelect.setAttribute('aria-label', 'Veri Kaynağı');
        wlSourceSelect.innerHTML = '<option value="hyperliquid">HL</option><option value="yfinance">YF</option>';

        const wlSymbolInput = document.createElement('input');
        wlSymbolInput.type = 'text';
        wlSymbolInput.className = 'wl-input';
        wlSymbolInput.name = 'symbol';
        wlSymbolInput.placeholder = 'Sembol (BTC, THYAO.IS)';
        wlSymbolInput.autocomplete = 'off';

        const wlAddBtn = document.createElement('button');
        wlAddBtn.type = 'submit';
        wlAddBtn.className = 'wl-add-btn';
        wlAddBtn.title = 'Listeye Ekle';
        wlAddBtn.textContent = '+';

        wlRowTop.appendChild(wlSourceSelect);
        wlRowTop.appendChild(wlSymbolInput);
        wlRowTop.appendChild(wlAddBtn);

        const wlLabelInput = document.createElement('input');
        wlLabelInput.type = 'text';
        wlLabelInput.className = 'wl-input wl-label-input';
        wlLabelInput.name = 'label';
        wlLabelInput.placeholder = 'Etiket (opsiyonel)';
        wlLabelInput.autocomplete = 'off';

        wlForm.appendChild(wlRowTop);
        wlForm.appendChild(wlLabelInput);
        wlForm.addEventListener('submit', (e) => this._handleAddWatchlist(e));

        const wlList = document.createElement('div');
        wlList.className = 'wl-list';

        wlPanel.appendChild(wlForm);
        wlPanel.appendChild(wlList);

        // Alerts panel
        const alertsPanel = document.createElement('div');
        alertsPanel.className = 'sidebar-panel hidden';
        alertsPanel.dataset.panel = 'alerts';

        const notifyBar = document.createElement('div');
        notifyBar.className = 'alerts-notify-bar';
        const notifyBtn = document.createElement('button');
        notifyBtn.type = 'button';
        notifyBtn.className = 'btn-notify-perm';
        notifyBtn.textContent = '🔔 Bildirim İzni';
        notifyBtn.addEventListener('click', async () => {
            await alertManager.requestNotificationPermission();
            this._updateNotifyBarVisibility();
        });
        notifyBar.appendChild(notifyBtn);

        const alertForm = document.createElement('form');
        alertForm.className = 'alert-create-form';

        const alertRow1 = document.createElement('div');
        alertRow1.className = 'alert-form-row';

        const alertSource = document.createElement('select');
        alertSource.className = 'wl-select';
        alertSource.name = 'source';
        alertSource.setAttribute('aria-label', 'Alarm Veri Kaynağı');
        alertSource.innerHTML = '<option value="hyperliquid">HL</option><option value="yfinance">YF</option>';

        const alertSymbol = document.createElement('input');
        alertSymbol.type = 'text';
        alertSymbol.className = 'wl-input';
        alertSymbol.name = 'symbol';
        alertSymbol.placeholder = 'Sembol (BTC)';
        alertSymbol.autocomplete = 'off';

        alertRow1.appendChild(alertSource);
        alertRow1.appendChild(alertSymbol);

        const alertRow2 = document.createElement('div');
        alertRow2.className = 'alert-form-row';

        const alertCondition = document.createElement('select');
        alertCondition.className = 'wl-select wl-select-wide';
        alertCondition.name = 'condition';
        alertCondition.innerHTML =
            '<option value="cross_above">Üstüne Çıkınca</option>' +
            '<option value="cross_below">Altına İnince</option>';

        const alertPrice = document.createElement('input');
        alertPrice.type = 'number';
        alertPrice.step = 'any';
        alertPrice.className = 'wl-input';
        alertPrice.name = 'price';
        alertPrice.placeholder = 'Fiyat';

        alertRow2.appendChild(alertCondition);
        alertRow2.appendChild(alertPrice);

        const alertMessage = document.createElement('input');
        alertMessage.type = 'text';
        alertMessage.className = 'wl-input';
        alertMessage.name = 'message';
        alertMessage.placeholder = 'Mesaj (opsiyonel)';
        alertMessage.autocomplete = 'off';

        const alertSubmitBtn = document.createElement('button');
        alertSubmitBtn.type = 'submit';
        alertSubmitBtn.className = 'alert-submit-btn';
        alertSubmitBtn.textContent = '+ Alarm Ekle';

        alertForm.appendChild(alertRow1);
        alertForm.appendChild(alertRow2);
        alertForm.appendChild(alertMessage);
        alertForm.appendChild(alertSubmitBtn);
        alertForm.addEventListener('submit', (e) => this._handleCreateAlert(e));

        const alertsList = document.createElement('div');
        alertsList.className = 'alerts-list';

        alertsPanel.appendChild(notifyBar);
        alertsPanel.appendChild(alertForm);
        alertsPanel.appendChild(alertsList);

        this.containerEl.appendChild(wlPanel);
        this.containerEl.appendChild(alertsPanel);

        this._refs = {
            tabWatchlist,
            tabAlerts,
            alertsBadge,
            wlPanel,
            alertsPanel,
            wlForm,
            wlSourceSelect,
            wlSymbolInput,
            wlLabelInput,
            wlList,
            notifyBar,
            alertForm,
            alertSource,
            alertSymbol,
            alertCondition,
            alertPrice,
            alertMessage,
            alertsList,
        };

        this._updateNotifyBarVisibility();
    }

    _switchTab(tabName) {
        this.activeTab = tabName === 'alerts' ? 'alerts' : 'watchlist';
        const { tabWatchlist, tabAlerts, wlPanel, alertsPanel } = this._refs;
        if (!tabWatchlist || !tabAlerts) return;

        tabWatchlist.classList.toggle('active', this.activeTab === 'watchlist');
        tabAlerts.classList.toggle('active', this.activeTab === 'alerts');
        wlPanel.classList.toggle('hidden', this.activeTab !== 'watchlist');
        alertsPanel.classList.toggle('hidden', this.activeTab !== 'alerts');

        if (this.activeTab === 'alerts') {
            this._updateNotifyBarVisibility();
        }
    }

    _updateNotifyBarVisibility() {
        const { notifyBar } = this._refs;
        if (!notifyBar) return;
        const shouldShow =
            typeof Notification !== 'undefined' && Notification.permission !== 'granted';
        notifyBar.classList.toggle('hidden', !shouldShow);
    }

    async _handleAddWatchlist(e) {
        e.preventDefault();
        const { wlSourceSelect, wlSymbolInput, wlLabelInput } = this._refs;
        const source = (wlSourceSelect?.value || 'hyperliquid').trim().toLowerCase();
        const symbol = (wlSymbolInput?.value || '').trim().toUpperCase();
        const label = (wlLabelInput?.value || '').trim();

        if (!symbol) {
            wlSymbolInput?.focus();
            return;
        }

        try {
            const added = await addWatchlistItem(source, symbol, label);
            if (wlSymbolInput) wlSymbolInput.value = '';
            if (wlLabelInput) wlLabelInput.value = '';

            if (added) {
                const idx = this.items.findIndex(
                    (it) => it.id === added.id || itemKey(it.source, it.symbol) === itemKey(added.source, added.symbol)
                );
                if (idx !== -1) {
                    this.items[idx] = added;
                } else {
                    this.items.push(added);
                }
                this._renderWatchlist();
                await this._refreshQuotes();
            }
        } catch (err) {
            showToast('İzleme Listesi Hatası', err?.message || 'Sembol eklenemedi.', 'error');
        }
    }

    async _handleCreateAlert(e) {
        e.preventDefault();
        const { alertSource, alertSymbol, alertCondition, alertPrice, alertMessage } = this._refs;
        const source = (alertSource?.value || 'hyperliquid').trim().toLowerCase();
        const symbol = (alertSymbol?.value || '').trim().toUpperCase();
        const condition = alertCondition?.value || 'cross_above';
        const price = parseFloat(alertPrice?.value || '');
        const message = (alertMessage?.value || '').trim();

        if (!symbol) {
            alertSymbol?.focus();
            return;
        }
        if (!Number.isFinite(price)) {
            showToast('Geçersiz Fiyat', 'Lütfen geçerli bir hedef fiyat girin.', 'error');
            alertPrice?.focus();
            return;
        }

        try {
            await alertManager.createAlert({ source, symbol, condition, price, message });
            if (alertPrice) alertPrice.value = '';
            if (alertMessage) alertMessage.value = '';
            if (alertSymbol) alertSymbol.value = '';
            showToast('Alarm Oluşturuldu', `${symbol} (${formatPrice(price)}) için alarm kuruldu.`, 'success');
        } catch (err) {
            showToast('Alarm Hatası', err?.message || 'Alarm oluşturulamadı.', 'error');
        }
    }

    _renderWatchlist() {
        const { wlList } = this._refs;
        if (!wlList) return;
        wlList.innerHTML = '';

        if (!this.items.length) {
            const empty = document.createElement('div');
            empty.className = 'sidebar-empty';
            empty.textContent = 'İzleme listesi boş. Yukarıdan sembol ekleyin.';
            wlList.appendChild(empty);
            return;
        }

        for (const item of this.items) {
            const key = itemKey(item.source, item.symbol);
            const quote = this.quotes.get(key);

            const row = document.createElement('div');
            row.className = 'wl-row';
            row.dataset.id = String(item.id);
            row.dataset.source = String(item.source).toLowerCase();
            row.dataset.symbol = String(item.symbol).toUpperCase();

            const left = document.createElement('div');
            left.className = 'wl-row-left';

            const pill = document.createElement('span');
            const isHL = String(item.source).toLowerCase() === 'hyperliquid';
            pill.className = `wl-source-pill ${isHL ? 'source-hl' : 'source-yf'}`;
            pill.textContent = isHL ? 'HL' : 'YF';

            const symGroup = document.createElement('div');
            symGroup.className = 'wl-symbol-group';

            const symEl = document.createElement('span');
            symEl.className = 'wl-symbol';
            symEl.textContent = String(item.symbol).toUpperCase();
            symGroup.appendChild(symEl);

            if (item.label && item.label.trim().toUpperCase() !== String(item.symbol).trim().toUpperCase()) {
                const labelEl = document.createElement('span');
                labelEl.className = 'wl-label';
                labelEl.textContent = item.label.trim();
                symGroup.appendChild(labelEl);
            }

            left.appendChild(pill);
            left.appendChild(symGroup);

            const right = document.createElement('div');
            right.className = 'wl-row-right';

            const quoteGroup = document.createElement('div');
            quoteGroup.className = 'wl-quote-group';

            const priceEl = document.createElement('span');
            priceEl.className = 'wl-price';
            priceEl.textContent = formatPrice(quote?.price);

            const { text: pctText, cls: pctCls } = formatChangePct(quote?.changePct);
            const pctEl = document.createElement('span');
            pctEl.className = `wl-pct ${pctCls}`;
            pctEl.textContent = pctText;

            quoteGroup.appendChild(priceEl);
            quoteGroup.appendChild(pctEl);

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'wl-delete-btn';
            delBtn.title = 'Listeden Kaldır';
            delBtn.setAttribute('aria-label', `${item.symbol} sil`);
            delBtn.textContent = '×';
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await deleteWatchlistItem(item.id);
                    this.items = this.items.filter((x) => x.id !== item.id);
                    this._renderWatchlist();
                } catch (err) {
                    showToast('Silme Hatası', err?.message || 'Öğe silinemedi.', 'error');
                }
            });

            right.appendChild(quoteGroup);
            right.appendChild(delBtn);

            row.appendChild(left);
            row.appendChild(right);

            row.addEventListener('click', () => {
                if (this.onSelectSymbol) {
                    this.onSelectSymbol(String(item.source).toLowerCase(), String(item.symbol).toUpperCase());
                }
            });

            wlList.appendChild(row);
        }
    }

    _renderAlerts() {
        const { alertsList, alertsBadge } = this._refs;
        this._updateNotifyBarVisibility();

        const activeCount = this.alerts.filter((a) => a && a.active).length;
        if (alertsBadge) {
            alertsBadge.textContent = String(activeCount);
            alertsBadge.classList.toggle('hidden', activeCount === 0);
        }

        if (!alertsList) return;
        alertsList.innerHTML = '';

        if (!this.alerts.length) {
            const empty = document.createElement('div');
            empty.className = 'sidebar-empty';
            empty.textContent = 'Kayıtlı alarm yok. Grafik veya yukarıdaki form üzerinden ekleyin.';
            alertsList.appendChild(empty);
            return;
        }

        const sorted = [...this.alerts].sort((a, b) => {
            const aActive = Boolean(a?.active);
            const bActive = Boolean(b?.active);
            if (aActive !== bActive) {
                return aActive ? -1 : 1;
            }
            return (b?.created_at || 0) - (a?.created_at || 0);
        });

        for (const alert of sorted) {
            if (!alert) continue;

            const row = document.createElement('div');
            row.className = `alert-row ${alert.active ? 'is-active' : 'is-triggered'}`;
            row.dataset.alertId = String(alert.id);

            const top = document.createElement('div');
            top.className = 'alert-row-top';

            const identity = document.createElement('div');
            identity.className = 'alert-identity';

            const badge = document.createElement('span');
            badge.className = `alert-badge ${alert.active ? 'is-active' : 'is-triggered'}`;
            badge.textContent = alert.active ? 'AKTİF' : 'TETİKLENDİ';

            const isHL = String(alert.source).toLowerCase() === 'hyperliquid';
            const sourcePill = document.createElement('span');
            sourcePill.className = `wl-source-pill ${isHL ? 'source-hl' : 'source-yf'}`;
            sourcePill.textContent = isHL ? 'HL' : 'YF';

            const symEl = document.createElement('span');
            symEl.className = 'alert-symbol';
            symEl.textContent = String(alert.symbol || '').toUpperCase();

            identity.appendChild(badge);
            identity.appendChild(sourcePill);
            identity.appendChild(symEl);

            const actions = document.createElement('div');
            actions.className = 'alert-actions';

            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'alert-action-btn';
            toggleBtn.textContent = alert.active ? '⏸' : '↻';
            toggleBtn.title = alert.active ? 'Alarmı Duraklat' : 'Alarmı Yeniden Kur';
            toggleBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await alertManager.toggleAlert(alert.id, !alert.active);
                } catch (err) {
                    showToast('Alarm Güncelleme Hatası', err?.message || 'Durum değiştirilemedi.', 'error');
                }
            });

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'alert-action-btn alert-delete-btn';
            delBtn.textContent = '×';
            delBtn.title = 'Alarmı Sil';
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await alertManager.deleteAlert(alert.id);
                } catch (err) {
                    showToast('Alarm Silme Hatası', err?.message || 'Alarm silinemedi.', 'error');
                }
            });

            actions.appendChild(toggleBtn);
            actions.appendChild(delBtn);

            top.appendChild(identity);
            top.appendChild(actions);

            const condLine = document.createElement('div');
            condLine.className = 'alert-cond-line';
            const condIcon = alert.condition === 'cross_above' ? '↑ Üstüne Çıkınca' : '↓ Altına İnince';
            const condText = document.createElement('span');
            condText.className = `alert-cond-label ${alert.condition === 'cross_above' ? 'cond-up' : 'cond-down'}`;
            condText.textContent = condIcon;
            const targetEl = document.createElement('span');
            targetEl.className = 'alert-target-price';
            targetEl.textContent = formatPrice(Number(alert.price));

            condLine.appendChild(condText);
            condLine.appendChild(targetEl);

            row.appendChild(top);
            row.appendChild(condLine);

            if (alert.message) {
                const msgEl = document.createElement('div');
                msgEl.className = 'alert-msg';
                msgEl.textContent = alert.message;
                row.appendChild(msgEl);
            }

            if (!alert.active && alert.triggered_at) {
                const timeStr = formatAlertTime(alert.triggered_at);
                if (timeStr) {
                    const metaEl = document.createElement('div');
                    metaEl.className = 'alert-meta-time';
                    metaEl.textContent = `Tetiklendi: ${timeStr}`;
                    row.appendChild(metaEl);
                }
            }

            row.addEventListener('click', () => {
                if (this.onSelectSymbol) {
                    this.onSelectSymbol(String(alert.source).toLowerCase(), String(alert.symbol).toUpperCase());
                }
            });

            alertsList.appendChild(row);
        }
    }

    _handleMidsUpdate(mids) {
        if (!mids || typeof mids !== 'object') return;

        // Collect all Hyperliquid symbols from both watchlist and active alerts
        const watchlistHLSymbols = new Set();
        for (const item of this.items) {
            if (String(item.source).toLowerCase() === 'hyperliquid') {
                watchlistHLSymbols.add(String(item.symbol).toUpperCase());
            }
        }

        const allHLSymbols = new Set(watchlistHLSymbols);
        for (const alert of alertManager.getAlerts()) {
            if (alert && alert.active && String(alert.source).toLowerCase() === 'hyperliquid') {
                allHLSymbols.add(String(alert.symbol).toUpperCase());
            }
        }

        for (const sym of allHLSymbols) {
            const raw = mids[sym] ?? mids[sym.toLowerCase()];
            if (raw === undefined || raw === null) continue;
            const price = parseFloat(raw);
            if (!Number.isFinite(price)) continue;

            alertManager.checkTick('hyperliquid', sym, price);

            if (watchlistHLSymbols.has(sym)) {
                const key = itemKey('hyperliquid', sym);
                const prev = this.quotes.get(key);
                const prevPrice = prev?.price;
                const direction =
                    typeof prevPrice === 'number' && Number.isFinite(prevPrice) && price !== prevPrice
                        ? price > prevPrice
                            ? 'up'
                            : 'down'
                        : null;

                this.quotes.set(key, {
                    price,
                    changePct: prev?.changePct ?? null,
                    wsUpdatedAt: Date.now(),
                });

                this._updateRowDOM('hyperliquid', sym, price, prev?.changePct ?? null, direction);
            }
        }
    }

    async _refreshQuotes() {
        const deduped = new Map();
        for (const item of this.items) {
            const key = itemKey(item.source, item.symbol);
            if (key) {
                deduped.set(key, {
                    source: String(item.source).toLowerCase(),
                    symbol: String(item.symbol).toUpperCase(),
                });
            }
        }
        // Also poll active YFinance alerts so off-watchlist stock alerts still fire
        for (const alert of alertManager.getAlerts()) {
            if (alert && alert.active && String(alert.source).toLowerCase() === 'yfinance') {
                const key = itemKey('yfinance', alert.symbol);
                if (key && !deduped.has(key)) {
                    deduped.set(key, {
                        source: 'yfinance',
                        symbol: String(alert.symbol).toUpperCase(),
                    });
                }
            }
        }

        const requestItems = Array.from(deduped.values());
        if (!requestItems.length) return;

        const reqId = ++this._quoteReqId;
        try {
            const quotes = await fetchQuotes(requestItems);
            if (reqId !== this._quoteReqId || !quotes || typeof quotes !== 'object') return;

            const now = Date.now();
            for (const [rawKey, quote] of Object.entries(quotes)) {
                if (!quote || typeof quote !== 'object') continue;
                const sepIdx = rawKey.indexOf(':');
                if (sepIdx <= 0) continue;
                const source = rawKey.slice(0, sepIdx).toLowerCase();
                const symbol = rawKey.slice(sepIdx + 1).toUpperCase();
                const key = itemKey(source, symbol);

                if (source === 'yfinance' && Number.isFinite(quote.price)) {
                    alertManager.checkTick('yfinance', symbol, quote.price);
                }

                const prev = this.quotes.get(key);
                const hasFreshWS =
                    source === 'hyperliquid' &&
                    prev?.wsUpdatedAt &&
                    now - prev.wsUpdatedAt < 5000 &&
                    Number.isFinite(prev.price);

                const nextPrice = hasFreshWS ? prev.price : quote.price;
                const nextPct = quote.changePct !== undefined ? quote.changePct : prev?.changePct ?? null;

                let direction = null;
                if (
                    !hasFreshWS &&
                    typeof prev?.price === 'number' &&
                    Number.isFinite(prev.price) &&
                    typeof nextPrice === 'number' &&
                    Number.isFinite(nextPrice) &&
                    nextPrice !== prev.price
                ) {
                    direction = nextPrice > prev.price ? 'up' : 'down';
                }

                this.quotes.set(key, {
                    price: nextPrice,
                    changePct: nextPct,
                    wsUpdatedAt: prev?.wsUpdatedAt || 0,
                });

                this._updateRowDOM(source, symbol, nextPrice, nextPct, direction);
            }
        } catch (err) {
            console.warn('Quote poll failed:', err);
        }
    }

    _updateRowDOM(source, symbol, price, changePct, direction) {
        const { wlList } = this._refs;
        if (!wlList) return;

        const normSource = String(source).toLowerCase();
        const normSymbol = String(symbol).toUpperCase();
        const rows = wlList.querySelectorAll('.wl-row');
        for (const row of rows) {
            if (row.dataset.source !== normSource || row.dataset.symbol !== normSymbol) continue;

            const priceEl = row.querySelector('.wl-price');
            if (priceEl) {
                priceEl.textContent = formatPrice(price);
                if (direction) {
                    flashPriceElement(priceEl, direction);
                }
            }

            const pctEl = row.querySelector('.wl-pct');
            if (pctEl) {
                const { text, cls } = formatChangePct(changePct);
                pctEl.textContent = text;
                pctEl.className = `wl-pct ${cls}`;
            }
        }
    }
}
