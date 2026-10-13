// Reality check timing (FR-RG-008).

export const MIN_REALITY_CHECK_MINUTES = 15;
export const MAX_REALITY_CHECK_MINUTES = 120;

export interface RealityCheckSettings {
  intervalMinutes: number;
}

/**
 * When the next reality check is due: one interval after the last acknowledgement,
 * or after the session start when nothing has been acknowledged yet.
 */
export const nextRealityCheck = (sessionStart: Date, lastAck: Date | null, settings: RealityCheckSettings): Date => {
  const base = lastAck && lastAck > sessionStart ? lastAck : sessionStart;
  return new Date(base.getTime() + settings.intervalMinutes * 60_000);
};
