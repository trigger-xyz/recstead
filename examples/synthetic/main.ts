import { createRecorder, type Recorder } from 'recstead';

const button = document.getElementById('run');
const status = document.getElementById('status');
const report = document.getElementById('report');
if (!(button instanceof HTMLButtonElement) || !status || !report) {
  throw new Error('The encoder check page is missing its controls.');
}
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
type Scenario = 'final-only' | 'multiple-chunks';
interface NativeChunk {
  bytes: number;
  afterStopRequest: boolean;
}
interface CaseReport {
  scenario: Scenario;
  passed: boolean;
  checks?: Record<string, boolean>;
  error?: string;
  cleanupErrors: string[];
  states: string[];
  nativeEvents: string[];
  chunks: NativeChunk[];
  timesliceMs: number | null;
  bytes?: number;
  mimeType?: string;
  decodedSeconds?: number;
  firstHz?: number;
  secondHz?: number;
  activeMs?: number;
  wallMs?: number;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function frequency(data: Float32Array, rate: number, from: number, to: number): number {
  const first = Math.floor(from * rate);
  const last = Math.min(data.length, Math.floor(to * rate));
  if (last <= first) return 0;
  let crossings = 0;
  for (let i = first + 1; i < last; i++) if (data[i - 1]! <= 0 && data[i]! > 0) crossings++;
  return crossings / ((last - first) / rate);
}

async function runCase(scenario: Scenario): Promise<CaseReport> {
  const outcome: CaseReport = {
    scenario, passed: false, cleanupErrors: [], states: [], nativeEvents: [], chunks: [], timesliceMs: null,
  };
  let context: AudioContext | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let oscillator: OscillatorNode | undefined;
  let gain: GainNode | undefined;
  let recorder: Recorder | undefined;
  let restoreCapture: (() => void) | undefined;
  let restoreEncoder: (() => void) | undefined;
  try {
    if (typeof AudioContext !== 'function' || typeof MediaRecorder !== 'function' || !navigator.mediaDevices) {
      throw new Error('This check needs Web Audio, MediaRecorder and a secure browser context.');
    }
    context = new AudioContext();
    destination = context.createMediaStreamDestination();
    oscillator = context.createOscillator();
    gain = context.createGain();
    gain.gain.value = 0.2;
    oscillator.frequency.value = 440;
    oscillator.connect(gain).connect(destination);

    // Replace capture only on this isolated test page. The actual browser encoder
    // still runs, and its data/stop events are observed without altering them.
    const devices = navigator.mediaDevices;
    const originalCapture = Object.getOwnPropertyDescriptor(devices, 'getUserMedia');
    const stream = destination.stream;
    Object.defineProperty(devices, 'getUserMedia', { configurable: true, value: async () => stream });
    restoreCapture = () => {
      if (originalCapture) Object.defineProperty(devices, 'getUserMedia', originalCapture);
      else Reflect.deleteProperty(devices, 'getUserMedia');
    };
    const NativeMediaRecorder = MediaRecorder;
    const originalEncoder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
    let stopRequested = false;
    class ObservedMediaRecorder extends NativeMediaRecorder {
      constructor(input: MediaStream, options?: MediaRecorderOptions) {
        super(input, options);
        for (const type of ['start', 'pause', 'resume', 'stop']) {
          this.addEventListener(type, () => outcome.nativeEvents.push(type));
        }
        this.addEventListener('dataavailable', event => {
          outcome.nativeEvents.push('data');
          outcome.chunks.push({ bytes: event.data.size, afterStopRequest: stopRequested });
        });
      }
      override start(timeslice?: number): void {
        outcome.timesliceMs = timeslice ?? null;
        super.start(timeslice);
      }
      override stop(): void {
        stopRequested = true;
        super.stop();
      }
    }
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: ObservedMediaRecorder });
    restoreEncoder = () => {
      if (originalEncoder) Object.defineProperty(globalThis, 'MediaRecorder', originalEncoder);
      else Reflect.deleteProperty(globalThis, 'MediaRecorder');
    };
    recorder = createRecorder({ maxActiveMs: 5_000 });
    const activeRecorder = recorder;
    recorder.subscribe(() => outcome.states.push(activeRecorder.getSnapshot().status));
    let publishedAfterNativeStop = false;
    recorder.onEvent(event => {
      if (event.type === 'result') publishedAfterNativeStop = outcome.nativeEvents.includes('stop');
    });
    await context.resume();
    oscillator.start();
    await recorder.start();
    if (scenario === 'final-only') {
      // Finish before the core's first requested timeslice, so stop supplies the
      // recording's only data event. The chunk checks verify this actually ran.
      await delay(400);
    } else {
      await delay(450);
      await recorder.pause();
      await delay(120);
      oscillator.frequency.value = 880;
      await recorder.resume();
      await delay(1_300);
    }
    const result = await recorder.stop();
    if (!result) throw new Error('Recording did not produce a result.');
    const decoded = await context.decodeAudioData(await result.blob.arrayBuffer());
    const firstHz = frequency(decoded.getChannelData(0), decoded.sampleRate, 0.1, 0.3);
    const checks: Record<string, boolean> = {
      nonempty: result.bytes > 0,
      complete: result.completion === 'complete',
      mimeConsistent: result.mimeType === result.blob.type,
      allNativeBytesRetained: outcome.chunks.reduce((bytes, chunk) => bytes + chunk.bytes, 0) === result.bytes,
      receivedBytesMatch: result.receivedBytes === result.bytes,
      finalDataBeforeNativeStop: outcome.nativeEvents.lastIndexOf('data') >= 0 &&
        outcome.nativeEvents.lastIndexOf('data') < outcome.nativeEvents.indexOf('stop'),
      resultAfterNativeStop: publishedAfterNativeStop,
      firstTone: firstHz > 400 && firstHz < 480,
      tracksEnded: stream.getTracks().every(track => track.readyState === 'ended'),
      ready: recorder.getSnapshot().status === 'ready',
    };
    if (scenario === 'final-only') {
      checks.onlyFinalChunk = outcome.chunks.length === 1 && outcome.chunks[0]!.afterStopRequest;
      checks.durationPlausible = decoded.duration > 0.25 && decoded.duration < 1.1;
    } else {
      const secondHz = frequency(decoded.getChannelData(0), decoded.sampleRate, 0.85, 1.25);
      outcome.secondHz = secondHz;
      checks.multipleNonemptyChunks = outcome.chunks.filter(chunk => chunk.bytes > 0).length >= 2;
      checks.periodicAndFinalChunks = outcome.chunks.some(chunk => !chunk.afterStopRequest) &&
        outcome.chunks.some(chunk => chunk.afterStopRequest);
      checks.durationPlausible = decoded.duration > 1.55 && decoded.duration < 2.8;
      checks.secondTone = secondHz > 830 && secondHz < 930;
      checks.paused = outcome.states.includes('paused');
    }
    Object.assign(outcome, {
      checks, passed: Object.values(checks).every(Boolean), bytes: result.bytes, mimeType: result.mimeType,
      decodedSeconds: decoded.duration, firstHz, activeMs: result.activeMs, wallMs: result.wallMs,
    });
  } catch (error) {
    outcome.error = message(error);
  } finally {
    // Finish every cleanup step even if an earlier API throws.
    const cleanup = async (operation: () => unknown): Promise<void> => {
      try { await operation(); } catch (error) { outcome.cleanupErrors.push(message(error)); }
    };
    await cleanup(() => recorder?.dispose());
    for (const track of destination?.stream.getTracks() ?? []) {
      await cleanup(() => { if (track.readyState !== 'ended') track.stop(); });
    }
    try { oscillator?.stop(); } catch { /* The oscillator may not have started. */ }
    await cleanup(() => oscillator?.disconnect());
    await cleanup(() => gain?.disconnect());
    await cleanup(() => restoreCapture?.());
    await cleanup(() => restoreEncoder?.());
    await cleanup(() => context?.close());
    if (outcome.cleanupErrors.length > 0) outcome.passed = false;
  }
  return outcome;
}

button.onclick = () => {
  button.disabled = true;
  report.textContent = 'Running the final-only and multiple-chunk cases…';
  void (async () => {
    const cases: CaseReport[] = [];
    try {
      for (const scenario of ['final-only', 'multiple-chunks'] as const) {
        status.textContent = `Running ${scenario}`;
        cases.push(await runCase(scenario));
      }
      const passed = cases.every(result => result.passed);
      report.textContent = JSON.stringify({ passed, cases, userAgent: navigator.userAgent, checkedAt: new Date().toISOString() }, null, 2);
      status.textContent = passed ? 'Passed' : 'Failed';
    } catch (error) {
      status.textContent = 'Failed';
      report.textContent = JSON.stringify({ passed: false, error: message(error), cases }, null, 2);
    } finally {
      button.disabled = false;
    }
  })();
};
