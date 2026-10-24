/**
 * Whole seconds left until `endAt` (epoch ms). A countdown derived from an end
 * timestamp stays right when iOS throttles background intervals, which a
 * decrement-per-tick counter does not.
 */
export function remainingSeconds(endAt, now) {
  return Math.max(0, Math.ceil((endAt - now) / 1000));
}

/**
 * Seconds a Start tap should count from: resume what is left after a pause,
 * but restart from the selection when nothing is left (null = never started,
 * 0 = rang). `timeLeft ?? selected` kept 0 and rang again immediately.
 */
export function secondsToStart(timeLeft, selected) {
  return timeLeft > 0 ? timeLeft : selected;
}
