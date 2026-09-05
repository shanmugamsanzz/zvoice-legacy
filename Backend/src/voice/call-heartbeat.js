// A failed renewal does not invalidate an unexpired lease. Retry transient
// failures, but never continue past the last positively confirmed lease.
export function startCallHeartbeat({ session, ownership, intervalMs, ttlMs,
  claimedAt = performance.now(), now = () => performance.now(),
  schedule = setTimeout, unschedule = clearTimeout }) {
  const marginMs = Math.min(1000, ttlMs / 10);
  let deadline = claimedAt + ttlMs - marginMs;
  let retryTimer;
  let expiryTimer;
  let stopped = false;
  let failures = 0;
  const fields = { callId: session.callId, stage: 'voice.heartbeat' };
  const stop = () => {
    stopped = true;
    unschedule(retryTimer);
    unschedule(expiryTimer);
  };
  const close = (reason) => {
    if (stopped) return;
    stop();
    session.close(1012, reason);
  };
  const expire = () => {
    if (stopped || session.closed) return;
    session.log.error({ ...fields, failures }, 'Voice heartbeat lease expired without a successful renewal');
    close('voice call heartbeat lease expired');
  };
  const armExpiry = () => {
    unschedule(expiryTimer);
    expiryTimer = schedule(expire, Math.max(0, deadline - now()));
    expiryTimer.unref?.();
  };
  const queue = (delay) => {
    retryTimer = schedule(() => void renew(), Math.max(0, Math.min(delay, deadline - now())));
    retryTimer.unref?.();
  };
  const renew = async () => {
    if (stopped || session.closed) return;
    if (now() >= deadline) { expire(); return; }
    // Count lease lifetime from the request's start, not the delayed response.
    const sentAt = now();
    try {
      const owned = await ownership.heartbeat({ tenantId: session.call.tenantId, providerCallId: session.providerCallId });
      if (stopped || session.closed) return;
      if (now() >= deadline) { expire(); return; }
      if (!owned) { close('voice call ownership lost'); return; }
      if (failures) session.log.info({ ...fields, failures }, 'Voice heartbeat recovered; call continues');
      failures = 0;
      deadline = sentAt + ttlMs - marginMs;
      armExpiry();
      queue(Math.min(intervalMs, ttlMs / 3));
    } catch (error) {
      if (stopped || session.closed) return;
      failures++;
      const retryMs = Math.min(1000 * 2 ** Math.min(failures - 1, 2), intervalMs);
      session.log.warn({ ...fields, err: error, failures, retryMs,
        leaseRemainingMs: Math.max(0, Math.round(deadline - now())) }, 'Voice heartbeat renewal failed; retrying within the existing lease');
      if (now() >= deadline) expire();
      else queue(retryMs);
    }
  };
  session.once('closed', stop);
  armExpiry();
  queue(Math.min(intervalMs, ttlMs / 3));
  return stop;
}
