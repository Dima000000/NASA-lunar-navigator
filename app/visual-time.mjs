const normalize = (a) => {
  const n = Math.hypot(...a);
  return a.map((v) => v / n);
};
export function interpolateVisualState(ephem, ms) {
  const hour = 3600000,
    a = Math.floor(ms / hour) * hour,
    f = (ms - a) / hour;
  if (f === 0) return ephem.state(ms);
  const p = ephem.state(a),
    q = ephem.state(Math.min(a + hour, ephem.last ?? Infinity));
  const body = (u, v) => {
    const ru = Math.hypot(...u),
      rv = Math.hypot(...v),
      x = normalize(u),
      y = normalize(v),
      angle = Math.acos(
        Math.max(
          -1,
          Math.min(
            1,
            x.reduce((s, n, k) => s + n * y[k], 0),
          ),
        ),
      );
    const direction =
      angle < 1e-7
        ? normalize(x.map((n, k) => n * (1 - f) + y[k] * f))
        : x.map(
            (n, k) =>
              (n * Math.sin((1 - f) * angle) + y[k] * Math.sin(f * angle)) /
              Math.sin(angle),
          );
    return direction.map((n) => n * (ru * (1 - f) + rv * f));
  };
  return { sun: body(p.sun, q.sun), earth: body(p.earth, q.earth) };
}
