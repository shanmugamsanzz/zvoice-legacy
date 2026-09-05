import { apiRequest, apiWebSocketUrl } from './api';

type Session = { callId: string; providerCallId: string; mediaPath: string; protocol: string };
type CallEvents = {
  onStatus: (status: string) => void;
  onCall: (id: string) => void;
  onTranscript: (speaker: string, text: string) => void;
  onEnded: (error?: string) => void;
};

export class BrowserTestCall {
  private context?: AudioContext;
  private stream?: MediaStream;
  private input?: MediaStreamAudioSourceNode;
  private processor?: AudioWorkletNode;
  private socket?: WebSocket;
  private sources = new Set<AudioBufferSourceNode>();
  private playbackAt = 0;
  private closed = false;
  private ready = false;
  private muted = false;
  private timeout?: number;
  private session?: Session;
  constructor(private events: CallEvents) {}

  async start(agentId: string) {
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
        throw new Error('Microphone calls require HTTPS or localhost and a browser with Web Audio support.');
      }
      this.events.onStatus('Allow microphone access');
      this.context = new AudioContext();
      await this.context.resume();
      if (this.closed) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (this.closed) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      stream.getAudioTracks()[0].onended = () => this.finish('Microphone disconnected.');
      await this.context.audioWorklet.addModule(`${import.meta.env.BASE_URL}browser-audio-worklet.js`);
      if (this.closed) return;
      this.input = this.context.createMediaStreamSource(stream);
      this.processor = new AudioWorkletNode(this.context, 'browser-audio');
      this.processor.onprocessorerror = () => this.finish('Microphone audio processing failed.');
      this.processor.port.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
        if (!this.ready || this.closed) return;
        if ((this.socket?.bufferedAmount ?? 0) > 128_000) {
          this.finish('Connection is too slow for a live call. Please try again.');
          return;
        }
        const bytes = this.muted ? new Uint8Array(data.length).fill(255) : data;
        this.send({ event: 'media', media: { track: 'inbound', payload: btoa(String.fromCharCode(...bytes)) } });
      };
      this.events.onStatus('Connecting to agent');
      const session = await apiRequest<Session>(`/agents/${agentId}/test-call`, { method: 'POST', body: '{}' });
      if (this.closed) return;
      this.session = session;
      this.events.onCall(session.callId);
      this.socket = new WebSocket(apiWebSocketUrl(session.mediaPath), session.protocol);
      this.timeout = window.setTimeout(() => this.finish('The agent connection timed out. Check provider settings and try again.'), 30_000);
      this.socket.onmessage = ({ data }) => {
        try { this.receive(JSON.parse(data)); }
        catch { this.finish('Invalid audio response from the server.'); }
      };
      this.socket.onerror = () => this.finish('Could not connect to the voice WebSocket. Check the backend connection.');
      this.socket.onclose = ({ code, reason }) => this.finish(code === 1000 ? undefined : reason || 'The call connection was interrupted.');
    } catch (error) {
      this.finish(error instanceof Error ? error.message : 'Could not start browser call.');
    }
  }

  private send(message: object) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private receive(message: { event: string; media?: { payload: string }; name?: string; speaker?: string; text?: string; message?: string }) {
    if (this.closed || !this.context) return;
    switch (message.event) {
      case 'ready':
        if (this.ready) return;
        window.clearTimeout(this.timeout);
        this.send({ event: 'start', start: { callId: this.session!.providerCallId,
          streamId: this.session!.callId, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } } });
        this.ready = true;
        this.input!.connect(this.processor!);
        // The worklet emits silence to the destination; microphone audio is only sent over the socket.
        this.processor!.connect(this.context.destination);
        this.events.onStatus('Call connected');
        break;
      case 'playAudio': {
        const bytes = atob(message.media!.payload);
        const buffer = this.context.createBuffer(1, bytes.length, 8000);
        const output = buffer.getChannelData(0);
        for (let i = 0; i < bytes.length; i++) {
          const value = (~bytes.charCodeAt(i)) & 255;
          const magnitude = (((value & 15) * 8 + 132) << ((value >> 4) & 7)) - 132;
          output[i] = (value & 128 ? -magnitude : magnitude) / 32768;
        }
        this.play(buffer);
        break;
      }
      case 'checkpoint': {
        const marker = this.context.createBuffer(1, 1, 8000);
        this.play(marker, () => this.send({ event: 'playedStream', name: message.name }));
        break;
      }
      case 'clearAudio':
        this.clearPlayback();
        this.send({ event: 'clearedAudio' });
        break;
      case 'transcript': this.events.onTranscript(message.speaker ?? 'agent', message.text ?? ''); break;
      case 'error': this.finish(message.message ?? 'Voice provider error.'); break;
    }
  }

  private play(buffer: AudioBuffer, done?: () => void) {
    const context = this.context!;
    if (this.playbackAt - context.currentTime > 10) throw new Error('Audio playback fell behind');
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.sources.add(source);
    source.onended = () => { this.sources.delete(source); source.disconnect(); done?.(); };
    const start = Math.max(context.currentTime + 0.02, this.playbackAt);
    source.start(start);
    this.playbackAt = start + buffer.duration;
  }

  private clearPlayback() {
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear();
    this.playbackAt = 0;
  }

  setMuted(muted: boolean) { this.muted = muted; }
  end() { this.finish(); }
  private finish(error?: string) {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.timeout);
    if (!error) this.send({ event: 'stop' });
    this.socket?.close(error ? 4000 : 1000, error ? 'Browser test failed' : 'Browser test ended');
    this.clearPlayback();
    this.input?.disconnect();
    this.processor?.disconnect();
    this.processor?.port.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => {});
    this.events.onEnded(error);
  }
}
