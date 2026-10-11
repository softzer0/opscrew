---
name: opscrew-scan
description: Run OpsCrew's free security scan on this repository and help the user fix what it finds (leaked keys, Supabase service-role keys in frontend code, tables without row-level security, open Firebase rules, risky Docker or framework settings, vulnerable dependencies). Use when the user asks whether their app is secure, before launching, or after a security scare.
---

# Security scan with OpsCrew

1. Call `opscrew_scan` (pass `offline: true` if the user does not want dependency names sent to the
   OSV vulnerability database). The full report is written to `opscrew/SECURITY_SCAN.md`.
2. Explain the results in plain English, most severe first: what is wrong, why it matters for this
   app, and the fix. Evidence in the report is masked; never try to recover or print a secret.
3. For each fix, propose the smallest safe change and apply it only after the user agrees:
   - **Leaked key or token committed to git:** the key must be revoked and replaced at the provider
     first (removing it from the code is not enough — it stays in git history). Then move it to an
     environment variable and add `.env` to `.gitignore`.
   - **Supabase service-role key in frontend code:** remove it from client code entirely; only a
     server (or a Supabase Edge Function) may use it. Rotate it in the Supabase dashboard.
   - **Table without row-level security:** add `alter table <table> enable row level security;` in
     a new migration and write policies that limit rows to their owner (`auth.uid() = user_id`).
   - **Permissive policy (`using (true)` on writes):** replace it with an ownership check.
   - **Open Firebase rules:** require `request.auth != null` and ownership checks.
   - **Vulnerable dependency:** upgrade to the fixed version named in the finding.
4. Re-run `opscrew_scan` to confirm the fixes.

Do not read `.env` files or private keys yourself; OpsCrew's scanner already did, safely.
