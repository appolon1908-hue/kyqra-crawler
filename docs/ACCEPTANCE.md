# Acceptance ledger

This ledger records only capabilities proved by CI on a fresh checkout. Every
milestone appends one row after its exit criteria pass. Links must point to the
specific GitHub Actions run that exercised the recorded commit.

| Milestone | Date (UTC) | Commit SHA                                                                                                                                     | CI run                                                                                                | Claims proved                                                                                                                                                                                                                                                                                                                                                                           | Explicitly not claimed                                                                                                                                                                                                                                                                                |
| --------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | 2026-08-29 | [`0ed8fb0f67daefd09a26670e2791ae50e4ceb0a8`](https://github.com/appolon1908-hue/kyqra-crawler/commit/0ed8fb0f67daefd09a26670e2791ae50e4ceb0a8) | [kyqra-ci run 33244971851](https://github.com/appolon1908-hue/kyqra-crawler/actions/runs/33244971851) | Target architecture and acceptance ledger established; README identifies the four unimplemented API options and accurately inventories every registered and outbound v1 route; all 19 mission P0/P1 defects plus the public deep-probe defect are filed with severity and remediation milestones; CODEOWNERS and the milestone PR evidence checklist are active; all 18 CI jobs passed. | No application defect is fixed by M0. Existing tests remain source-string based until M1. Crawl-target SSRF, robots enforcement, real cancellation, distributed frontier, adaptive browser selection, honest modes/extraction, public deep-probe remediation, and production cutover are not claimed. |

## Entry requirements

- Use the exact commit SHA tested by CI; do not use a branch name.
- Link the CI run that proves every milestone exit criterion.
- State partial or deferred capabilities under **Explicitly not claimed**.
- Do not mark a milestone complete while any required job is pending, skipped,
  or failing.
- Record required human approval for M6, M14, and M15 in the claims cell.
