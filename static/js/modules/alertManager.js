/**
 * Client-side price alert manager and floating toast notification helper.
 */

import {
    fetchAlerts as apiFetchAlerts,
    createAlert as apiCreateAlert,
    updateAlert as apiUpdateAlert,
    deleteAlert as apiDeleteAlert,
} from './api.js';

const TOAST_DURATION_MS = 6000;

/**
 * Display a floating toast notification inside #toast-container.
 * Automatically dismisses after 6 seconds or immediately via close button.
 */
export function showToast(title, body, variant = 'info') {
    if (typeof document === 'undefined') return null;

    let container = document.getElementById('toast-container');
    if (!container && document.body) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    if (!container) return null;

    const safeVariant = ['info', 'alert', 'success', 'error'].includes(variant) ? variant : 'info';

    const toastEl = document.createElement('div');
    toastEl.className = `toast-item toast-${safeVariant}`;
    toastEl.setAttribute('role', 'status');

    const headerEl = document.createElement('div');
    headerEl.className = 'toast-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'toast-title';
    titleEl.textContent = title ? String(title) : '';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Bildirimi Kapat');
    closeBtn.textContent = '×';

    headerEl.appendChild(titleEl);
    headerEl.appendChild(closeBtn);
    toastEl.appendChild(headerEl);

    if (body) {
        const bodyEl = document.createElement('div');
        bodyEl.className = 'toast-body';
        bodyEl.textContent = String(body);
        toastEl.appendChild(bodyEl);
    }

    let timerId = null;
    const dismiss = () => {
        if (timerId !== null) {
            clearTimeout(timerId);
            timerId = null;
        }
        if (toastEl.parentNode) {
            toastEl.parentNode.removeChild(toastEl);
        }
    };

    closeBtn.addEventListener('click', dismiss);
    timerId = setTimeout(dismiss, TOAST_DURATION_MS);

    container.appendChild(toastEl);
    return toastEl;
}

/**
 * Normalize (source, symbol) pair to canonical "source:SYMBOL" key.
 */
function normalizeAlertKey(source, symbol) {
    const normSource = String(source || '').trim().toLowerCase();
    const normSymbol = String(symbol || '').trim().toUpperCase();
    if (!normSource || !normSymbol) return '';
    return `${normSource}:${normSymbol}`;
}

export class AlertManager {
    constructor() {
        this.alerts = [];
        this.lastPrices = new Map(); // "source:SYMBOL" -> number
        this.listeners = new Set();
        this._audioCtx = null;
    }

    /**
     * Replace the in-memory alerts list and notify subscribers.
     */
    setAlerts(alertsArray) {
        this.alerts = Array.isArray(alertsArray)
            ? alertsArray.filter(Boolean).map((item) => ({ ...item }))
            : [];
        this._notify();
    }

    /**
     * Return a shallow copy of current alerts.
     */
    getAlerts() {
        return this.alerts.map((item) => ({ ...item }));
    }

    /**
     * Fetch alerts from backend REST API and refresh local state.
     */
    async loadAlerts() {
        const alerts = await apiFetchAlerts();
        this.setAlerts(alerts);
        return this.getAlerts();
    }

    /**
     * Return active alerts matching (source, symbol) for rendering chart lines.
     */
    getAlertsForSymbol(source, symbol) {
        const key = normalizeAlertKey(source, symbol);
        if (!key) return [];
        return this.alerts.filter(
            (alert) =>
                alert &&
                alert.active &&
                normalizeAlertKey(alert.source, alert.symbol) === key
        );
    }

    /**
     * Create a new price alert via backend API and append to local state.
     */
    async createAlert({ source, symbol, condition, price, message = '' }) {
        const payload = {
            source: String(source || '').trim().toLowerCase(),
            symbol: String(symbol || '').trim().toUpperCase(),
            condition,
            price: Number(price),
            message: String(message || '').trim(),
        };
        const created = await apiCreateAlert(payload);
        if (created) {
            this.alerts.unshift(created);
            this._notify();
        }
        return created;
    }

    /**
     * Toggle an alert between active and paused/triggered states.
     */
    async toggleAlert(alertId, active) {
        const isActive = Boolean(active);
        const patch = {
            active: isActive,
            triggered_at: isActive ? null : Math.floor(Date.now() / 1000),
        };
        const updated = await apiUpdateAlert(alertId, patch);
        if (updated) {
            const idx = this.alerts.findIndex((item) => item.id === alertId);
            if (idx !== -1) {
                this.alerts[idx] = updated;
            } else {
                this.alerts.unshift(updated);
            }
            this._notify();
        }
        return updated;
    }

    /**
     * Delete an alert via backend API and remove it locally.
     */
    async deleteAlert(alertId) {
        await apiDeleteAlert(alertId);
        this.alerts = this.alerts.filter((item) => item.id !== alertId);
        this._notify();
    }

