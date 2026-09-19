// Product-catalog hygiene primitives (#93 Phase A): category tree, gap finding,
// clean search, duplicate grouping. Pure functions.

import {
  buildCategoryTree, isMalformedCategoryLabel, findCatalogGaps, matchProducts, findDuplicateProducts,
} from '../src/utils/catalog-hygiene';

describe('buildCategoryTree', () => {
  const picks = [
    { value: 7, label: 'Security' },
    { value: 49, label: 'Security>Video Surveillance' },
    { value: 10, label: 'Security>Video Surveillance>Licenses' },
    { value: 1, label: 'Network' },
    { value: 38, label: 'Network>Supporting components used with wireless networking equipment. Includes mounting brackets, antennas, and power injectors used with access points.' },
  ];
  test('derives parent→child from the > path and depth', () => {
    const { nodes, roots } = buildCategoryTree(picks);
    const byV = new Map(nodes.map((n) => [n.value, n]));
    expect(roots.sort()).toEqual([1, 7]);
    expect(byV.get(49)!.parentValue).toBe(7);
    expect(byV.get(10)!.parentValue).toBe(49);
    expect(byV.get(10)!.depth).toBe(2);
    expect(byV.get(7)!.childValues).toContain(49);
    expect(byV.get(49)!.name).toBe('Video Surveillance');
  });
  test('flags malformed (description-like) labels', () => {
    const { nodes, malformedCount } = buildCategoryTree(picks);
    expect(nodes.find((n) => n.value === 38)!.malformed).toBe(true);
    expect(nodes.find((n) => n.value === 7)!.malformed).toBe(false);
    expect(malformedCount).toBe(1);
    expect(isMalformedCategoryLabel('Network>Wireless')).toBe(false);
  });
  test('tallies counts when supplied', () => {
    const { nodes } = buildCategoryTree(picks, new Map([[7, 3], [10, 5]]));
    expect(nodes.find((n) => n.value === 7)!.productCount).toBe(3);
    expect(nodes.find((n) => n.value === 1)!.productCount).toBe(0);
  });
});

describe('findCatalogGaps', () => {
  const products = [
    { id: 1, name: 'A', description: 'A good long description here', productCategory: 7, msrp: 10 },
    { id: 2, name: 'NoCat', description: 'fine description text', productCategory: null, msrp: 5 },
    { id: 3, name: 'NoMsrp', description: 'fine description text', productCategory: 7, msrp: 0 },
    { id: 4, name: 'Premium Widget Assembly', description: 'Premium Widget Assembly', productCategory: 7, msrp: 1 }, // same as name (>min length)
    { id: 5, name: 'Short', description: 'hi', productCategory: 7, msrp: 1 },        // too short
    { id: 6, name: 'Empty', description: '', productCategory: 7, msrp: 1 },          // empty
  ];
  test('detects missing category / msrp / weak descriptions', () => {
    const r = findCatalogGaps(products as any);
    expect(r.gaps.missingCategory.count).toBe(1);
    expect(r.gaps.missingMsrp.count).toBe(1);
    expect(r.gaps.weakDescription.count).toBe(3);
    const reasons = r.gaps.weakDescription.sample.map((s) => s.reason);
    expect(reasons).toEqual(expect.arrayContaining(['same as name', 'too short (2 chars)', 'empty']));
  });
});

describe('matchProducts (clean search)', () => {
  const products = [
    { id: 1, name: 'Blue Cat6 Keystone Jack', sku: 'GDS-KJ-C6-BL', manufacturerProductName: '326-120BL' },
    { id: 2, name: 'White Cat6 Keystone', sku: 'GDS-KJ-C6-WH', manufacturerProductName: '326-120WH' },
    { id: 3, name: 'Surface Mount Box', sku: 'GDS-SMB-1', vendorProductNumber: '300-314SE' },
  ];
  test('exact manufacturer part number ranks top', () => {
    const m = matchProducts(products as any, '326-120BL');
    expect(m[0].id).toBe(1);
    expect(m[0].matchedOn.join()).toContain('manufacturerProductName (exact)');
  });
  test('vendor number matches', () => {
    const m = matchProducts(products as any, '300-314SE');
    expect(m[0].id).toBe(3);
  });
  test('name token overlap catches loose queries', () => {
    const m = matchProducts(products as any, 'cat6 keystone');
    expect(m.map((x) => x.id).sort()).toEqual([1, 2]);
  });
  test('sku exact wins', () => {
    expect(matchProducts(products as any, 'gds-kj-c6-wh')[0].id).toBe(2);
  });
});

describe('findDuplicateProducts', () => {
  const products = [
    { id: 10, name: '11X8-061TH', sku: 'ACME-1', isActive: true, description: 'good', msrp: 5, productCategory: 1 },
    { id: 11, name: '11X8-061TH', sku: 'ACME-1', isActive: true },                 // dup by sku
    { id: 12, name: '11X8-061TH', sku: 'ACME-1', isActive: false },                // dup by sku, inactive
    { id: 20, name: 'Unique Item', sku: 'ACME-2' },                                // singleton
    { id: 30, manufacturerProductName: 'MPN-9' },
    { id: 31, manufacturerProductName: 'mpn 9' },                                  // dup by normalized mfr part
  ];
  test('groups by strongest identifier and suggests a survivor', () => {
    const groups = findDuplicateProducts(products as any);
    const skuGroup = groups.find((g) => g.matchKey === 'sku' && g.keyValue === 'acme1')!;
    expect(skuGroup.members.map((m) => m.id).sort()).toEqual([10, 11, 12]);
    expect(skuGroup.suggestedSurvivorId).toBe(10); // active + most complete
    const mpnGroup = groups.find((g) => g.matchKey === 'manufacturerProductName')!;
    expect(mpnGroup.members.map((m) => m.id).sort()).toEqual([30, 31]);
    expect(groups.some((g) => g.members.some((m) => m.id === 20))).toBe(false); // singleton excluded
  });
});
