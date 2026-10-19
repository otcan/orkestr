# Selected Codex Fast and Deep composition

The explicit `orkestr-v2-codex-bounded-roles-plan-v1` package configures Fast
and Deep for one ordinary conversation. The original single-Deep plan and
package remain unchanged. This is a finite operator-controlled opt-in window,
not an installer default or an automatically restarted provider service.

The ordinary server already owns both factories and their separate authority:

- Both roles observe one canonical owner input. Fast presents it without
  claiming or acknowledging the Deep inbox.
- Each role has its own Core context, supervisor key, namespace, native binding,
  workspace and writable native state. The fixed role launchers select those
  profiles in protected code; HTTP requests and launcher arguments cannot
  choose another profile.
- Fast acceptance applies only to its exact completion proposal. It does not
  accept Deep work or release the Deep queue. Neither provider can accept itself.
- Fast status and Stop use the `/fast/execution` and `/fast/stop` routes.
  Cross-role run locators and control requests cannot fall back to the other
  role. Fast steering remains unavailable.

The package emits a pinned ordinary execution set and two separately pinned
execution configurations. It validates the entire set before the controller
starts the ordinary server. Missing/duplicate roles, swapped launchers,
different conversations or account references, overlapping native state,
duplicate supervisor keys and Worker policy are refused. The ordinary server
still authenticates the machine token, issues metadata/dispatch grants, checks
native identity, and requires current owner acceptance.

Both profiles use the same explicitly selected canonical auth file as a
read-only mount. Each native home is fresh and separate; no auth file is copied,
hashed or opened by the packager/controller. The existing broker owns the sole
stdin FD3 handoff and one-use parent FD4 resume bootstrap. The selected namespace,
seccomp, parent-death and joined-cleanup behavior is unchanged.

## One aggregate resource window

There is one root controller, one ordinary server and one outer proxy pool for
both roles. The limits from [bounded Codex composition](selected-codex-composition.md)
remain aggregate: eight active outer relays, four pending local channels, 32
authenticated connection attempts, 64 MiB combining both directions, and the
original finite deadline. Role or server replacement cannot reset those counts.
Each inner namespace has its own bounded local pool; shared outer admission is
the additional common ceiling. These limits are not doubled for two roles.

Every protected profile retains only `chatgpt.com:443`, public numeric DNS,
the fixed authenticated timestamp prelude and the two-second setup deadline.
The explicit native role keeps `features.plugins=false`. No refresh command,
alternate account, API-key fallback, TLS inspection or service mutation is added.
Multiple concurrent real providers may exhaust this finite budget; successful
synthetic lifecycle checks do not prove their network demand fits it.

## Prepare an explicit two-role package

Use the same exact-commit binary/module and protected-path requirements as the
single-role package. A new protected plan has format
`orkestr-v2-codex-bounded-roles-plan-v1` and these common fields:

`output`, `source_repository`, `source_commit`, `server`, `native`, `uid`, `gid`,
`home`, `auth_file`, `egress_directory`, `bootstrap_file`, `machine_token_file`,
`conversation_id`, `port`, `lifetime_seconds`.

Replace the single-role `workspace`, `state_root`, `namespace` and
`supervisor_key` fields with exactly:

```json
{
  "roles": {
    "deep": {
      "workspace": "/srv/example/private/deep-workspace",
      "state_root": "/srv/example/private/deep-native-state",
      "namespace": "selected-deep",
      "supervisor_key": "selected-owner-deep"
    },
    "fast": {
      "workspace": "/srv/example/private/fast-workspace",
      "state_root": "/srv/example/private/fast-native-state",
      "namespace": "selected-fast",
      "supervisor_key": "selected-owner-fast"
    }
  }
}
```

All four role directories must be private and disjoint from each other, the
ordinary data home and selected auth reference. Both native-state directories
must initially be empty. The machine/bootstrap tokens remain ordinary private
file references, never JSON token values or arguments.

```sh
# Preparation only; this does not start either provider.
sudo env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
  /usr/bin/python3 -I -B v2/packaging/selected_codex_roles.py --plan "$root_plan"
# Review the returned immutable inventory and scope before a separate activation.
# The controller entrypoint and manifest argument are the existing public ones.
```

## Synthetic qualification

The protected-package suite tests role/profile substitutions, aliasing,
missing/private descriptors, read-only auth mounts and one shared budget:

```sh
cd v2/provider-broker
sudo env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -B -m unittest \
  test_selected_codex_roles -v
```

`v2/tests/selected_codex_roles_http.py` uses a protected ordinary server built
from the exact same committed source, the public packager/controller/broker,
real authenticated HTTP and the real selected isolation command. Its native is
a freshly compiled fixed synthetic ELF; its only account is a fresh dummy.
It reuses the ordinary Fast/Deep authority oracles for independent acceptance,
cross-role control refusal, same-child continuation, accepted restart,
selective Fast Stop, ACK-only uncertainty and machine-session revocation.
It records host PID/start identities and requires all observed processes and
listeners to disappear. Failed and successful synthetic fixtures are retained
for review. It makes no HTTPS requests or actual-provider readiness claim.

```sh
sudo env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -B \
  v2/tests/selected_codex_roles_http.py "$protected_server" \
  --source "$exact_commit" --report "$fresh_report"
```

Real selected-account qualification, Fast steering, broader workspace support,
ordinary installer setup and a complete production replacement remain separate
release gates. No account invocation is a side effect of these tests or package
preparation.