    /**
     * Subscribe to alerts list updates. Returns an unsubscribe function.
     */
    subscribe(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Evaluate incoming live price tick against active alerts for (source, symbol).
     */
    checkTick(source, symbol, price) {
        const key = normalizeAlertKey(source, symbol);
        if (!key || !Number.isFinite(price)) return;

        const prev = this.lastPrices.get(key);
        this.lastPrices.set(key, price);

        // Initial seed establishes baseline without triggering on stale crossing
        if (prev === undefined) return;

        let anyTriggered = false;
        const nowSec = Math.floor(Date.now() / 1000);

        for (const alert of this.alerts) {
            if (!alert || !alert.active) continue;
            if (normalizeAlertKey(alert.source, alert.symbol) !== key) continue;

            const targetPrice = Number(alert.price);
            if (!Number.isFinite(targetPrice)) continue;

            const crossedAbove = alert.condition === 'cross_above' && prev < targetPrice && price >= targetPrice;
            const crossedBelow = alert.condition === 'cross_below' && prev > targetPrice && price <= targetPrice;

            if (!crossedAbove && !crossedBelow) continue;

            // Mark inactive synchronously before async persistence so consecutive ticks cannot re-trigger
            alert.active = false;
            alert.triggered_at = nowSec;
            anyTriggered = true;

            apiUpdateAlert(alert.id, {
                active: false,
                triggered_at: alert.triggered_at,
            }).catch((err) => {
                console.error('Alert state persistence error:', err);
            });

            this._playChime();

            const condLabel = alert.condition === 'cross_above' ? 'üstüne çıktı:' : 'altına indi:';
            const msg = alert.message ? ` — ${alert.message}` : '';
            const bodyText = `${alert.symbol} ${condLabel} ${alert.price} (Anlık: ${price})${msg}`;

            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                try {
                    new Notification(`ALARM TETİKLENDİ: ${alert.symbol}`, {
                        body: bodyText,
                        tag: `alpg-alert-${alert.id}`,
                    });
                } catch {
                    // Ignore Notification constructor errors in restricted environments
                }
            }

            showToast('ALARM TETİKLENDİ', bodyText, 'alert');
        }

        if (anyTriggered) {
            this._notify();
        }
    }

    /**
     * Request browser Notification API permission and display feedback toast.
     */
    async requestNotificationPermission() {
        if (typeof window === 'undefined' || !('Notification' in window)) {
            showToast('Bildirim Desteklenmiyor', 'Tarayıcınız masaüstü bildirimlerini desteklemiyor.', 'info');
            return 'unsupported';
        }

        if (Notification.permission === 'granted') {
            showToast('Bildirim İzni Aktif', 'Fiyat alarmları masaüstü bildirimi olarak gösterilecek.', 'success');
            return 'granted';
        }

        if (Notification.permission === 'denied') {
            showToast('Bildirim İzni Engelli', 'Tarayıcı ayarlarından site bildirimlerine izin verebilirsiniz.', 'error');
            return 'denied';
        }

        try {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                showToast('Bildirim İzni Verildi', 'Tetiklenen alarmlar tarayıcı bildirimi olarak gönderilecek.', 'success');
            } else if (permission === 'denied') {
                showToast('Bildirim İzni Reddedildi', 'Alarmlar uygulama içi bildirim ve ses ile gösterilecek.', 'info');
            } else {
                showToast('Bildirim İzni Beklemede', 'Masaüstü bildirim izni onaylanmadı.', 'info');
            }
            this._notify();
            return permission;
        } catch (err) {
            showToast('Bildirim Hatası', err?.message || 'İzin istenemedi.', 'error');
            return 'denied';
        }
    }

    _playChime() {
        try {
            if (typeof window === 'undefined') return;
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;

            if (!this._audioCtx) {
                this._audioCtx = new AudioCtx();
            }
            const ctx = this._audioCtx;
            if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
                ctx.resume().catch(() => {});
            }

            const now = ctx.currentTime;
            const playTone = (freq, startOffset, duration, type, peakGain) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = type;
                osc.frequency.setValueAtTime(freq, now + startOffset);
                gain.gain.setValueAtTime(0.0001, now + startOffset);
                gain.gain.exponentialRampToValueAtTime(peakGain, now + startOffset + 0.015);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now + startOffset);
                osc.stop(now + startOffset + duration + 0.02);
            };

            playTone(880, 0, 0.18, 'sine', 0.14);
            playTone(1320, 0.13, 0.28, 'triangle', 0.12);
        } catch {
            // Ignore autoplay policy or audio subsystem failures
        }
    }

    _notify() {
        const snapshot = this.getAlerts();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch (err) {
                console.error('Error in alertManager listener:', err);
            }
        }
    }
}

export const alertManager = new AlertManager();
