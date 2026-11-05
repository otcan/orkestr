# Root launch failure metadata

A claimed Root launch remains single-use when setup fails. Its private launch
journal keeps `state: unknown`; diagnostics never authorize a retry, release a
window, establish clean shutdown, or establish business completion.

`original_child` records the PID returned by the original `Popen`, the observed
process start identity (or null if unavailable), and its exit status before
cleanup (or null while still running). It describes the broker bootstrap child,
not a registered original native provider process. `cleanup_wait_status` is
separate so a cleanup signal cannot masquerade as the original failure.

`failure` contains a bounded exception class, numeric errno when applicable, and
a package-relative Python module, its SHA-256 and line. It never contains
exception text, traceback strings, locals, argv, prompts or credentials. The
entry process can return the same fixed schema as `child_failure` over the
existing Root-created capsule socket, in the direction opposite the setup
payload. The child checks the socket's Root peer against its original parent;
the Root reader checks the closed schema, size and immutable module digest.
Missing, foreign, malformed or stale reports are ignored. A child report is
diagnostic metadata and supplies no authority.

Existing launch readers preserve additional journal fields. The Fast observer
continues to select its original fixed claim fields and requires actual live
Root/kernel custody; these diagnostics cannot make an unknown launch observed
or accepted. Existing historical records remain readable without new fields.

The change modifies the package entry and launcher bytes. A build and package
manifest must therefore use the new source and module digests. Evidence pinned
to an older code subject remains historical component evidence; it must not be
renamed as qualification of the changed package. No deployment is implied by
committing this diagnostic change.
