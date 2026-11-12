/** One sample for Bklit's LiveLineChart: `time` is unix seconds. */
export type LivePoint = { time: number; value: number }

/**
 * Returns a new buffer with `point` appended and samples older than `windowSec`
 * dropped, keeping the last sample before the cutoff so the line still reaches the
 * chart's left edge. Out-of-order or duplicate samples return `prev` unchanged.
 */
export function appendLive(prev: LivePoint[], point: LivePoint, windowSec: number): LivePoint[] {
  const last = prev[prev.length - 1]
  if (last && point.time <= last.time) return prev
  const cutoff = point.time - windowSec
  let start = 0
  while (start + 1 < prev.length && prev[start + 1].time < cutoff) start++
  return [...prev.slice(start), point]
}
