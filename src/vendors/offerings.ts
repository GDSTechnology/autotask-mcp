// Product identity, independent of the sales channel. A vendor line and an
// Autotask service are matched on the manufacturer's PRODUCT plus the term it
// is sold on — never on the distributor. These helpers propose; people decide
// (vendor_offering_mapping / catalog_offering_link).

import type { Cadence } from './types.js';

/** Vendor SKU prefix → manufacturer (Pax8 SKUs are "<MFR>-<LINE>-<ID>-<SUFFIX>"). Extend per vendor. */
const PAX8_MANUFACTURER: Record<string, string> = {
  MST: 'Microsoft', DRP: 'Dropsuite', AGY: 'Addigy', ADY: 'Addigy', SEN: 'SentinelOne', LMI: 'LastPass', PAX: 'Pax8',
  NIN: 'NinjaOne', ACR: 'Acronis', ADB: 'Adobe', GOO: 'Google', KEE: 'Keeper', HUN: 'Huntress', DUO: 'Cisco Duo',
};

export function manufacturerOf(vendor: string, sku: string | null, description: string): string {
  if (vendor === 'pax8' && sku) {
    const m = PAX8_MANUFACTURER[sku.split('-')[0]!.toUpperCase()];
    if (m) return /ninjaone/i.test(description) && m === 'Dropsuite' ? 'NinjaOne (Dropsuite)' : m;
  }
  if (/microsoft|office 365|exchange online|sharepoint|intune|defender|teams/i.test(description)) return 'Microsoft';
  return 'Unknown';
}

/** Words that describe the TERM or the channel, not the product. */
const TERM_NOISE = [
  /\[\s*new commerce experience\s*\]/gi, /\[\s*nce\s*\]/gi, /\bnce\b/gi,
  /\bannual\s*-\s*billed\s*(monthly|annual(ly)?)\b/gi, /\bmonthly\s*-\s*billed\s*monthly\b/gi,
  /\bmonthly\s*-\s*1\s*yr\s*commit\b/gi, /\b1\s*yr\s*commit\b/gi, /\b(monthly|annual|yearly)\b\s*$/gi,
  /\s-\s*(monthly|annual|yearly)\b/gi, /\[options:\s*\]/gi, /\bpowered by dropsuite\b/gi,
];

/** "Microsoft 365 Business Standard [NCE] Annual - Billed Monthly" → "microsoft 365 business standard". */
export function productKey(name: string): string {
  let s = String(name ?? '');
  for (const re of TERM_NOISE) s = s.replace(re, ' ');
  return s.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A tidy display name for an offering from a vendor description — the product,
 * without the billing event ("Arrears Charge Tier 1", "Jun Partial:") or the
 * quantity ("- 22 Each", "- 34 User").
 */
export function offeringName(description: string): string {
  let s = String(description ?? '').replace(/^[A-Z][a-z]{2}\s+Partial:?\s*/, '');
  for (const re of TERM_NOISE) s = s.replace(re, ' ');
  s = s.replace(/\s*-\s*Arrears Charge\b.*$/i, '')
    .replace(/\s+Enforcement Charge\b.*$/i, '')
    .replace(/\s*-\s*\d+(\.\d+)?\s*(users?|each|gb|endpoints?|devices?|seats?)\b.*$/i, '')
    .replace(/\bquantity change.*$/i, '');
  return s.replace(/\s*\/\s*$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * The term an Autotask service SELLS, from its name and period type
 * (periodType 2 = Monthly, 5 = Yearly). '' = the name doesn't say — never
 * guessed as MM.
 */
export function serviceCadence(name: string, periodType: number | null | undefined): Cadence | '' {
  const n = String(name ?? '').toLowerCase();
  if (/annual\s*-\s*billed\s*monthly|monthly\s*-\s*1\s*yr\s*commit|1\s*yr\s*commit/.test(n)) return 'AM';
  if (/annual\s*-\s*billed\s*annual|-\s*annual\b|\bannual\b/.test(n) && periodType === 5) return 'AA';
  if (/monthly\s*-\s*billed\s*monthly/.test(n)) return 'MM';
  if (/\[(nce|new commerce experience)\][^a-z]*-?\s*monthly\s*$|\bnce\]\s*-\s*monthly/.test(n)) return 'MM';
  if (periodType === 5) return 'annual';
  // a non-NCE product sold "- Monthly" (Dropsuite, Addigy, …): monthly, no commitment
  if (/-\s*monthly\s*$/.test(n) && !/nce|new commerce/.test(n)) return 'monthly';
  return '';
}

/** Token overlap 0..1 between two product keys (for ranking candidates, never for auto-matching). */
export function similarity(a: string, b: string): number {
  const A = new Set(productKey(a).split(' ').filter(Boolean)), B = new Set(productKey(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Compare a vendor line's cadence with what a service sells. */
export function cadenceMatches(line: Cadence, sold: Cadence | ''): 'same' | 'unknown' | 'different' {
  if (!sold || line === 'none') return 'unknown';
  if (line === sold) return 'same';
  // non-NCE vendors bill "monthly" with no commitment; a service sold "MM" is the same thing
  if ((line === 'monthly' && sold === 'MM') || (line === 'MM' && sold === 'monthly')) return 'same';
  if ((line === 'annual' && sold === 'AA') || (line === 'AA' && sold === 'annual')) return 'same';
  return 'different';
}
