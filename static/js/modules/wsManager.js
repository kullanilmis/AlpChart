/**
 * Shared Hyperliquid WebSocket connection manager supporting
 * per-pane candle subscriptions and watchlist allMids updates.
 */

export class HyperliquidWSManager {
    constructor() {
        this.url = 'wss://api.hyperliquid.xyz/ws';
        this.ws = null;
        this.subscribers = {}; // key: "SYMBOL:interval" -> array of { paneId, callback, statusCallback }
        this.midsListeners = new Map(); // listenerId -> callback
        this.reconnectTimeout = null;
    }

    /**
     * Open the shared WebSocket connection if not already connecting or open.
     */
    connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        console.log('Connecting to Hyperliquid WebSocket...');
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
            console.log('Hyperliquid WebSocket connected.');
            for (const key in this.subscribers) {
                const sepIdx = key.lastIndexOf(':');
                const symbol = sepIdx >= 0 ? key.slice(0, sepIdx) : key;
                const interval = sepIdx >= 0 ? key.slice(sepIdx + 1) : '';
                this._sendSubscribe(symbol, interval);
                this.subscribers[key].forEach((sub) => {
                    if (typeof sub.statusCallback === 'function') {
                        sub.statusCallback('connected');
                    }
                });
            }

            if (this.midsListeners.size > 0) {
                this._sendMidsSubscribe();
            }
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.channel === 'candle' && msg.data) {
                    const items = Array.isArray(msg.data) ? msg.data : [msg.data];
                    for (const item of items) {
                        if (!item || !item.s || !item.i) continue;
                        const symbol = String(item.s).toUpperCase();
                        const interval = item.i;
                        const key = `${symbol}:${interval}`;

                        if (this.subscribers[key]) {
                            const tick = {
                                time: Math.floor(item.t / 1000),
                                open: parseFloat(item.o),
                                high: parseFloat(item.h),
                                low: parseFloat(item.l),
                                close: parseFloat(item.c),
                                volume: parseFloat(item.v),
                                price: parseFloat(item.c),
                            };
                            this.subscribers[key].forEach((sub) => sub.callback(tick));
                        }
                    }
                } else if (msg.channel === 'allMids' && msg.data && msg.data.mids) {
                    const mids = msg.data.mids;
                    this.midsListeners.forEach((callback) => {
                        try {
                            callback(mids);
                        } catch (cbErr) {
                            console.error('Error in allMids listener:', cbErr);
                        }
                    });
                }
            } catch (err) {
                console.error('Error processing WS message:', err);
            }
        };

        this.ws.onclose = () => {
            console.warn('Hyperliquid WebSocket disconnected. Retrying in 5 seconds...');
            for (const key in this.subscribers) {
                this.subscribers[key].forEach((sub) => {
                    if (typeof sub.statusCallback === 'function') {
                        sub.statusCallback('disconnected');
                    }
                });
            }
            if (!this.reconnectTimeout) {
                this.reconnectTimeout = setTimeout(() => {
                    this.reconnectTimeout = null;
                    this.connect();
                }, 5000);
            }
        };

        this.ws.onerror = (err) => {
            console.error('Hyperliquid WebSocket error:', err);
            if (this.ws && this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
                this.ws.close();
            }
        };
    }

    /**
     * Subscribe a pane to candle updates for a symbol and exchange interval.
     */
    subscribe(symbol, interval, paneId, callback, statusCallback) {
        if (!symbol || !interval) return;
        const normSymbol = symbol.toUpperCase();
        const key = `${normSymbol}:${interval}`;
        if (!this.subscribers[key]) {
            this.subscribers[key] = [];
        }

        const filtered = this.subscribers[key].filter((sub) => sub.paneId !== paneId);
        const wasEmpty = filtered.length === 0;
        filtered.push({ paneId, callback, statusCallback });
        this.subscribers[key] = filtered;

        const isOpen = Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
        if (typeof statusCallback === 'function') {
            statusCallback(isOpen ? 'connected' : 'connecting');
        }

        if (isOpen) {
            if (wasEmpty) {
                this._sendSubscribe(normSymbol, interval);
            }
        } else {
            this.connect();
        }
    }

    /**
     * Unsubscribe a pane from candle updates for a symbol and exchange interval.
     */
    unsubscribe(symbol, interval, paneId) {
        if (!symbol || !interval) return;
        const normSymbol = symbol.toUpperCase();
        const key = `${normSymbol}:${interval}`;
        if (!this.subscribers[key]) return;

        this.subscribers[key] = this.subscribers[key].filter((sub) => sub.paneId !== paneId);

        if (this.subscribers[key].length === 0) {
            this._sendUnsubscribe(normSymbol, interval);
            delete this.subscribers[key];
        }
    }

    /**
     * Register a listener for Hyperliquid allMids live price updates.
     */
    subscribeMids(listenerId, callback) {
        if (listenerId == null || typeof callback !== 'function') return;
        const wasEmpty = this.midsListeners.size === 0;
        this.midsListeners.set(listenerId, callback);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            if (wasEmpty) {
                this._sendMidsSubscribe();
            }
        } else {
            this.connect();
        }
    }

    /**
     * Remove a listener from Hyperliquid allMids live price updates.
     */
    unsubscribeMids(listenerId) {
        if (!this.midsListeners.has(listenerId)) return;
        this.midsListeners.delete(listenerId);

        if (this.midsListeners.size === 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this._sendJSON({
                method: 'unsubscribe',
                subscription: { type: 'allMids' },
            });
        }
    }

    _sendMidsSubscribe() {
        this._sendJSON({
            method: 'subscribe',
            subscription: { type: 'allMids' },
        });
    }

    _sendSubscribe(symbol, interval) {
        this._sendJSON({
            method: 'subscribe',
            subscription: {
                type: 'candle',
                coin: symbol.toUpperCase(),
                interval,
            },
        });
    }

    _sendUnsubscribe(symbol, interval) {
        this._sendJSON({
            method: 'unsubscribe',
            subscription: {
                type: 'candle',
                coin: symbol.toUpperCase(),
                interval,
            },
        });
    }

    _sendJSON(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        }
    }
}

export const hlWSManager = new HyperliquidWSManager();
