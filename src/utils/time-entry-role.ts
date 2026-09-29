/**
 * Role selection for ticket/task time entries.
 *
 * Autotask requires a roleID on ticket/task time, and the role drives the bill
 * rate, labour classification and departmental reporting — so for a resource
 * with several roles (e.g. Engineer vs Technician) the choice is the caller's,
 * never a guess. These helpers keep the choice list and the wording identical
 * across every labour-entry path (create, log_my_time, bulk, collaboration).
 */

export interface RoleChoice {
  roleID: number;
  roleName: string | null;
  isDefault: boolean;
  departments?: string[];
  queues?: string[];
}

/** How the role on a time entry was chosen — carried in results for audit. */
export type RoleSource = 'explicit' | 'default' | 'sole' | 'explicit_unverified';

/** "29683355 = Engineer [Information Technology]; 29682834 = Technician [...]" */
export function formatRoleChoices(choices: RoleChoice[]): string {
  return choices
    .map((r) => `${r.roleID} = ${r.roleName ?? '(unnamed role)'}${r.departments?.length ? ` [${r.departments.join('/')}]` : ''}${r.isDefault ? ' (default)' : ''}`)
    .join('; ');
}

export function needsRoleSelectionMessage(choices: RoleChoice[]): string {
  return `This resource has multiple roles and no single default — pick the one matching the work (by role/department) and re-run with roleID set to one of: ${formatRoleChoices(choices)}. Nothing was written.`;
}

export function invalidRoleMessage(roleID: number, resourceID: number, validRoles: RoleChoice[]): string {
  return `roleID ${roleID} is not an active role for resource ${resourceID} — nothing was written. Re-run with roleID set to one of: ${formatRoleChoices(validRoles)}.`;
}
