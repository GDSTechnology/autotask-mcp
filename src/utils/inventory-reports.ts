// Inventory reporting (Expansion Spec §Phase 3 — inventory/purchasing).
//
// Pure, HTTP-free computation for three reports; the service fetches the Autotask
// entities and feeds them here so the accounting is unit-testable without a tenant:
//   - reorder control  (InventoryProducts below minimum → suggested order)
//   - close-outs        (to-order ticket charges already fulfillable from stock)
//   - stale / trending  (on-hand stock aging + movement)

export interface InvProductRow {
  productID: number;
  inventoryLocationID: number;
  onHandUnits?: number;
  availableUnits?: number;
  unitsOnOrder?: number;
  quantityMinimum?: number;
  quantityMaximum?: number;
  bin?: string;
}
export interface ProductRow {
  id: number;
  name?: string;
  sku?: string;
  unitCost?: number;
  isActive?: boolean;
}
export interface LocationRow {
  id: number;
  locationName?: string;
  resourceID?: number | null;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A location tied to a resource (tech van / personal stock) rather than a warehouse. */
export function locationType(loc?: LocationRow): 'warehouse' | 'resource' {
  return loc && loc.resourceID != null ? 'resource' : 'warehouse';
}

/** Generic catch-all products (Misc / Equipment / labor / freight) — flagged, not trusted for stock. */
export function isGenericProduct(p?: ProductRow): boolean {
  if (!p) return true;
  if (!p.sku || String(p.sku).trim() === '') return true;
  return /\b(misc|miscellaneous|equipment|generic|hardware|non-?taxable|shipping|freight|ground|labor|parts)\b/i.test(
    String(p.name ?? '')
  );
}

export interface ReorderLine {
  productID: number;
  name: string;
  sku: string;
  location: string;
  locationType: 'warehouse' | 'resource';
  available: number;
  onOrder: number;
  min: number;
  max: number;
  suggestQty: number;
  estCost: number;
}

/**
 * Below-minimum lines with a suggested order quantity. Position = on-hand available
 * + already-on-order; below when position <= minimum; suggest ordering back up to
 * the maximum (or the minimum if no max is set). Inactive products are skipped.
 */
export function computeReorder(
  inv: InvProductRow[],
  productsById: Record<string, ProductRow>,
  locationsById: Record<string, LocationRow>
): { lines: ReorderLine[]; totalEstCost: number } {
  const lines: ReorderLine[] = [];
  for (const r of inv ?? []) {
    const p = productsById[String(r.productID)];
    if (p && p.isActive === false) continue;
    const min = num(r.quantityMinimum);
    if (min <= 0) continue;
    const max = num(r.quantityMaximum);
    const available = num(r.availableUnits ?? r.onHandUnits);
    const onOrder = num(r.unitsOnOrder);
    const position = available + onOrder;
    if (position > min) continue;
    const suggestQty = Math.max(0, (max || min) - position);
    if (suggestQty <= 0) continue;
    const loc = locationsById[String(r.inventoryLocationID)];
    lines.push({
      productID: r.productID,
      name: p?.name ?? `product#${r.productID}`,
      sku: p?.sku ?? '',
      location: loc?.locationName ?? `loc#${r.inventoryLocationID}`,
      locationType: locationType(loc),
      available,
      onOrder,
      min,
      max,
      suggestQty,
      estCost: round2(suggestQty * num(p?.unitCost)),
    });
  }
  lines.sort((a, b) => b.estCost - a.estCost);
  return { lines, totalEstCost: round2(lines.reduce((s, l) => s + l.estCost, 0)) };
}

export interface OpenChargeRow {
  id: number;
  ticketID?: number;
  productID?: number | null;
  name?: string;
  status: number;
  unitQuantity?: number;
}
export interface CloseoutLine {
  chargeId: number;
  ticketID: number | null;
  charge: string;
  status: string;
  qty: number;
  productID: number;
  inStock: number;
  isGeneric: boolean;
}

const CHARGE_STATUS: Record<number, string> = { 3: 'Need to Order', 4: 'On Order' };

/**
 * To-order charges (status 3/4) whose product has stock on hand. `stockByProduct`
 * maps productID → available units summed across locations. Generic/catch-all
 * products are flagged (their stock counts are unreliable) but not dropped.
 */
export function computeCloseouts(
  charges: OpenChargeRow[],
  stockByProduct: Record<string, number>,
  productsById: Record<string, ProductRow>
): CloseoutLine[] {
  const out: CloseoutLine[] = [];
  for (const c of charges ?? []) {
    if (c.productID == null) continue;
    const inStock = num(stockByProduct[String(c.productID)]);
    if (inStock <= 0) continue;
    out.push({
      chargeId: c.id,
      ticketID: c.ticketID ?? null,
      charge: c.name ?? '',
      status: CHARGE_STATUS[c.status] ?? String(c.status),
      qty: num(c.unitQuantity),
      productID: c.productID,
      inStock,
      isGeneric: isGenericProduct(productsById[String(c.productID)]),
    });
  }
  // Real (SKU'd) matches first, then generics; each group by stock depth.
  out.sort((a, b) => Number(a.isGeneric) - Number(b.isGeneric) || b.inStock - a.inStock);
  return out;
}

export interface StockedItemRow {
  inventoryProductID?: number;
  onHandUnits?: number;
  unitCost?: number;
  createDateTime?: string;
  pickedRemovedDateTime?: string | null;
}
export interface StaleLine {
  inventoryProductID: number;
  productID: number | null;
  name: string;
  onHand: number;
  value: number;
  oldestReceiptDays: number;
  removedRecently: number;
  stale: boolean;
}

/**
 * On-hand stock aging + movement. Groups InventoryStockedItems by inventory
 * product: total on-hand qty/value, age of the oldest still-on-hand receipt, and
 * how many units were removed within `recentDays`. `stale` = oldest receipt older
 * than `staleDays` with no recent movement. `resolve` maps inventoryProductID →
 * { productID, name }.
 */
export function computeStaleStock(
  items: StockedItemRow[],
  resolve: (inventoryProductID: number) => { productID: number | null; name: string },
  opts: { asOf?: Date; staleDays?: number; recentDays?: number } = {}
): StaleLine[] {
  const asOf = opts.asOf ?? new Date();
  const staleDays = opts.staleDays ?? 180;
  const recentDays = opts.recentDays ?? 180;
  const recentCutoff = asOf.getTime() - recentDays * 864e5;
  const days = (iso?: string | null) => (iso ? (asOf.getTime() - new Date(iso).getTime()) / 864e5 : 0);

  const groups = new Map<string, { onHand: number; value: number; oldest: number; removedRecently: number }>();
  for (const it of items ?? []) {
    if (it.inventoryProductID == null) continue;
    const key = String(it.inventoryProductID);
    let g = groups.get(key);
    if (!g) { g = { onHand: 0, value: 0, oldest: 0, removedRecently: 0 }; groups.set(key, g); }
    const onHand = num(it.onHandUnits);
    if (onHand > 0) {
      g.onHand += onHand;
      g.value += onHand * num(it.unitCost);
      g.oldest = Math.max(g.oldest, days(it.createDateTime));
    }
    if (it.pickedRemovedDateTime && new Date(it.pickedRemovedDateTime).getTime() >= recentCutoff) {
      g.removedRecently += 1;
    }
  }

  const lines: StaleLine[] = [];
  for (const [key, g] of groups) {
    if (g.onHand <= 0) continue;
    const info = resolve(Number(key));
    lines.push({
      inventoryProductID: Number(key),
      productID: info.productID,
      name: info.name,
      onHand: g.onHand,
      value: round2(g.value),
      oldestReceiptDays: Math.round(g.oldest),
      removedRecently: g.removedRecently,
      stale: g.oldest > staleDays && g.removedRecently === 0,
    });
  }
  lines.sort((a, b) => Number(b.stale) - Number(a.stale) || b.value - a.value);
  return lines;
}
