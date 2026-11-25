/** Server-only analytics routes are disabled in static GitHub Pages builds. */
export const visitsApiEnabled = import.meta.env.VITE_VISITS_API !== 'false';
