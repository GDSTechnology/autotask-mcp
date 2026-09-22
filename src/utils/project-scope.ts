// extract_project_scope (#46 §8) — deterministic SOW → normalized scope envelope.
//
// The front of the SOW-to-project pipeline. The MCP never writes to Autotask from
// raw prose and never infers scope from a reference project — it produces a
// normalized, reviewable scope object first. AI extraction (if any) happens in the
// CALLER; this tool is pure/deterministic: it section-parses pasted SOW text into
// the canonical buckets, merges a caller-supplied partial scope, extracts BOM-style
// quantities, and surfaces anything it could NOT classify (never silently dropped).
//
// Buckets (§8): included / excluded / byOthers / assumptions / allowances /
// customerProvided / vendorProvided / dependencies / milestones / quantities.

export interface QuantityItem { item: string; quantity: number; unit?: string | undefined; source: string }
export interface Milestone { text: string; date?: string | undefined }

export interface ProjectScope {
  source?: string | undefined;
  included: string[];
  excluded: string[];
  byOthers: string[];
  assumptions: string[];
  allowances: string[];
  customerProvided: string[];
  vendorProvided: string[];
  dependencies: string[];
  milestones: Milestone[];
  quantities: QuantityItem[];
  unclassified: string[];
  warnings: string[];
}

export type ScopeBucket = Exclude<keyof ProjectScope, 'source' | 'milestones' | 'quantities' | 'unclassified' | 'warnings'>;

// Heading synonyms, most-specific first (so "not in scope" beats "scope").
const HEADINGS: Array<[ScopeBucket | 'milestones', string[]]> = [
  ['excluded', ['out of scope', 'out-of-scope', 'not in scope', 'not included', 'exclusions', 'excluded', 'exclusion']],
  ['byOthers', ['provided by others', 'work by others', 'by others', 'by other', 'others']],
  ['customerProvided', ['customer provided', 'customer-provided', 'client provided', 'client-provided', 'owner provided', 'provided by customer', 'provided by client', 'customer furnished', 'customer to provide']],
  ['vendorProvided', ['vendor provided', 'vendor-provided', 'provided by vendor', 'contractor provided', 'supplier provided', 'manufacturer provided']],
  ['assumptions', ['assumptions', 'assumption']],
  ['allowances', ['allowances', 'allowance']],
  ['dependencies', ['dependencies', 'dependency', 'prerequisites', 'prerequisite', 'depends on']],
  ['milestones', ['milestones', 'milestone', 'key dates', 'schedule of values', 'deliverables schedule', 'deliverables']],
  ['included', ['scope of work', 'services included', 'work included', 'in scope', 'in-scope', 'included', 'scope']],
];

const EMPTY_BUCKETS = (): Pick<ProjectScope, ScopeBucket> => ({
  included: [], excluded: [], byOthers: [], assumptions: [], allowances: [],
  customerProvided: [], vendorProvided: [], dependencies: [],
});

function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*•·▪◦]|\d+[.)]|[a-z][.)])\s+/i, '').trim();
}

