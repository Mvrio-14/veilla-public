import { UsersClient } from "@/components/admin/users-client";

/**
 * /admin/users — list + edit users.
 *
 * The admin can create a user row, edit name / slug / email /
 * output_lang / active / public and set the plan. The login itself is
 * still created in the Supabase Auth dashboard, and links to the row at
 * first sign-in by email.
 */
export default function AdminUsersPage() {
  return <UsersClient />;
}
