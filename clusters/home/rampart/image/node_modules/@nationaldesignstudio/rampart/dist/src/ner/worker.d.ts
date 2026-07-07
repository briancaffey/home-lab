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
import { type NerOptions } from "./classifier";
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
export type WorkerMessagePort = {
    onmessage: ((event: WorkerInboundEvent) => void) | null;
    postMessage: (message: unknown) => void;
};
/** Register the worker message handler. Call from the worker entry module. */
export declare function registerNerWorker(scope: WorkerMessagePort): void;
/**
 * Wrap a worker as a {@link TokenClassifier}-compatible async function. The
 * detection contract is span-in/span-out, so callers use it exactly like the
 * in-process classifier. Resolves once the worker reports `ready`.
 */
export declare function createWorkerClassifier(worker: WorkerMessagePort, options: NerOptions): {
    ready: Promise<void>;
    detect: (text: string, minScore?: number) => Promise<unknown>;
};
export {};
//# sourceMappingURL=worker.d.ts.map