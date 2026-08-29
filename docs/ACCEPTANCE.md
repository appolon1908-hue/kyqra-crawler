# Acceptance ledger

This ledger records only capabilities proved by CI on a fresh checkout. Every
milestone appends one row after its exit criteria pass. Links must point to the
specific GitHub Actions run that exercised the recorded commit.

| Milestone | Date (UTC) | Commit SHA | CI run | Claims proved | Explicitly not claimed |
| --------- | ---------- | ---------- | ------ | ------------- | ---------------------- |

## Entry requirements

- Use the exact commit SHA tested by CI; do not use a branch name.
- Link the CI run that proves every milestone exit criterion.
- State partial or deferred capabilities under **Explicitly not claimed**.
- Do not mark a milestone complete while any required job is pending, skipped,
  or failing.
- Record required human approval for M6, M14, and M15 in the claims cell.
