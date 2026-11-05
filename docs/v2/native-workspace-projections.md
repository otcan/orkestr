# Native conversation CWDs in a private resource view

The sealed `beta.conversation_workspaces` map selects Deep/Fast native working
directories. A configured resource namespace projects those exact leaves from
declared private homes, together with their checked Git metadata when present.
It preserves absolute paths and source ownership; unrelated home contents stay
hidden. Leaf owners must belong to the contract's declared source identities.
Foreign-owned leaves retain the existing `shared: true` named-executor ACL rule.
Existing named writers from the explicitly declared source identities are admitted
only inside selected native/Git roots. This never grants a writer permission or
permits an unrelated writer/group, and never applies to whole-home ancestors.
A non-Git CWD is valid here; a malformed or missing Git pointer target refuses.

These selections do not create `workspace_exec` profiles or Worker command
grants. Worker profiles retain their existing shape and Git requirements. Native
mount receipts carry a conversation ID rather than a project ID. Root checks the
original retained home/directory identities again; Core remains denied access.
Whole homes, credential/admin directories and protected authority overlaps
refuse. An outside-home Root-owned native CWD is not remounted or chowned and
uses its existing shared ACL, including Core denial.

For Git ownership checks, a native launch adds only its Root-attested current
conversation's exact directory to the existing explicit Git environment.
Worker command execution does not inherit native-only safe-directory entries.
No host account, ACL, service, process, conversation mapping or repository data
is changed by configuration parsing. Activation uses a private mount namespace.
