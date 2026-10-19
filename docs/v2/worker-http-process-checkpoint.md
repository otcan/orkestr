# Synthetic Worker HTTP and process checkpoint

The independent runner reported six of six scenarios passing for integration
`765e754535492d48d544d0aaf089dec4b8f71f57` using committed probe `95bc2080`.
The pinned server SHA256 was
`fa6c189987f929d4f3f02cb82747c1e6a1fd135a637ed39cefc0c6a9b5c34bff`.
This records the attributed result; the coordinator did not repeat the run.

The source combined Worker module `533d08ab`, shared control mailbox `e025c246`,
Core attachment guard `d787153e` and Runtime retained-resource ownership.

The ordinary HTTP/process scenarios established a distinct native Worker with
immutable parent source, no extra inbox consumption and separate owner
acceptance. They covered revocation before Started and during execution, parent
completion fencing while preserving terminal truth, parent HTTP Stop, and the
Worker's own deadline reaching terminal Stop while Deep remained Running.
Every fixture checked native process disappearance and Worker scratch removal.

Direct Worker browser Stop remained unavailable and refused before cancellation
writes. All providers in this checkpoint were synthetic. Real-provider Worker
acceptance, browser controls, final ancestry integration, multi-conversation
scheduling and production lifecycle qualification remain separate gates. No
production activation or full-release claim follows from these results. Private
receipts remain outside this repository.
