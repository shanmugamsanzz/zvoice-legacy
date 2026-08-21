function delay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done(signal.reason ?? new Error('Audio pacing cancelled'));
    function done(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class AudioPacer {
  constructor(options) {
    if (!options?.queue || typeof options.send !== 'function') {
      throw new TypeError('AudioPacer requires a queue and send function');
    }
    this.queue = options.queue;
    this.send = options.send;
    this.onError = options.onError ?? (() => {});
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? delay;
    this.preRollMs = options.preRollMs ?? 0;
    this.preRollMaxWaitMs = options.preRollMaxWaitMs ?? 0;
    this.lowWaterMs = options.lowWaterMs ?? 0;
    this.deliveryLeadMs = options.deliveryLeadMs ?? 0;
    this.underrunThresholdMs = options.underrunThresholdMs ?? 0;
    this.packetDurationMs = options.packetDurationMs ?? 0;
    this.onUnderrun = options.onUnderrun ?? (() => {});
    this.onPacket = options.onPacket ?? (() => {});
    this.running = false;
    this.sending = false;
    this.controller = null;
    this.runPromise = null;
    this.drainWaiters = [];
    this.remotePlaybackEndAt = 0;
    this.startedPlayback = false;
    this.underrunCount = 0;
    this.pendingFrame = null;
    this.cancelledGenerations = new Set();
  }

  start() {
    if (this.running) return this.runPromise;
    this.running = true;
    this.controller = new AbortController();
    this.runPromise = this.#run(this.controller.signal).catch((error) => {
      if (!this.controller.signal.aborted) this.onError(error);
    }).finally(() => {
      this.running = false;
      this.sending = false;
      this.pendingFrame = null;
      this.#resolveDrains();
    });
    return this.runPromise;
  }

  async #waitForPreRoll(firstFrame, signal, targetMs = this.preRollMs) {
    if (targetMs <= firstFrame.durationMs || this.preRollMaxWaitMs <= 0) return;
    const waitStartedAt = this.now();
    while (!signal.aborted
      && firstFrame.durationMs + this.queue.bufferedMs < targetMs
      && this.now() - waitStartedAt < this.preRollMaxWaitMs) {
      const remaining = this.preRollMaxWaitMs - (this.now() - waitStartedAt);
      await this.sleep(Math.min(5, remaining), signal);
    }
  }

  async #run(signal) {
    while (!signal.aborted) {
      const queueWasEmpty = this.queue.size === 0;
      const frame = await this.queue.dequeue({ signal });
      if (!frame) break;
      this.pendingFrame = frame;

      const remainingRemoteMs = Math.max(0, this.remotePlaybackEndAt - this.now());
      const underrun = this.startedPlayback && queueWasEmpty
        && remainingRemoteMs <= this.underrunThresholdMs;
      if (!this.startedPlayback || underrun) {
        if (underrun) {
          this.underrunCount += 1;
          this.onUnderrun({
            count: this.underrunCount,
            remainingRemoteMs,
            queueBufferedMs: this.queue.bufferedMs,
          });
        }
        await this.#waitForPreRoll(
          frame,
          signal,
          underrun ? Math.max(this.preRollMs, this.lowWaterMs) : this.preRollMs,
        );
      }

      if (this.cancelledGenerations.delete(frame.generationId)) {
        this.pendingFrame = null;
        this.#resolveDrains();
        continue;
      }


      const packetFrames = [frame, ...this.queue.takeAvailable({
        generationId: frame.generationId,
        maxDurationMs: Math.max(0, this.packetDurationMs - frame.durationMs),
      })];
      const packet = packetFrames.length === 1 ? frame : {
        ...frame,
        data: Buffer.concat(packetFrames.map((item) => item.data)),
        durationMs: packetFrames.reduce((total, item) => total + item.durationMs, 0),
      };
      this.pendingFrame = packet;

      const leadMs = Math.max(0, this.remotePlaybackEndAt - this.now());
      const waitMs = leadMs - this.deliveryLeadMs;
      if (waitMs > 0) await this.sleep(waitMs, signal);
      if (signal.aborted) break;
      this.sending = true;
      await this.send(packet);
      this.sending = false;
      this.pendingFrame = null;
      if (this.cancelledGenerations.delete(packet.generationId)) {
        this.#resolveDrains();
        continue;
      }
      const sentAt = this.now();
      this.remotePlaybackEndAt = Math.max(this.remotePlaybackEndAt, sentAt) + packet.durationMs;
      this.startedPlayback = true;
      this.onPacket({
        durationMs: packet.durationMs,
        bytes: packet.data.length,
        deliveryLeadMs: Math.max(0, this.remotePlaybackEndAt - sentAt),
        queueBufferedMs: this.queue.bufferedMs,
      });
      this.#resolveDrains();
    }
  }

  resetTimeline() {
    this.remotePlaybackEndAt = this.now();
    this.startedPlayback = false;
  }

  cancelGeneration(generationId) {
    if (generationId && this.pendingFrame?.generationId === generationId) {
      this.cancelledGenerations.add(generationId);
    }
  }

  drain() {
    if (this.queue.size === 0 && !this.sending && !this.pendingFrame) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  #resolveDrains() {
    if (this.queue.size || this.sending || this.pendingFrame) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }

  async stop() {
    this.controller?.abort(new Error('Audio pacer stopped'));
    await this.runPromise;
  }
}
