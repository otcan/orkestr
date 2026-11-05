# Managed host providers

`managed_host` is an explicit operator-only host-native profile for the
authority/executor UID split. Its environment, optional private environment-file
references and `providers: true` use the existing host environment grammar.
It cannot be combined with legacy `host_full_access` or a single-UID plan.

Root starts the executor with no supplementary groups, no capabilities and
inherited `no_new_privs`. Host commands use the executor's existing accounts and
project ownership. A managed native cannot use sudo to become the Core owner.
Privileged business capabilities require separately configured fixed operations.

Root's original launch capsule selects a conversation. Only that conversation's
protected `conversation_workspaces` entry can replace the Deep/Fast cwd. Owned
projects retain their executor UID; foreign shared projects require an explicit
named executor ACL and effective rwx mask. Core does not open these private
project trees. The proxy starts at `/`; protocol cwd still matches the selected
project exactly. Primary and secondary conversations apply the same mapping,
while unmapped conversations retain the original configured default.

The disposable `identity_split_host_http.py` rehearsal covers both providers,
fresh and resumed native sessions, multiple accepted turns, actual private
project cwd, Core traversal denial, NNP and original process cleanup. It uses
synthetic natives and no real provider account. Production split startup remains
held until the complete installed workflow and cutover are qualified.
