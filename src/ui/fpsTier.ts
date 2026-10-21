/**
 * The CSS spelling of a perf tier.
 *
 * The fps *thresholds* live once, in `core/perf.ts` — `perfTier` is the only
 * definition of what "good", "warn" and "bad" mean for a frame rate, and this
 * module deliberately restates not one of those numbers.
 *
 * What lives here is the other half of the job: which class the three tiers
 * paint. The three readouts that colour themselves on the fps ladder (the
 * overlay's two rows and the standalone meter) all append a suffix to a
 * `className` that already holds something, so they share the " leading space,
 * two words" phrasing here rather than re-deriving it — and rather than holding
 * it as a literal at each site, where it can drift.
 */

import type { PerfTier } from "../core/perf.js";

/** `tier` as the suffix the fps readouts append to their class: `"num" + …`. */
export function fpsTierSuffix(tier: PerfTier): string {
 if (tier === "bad") return " bad";
 if (tier === "warn") return " warn";
 // "good" is the absence of a class, not a class of its own — the stylesheets
 // colour only `.warn` and `.bad`, and an unstyled row is already the good one.
 return "";
}
