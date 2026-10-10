# Example A: repository maintainer

An Agent Job that reads a repository, pushes a fix branch, opens one pull
request and merges it after a human approval. It runs offline: the
`simulated` provider replays a script, `repo.*` tools act on a local git
repository and `github.*` tools act on Orkestr's local fake code host.

```sh
cd examples/repository-maintainer
git init -q repo && echo '# example' > repo/README.md
git -C repo add README.md && git -C repo commit -q -m init   # any local repo with a README.md
orkestr run .                     # parks at the merge approval
orkestr jobs approvals
orkestr jobs approve <approval-id>
orkestr jobs status <run-id>
```

Crash the process at any point (or `kill -9` it) and run `orkestr jobs
approve`/`orkestr run` again: the run resumes from its checkpoints, the fix
branch is found again in git (`orkestr-effect:` marker) and the pull request
is opened once. See `test/agent-job-example-a.test.js`.

A real GitHub connector is a follow-up; until then `github.*` tools refuse to
run unless `inputs.code_host` is `fake`.
