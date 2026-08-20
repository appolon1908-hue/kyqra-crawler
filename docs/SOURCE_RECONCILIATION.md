# Source reconciliation

The reconciliation branch is based on deployed commit
`45b388fed2f9424c296ca74e19404b383cafeee4` from PR #1.

Live-only changes were classified as follows:

| Change                                       | Classification                     | Resolution                                      |
| -------------------------------------------- | ---------------------------------- | ----------------------------------------------- |
| Idempotency, correlation and tenant metadata | Required application behavior      | Preserved in source                             |
| Signed middleware result/progress callbacks  | Required application behavior      | Preserved in source                             |
| Middleware callback URL and allowlist        | Environment-specific configuration | Kept as non-secret references in `.env.example` |
| `10.40.0.4:3100` Compose publication         | Obsolete or unsafe drift           | Removed; loopback publication is authoritative  |
| Live `.env`, logs, backups and volumes       | Secret/runtime data                | Excluded and never copied                       |
| `/healthz` and `/readyz`                     | Required deployment behavior       | Added as safe endpoints                         |
| Private mTLS and public edge policy          | Required deployment behavior       | Added as reviewed templates                     |

The release process substitutes only the immutable image digest and approved
client-certificate serial into fixed templates. It never imports the live
environment file.
