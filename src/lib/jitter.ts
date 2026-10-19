/**
 * A wait of about `ms`, randomly up to 20% either way, so callers turned away
 * together (listeners sharing a busy voice, say) don't all come back together.
 */
export function jittered(ms: number): number {
  return ms * (0.8 + 0.4 * Math.random());
}
