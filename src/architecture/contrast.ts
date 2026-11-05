/** WCAG 2 contrast ratio of two #rrggbb colours: 1 (none) to 21 (black on white). Null for other values. */
export function contrastRatio(a: string | null, b: string | null): number | null {
  const luminance = (hex: string | null) => {
    const m = hex?.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
    if (!m) return null;
    const [r, g, b] = m.slice(1).map(part => { const c = parseInt(part, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const x = luminance(a), y = luminance(b);
  if (x === null || y === null) return null;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
