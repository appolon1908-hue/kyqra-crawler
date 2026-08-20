# Atomic staging deployment

The backend is published only on `127.0.0.1:3100`. Nginx terminates mTLS on
`10.40.0.4:18444` for `kyqra.internal.codestra.agency` and proxies to that
loopback backend. UFW permits only `10.40.0.1` on VLAN interface
`enp5s0.4001` to TCP/18444.

The public virtual host exposes only the Basic-authenticated UI and safe GET
health endpoints. Every job, result, cancellation, retry, statistics and
callback path is denied at the public edge and remains available only behind
the private mTLS listener and application bearer authentication.

The privileged installer verifies the release manifest, fixed paths, commit,
image digest, certificates, configuration and backups, then changes Compose,
Nginx and UFW as one transaction. Any failed verification invokes rollback.
Only the Kyqra API container and Nginx configuration are reloaded.
