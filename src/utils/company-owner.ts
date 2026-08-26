// Company owner resolution (GDS brief §6.1).
//
// Autotask rejects company creation without ownerResourceID, even though the
// tool historically described it as optional. Resolve it explicitly — from the
// supplied value or a configured default — and never silently pick an arbitrary
// owner.

export function resolveCompanyOwnerResourceID(
  company: { ownerResourceID?: number | null | undefined },
  env: NodeJS.ProcessEnv = process.env
): number {
  if (company.ownerResourceID != null) return company.ownerResourceID;

  const raw = env.AUTOTASK_DEFAULT_OWNER_RESOURCE_ID;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }

  throw new Error(
    'Company create requires ownerResourceID — Autotask rejects company creation ' +
    'without an owner. Provide ownerResourceID, or set AUTOTASK_DEFAULT_OWNER_RESOURCE_ID.'
  );
}
