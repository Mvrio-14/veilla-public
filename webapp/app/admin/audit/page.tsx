import { AuditClient } from "@/components/admin/audit-client";

/**
 * /admin/audit — read-only audit log viewer.
 *
 * Surfaces the `admin_actions` table (migration 0053): every mutation
 * performed through /admin/* lands here with who/what/when/payload.
 * Filterable by actor / action / target. Pagination cursor-based via
 * `before_id`. Click a row to see the full payload as formatted JSON.
 */
export default function AdminAuditPage() {
  return <AuditClient />;
}
