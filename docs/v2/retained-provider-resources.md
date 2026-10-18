# Retained provider setup resources

`PreparingCodex::open_retained` has the same trusted arguments as `open`, plus
`resources: Box<dyn Send + 'static>`. This opaque value carries caller capacity
permits and scratch-directory ownership; Runtime never inspects it or derives
execution authority from it. Existing `open` supplies `()`.

Before spawning, the metadata authority transfers the value to its owned reaper.
The reaper releases it only after all senders close and every submitted child has
been waited. Thus setup errors after spawning, failed confirmation/attachment,
Stop, handle drop, and transfer to execution preserve the resource lifetime.
Pre-spawn refusal releases it without a child. Retention may exceed process exit
while an authority still owns a sender; callers must drop retired authority
handles to release capacity. Revocation is not itself a wait-completion signal.

This bounds the lifetime of caller permits across separately created authorities.
It does not make scratch cleanup an execution capability, nor prove termination
of processes outside the owned-child/reaper boundary.
