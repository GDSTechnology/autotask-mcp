---
title: Merges & bulk cleanup
description: Safe ID-only merges through the Autotask UI, and paced bulk cleanup of placeholder companies and junk contacts.
---

Autotask's REST API has **no merge**, can't delete companies, and won't move a contact to another company. So
duplicates are merged with Autotask's own UI merge, and junk is **inactivated** at a pace the tenant can take.

## Safe merges

Merges are addressed **only by numeric IDs** — never by names or searches — and one kind per plan.

1. `autotask_merge_discover` finds candidates (by email across all three email fields, by exact name, around given
   IDs), with who created them and when. It never picks a survivor.
2. `autotask_merge_dependency_inventory` lists everything that points at each record — tickets, contracts,
   invoices, child companies — and the blockers (e.g. active contracts need a billing review).
3. `autotask_merge_build_plan` turns old → correct IDs (or a CSV) into numbered **UI steps** with deep links:
   merge, then delete in Admin. Chains, repeats, company 0 and placeholder survivors are refused.
4. After the UI work, `autotask_merge_verify` re-reads everything and marks each step done — or says what is
   still attached.

## Bulk cleanup

For junk at scale — tens of thousands of placeholder companies an integration created, or junk contacts on one
real account — `autotask_bulk_inactivate` and the console's **Bulk jobs** page run a job:

1. **Prepare** (reads only, from the mirror). For **placeholder companies**, every company with history —
   tickets, projects, contracts, opportunities, quotes, invoices, billing items, child companies — or a contact with
   a real name is **excluded**. For **junk contacts on one company**, contacts on the company's own domains, the
   primary contact and contacts with history are kept.
2. **Email safeguard** (placeholder cleanups). Real people use personal mail too, so every address is checked
   across the whole tenant: a ticket on any contact with that address keeps it; a person can list addresses to
   **keep** or to **treat as junk**; an address that also belongs to a contact on a real company is shown as a
   duplicate. The job card's **Email addresses** table shows each decision and why.
3. **Approve** by hash — exactly the records shown — then **start**: a 50-record **canary** runs and the job
   pauses for you to check them in Autotask.
4. **Resume.** The worker writes at the job's pace: slower in business hours, nothing in **quiet hours** (another
   integration's busy window), half pace from 40% tenant usage, waiting from 65%. Throttling never counts as a
   failure; 20 real failures in a row pause the job. It continues after a restart.

Inactivated records stay in Autotask. Finished jobs can be archived on the console.

Full details: [docs/MERGE.md](https://github.com/GDSTechnology/psarelay/blob/main/docs/MERGE.md).
