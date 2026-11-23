/**
 * Backend REST API client wrappers.
 */

async function requestJSON(url, options = {}) {
    const { body, headers, ...rest } = options;
    const fetchOptions = {
        ...rest,
        headers: {
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    const res = await fetch(url, fetchOptions);
    let data = null;
    try {
        data = await res.json();
    } catch {
        if (res.ok) {
            throw new Error('HTTP ' + res.status);
        }
    }

    if (!res.ok) {
        throw new Error(data?.error || 'HTTP ' + res.status);
    }
    return data;
}

/**
 * Fetch persisted dashboard state.
 */
export async function fetchState() {
    return requestJSON('/api/state');
}

/**
 * Merge and persist dashboard state patch.
 */
export async function saveState(patch) {
    return requestJSON('/api/state', {
        method: 'PUT',
        body: patch,
    });
}

/**
 * Fetch saved drawings for a symbol key (e.g. "hyperliquid:BTC").
 */
export async function fetchDrawings(symbolKey) {
    const data = await requestJSON(`/api/drawings?key=${encodeURIComponent(symbolKey)}`);
    return data.drawings || [];
}

/**
 * Persist drawings list for a symbol key.
 */
export async function saveDrawings(symbolKey, drawings) {
    const data = await requestJSON('/api/drawings', {
        method: 'PUT',
        body: { key: symbolKey, drawings },
    });
    return data.drawings || [];
}

/**
 * Fetch ordered watchlist items.
 */
export async function fetchWatchlist() {
    const data = await requestJSON('/api/watchlist');
    return data.items || [];
}

/**
 * Add or update a watchlist item.
 */
export async function addWatchlistItem(source, symbol, label = '') {
    return requestJSON('/api/watchlist', {
        method: 'POST',
        body: { source, symbol, label },
    });
}

/**
 * Delete a watchlist item by ID.
 */
export async function deleteWatchlistItem(itemId) {
    return requestJSON(`/api/watchlist/${encodeURIComponent(itemId)}`, {
        method: 'DELETE',
    });
}

/**
 * Fetch all configured price alerts.
 */
export async function fetchAlerts() {
    const data = await requestJSON('/api/alerts');
    return data.alerts || [];
}

/**
 * Create a new price alert.
 */
export async function createAlert(alertPayload) {
    return requestJSON('/api/alerts', {
        method: 'POST',
        body: alertPayload,
    });
}

/**
 * Update an existing alert by ID.
 */
export async function updateAlert(alertId, patch) {
    return requestJSON(`/api/alerts/${encodeURIComponent(alertId)}`, {
        method: 'PATCH',
        body: patch,
    });
}

/**
 * Delete an alert by ID.
 */
export async function deleteAlert(alertId) {
    return requestJSON(`/api/alerts/${encodeURIComponent(alertId)}`, {
        method: 'DELETE',
    });
}

/**
 * Fetch historical candle data and streaming configuration.
 */
export async function fetchHistory(source, symbol, timeframe, endTime = null, limit = 1000) {
    let url = `/api/history?source=${encodeURIComponent(source)}&symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=${encodeURIComponent(limit)}`;
    if (endTime !== null && endTime !== undefined) {
        url += `&end_time=${encodeURIComponent(endTime)}`;
    }
    return requestJSON(url);
}

/**
 * Fetch symbol suggestions for a data source and optional search query.
 */
export async function fetchSymbols(source, query = '') {
    return requestJSON(`/api/symbols?source=${encodeURIComponent(source)}&q=${encodeURIComponent(query)}`);
}

/**
 * Batch fetch current quotes for [{ source, symbol }, ...].
 */
export async function fetchQuotes(items) {
    const data = await requestJSON('/api/quotes', {
        method: 'POST',
        body: { items },
    });
    return data.quotes || {};
}

/**
 * Export full dashboard backup JSON.
 */
export async function exportBackup() {
    return requestJSON('/api/backup/export');
}

/**
 * Restore dashboard data from backup JSON payload.
 */
export async function importBackup(payload) {
    return requestJSON('/api/backup/import', {
        method: 'POST',
        body: payload,
    });
}
