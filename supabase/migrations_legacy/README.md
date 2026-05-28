# Legacy schema archive

`001_initial_schema.sql` and `002_rls_policies.sql` are preserved for reference and for teams that intentionally run the **standalone users-table** model.

They are **not** part of the default Zuri + Supabase Auth migration path. The active chain lives in `../migrations/` (`20250509*` … `20250510*`).

Applying both designs to one database will fail or corrupt semantics. Choose one model per project.
