/**
 * Technical indicator calculators: EMA, RSI, and Flow V2.5.
 */

/**
 * Compute Exponential Moving Average (SMA seed followed by EMA smoothing).
 */
export function calculateEMA(candles, period) {
    if (!candles || !period || period <= 0 || candles.length < period) return [];
    const ema = [];

    // SMA for the first value
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += candles[i].close;
    }
    let prevEma = sum / period;
    ema.push({ time: candles[period - 1].time, value: prevEma });

    const multiplier = 2 / (period + 1);
    for (let i = period; i < candles.length; i++) {
        const val = (candles[i].close - prevEma) * multiplier + prevEma;
        ema.push({ time: candles[i].time, value: val });
        prevEma = val;
    }
    return ema;
}

/**
 * Compute Relative Strength Index using Wilder's smoothing.
 */
export function calculateRSI(candles, period = 14) {
    if (!candles || !period || period <= 0 || candles.length < period + 1) return [];
    const rsi = [];

    let gains = 0;
    let losses = 0;

    // First RSI (SMA basis)
    for (let i = 1; i <= period; i++) {
        const diff = candles[i].close - candles[i - 1].close;
        if (diff > 0) gains += diff;
        else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push({ time: candles[period].time, value: 100 - (100 / (1 + rs)) });

    // Wilder's smoothing
    for (let i = period + 1; i < candles.length; i++) {
        const diff = candles[i].close - candles[i - 1].close;
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi.push({ time: candles[i].time, value: 100 - (100 / (1 + rs)) });
    }
    return rsi;
}

function createFlowBox(leftTime, rightTime, top, bottom, isLong, showFibLevels) {
    const fibRange = top - bottom;
    const boxData = {
        left_time: leftTime,
        right_time: rightTime,
        top,
        bottom,
        is_long: isLong,
        is_current: true,
    };
    if (showFibLevels && fibRange > 0) {
        boxData.fib_levels = {
            '0.25': bottom + fibRange * 0.25,
            '0.50': bottom + fibRange * 0.50,
            '0.75': bottom + fibRange * 0.75,
        };
    }
    return boxData;
}

/**
 * Compute Flow V2.5 indicator (ZigZag, close/sweep lines, structural boxes + fib levels).
 * 1:1 port of backend/flow_indicator.py:compute_flow.
 */
export function computeFlowJS(candles, settings = {}) {
    const empty = {
        zigzag_segments: [],
        close_lines: [],
        sweep_lines: [],
        boxes: [],
    };

    if (!candles || candles.length < 3) {
        return empty;
    }

    const s = {
        history_box_count: 3,
        show_fib_levels: true,
        ...(settings || {}),
    };
    const showFibLevels = s.show_fib_levels === undefined ? true : Boolean(s.show_fib_levels);
    const maxHistory = s.history_box_count === undefined ? 3 : s.history_box_count;

    const n = candles.length;

    // State Variables (Pine Script 'var' equivalents)
    let top = candles[0].high;
    let bot = candles[0].low;
    let lastTop = top;
    let lastBot = bot;

    let puUp = candles[0].high;
    let puDn = candles[0].low;
    let puUpbar = 0;
    let puDnbar = 0;

    let mainH = candles[0].high;
    let mainL = candles[0].low;
    let mainHBar = 0;
    let mainLBar = 0;

    let maksMum = candles[0].high;
    let minMum = candles[0].low;
    let maksMumBar = 0;
    let minMumBar = 0;

    let lastHH = mainH;
    let lastLL = mainL;

    let yon = false;
    let refBar = 0;
    let lastRefBar = 0;

    const zigzag_segments = [];
    const close_lines = [];
    const sweep_lines = [];

    let current_box = null;
    let history_boxes = [];

    for (let i = 1; i < n; i++) {
        const c = candles[i];
        const h = c.high;
        const l = c.low;
        const cl = c.close;
        const t = c.time;
        const is_confirmed = i < n - 1;

        // Skip zero-range candles
        if (h <= l) {
            lastTop = top;
            top = h;
            puUpbar = i;
            lastRefBar = refBar;
            refBar = i;
            lastBot = bot;
            bot = l;
            puDnbar = i;
            continue;
        }

        // Minor Pivot HIGH
        if (h <= top && top > lastTop) {
            puUpbar = refBar;
            puUp = top;
            maksMum = top;
            maksMumBar = refBar;
            if (maksMum > mainH) {
                mainH = maksMum;
                mainHBar = maksMumBar;
            }
        }

        // Minor Pivot LOW
        if (l >= bot && bot < lastBot) {
            puDnbar = refBar;
            puDn = bot;
            minMum = bot;
            minMumBar = refBar;
            if (minMum < mainL) {
                mainLBar = minMumBar;
                mainL = minMum;
            }
        }

        // Structural Break DOWN (Bearish)
        if (l < mainL && lastLL !== mainL) {
            if (cl < mainL) {
                if (!yon) {
                    zigzag_segments.push({
                        x1_time: candles[mainHBar].time,
                        y1: candles[mainHBar].high,
                        x2_time: candles[mainLBar].time,
                        y2: candles[mainLBar].low,
                    });
                }

                const save_mainLBar = mainLBar;
                const save_mainL = mainL;

                mainHBar = i;
                mainH = h;
                const scan_end = i - save_mainLBar;
                for (let j = 1; j <= scan_end; j++) {
                    const idx = i - j;
                    if (idx >= 0 && candles[idx].high > mainH) {
                        mainH = candles[idx].high;
                        mainHBar = idx;
                    }
                }

                zigzag_segments.push({
                    x1_time: candles[mainHBar].time,
                    y1: candles[mainHBar].high,
                    x2_time: candles[save_mainLBar].time,
                    y2: candles[save_mainLBar].low,
                });

                close_lines.push({
                    x1_time: candles[save_mainLBar].time,
                    y1: save_mainL,
                    x2_time: t,
                    y2: save_mainL,
                });
                close_lines.push({
                    x1_time: candles[mainHBar].time,
                    y1: mainH,
                    x2_time: t,
                    y2: mainH,
                });

                const box_left = Math.min(save_mainLBar, mainHBar);
                const box_data = createFlowBox(
                    candles[box_left].time,
                    t,
                    mainH,
                    save_mainL,
                    false,
                    showFibLevels,
                );

                if (current_box !== null) {
                    current_box.is_current = false;
                    history_boxes.push(current_box);
                }

                current_box = box_data;
                yon = false;
                lastLL = mainL;
            } else if (is_confirmed) {
                sweep_lines.push({
                    x1_time: candles[mainLBar].time,
                    y1: mainL,
                    x2_time: t,
                    y2: mainL,
                });
                lastLL = mainL;
                mainL = l;
            }
        }

        // Structural Break UP (Bullish)
        if (h > mainH && lastHH !== mainH) {
            if (cl > mainH) {
                if (yon) {
                    zigzag_segments.push({
                        x1_time: candles[mainHBar].time,
                        y1: candles[mainHBar].high,
                        x2_time: candles[mainLBar].time,
                        y2: candles[mainLBar].low,
                    });
                }

                const save_mainHBar = mainHBar;
                const save_mainH = mainH;

                mainLBar = i;
                mainL = l;
                const scan_end = i - save_mainHBar;
                for (let j = 1; j <= scan_end; j++) {
                    const idx = i - j;
                    if (idx >= 0 && candles[idx].low < mainL) {
                        mainL = candles[idx].low;
                        mainLBar = idx;
                    }
                }

                zigzag_segments.push({
                    x1_time: candles[save_mainHBar].time,
                    y1: candles[save_mainHBar].high,
                    x2_time: candles[mainLBar].time,
                    y2: candles[mainLBar].low,
                });

                close_lines.push({
                    x1_time: candles[mainLBar].time,
                    y1: mainL,
                    x2_time: t,
                    y2: mainL,
                });
                close_lines.push({
                    x1_time: candles[save_mainHBar].time,
                    y1: save_mainH,
                    x2_time: t,
                    y2: save_mainH,
                });

                const box_left = Math.min(mainLBar, save_mainHBar);
                const box_data = createFlowBox(
                    candles[box_left].time,
                    t,
                    save_mainH,
                    mainL,
                    true,
                    showFibLevels,
                );

                if (current_box !== null) {
                    current_box.is_current = false;
                    history_boxes.push(current_box);
                }

                current_box = box_data;
                yon = true;
                lastHH = mainH;
            } else if (is_confirmed) {
                sweep_lines.push({
                    x1_time: candles[mainHBar].time,
                    y1: mainH,
                    x2_time: t,
                    y2: mainH,
                });
                lastHH = mainH;
                mainH = h;
            }
        }

        // Update trailing variables
        lastTop = top;
        top = h;
        puUpbar = i;
        lastRefBar = refBar;
        refBar = i;
        lastBot = bot;
        bot = l;
        puDnbar = i;
    }

    // Extend current (active) box to the last candle
    if (current_box !== null) {
        current_box.right_time = candles[n - 1].time;
    }

    // Trim history boxes to configured limit
    if (history_boxes.length > maxHistory) {
        history_boxes = history_boxes.slice(-maxHistory);
    }

    const result_boxes = [...history_boxes];
    if (current_box !== null) {
        result_boxes.push(current_box);
    }

    return {
        zigzag_segments,
        close_lines,
        sweep_lines,
        boxes: result_boxes,
    };
}
