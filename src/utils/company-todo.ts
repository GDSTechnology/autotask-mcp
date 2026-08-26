// CompanyToDo action-type resolution (GDS brief §4.1).
//
// A To-Do's `actionType` is a tenant-specific picklist id. Callers may pass a
// numeric `actionType` OR a human `actionTypeName` (case-insensitive) resolved
// from live field metadata — never both. The verified GDS ids (0 General-ish
// set, 29682843 Sales, …) are NOT hard-coded here; they are resolved from the
// picklist the service fetches, so this stays a pure, tenant-agnostic lookup.

export interface ActionTypePicklistEntry {
  value: string | number;
  label: string;
}

/**
 * Resolve the numeric `actionType` for a create/update:
 *  - both actionType and actionTypeName supplied -> error (exactly one).
 *  - actionType supplied -> used as-is (no picklist needed).
 *  - actionTypeName supplied -> matched case-insensitively against the picklist.
 *  - neither -> the documented default label (General) is resolved from the picklist.
 *
 * Throws with the available labels when a name can't be matched, so the caller
 * gets an actionable error instead of a silent wrong id.
 */
export function resolveActionType(
  input: { actionType?: number | null | undefined; actionTypeName?: string | null | undefined },
  picklist: ActionTypePicklistEntry[],
  defaultLabel = 'General'
): number {
  const hasId = input.actionType !== undefined && input.actionType !== null;
  const hasName =
    input.actionTypeName !== undefined && input.actionTypeName !== null && input.actionTypeName !== '';

  if (hasId && hasName) {
    throw new Error('Provide exactly one of actionType or actionTypeName, not both.');
  }
  if (hasId) return input.actionType as number;

  const name = hasName ? (input.actionTypeName as string) : defaultLabel;
  const match = picklist.find((p) => String(p.label).toLowerCase() === name.toLowerCase());
  if (!match) {
    const available = picklist.map((p) => p.label).join(', ');
    throw new Error(
      `Unknown To-Do actionTypeName "${name}". Available action types: ${available || '(none returned by field metadata)'}.`
    );
  }
  return Number(match.value);
}
