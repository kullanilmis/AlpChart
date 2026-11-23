"""SQLite persistence layer for AtlasMultiChart / TradingView clone."""

from contextlib import contextmanager
import copy
import json
import math
import os
import sqlite3
import tempfile
import threading
import time
import uuid

_DB_LOCK = threading.RLock()
_CUSTOM_DB_PATH = None

DEFAULT_STATE = {
    "layout": 4,
    "theme": "monochrome",
    "timezone": "Europe/Istanbul",
    "sync": {"crosshair": False, "time": False, "symbol": False},
    "watchlistOpen": True,
    "migratedFromLocalStorage": False,
    "panes": [],
}

DEFAULT_WATCHLIST = [
    ("hyperliquid", "BTC", "Bitcoin"),
    ("hyperliquid", "ETH", "Ethereum"),
    ("hyperliquid", "SOL", "Solana"),
    ("yfinance", "THYAO.IS", "Türk Hava Yolları"),
    ("yfinance", "ASELS.IS", "Aselsan"),
    ("yfinance", "XU100.IS", "BIST 100"),
    ("yfinance", "USDTRY=X", "USD/TRY"),
]

VALID_ALERT_CONDITIONS = ("cross_above", "cross_below")


def get_db_path() -> str:
    """Return the active SQLite database path."""
    if _CUSTOM_DB_PATH:
        return _CUSTOM_DB_PATH
    env_path = os.environ.get("ALPG_DB_PATH")
    if env_path:
        return env_path
    if os.environ.get("VERCEL"):
        return os.path.join(tempfile.gettempdir(), "alpg_data.db")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.db")


def set_db_path(path: str | None) -> str:
    """Override the SQLite database path (e.g. for isolated tests)."""
    global _CUSTOM_DB_PATH
    with _DB_LOCK:
        _CUSTOM_DB_PATH = str(path) if path else None
    return get_db_path()