function normalizeHeading(line: string): string {
  return line.replace(/^#+\s*/, '').replace(/[:：]\s*$/, '').trim().toLowerCase();
}

/** A line is a heading if it's a markdown heading, ends with a colon, or exactly
 *  matches a known synonym — and is short (headings aren't sentences). */
function detectBucket(rawLine: string): ScopeBucket | 'milestones' | null {
  const trimmed = rawLine.trim();
  const isMarkdown = /^#+\s+/.test(trimmed);
  const endsColon = /[:：]\s*$/.test(trimmed);
  const norm = normalizeHeading(trimmed);
  if (!norm) return null;
  const wordCount = norm.split(/\s+/).length;
  for (const [bucket, syns] of HEADINGS) {
    for (const s of syns) {
      const exact = norm === s;
      const prefixed = norm.startsWith(s) && (norm.length === s.length || /[\s:]/.test(norm[s.length]));
      if (exact || (prefixed && (isMarkdown || endsColon))) {
        // guard the generic "scope"/"included" from matching long sentences
        if ((s === 'scope' || s === 'included') && !exact && !isMarkdown && !endsColon) continue;
        if (wordCount > 8 && !isMarkdown && !endsColon) continue;
        return bucket;
      }
    }
  }
  return null;
}

// Anchored (line starts with the quantity) — item is the text after it.
const ANCHORED_QTY: RegExp[] = [
  /^\((\d+)\)\s*(.+)$/,                 // (12) drops
  /^(\d+)\s*[xX×]\s+(.+)$/,            // 12x cameras / 12 x cameras
  /^(\d+)\s+(.+)$/,                     // 12 drops
];
// Embedded (quantity appears mid-line) — only strong signals to avoid false hits
// like "Cat6". Item is the noun phrase following the quantity.
const EMBEDDED_QTY: RegExp[] = [
  /\((\d+)\)\s*([A-Za-z][^()]*)$/,     // Install (48) Cat6 data drops
  /\b(\d+)\s*[xX×]\s+([A-Za-z].+)$/,  // Provide 12x access points
];
const TRAILING_QTY = /^(.+?)[\s:–-]+(?:qty\.?\s*)?(\d+)\s*([a-zA-Z]+)?$/i;

function extractQuantity(item: string, source: string): QuantityItem | null {
  for (const re of ANCHORED_QTY) {
    const m = item.match(re);
    if (m) {
      const quantity = parseInt(m[1], 10);
      const rest = m[2].trim();
      if (quantity > 0 && rest && !/^\d/.test(rest)) return { item: rest, quantity, source };
    }
  }
  for (const re of EMBEDDED_QTY) {
    const m = item.match(re);
    if (m) {
      const quantity = parseInt(m[1], 10);
      const rest = m[2].trim();
      if (quantity > 0 && rest.length > 1) return { item: rest, quantity, source };
    }
  }
  const t = item.match(TRAILING_QTY);
  if (t) {
    const quantity = parseInt(t[2], 10);
    const name = t[1].trim();
    if (quantity > 0 && name && name.length > 1 && !/^\d+$/.test(name)) {
      return { item: name, quantity, ...(t[3] ? { unit: t[3] } : {}), source };
    }
  }
  return null;
}

function parseMilestone(text: string): Milestone {
  const iso = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return { text: text.replace(iso[1], '').replace(/[\s:–-]+$/, '').trim() || text, date: iso[1] };
  const md = text.match(/([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/);
  if (md) { const d = Date.parse(md[1]); if (!Number.isNaN(d)) return { text: text.replace(md[1], '').replace(/[\s:–-]+$/, '').trim() || text, date: new Date(d).toISOString().slice(0, 10) }; }
  return { text };
}

function dedupePush(arr: string[], v: string): void {
  const key = v.toLowerCase();
  if (!arr.some((x) => x.toLowerCase() === key)) arr.push(v);
}

export interface ExtractScopeInput {
  sowText?: string | undefined;
  /** caller-supplied partial scope (e.g. from an LLM); merged with parsed text */
  scope?: Partial<ProjectScope> | undefined;
  source?: string | undefined;
  /** also scan these buckets' lines for quantities (default ['included']) */
  quantityBuckets?: ScopeBucket[] | undefined;
}

/** Parse a SOW into the normalized scope envelope. Pure/deterministic. */
export function extractProjectScope(input: ExtractScopeInput = {}): ProjectScope {
  const out: ProjectScope = {
    ...(input.source ? { source: input.source } : {}),
    ...EMPTY_BUCKETS(),
    milestones: [], quantities: [], unclassified: [], warnings: [],
  };

  // 1) Merge caller-supplied partial scope first.
  const partial = input.scope;
  if (partial) {
    for (const b of Object.keys(EMPTY_BUCKETS()) as ScopeBucket[]) {
      for (const v of partial[b] ?? []) if (typeof v === 'string' && v.trim()) dedupePush(out[b], v.trim());
    }
    for (const m of partial.milestones ?? []) if (m && m.text) out.milestones.push(m);
    for (const q of partial.quantities ?? []) if (q && q.item && q.quantity > 0) out.quantities.push(q);
  }

  // 2) Section-parse the SOW text.
  let sawHeading = false;
  if (input.sowText && input.sowText.trim()) {
    let current: ScopeBucket | 'milestones' | null = null;
    for (const rawLine of input.sowText.split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      const bucket = detectBucket(rawLine);
      if (bucket) { current = bucket; sawHeading = true; continue; }
      const item = stripBullet(rawLine);
      if (!item) continue;
      if (current === 'milestones') out.milestones.push(parseMilestone(item));
      else if (current) dedupePush(out[current], item);
      else out.unclassified.push(item);
    }
  }

  // 3) Extract quantities from the requested buckets (default: included).
  const qBuckets = input.quantityBuckets?.length ? input.quantityBuckets : (['included'] as ScopeBucket[]);
  for (const b of qBuckets) {
    for (const line of out[b]) {
      const q = extractQuantity(line, b);
      if (q && !out.quantities.some((x) => x.item.toLowerCase() === q.item.toLowerCase() && x.quantity === q.quantity)) {
        out.quantities.push(q);
      }
    }
  }

  // 4) Data-quality warnings — surface gaps, never guess.
  if (input.sowText && input.sowText.trim() && !sawHeading && !partial) {
    out.warnings.push('No recognized SOW section headings found — everything is unclassified. Add headings (Included / Excluded / Assumptions / …) or pass a structured `scope`.');
  }
  if (out.included.length === 0) out.warnings.push('No in-scope items detected — scope should list what IS included before building a plan.');
  if (out.excluded.length === 0) out.warnings.push('No exclusions captured — confirm nothing is out of scope, or record exclusions to avoid scope creep.');
  if (out.unclassified.length > 0) out.warnings.push(`${out.unclassified.length} line(s) could not be classified — review and assign before planning.`);

  return out;
}
