/**
 * Multi-pane synchronization manager for crosshair, visible time range, and symbol.
 */

export class SyncManager {
    constructor() {
        this.config = { crosshair: false, time: false, symbol: false };
        this.panes = new Set();
        this.isSyncingCrosshair = false;
        this.isSyncingTime = false;
        this.isSyncingSymbol = false;
    }

    /**
     * Update sync toggles and return the resulting config copy.
     */
    setConfig(cfg) {
        if (!cfg || typeof cfg !== 'object') {
            return this.getConfig();
        }
        this.config = {
            crosshair: cfg.crosshair !== undefined ? Boolean(cfg.crosshair) : this.config.crosshair,
            time: cfg.time !== undefined ? Boolean(cfg.time) : this.config.time,
            symbol: cfg.symbol !== undefined ? Boolean(cfg.symbol) : this.config.symbol,
        };
        return this.getConfig();
    }

    /**
     * Return a shallow copy of the current sync configuration.
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Register a chart pane instance for synchronization.
     */
    registerPane(pane) {
        if (pane) {
            this.panes.add(pane);
        }
    }

    /**
     * Unregister a chart pane instance from synchronization.
     */
    unregisterPane(pane) {
        if (pane) {
            this.panes.delete(pane);
        }
    }

    /**
     * Broadcast crosshair timestamp from sourcePane to all other registered panes.
     */
    broadcastCrosshair(sourcePane, time) {
        if (!this.config.crosshair || this.isSyncingCrosshair || time == null) return;
        this._broadcast('isSyncingCrosshair', sourcePane, 'applySyncedCrosshair', time);
    }

    /**
     * Clear synced crosshair across all other registered panes.
     */
    clearCrosshair(sourcePane) {
        if (!this.config.crosshair || this.isSyncingCrosshair) return;
        this._broadcast('isSyncingCrosshair', sourcePane, 'clearSyncedCrosshair');
    }

    /**
     * Broadcast visible time range from sourcePane to all other registered panes.
     */
    broadcastTimeRange(sourcePane, visibleRange) {
        if (!this.config.time || this.isSyncingTime || !visibleRange) return;
        this._broadcast('isSyncingTime', sourcePane, 'applySyncedTimeRange', visibleRange);
    }

    /**
     * Broadcast symbol/source change from sourcePane to all other registered panes.
     */
    broadcastSymbol(sourcePane, source, symbol) {
        if (!this.config.symbol || this.isSyncingSymbol || !symbol) return;
        this._broadcast('isSyncingSymbol', sourcePane, 'applySyncedSymbol', source, symbol);
    }

    _broadcast(guardKey, sourcePane, methodName, ...args) {
        this[guardKey] = true;
        try {
            for (const pane of this.panes) {
                if (pane !== sourcePane && typeof pane[methodName] === 'function') {
                    pane[methodName](...args);
                }
            }
        } finally {
            this[guardKey] = false;
        }
    }
}

export const syncManager = new SyncManager();
