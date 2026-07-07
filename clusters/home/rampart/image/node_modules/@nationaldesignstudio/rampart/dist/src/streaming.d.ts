/**
 * Streaming placeholder reveal.
 *
 * The assistant streams tokens, so a placeholder can be split across chunks:
 *   chunk A: "...thanks [NA"
 *   chunk B: "ME_1] for..."
 * A per-chunk regex replace would emit the broken `[NA` and never match. This
 * buffers the smallest suffix that could still become a placeholder, emits
 * everything safe before it, and flushes the remainder at stream end.
 */
/** Resolves a placeholder token to its real value, or null to leave it as-is. */
export type PlaceholderResolver = (token: string) => string | null;
/**
 * Stateful reveal for a token stream. Feed chunks in order; `push` returns the
 * text safe to render now, `flush` returns whatever was held at the end.
 */
export declare class StreamingReveal {
    private readonly resolve;
    private buffer;
    constructor(resolve: PlaceholderResolver);
    /** Reveal complete placeholders in `chunk`, holding any partial tail. */
    push(chunk: string): string;
    /** Emit any buffered tail (e.g. a lone `[` that never became a token). */
    flush(): string;
    private replaceComplete;
}
/**
 * A Web Streams transform that reveals placeholders in a string stream — drop
 * it into an AI SDK text stream pipeline so the user never sees `[NAME_1]`.
 */
export declare function createRevealTransform(resolve: PlaceholderResolver): TransformStream<string, string>;
//# sourceMappingURL=streaming.d.ts.map