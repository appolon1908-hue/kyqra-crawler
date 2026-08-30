# Privileged installer security contract

`codestra-kyqra-remediation-admin` accepts exactly one fixed subcommand and no
paths, environment assignments, service names, or shell fragments. Its release
directory, managed targets, image, commit, certificate identity, interface,
addresses and ports are compiled into the installed script.

The installer verifies a Codestra release-signing signature over SHA256SUMS,
every manifest path and checksum, root ownership, non-writable modes, absence
of symlinks and secrets, the exact merged commit and immutable image, mTLS
chain/SAN/key/serial, Compose and Nginx configuration, backup capacity and
unrelated provider health. Installation takes a database and configuration
backup first and automatically rolls back on error.

For releases with schema changes, validation rejects a Compose model that does
not gate API startup on the one-shot migrator. Installation stops the fixed
Kyqra application service set, runs that migrator from the pinned image, and
then recreates the API and every worker. Rollback keeps the service set stopped,
recreates the crawler database from the checksummed pre-install dump, and then
restarts the prior API and workers.

The sudo policy grants `kyqra-deploy` only seven exact command lines. It does
not grant a shell, editor, copy primitive, Docker wildcard, systemctl wildcard,
Nginx wildcard, UFW wildcard, or general root access.
