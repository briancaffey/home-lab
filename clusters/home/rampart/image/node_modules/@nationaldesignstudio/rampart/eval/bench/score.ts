/**
 * Scoring for the native bench: term-presence recall/retention, span-level F1,
 * calibration (ECE/Brier) and percentile latency. The predictions are produced
 * by the shipped TypeScript pipeline, so the metrics describe the artifact that
 * ships rather than a separate evaluation implementation.
 */

export interface GoldSpan {
  readonly label: string;
  readonly start: number;
  readonly end: number;
}

export interface PredSpan extends GoldSpan {
  /** Detector confidence; deterministic spans are 1. */
  readonly score: number;
}

/** Wilson 95% CI for a binomial proportion. Robust at small n and at p=0/1. */
export function wilsonCi(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const phat = k / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Deterministic PRNG so bootstrap CIs are reproducible run to run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile-bootstrap CI for the mean of 0/1 outcomes. */
export function bootstrapCi(successes: readonly boolean[], iters = 1000, alpha = 0.05, seed = 0): [number, number] {
  if (successes.length === 0) return [0, 1];
  const rng = mulberry32(seed);
  const n = successes.length;
  const means: number[] = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += successes[Math.floor(rng() * n)] ? 1 : 0;
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor((iters * alpha) / 2)], means[Math.floor(iters * (1 - alpha / 2))]];
}

export function iou(a: GoldSpan, b: GoldSpan): number {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  if (inter === 0) return 0;
  return inter / (Math.max(a.end, b.end) - Math.min(a.start, b.start));
}

/** (TP, FP, FN) under one-to-one greedy matching at the given IoU; higher-scored predictions match first. */
export function matchSpans(gold: readonly GoldSpan[], pred: readonly PredSpan[], threshold = 1): { tp: number; fp: number; fn: number } {
  const goldUsed = new Array(gold.length).fill(false);
  const order = [...pred].sort((a, b) => b.score - a.score);
  let tp = 0;
  let fp = 0;
  for (const p of order) {
    let bestIou = 0;
    let bestJ = -1;
    for (let j = 0; j < gold.length; j++) {
      if (goldUsed[j] || gold[j].label !== p.label) continue;
      const s = iou(p, gold[j]);
      if (s >= threshold && s > bestIou) {
        bestIou = s;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      goldUsed[bestJ] = true;
      tp += 1;
    } else {
      fp += 1;
    }
  }
  return { tp, fp, fn: goldUsed.filter((u) => !u).length };
}

export function f1(tp: number, fp: number, fn: number): { precision: number; recall: number; f1: number } {
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1: f };
}

/** Replace each span with a `[LABEL]` placeholder, right to left. */
export function redactText(raw: string, spans: readonly GoldSpan[]): string {
  let out = raw;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + `[${s.label}]` + out.slice(s.end);
  }
  return out;
}

export interface TermResult {
  readonly leaked: number;
  readonly protectedCount: number;
  readonly over: number;
  readonly retained: number;
}

/** One row: each private term must vanish from the redacted text; each public term must remain. */
export function termPresence(redacted: string, goldPrivate: readonly string[], goldPublic: readonly string[]): TermResult {
  const leaked = goldPrivate.filter((t) => t && redacted.includes(t)).length;
  const over = goldPublic.filter((t) => t && !redacted.includes(t)).length;
  return { leaked, protectedCount: goldPrivate.length - leaked, over, retained: goldPublic.length - over };
}

/** 15-bin reliability ECE over (predicted_score, was_correct) pairs. */
export function expectedCalibrationError(pairs: readonly [number, boolean][], nBins = 15): number {
  if (pairs.length === 0) return 0;
  const bins: [number, boolean][][] = Array.from({ length: nBins }, () => []);
  for (const [score, correct] of pairs) bins[Math.min(nBins - 1, Math.floor(score * nBins))].push([score, correct]);
  let ece = 0;
  for (const b of bins) {
    if (!b.length) continue;
    const acc = b.filter(([, c]) => c).length / b.length;
    const conf = b.reduce((s, [v]) => s + v, 0) / b.length;
    ece += Math.abs(acc - conf) * (b.length / pairs.length);
  }
  return ece;
}

export function brierScore(pairs: readonly [number, boolean][]): number {
  if (pairs.length === 0) return 0;
  return pairs.reduce((s, [score, c]) => s + (score - (c ? 1 : 0)) ** 2, 0) / pairs.length;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Accumulates per-row results into one bucket and reports the summary.json shape. */
export class Stratum {
  rows = 0;
  leaked = 0;
  privateTotal = 0;
  over = 0;
  publicTotal = 0;
  private readonly outcomes: boolean[] = [];
  private readonly spanTp: Record<string, number> = {};
  private readonly spanFp: Record<string, number> = {};
  private readonly spanFn: Record<string, number> = {};

  addTerm(term: TermResult): void {
    this.rows += 1;
    this.leaked += term.leaked;
    this.privateTotal += term.leaked + term.protectedCount;
    this.over += term.over;
    this.publicTotal += term.over + term.retained;
    for (let i = 0; i < term.protectedCount; i++) this.outcomes.push(true);
    for (let i = 0; i < term.leaked; i++) this.outcomes.push(false);
  }

  addSpans(gold: readonly GoldSpan[], pred: readonly PredSpan[], thresholds: readonly number[]): void {
    for (const t of thresholds) {
      const key = t.toFixed(2);
      const { tp, fp, fn } = matchSpans(gold, pred, t);
      this.spanTp[key] = (this.spanTp[key] ?? 0) + tp;
      this.spanFp[key] = (this.spanFp[key] ?? 0) + fp;
      this.spanFn[key] = (this.spanFn[key] ?? 0) + fn;
    }
  }

  report(): Record<string, unknown> {
    const recall = this.privateTotal ? (this.privateTotal - this.leaked) / this.privateTotal : 1;
    const spanF1: Record<string, unknown> = {};
    for (const key of Object.keys(this.spanTp)) {
      const tp = this.spanTp[key];
      const fp = this.spanFp[key];
      const fn = this.spanFn[key];
      spanF1[`iou_${key}`] = { tp, fp, fn, ...f1(tp, fp, fn) };
    }
    return {
      rows: this.rows,
      private_total: this.privateTotal,
      private_recall: recall,
      private_recall_wilson95: wilsonCi(this.privateTotal - this.leaked, this.privateTotal),
      private_recall_bootstrap95: bootstrapCi(this.outcomes),
      leaked: this.leaked,
      public_total: this.publicTotal,
      public_retained: this.publicTotal ? (this.publicTotal - this.over) / this.publicTotal : 1,
      over_redacted: this.over,
      span_f1: spanF1,
    };
  }
}
