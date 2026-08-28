// Ticket-charge reporting (Expansion Spec §Phase 6 — billing review).
//
// Pure summary of ticket charges: status breakdown (Autotask's fulfillment
// picklist), billed vs unbilled, total billable, and a per-ticket rollup. The
// service supplies the charges (optionally enriched with ticket number/company);
// this owns the grouping so it is unit-testable without a tenant.

export const CHARGE_STATUS: Record<number, string> = {
  1: 'Pending',
  2: 'Waiting Approval',
  3: 'Need to Order/Fulfill',
  4: 'On Order',
  6: 'Ready to Deliver/Ship',
  7: 'Delivered/Shipped Full',
  8: 'Canceled',
};

export interface ChargeRow {
  id: number;
  ticketID?: number | null;
  name?: string;
  status: number;
  isBilled?: boolean;
  billableAmount?: number;
  extendedCost?: number;
  unitQuantity?: number;
  ticketNumber?: string;
  company?: string;
}

export interface ChargeLine {
  chargeId: number;
  name: string;
  status: string;
  billed: boolean;
  amount: number;
}
export interface TicketCharges {
  ticketID: number | null;
  ticketNumber?: string;
  company?: string;
  charges: ChargeLine[];
  total: number;
}
export interface ChargeSummary {
  totalCharges: number;
  byStatus: Record<string, number>;
  billed: number;
  unbilled: number;
  totalBillable: number;
  unbilledBillable: number;
  ticketsWithCharges: number;
  tickets: TicketCharges[];
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Summarize ticket charges. Set `unbilledOnly` to keep only not-yet-billed charges. */
export function summarizeTicketCharges(
  charges: ChargeRow[],
  opts: { unbilledOnly?: boolean } = {}
): ChargeSummary {
  const rows = (charges ?? []).filter((c) => (opts.unbilledOnly ? !c.isBilled : true));

  const byStatus: Record<string, number> = {};
  let billed = 0, unbilled = 0, totalBillable = 0, unbilledBillable = 0;
  const perTicket = new Map<number | null, TicketCharges>();

  for (const c of rows) {
    const label = CHARGE_STATUS[c.status] ?? String(c.status);
    byStatus[label] = (byStatus[label] || 0) + 1;
    const amount = round2(num(c.billableAmount ?? c.extendedCost));
    totalBillable += amount;
    if (c.isBilled) billed += 1;
    else { unbilled += 1; unbilledBillable += amount; }

    const key = c.ticketID ?? null;
    let t = perTicket.get(key);
    if (!t) {
      t = { ticketID: key, ...(c.ticketNumber ? { ticketNumber: c.ticketNumber } : {}), ...(c.company ? { company: c.company } : {}), charges: [], total: 0 };
      perTicket.set(key, t);
    }
    t.charges.push({ chargeId: c.id, name: c.name ?? '', status: label, billed: !!c.isBilled, amount });
    t.total = round2(t.total + amount);
  }

  const tickets = [...perTicket.values()].sort((a, b) => b.total - a.total);
  return {
    totalCharges: rows.length,
    byStatus,
    billed,
    unbilled,
    totalBillable: round2(totalBillable),
    unbilledBillable: round2(unbilledBillable),
    ticketsWithCharges: tickets.length,
    tickets,
  };
}
