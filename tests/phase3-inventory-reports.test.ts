// Inventory report accounting (Expansion Spec §Phase 3). Pure — no tenant.

import {
  computeReorder, computeCloseouts, computeStaleStock, isGenericProduct, locationType,
} from '../src/utils/inventory-reports';

const products = {
  '10': { id: 10, name: 'US-48-500W', sku: 'US-48-500W', unitCost: 700, isActive: true },
  '11': { id: 11, name: 'Misc Hardware', sku: '', unitCost: 5, isActive: true },
  '12': { id: 12, name: 'Old Phone', sku: 'PH1', unitCost: 50, isActive: false },
};
const locations = {
  '1': { id: 1, locationName: 'Office - GDS', resourceID: null },
  '2': { id: 2, locationName: 'RESOURCE: Tech Van', resourceID: 555 },
};

describe('locationType / isGenericProduct', () => {
  test('resource-tied location is a van, else warehouse', () => {
    expect(locationType(locations['2'])).toBe('resource');
    expect(locationType(locations['1'])).toBe('warehouse');
  });
  test('generic when no sku or catch-all name', () => {
    expect(isGenericProduct(products['11'])).toBe(true);       // no sku
    expect(isGenericProduct({ id: 9, name: 'Equipment', sku: 'X' })).toBe(true); // catch-all name
    expect(isGenericProduct(products['10'])).toBe(false);      // real sku'd product
  });
});

describe('computeReorder', () => {
  const inv = [
    { productID: 10, inventoryLocationID: 1, availableUnits: 0, unitsOnOrder: 0, quantityMinimum: 1, quantityMaximum: 25 },
    { productID: 10, inventoryLocationID: 2, availableUnits: 4, unitsOnOrder: 0, quantityMinimum: 5, quantityMaximum: 10 },
    { productID: 10, inventoryLocationID: 1, availableUnits: 30, unitsOnOrder: 0, quantityMinimum: 5, quantityMaximum: 25 }, // above min → skip
    { productID: 12, inventoryLocationID: 1, availableUnits: 0, unitsOnOrder: 0, quantityMinimum: 1, quantityMaximum: 5 }, // inactive → skip
  ];
  test('below-min lines with suggested qty, est cost, location type', () => {
    const { lines, totalEstCost } = computeReorder(inv as any, products as any, locations as any);
    expect(lines).toHaveLength(2);
    // sorted by est cost desc: loc1 order 25 * 700 = 17500 first
    expect(lines[0]).toMatchObject({ productID: 10, location: 'Office - GDS', locationType: 'warehouse', suggestQty: 25, estCost: 17500 });
    expect(lines[1]).toMatchObject({ location: 'RESOURCE: Tech Van', locationType: 'resource', available: 4, suggestQty: 6, estCost: 4200 });
    expect(totalEstCost).toBe(21700);
  });
  test('on-order that covers the min is not reordered', () => {
    const { lines } = computeReorder([{ productID: 10, inventoryLocationID: 1, availableUnits: 0, unitsOnOrder: 2, quantityMinimum: 1, quantityMaximum: 25 }] as any, products as any, locations as any);
    expect(lines).toHaveLength(0); // position 2 > min 1
  });
});

describe('computeCloseouts', () => {
  const charges = [
    { id: 1, ticketID: 100, productID: 10, name: 'US-48', status: 3, unitQuantity: 1 }, // real, in stock
    { id: 2, ticketID: 101, productID: 11, name: 'Misc Hard', status: 4, unitQuantity: 2 }, // generic, in stock
    { id: 3, ticketID: 102, productID: 12, name: 'Old Phone', status: 3, unitQuantity: 1 }, // no stock (12 absent from map)
    { id: 4, ticketID: 103, productID: null, name: 'labor', status: 3 }, // no product → skip
  ];
  const stock = { '10': 0, '11': 1481 };
  test('flags generics, sorts real-first, skips out-of-stock/no-product', () => {
    const out = computeCloseouts(charges as any, { '10': 5, '11': 1481 } as any, products as any);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ productID: 10, status: 'Need to Order', inStock: 5, isGeneric: false });
    expect(out[1]).toMatchObject({ productID: 11, status: 'On Order', inStock: 1481, isGeneric: true });
  });
  test('charge with zero stock is excluded', () => {
    const out = computeCloseouts([charges[2]] as any, stock as any, products as any);
    expect(out).toHaveLength(0);
  });
});

describe('computeStaleStock', () => {
  const asOf = new Date('2026-08-01T00:00:00Z');
  const resolve = (ip: number) => ({ productID: ip === 500 ? 10 : 11, name: ip === 500 ? 'US-48-500W' : 'Misc' });
  const items = [
    { inventoryProductID: 500, onHandUnits: 3, unitCost: 700, createDateTime: '2025-01-01' }, // ~575d old, no removal → stale
    { inventoryProductID: 501, onHandUnits: 2, unitCost: 50, createDateTime: '2026-07-01', pickedRemovedDateTime: '2026-07-15' }, // recent movement → not stale
  ];
  test('ages on-hand stock and flags dead stock', () => {
    const lines = computeStaleStock(items as any, resolve, { asOf, staleDays: 180, recentDays: 180 });
    const s = lines.find((l) => l.inventoryProductID === 500)!;
    expect(s).toMatchObject({ onHand: 3, value: 2100, stale: true });
    expect(s.oldestReceiptDays).toBeGreaterThan(500);
    const fresh = lines.find((l) => l.inventoryProductID === 501)!;
    expect(fresh).toMatchObject({ removedRecently: 1, stale: false });
    expect(lines[0].stale).toBe(true); // stale sorted first
  });
});
