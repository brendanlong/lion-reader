/**
 * Maps a client-stamped change time onto the server clock.
 *
 * Read/star writes resolve conflicts by `changedAt` (last writer wins), so a
 * device whose clock runs ahead would win every conflict for as long as its
 * clock stays ahead. A client that sends `clientSentAt` (its clock when it sent
 * the request) has its timestamps shifted by the observed offset, which also
 * corrects an offline queue flushed hours later; every timestamp is then capped
 * at the server's `now`.
 */
export function toServerTime(
  changedAt: Date | undefined,
  clientSentAt: Date | undefined,
  now: Date = new Date()
): Date {
  if (!changedAt) {
    return now;
  }
  const offsetMs = clientSentAt ? now.getTime() - clientSentAt.getTime() : 0;
  return new Date(Math.min(changedAt.getTime() + offsetMs, now.getTime()));
}