@contextmanager
def get_connection():
    """Yield a thread-safe SQLite connection configured with WAL mode and Row factory."""
    with _DB_LOCK:
        db_path = get_db_path()
        if db_path != ":memory:":
            parent_dir = os.path.dirname(os.path.abspath(db_path))
            if parent_dir:
                os.makedirs(parent_dir, exist_ok=True)
        conn = sqlite3.connect(db_path, timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=30000")
            conn.execute("PRAGMA foreign_keys=ON")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def init_db() -> None:
    """Create schema tables if needed and seed default watchlist once."""
    now = int(time.time())
    with get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS drawings (
                symbol_key TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS watchlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                symbol TEXT NOT NULL,
                label TEXT NOT NULL,
                position INTEGER NOT NULL,
                UNIQUE(source, symbol)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS alerts (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                symbol TEXT NOT NULL,
                condition TEXT NOT NULL,
                price REAL NOT NULL,
                message TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                triggered_at INTEGER,
                created_at INTEGER NOT NULL
            )
            """
        )

        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'watchlist_seeded'"
        ).fetchone()
        if not row or row["value"] != "1":
            for pos, (source, symbol, label) in enumerate(DEFAULT_WATCHLIST):
                conn.execute(
                    """
                    INSERT OR IGNORE INTO watchlist (source, symbol, label, position)
                    VALUES (?, ?, ?, ?)
                    """,
                    (source.lower(), symbol.strip().upper(), label, pos),
                )
            conn.execute(
                """
                INSERT INTO settings (key, value, updated_at)
                VALUES ('watchlist_seeded', '1', ?)
                ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
                """,
                (now,),
            )


def _merge_state(base: dict, patch: dict) -> dict:
    """Merge top-level state fields and nested sync keys onto a state dict."""
    merged = copy.deepcopy(base)
    if not isinstance(merged.get("sync"), dict):
        merged["sync"] = copy.deepcopy(DEFAULT_STATE["sync"])
    for key, value in patch.items():
        if key == "sync" and isinstance(value, dict):
            merged["sync"].update(value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def _read_state_conn(conn: sqlite3.Connection) -> dict:
    """Read and normalize dashboard_state inside an existing connection."""
    row = conn.execute(
        "SELECT value FROM settings WHERE key = 'dashboard_state'"
    ).fetchone()
    state = copy.deepcopy(DEFAULT_STATE)
    if not row:
        return state
    try:
        parsed = json.loads(row["value"])
    except (TypeError, ValueError):
        return state
    if isinstance(parsed, dict):
        return _merge_state(state, parsed)
    return state


def get_state() -> dict:
    """Return the persisted dashboard state merged with defaults."""
    with get_connection() as conn:
        return _read_state_conn(conn)


def save_state(patch_or_full: dict) -> dict:
    """Merge a partial or full state dict into settings and persist it."""
    if not isinstance(patch_or_full, dict):
        raise ValueError("State payload must be a JSON object")
    now = int(time.time())
    with get_connection() as conn:
        current = _read_state_conn(conn)
        updated = _merge_state(current, patch_or_full)
        conn.execute(
            """
            INSERT INTO settings (key, value, updated_at)
            VALUES ('dashboard_state', ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            """,
            (json.dumps(updated), now),
        )
        return updated


def get_drawings(symbol_key: str) -> list:
    """Return parsed drawing items for a symbol_key, or [] if none exist."""
    key = str(symbol_key or "").strip()
    if not key:
        return []
    with get_connection() as conn:
        row = conn.execute(
            "SELECT data FROM drawings WHERE symbol_key = ?", (key,)
        ).fetchone()
        if not row:
            return []
        try:
            parsed = json.loads(row["data"])
            return parsed if isinstance(parsed, list) else []
        except (TypeError, ValueError):
            return []


def save_drawings(symbol_key: str, drawings_list: list) -> list:
    """Persist drawing items for a symbol_key and return the saved list."""
    key = str(symbol_key or "").strip()
    if not key:
        raise ValueError("symbol_key is required")
    if not isinstance(drawings_list, list):
        raise ValueError("drawings must be a list")
    now = int(time.time())
    saved = copy.deepcopy(drawings_list)
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO drawings (symbol_key, data, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(symbol_key) DO UPDATE SET
                data = excluded.data,
                updated_at = excluded.updated_at
            """,
            (key, json.dumps(saved), now),
        )
    return saved


def get_all_drawings() -> dict:
    """Return a dict mapping symbol_key -> drawing list for all stored symbols."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT symbol_key, data FROM drawings ORDER BY symbol_key ASC"
        ).fetchall()
    result = {}
    for row in rows:
        try:
            parsed = json.loads(row["data"])
            result[row["symbol_key"]] = parsed if isinstance(parsed, list) else []
        except (TypeError, ValueError):
            result[row["symbol_key"]] = []
    return result


def _row_to_watchlist_dict(row: sqlite3.Row) -> dict:
    return {
        "id": int(row["id"]),
        "source": row["source"],
        "symbol": row["symbol"],
        "label": row["label"],
        "position": int(row["position"]),
    }


def get_watchlist() -> list[dict]:
    """Return all watchlist items ordered by position ASC, id ASC."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, source, symbol, label, position
            FROM watchlist
            ORDER BY position ASC, id ASC
            """
        ).fetchall()
    return [_row_to_watchlist_dict(r) for r in rows]


def add_watchlist_item(source: str, symbol: str, label: str = "") -> dict:
    """Add or update a watchlist item with normalized source and symbol."""
    norm_source = str(source or "").strip().lower()
    norm_symbol = str(symbol or "").strip().upper()
    norm_label = str(label if label is not None else "").strip()
    if not norm_source or not norm_symbol:
        raise ValueError("source and symbol are required")

    with get_connection() as conn:
        existing = conn.execute(
            """
            SELECT id, source, symbol, label, position
            FROM watchlist
            WHERE source = ? AND symbol = ?
            """,
            (norm_source, norm_symbol),
        ).fetchone()
        if existing:
            if norm_label and norm_label != existing["label"]:
                conn.execute(
                    "UPDATE watchlist SET label = ? WHERE id = ?",
                    (norm_label, existing["id"]),
                )
                updated = conn.execute(
                    "SELECT id, source, symbol, label, position FROM watchlist WHERE id = ?",
                    (existing["id"],),
                ).fetchone()
                return _row_to_watchlist_dict(updated)
            return _row_to_watchlist_dict(existing)

        next_pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM watchlist"
        ).fetchone()[0]
        cur = conn.execute(
            """
            INSERT INTO watchlist (source, symbol, label, position)
            VALUES (?, ?, ?, ?)
            """,
            (norm_source, norm_symbol, norm_label, int(next_pos)),
        )
        created = conn.execute(
            "SELECT id, source, symbol, label, position FROM watchlist WHERE id = ?",
            (cur.lastrowid,),
        ).fetchone()
        return _row_to_watchlist_dict(created)


def delete_watchlist_item(item_id: int) -> bool:
    """Delete a watchlist item by ID. Returns True if a row was deleted."""
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM watchlist WHERE id = ?", (int(item_id),))
        return cur.rowcount > 0


def _row_to_alert_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "source": row["source"],
        "symbol": row["symbol"],
        "condition": row["condition"],
        "price": float(row["price"]),
        "message": row["message"],
        "active": bool(row["active"]),
        "triggered_at": row["triggered_at"],
        "created_at": int(row["created_at"]),
    }


def _normalize_alert_payload(alert_dict: dict) -> dict:
    if not isinstance(alert_dict, dict):
        raise ValueError("Alert payload must be a JSON object")

    source = str(alert_dict.get("source") or "").strip().lower()
    symbol = str(alert_dict.get("symbol") or "").strip().upper()
    if not source or not symbol:
        raise ValueError("source and symbol are required")

    condition = str(alert_dict.get("condition") or "").strip()
    if condition not in VALID_ALERT_CONDITIONS:
        raise ValueError("condition must be 'cross_above' or 'cross_below'")

    try:
        price = float(alert_dict["price"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("price must be a valid number")
    if not math.isfinite(price):
        raise ValueError("price must be finite")

    message = str(alert_dict.get("message") or "").strip()
    active_int = 1 if alert_dict.get("active", True) else 0

    raw_triggered = alert_dict.get("triggered_at")
    if raw_triggered is not None:
        try:
            triggered_at = int(raw_triggered)
        except (TypeError, ValueError):
            raise ValueError("triggered_at must be an integer timestamp or null")
    else:
        triggered_at = None

    raw_created = alert_dict.get("created_at")
    if raw_created is not None:
        try:
            created_at = int(raw_created)
        except (TypeError, ValueError):
            raise ValueError("created_at must be an integer timestamp")
    else:
        created_at = int(time.time())

    alert_id = str(alert_dict.get("id") or "").strip()
    if not alert_id:
        alert_id = f"alert_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"

    return {
        "id": alert_id,
        "source": source,
        "symbol": symbol,
        "condition": condition,
        "price": price,
        "message": message,
        "active_int": active_int,
        "triggered_at": triggered_at,
        "created_at": created_at,
    }


def get_alerts() -> list[dict]:
    """Return all alerts ordered by created_at DESC."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, source, symbol, condition, price, message, active, triggered_at, created_at
            FROM alerts
            ORDER BY created_at DESC, rowid DESC
            """
        ).fetchall()
    return [_row_to_alert_dict(r) for r in rows]


def create_alert(alert_dict: dict) -> dict:
    """Validate and insert a new alert, returning the full alert dict."""
    norm = _normalize_alert_payload(alert_dict)
    with get_connection() as conn:
        try:
            conn.execute(
                """
                INSERT INTO alerts (
                    id, source, symbol, condition, price, message, active, triggered_at, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    norm["id"],
                    norm["source"],
                    norm["symbol"],
                    norm["condition"],
                    norm["price"],
                    norm["message"],
                    norm["active_int"],
                    norm["triggered_at"],
                    norm["created_at"],
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"Alert already exists: {norm['id']}") from exc

        row = conn.execute(
            """
            SELECT id, source, symbol, condition, price, message, active, triggered_at, created_at
            FROM alerts
            WHERE id = ?
            """,
            (norm["id"],),
        ).fetchone()
    return _row_to_alert_dict(row)


def update_alert(alert_id: str, patch: dict) -> dict | None:
    """Update allowed fields on an existing alert. Returns None if not found."""
    if not isinstance(patch, dict):
        raise ValueError("Alert patch must be a JSON object")
    aid = str(alert_id or "").strip()
    if not aid:
        return None

    updates = {}
    if "active" in patch:
        updates["active"] = 1 if patch["active"] else 0
    if "triggered_at" in patch:
        raw_triggered = patch["triggered_at"]
        if raw_triggered is None:
            updates["triggered_at"] = None
        else:
            try:
                updates["triggered_at"] = int(raw_triggered)
            except (TypeError, ValueError):
                raise ValueError("triggered_at must be an integer timestamp or null")
    if "price" in patch:
        try:
            price = float(patch["price"])
        except (TypeError, ValueError):
            raise ValueError("price must be a valid number")
        if not math.isfinite(price):
            raise ValueError("price must be finite")
        updates["price"] = price
    if "condition" in patch:
        cond = str(patch["condition"] or "").strip()
        if cond not in VALID_ALERT_CONDITIONS:
            raise ValueError("condition must be 'cross_above' or 'cross_below'")
        updates["condition"] = cond
    if "message" in patch:
        updates["message"] = str(patch["message"] if patch["message"] is not None else "").strip()

    with get_connection() as conn:
        existing = conn.execute(
            """
            SELECT id, source, symbol, condition, price, message, active, triggered_at, created_at
            FROM alerts
            WHERE id = ?
            """,
            (aid,),
        ).fetchone()
        if not existing:
            return None

        if updates:
            set_clause = ", ".join(f"{col} = ?" for col in updates.keys())
            params = list(updates.values()) + [aid]
            conn.execute(f"UPDATE alerts SET {set_clause} WHERE id = ?", params)

        updated = conn.execute(
            """
            SELECT id, source, symbol, condition, price, message, active, triggered_at, created_at
            FROM alerts
            WHERE id = ?
            """,
            (aid,),
        ).fetchone()
    return _row_to_alert_dict(updated)


def delete_alert(alert_id: str) -> bool:
    """Delete an alert by ID. Returns True if deleted."""
    aid = str(alert_id or "").strip()
    if not aid:
        return False
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM alerts WHERE id = ?", (aid,))
        return cur.rowcount > 0


def export_all() -> dict:
    """Export complete dashboard state, drawings, watchlist, and alerts."""
    return {
        "version": 2,
        "exportedAt": int(time.time()),
        "state": get_state(),
        "drawings": get_all_drawings(),
        "watchlist": get_watchlist(),
        "alerts": get_alerts(),
    }


def import_all(payload: dict) -> dict:
    """Restore state, drawings, watchlist, and alerts inside a single transaction."""
    if not isinstance(payload, dict):
        raise ValueError("Backup payload must be a JSON object")

    now = int(time.time())
    summary = {"state": 0, "drawings": 0, "watchlist": 0, "alerts": 0}

    with get_connection() as conn:
        if "state" in payload:
            if not isinstance(payload["state"], dict):
                raise ValueError("Backup 'state' field must be an object")
            restored_state = _merge_state(DEFAULT_STATE, payload["state"])
            conn.execute(
                """
                INSERT INTO settings (key, value, updated_at)
                VALUES ('dashboard_state', ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (json.dumps(restored_state), now),
            )
            summary["state"] = 1

        if "drawings" in payload:
            if not isinstance(payload["drawings"], dict):
                raise ValueError("Backup 'drawings' field must be an object")
            conn.execute("DELETE FROM drawings")
            for symbol_key, items in payload["drawings"].items():
                key = str(symbol_key or "").strip()
                if not key:
                    continue
                if not isinstance(items, list):
                    raise ValueError(f"Drawings for '{key}' must be a list")
                conn.execute(
                    """
                    INSERT INTO drawings (symbol_key, data, updated_at)
                    VALUES (?, ?, ?)
                    """,
                    (key, json.dumps(items), now),
                )
                summary["drawings"] += 1

        if "watchlist" in payload:
            if not isinstance(payload["watchlist"], list):
                raise ValueError("Backup 'watchlist' field must be a list")
            conn.execute("DELETE FROM watchlist")
            seen_pairs = set()
            pos = 0
            for item in payload["watchlist"]:
                if not isinstance(item, dict):
                    raise ValueError("Each watchlist entry must be an object")
                src = str(item.get("source") or "").strip().lower()
                sym = str(item.get("symbol") or "").strip().upper()
                lbl = str(item.get("label") if item.get("label") is not None else "").strip()
                if not src or not sym:
                    raise ValueError("Watchlist items require 'source' and 'symbol'")
                if (src, sym) in seen_pairs:
                    continue
                seen_pairs.add((src, sym))
                conn.execute(
                    """
                    INSERT INTO watchlist (source, symbol, label, position)
                    VALUES (?, ?, ?, ?)
                    """,
                    (src, sym, lbl, pos),
                )
                pos += 1
            conn.execute(
                """
                INSERT INTO settings (key, value, updated_at)
                VALUES ('watchlist_seeded', '1', ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = '1',
                    updated_at = excluded.updated_at
                """,
                (now,),
            )
            summary["watchlist"] = pos

        if "alerts" in payload:
            if not isinstance(payload["alerts"], list):
                raise ValueError("Backup 'alerts' field must be a list")
            conn.execute("DELETE FROM alerts")
            for raw_alert in payload["alerts"]:
                norm = _normalize_alert_payload(raw_alert)
                conn.execute(
                    """
                    INSERT INTO alerts (
                        id, source, symbol, condition, price, message, active, triggered_at, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        norm["id"],
                        norm["source"],
                        norm["symbol"],
                        norm["condition"],
                        norm["price"],
                        norm["message"],
                        norm["active_int"],
                        norm["triggered_at"],
                        norm["created_at"],
                    ),
                )
                summary["alerts"] += 1

    return summary
