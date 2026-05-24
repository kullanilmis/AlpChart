"""
Flow V2.5 Indicator – Python Implementation
=============================================
Translated from Pine Script "Alp_g Flow V2.5" by @hilmituncay @alp_g

Phase 1: ZigZag + Structural Boxes + Fibonacci Levels
Phase 2 (future): Volume Profile (Hacim Profili)
"""


def compute_flow(candles, settings=None):
    """
    Main entry point. Computes the Flow V2.5 indicator on the given candle data.

    Args:
        candles: list of dicts with keys: time, open, high, low, close, volume
        settings: optional dict with configuration overrides

    Returns:
        dict with:
            - zigzag_segments: list of line segments connecting structural points
            - close_lines:  horizontal segments at confirmed structural levels
            - sweep_lines:  horizontal segments at swept (but unbroken) levels
            - boxes:        structural boxes with fibonacci levels
    """
    empty = {
        'zigzag_segments': [],
        'close_lines': [],
        'sweep_lines': [],
        'boxes': []
    }

    if not candles or len(candles) < 3:
        return empty

    # Settings with defaults
    s = {
        'history_box_count': 3,
        'show_fib_levels': True,
    }
    if settings:
        s.update(settings)

    n = len(candles)

    # ==========================================================
    # State Variables  (Pine Script 'var' equivalents)
    # These persist across bars, mirroring the Pine Script state.
    # ==========================================================
    top = candles[0]['high']          # Previous bar's high
    bot = candles[0]['low']           # Previous bar's low
    lastTop = top                    # High two bars ago
    lastBot = bot                    # Low two bars ago

    puUp = candles[0]['high']         # Minor pivot up price
    puDn = candles[0]['low']          # Minor pivot down price
    puUpbar = 0                      # Minor pivot up bar index
    puDnbar = 0                      # Minor pivot down bar index

    mainH = candles[0]['high']        # Structural high price
    mainL = candles[0]['low']         # Structural low price
    mainHBar = 0                     # Structural high bar index
    mainLBar = 0                     # Structural low bar index

    maksMum = candles[0]['high']      # Running max candle high
    minMum = candles[0]['low']        # Running min candle low
    maksMumBar = 0
    minMumBar = 0

    lastHH = mainH                   # Last Higher-High (prevents re-detection)
    lastLL = mainL                   # Last Lower-Low  (prevents re-detection)

    yon = False                      # Direction: True=bullish, False=bearish
    refBar = 0                       # Reference bar (previous bar's index)
    lastRefBar = 0

    # ==========================================================
    # Result Collectors
    # ==========================================================
    zigzag_segments = []
    close_lines = []
    sweep_lines = []

    # Box management
    current_box = None               # Currently active (extending) box
    history_boxes = []               # Past completed boxes

    # ==========================================================
    # Main Bar-by-Bar Processing Loop
    # ==========================================================
    for i in range(1, n):
        c = candles[i]
        h = c['high']
        l = c['low']
        cl = c['close']
        t = c['time']
        is_confirmed = (i < n - 1)   # barstate.isconfirmed equivalent

        # Skip zero-range candles
        if h <= l:
            lastTop = top
            top = h
            puUpbar = i
            lastRefBar = refBar
            refBar = i
            lastBot = bot
            bot = l
            puDnbar = i
            continue

        # ======================================================
        # Minor Pivot Detection
        # ======================================================

        # Minor pivot HIGH:
        #   previous bar was a local high (top > lastTop)
        #   current bar confirms it (h <= top)
        if h <= top and top > lastTop:
            puUpbar = refBar
            puUp = top
            maksMum = top
            maksMumBar = refBar
            if maksMum > mainH:
                mainH = maksMum
                mainHBar = maksMumBar

        # Minor pivot LOW:
        #   previous bar was a local low (bot < lastBot)
        #   current bar confirms it (l >= bot)
        if l >= bot and bot < lastBot:
            puDnbar = refBar
            puDn = bot
            minMum = bot
            minMumBar = refBar
            if minMum < mainL:
                mainLBar = minMumBar
                mainL = minMum

        # ======================================================
        # Structural Break DOWN  (Bearish)
        # ======================================================
        if l < mainL and lastLL != mainL:
            if cl < mainL:
                # ---- Confirmed bearish break ----

                # If previous break was also bearish → draw intermediate zigzag
                if not yon:
                    zigzag_segments.append({
                        'x1_time': candles[mainHBar]['time'],
                        'y1': candles[mainHBar]['high'],
                        'x2_time': candles[mainLBar]['time'],
                        'y2': candles[mainLBar]['low']
                    })

                # Save old mainLBar before updating mainH
                save_mainLBar = mainLBar
                save_mainL = mainL

                # Find new structural HIGH by scanning backwards
                # from current bar to the structural low bar
                mainHBar = i
                mainH = h
                scan_end = i - save_mainLBar
                for j in range(1, scan_end + 1):
                    idx = i - j
                    if idx >= 0 and candles[idx]['high'] > mainH:
                        mainH = candles[idx]['high']
                        mainHBar = idx

                # Zigzag from NEW mainH to OLD mainL
                zigzag_segments.append({
                    'x1_time': candles[mainHBar]['time'],
                    'y1': candles[mainHBar]['high'],
                    'x2_time': candles[save_mainLBar]['time'],
                    'y2': candles[save_mainLBar]['low']
                })

                # Close lines (horizontal structural level markers)
                close_lines.append({
                    'x1_time': candles[save_mainLBar]['time'],
                    'y1': save_mainL,
                    'x2_time': t,
                    'y2': save_mainL
                })
                close_lines.append({
                    'x1_time': candles[mainHBar]['time'],
                    'y1': mainH,
                    'x2_time': t,
                    'y2': mainH
                })

                # Create SHORT box
                box_left = min(save_mainLBar, mainHBar)
                fib_range = mainH - save_mainL
                box_data = {
                    'left_time': candles[box_left]['time'],
                    'right_time': t,
                    'top': mainH,
                    'bottom': save_mainL,
                    'is_long': False,
                    'is_current': True,
                }
                if s.get('show_fib_levels', True) and fib_range > 0:
                    box_data['fib_levels'] = {
                        '0.25': save_mainL + fib_range * 0.25,
                        '0.50': save_mainL + fib_range * 0.50,
                        '0.75': save_mainL + fib_range * 0.75,
                    }

                # Move previous current box to history
                if current_box is not None:
                    current_box['is_current'] = False
                    history_boxes.append(current_box)

                current_box = box_data
                yon = False
                lastLL = mainL

            elif is_confirmed:
                # ---- Sweep (wick below but close above) ----
                sweep_lines.append({
                    'x1_time': candles[mainLBar]['time'],
                    'y1': mainL,
                    'x2_time': t,
                    'y2': mainL
                })
                lastLL = mainL
                mainL = l

        # ======================================================
        # Structural Break UP  (Bullish)
        # ======================================================
        if h > mainH and lastHH != mainH:
            if cl > mainH:
                # ---- Confirmed bullish break ----

                # If previous break was also bullish → draw intermediate zigzag
                if yon:
                    zigzag_segments.append({
                        'x1_time': candles[mainHBar]['time'],
                        'y1': candles[mainHBar]['high'],
                        'x2_time': candles[mainLBar]['time'],
                        'y2': candles[mainLBar]['low']
                    })

                # Save old mainHBar before updating mainL
                save_mainHBar = mainHBar
                save_mainH = mainH

                # Find new structural LOW by scanning backwards
                # from current bar to the structural high bar
                mainLBar = i
                mainL = l
                scan_end = i - save_mainHBar
                for j in range(1, scan_end + 1):
                    idx = i - j
                    if idx >= 0 and candles[idx]['low'] < mainL:
                        mainL = candles[idx]['low']
                        mainLBar = idx

                # Zigzag from OLD mainH to NEW mainL
                zigzag_segments.append({
                    'x1_time': candles[save_mainHBar]['time'],
                    'y1': candles[save_mainHBar]['high'],
                    'x2_time': candles[mainLBar]['time'],
                    'y2': candles[mainLBar]['low']
                })

                # Close lines
                close_lines.append({
                    'x1_time': candles[mainLBar]['time'],
                    'y1': mainL,
                    'x2_time': t,
                    'y2': mainL
                })
                close_lines.append({
                    'x1_time': candles[save_mainHBar]['time'],
                    'y1': save_mainH,
                    'x2_time': t,
                    'y2': save_mainH
                })

                # Create LONG box
                box_left = min(mainLBar, save_mainHBar)
                fib_range = save_mainH - mainL
                box_data = {
                    'left_time': candles[box_left]['time'],
                    'right_time': t,
                    'top': save_mainH,
                    'bottom': mainL,
                    'is_long': True,
                    'is_current': True,
                }
                if s.get('show_fib_levels', True) and fib_range > 0:
                    box_data['fib_levels'] = {
                        '0.25': mainL + fib_range * 0.25,
                        '0.50': mainL + fib_range * 0.50,
                        '0.75': mainL + fib_range * 0.75,
                    }

                if current_box is not None:
                    current_box['is_current'] = False
                    history_boxes.append(current_box)

                current_box = box_data
                yon = True
                lastHH = mainH

            elif is_confirmed:
                # ---- Sweep (wick above but close below) ----
                sweep_lines.append({
                    'x1_time': candles[mainHBar]['time'],
                    'y1': mainH,
                    'x2_time': t,
                    'y2': mainH
                })
                lastHH = mainH
                mainH = h

        # ======================================================
        # Update Trailing Variables (end of each bar)
        # ======================================================
        lastTop = top
        top = h
        puUpbar = i
        lastRefBar = refBar
        refBar = i
        lastBot = bot
        bot = l
        puDnbar = i

    # ==========================================================
    # Finalize Results
    # ==========================================================

    # Extend current (active) box to the last candle
    if current_box is not None:
        current_box['right_time'] = candles[-1]['time']

    # Trim history boxes to configured limit
    max_history = s.get('history_box_count', 3)
    if len(history_boxes) > max_history:
        history_boxes = history_boxes[-max_history:]

    # Combine: history boxes + current box
    result_boxes = list(history_boxes)
    if current_box is not None:
        result_boxes.append(current_box)

    return {
        'zigzag_segments': zigzag_segments,
        'close_lines': close_lines,
        'sweep_lines': sweep_lines,
        'boxes': result_boxes
    }
