/**
 * Chart and document theme definitions.
 */

export const THEMES = {
    monochrome: {
        id: 'monochrome',
        label: 'Monokrom',
        chartBackground: '#0b0b0c',
        textColor: '#71717a',
        gridColor: '#161618',
        borderColor: '#222226',
        crosshairColor: '#3f3f46',
        candle: {
            upColor: '#e4e4e7',
            downColor: '#18181b',
            borderUpColor: '#e4e4e7',
            borderDownColor: '#3f3f46',
            wickUpColor: '#e4e4e7',
            wickDownColor: '#3f3f46',
        },
        flow: {
            longFill: 'rgba(34, 197, 94, 0.04)',
            longBorder: 'rgba(34, 197, 94, 0.22)',
            shortFill: 'rgba(239, 68, 68, 0.04)',
            shortBorder: 'rgba(239, 68, 68, 0.22)',
            fib25: 'rgba(113,113,122,0.35)',
            fib50: 'rgba(113,113,122,0.55)',
            fib75: 'rgba(113,113,122,0.35)',
            closeLine: 'rgba(160, 160, 160, 0.55)',
            sweepLine: 'rgba(239, 68, 68, 0.65)',
            zigzag: '#5b86e5',
        },
        drawing: {
            defaultColor: '#e4e4e7',
            selectedColor: '#3b82f6',
            alertColor: '#f59e0b',
            measureFill: 'rgba(59, 130, 246, 0.14)',
            measureStroke: '#3b82f6',
        },
    },
    classic: {
        id: 'classic',
        label: 'Klasik TV',
        chartBackground: '#131722',
        textColor: '#787b86',
        gridColor: '#1e222d',
        borderColor: '#2a2e39',
        crosshairColor: '#758696',
        candle: {
            upColor: '#26a69a',
            downColor: '#ef5350',
            borderUpColor: '#26a69a',
            borderDownColor: '#ef5350',
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350',
        },
        flow: {
            longFill: 'rgba(38, 166, 154, 0.07)',
            longBorder: 'rgba(38, 166, 154, 0.28)',
            shortFill: 'rgba(239, 83, 80, 0.07)',
            shortBorder: 'rgba(239, 83, 80, 0.28)',
            fib25: 'rgba(120,123,134,0.40)',
            fib50: 'rgba(120,123,134,0.65)',
            fib75: 'rgba(120,123,134,0.40)',
            closeLine: 'rgba(209, 212, 220, 0.55)',
            sweepLine: 'rgba(239, 83, 80, 0.75)',
            zigzag: '#2962ff',
        },
        drawing: {
            defaultColor: '#d1d4dc',
            selectedColor: '#2962ff',
            alertColor: '#f59e0b',
            measureFill: 'rgba(41, 98, 255, 0.16)',
            measureStroke: '#2962ff',
        },
    },
};

/**
 * Return the theme object for the given name, falling back to monochrome.
 */
export function getTheme(name) {
    return THEMES[name] || THEMES.monochrome;
}

/**
 * Apply the resolved theme identifier to the root document element.
 */
export function applyDocumentTheme(name) {
    const theme = getTheme(name);
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.setAttribute('data-theme', theme.id);
    }
    return theme;
}
