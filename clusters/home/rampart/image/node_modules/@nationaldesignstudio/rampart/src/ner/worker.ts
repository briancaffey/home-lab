/**
 * Web Worker host for the NER classifier.
 *
 * Inference must not jank the chat UI, so the model lives on a worker thread.
 * The main thread talks to it through {@link createWorkerClassifier}, which
 * adapts the postMessage round-trip back into the {@link TokenClassifier}
 * signature the pipeline expects — so the rest of the system is agnostic to
 * whether detection runs on the main thread or off it.
 *
 * Bundle this file as the worker entry (it self-registers `onmessage`). The
 * client is created on the main thread with `new Worker(new URL(...))`.
 */

import { detectNer, loadNerClassifier, type NerOptions, type TokenClassifier } from "./classifier";

interface InitMessage {
  readonly kind: "init";
  readonly options: NerOptions;
}
interface DetectMessage {
  readonly kind: "detect";
  readonly id: number;
  readonly text: string;
  readonly minScore?: number;
}
type InboundMessage = InitMessage | DetectMessage;

type WorkerInboundEvent = {
  data: InboundMessage;
};

type WorkerOutboundEvent = {
  data: { kind: string; id?: number; spans?: unknown; message?: string };
};

export type WorkerMessagePort = {
  onmessage: ((event: WorkerInboundEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

// --- Worker side (runs inside the worker thread) ---

/** Register the worker message handler. Call from the worker entry module. */
export function registerNerWorker(scope: WorkerMessagePort): void {
  let classifierPromise: Promise<TokenClassifier> | null = null;

  scope.onmessage = async (event: WorkerInboundEvent) => {
    const message = event.data;
    if (message.kind === "init") {
      try {
        classifierPromise = loadNerClassifier(message.options);
        await classifierPromise;
        scope.postMessage({ kind: "ready" });
      } catch (error) {
        // Surface init failures so the main thread can fail closed instead of
        // hanging forever on a `ready` message that never arrives.
        classifierPromise = null;
        scope.postMessage({ kind: "error", message: String(error) });
      }
      return;
    }
    if (message.kind === "detect") {
      try {
        if (classifierPromise === null) throw new Error("[pii-filter] worker not initialized");
        const classifier = await classifierPromise;
        const spans = await detectNer(message.text, classifier, message.minScore);
        scope.postMessage({ kind: "result", id: message.id, spans });
      } catch (error) {
        scope.postMessage({ kind: "error", id: message.id, message: String(error) });
      }
    }
  };
}

// --- Main-thread side ---

/**
 * Wrap a worker as a {@link TokenClassifier}-compatible async function. The
 * detection contract is span-in/span-out, so callers use it exactly like the
 * in-process classifier. Resolves once the worker reports `ready`.
 */
export function createWorkerClassifier(
  worker: WorkerMessagePort,
  options: NerOptions,
): { ready: Promise<void>; detect: (text: string, minScore?: number) => Promise<unknown> } {
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let resolveReady: () => void = () => {
    /* replaced synchronously by Promise constructor below */
  };
  let rejectReady: (error: unknown) => void = () => {
    /* replaced synchronously by Promise constructor below */
  };
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  worker.onmessage = (event: WorkerOutboundEvent) => {
    const data = event.data;
    if (data.kind === "ready") {
      resolveReady();
      return;
    }
    // Worker reports a pre-init failure (no id) → reject the ready promise so
    // callers fail loudly instead of hanging on `await ready`.
    if (data.kind === "error" && data.id === undefined) {
      rejectReady(new Error(data.message ?? "[pii-filter] worker init failed"));
      return;
    }
    if (data.id === undefined) return;
    const entry = pending.get(data.id);
    if (entry === undefined) return;
    pending.delete(data.id);
    if (data.kind === "error") entry.reject(new Error(data.message));
    else entry.resolve(data.spans);
  };

  worker.postMessage({ kind: "init", options });

  function detect(text: string, minScore?: number): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ kind: "detect", id, text, minScore });
    });
  }

  return { ready, detect };
}
