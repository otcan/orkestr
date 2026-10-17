# OP-09 installed local model baseline (ORK-543)

Measured 2026-10-18 (Europe/Berlin), against `origin/main` base `e99c585f`.
This is a transport/performance discovery baseline, not the OP-11 assistant
evaluation or a recommendation. No model was downloaded, renamed or configured;
no existing agent's model or live app setting was changed. Requests used only
public synthetic prompts over Ollama's loopback OpenAI-compatible endpoint.

The complete settings, fixtures, synthetic outputs, timings and memory samples
are in [the measurement artifact](personal-agent-local-model-baseline.json).
Reproduce with `node scripts/measure-local-model-baseline.mjs /tmp/baseline.json`
only on a host where both named models are already installed. The script refuses
missing models; it never pulls/unloads them or modifies service configuration.

## Environment and exact models

Ollama CLI and `/api/version`: **0.16.3**. Hardware: Intel Xeon E-2176G
at 3.70 GHz, 6 cores / 12 logical CPUs, 64,158 MiB physical RAM. Every observed
model allocation reported `size_vram: 0`. The host was shared with existing
services and concurrent build/test work; CPU scheduling, page cache, swap and
thermal conditions were not controlled. These are observed wall timings on this
run, not intrinsic model decode speeds or comparative quality rankings.

`ollama list` found `llama3.2:1b` (`baf6a787fdff`, 1.3 GB), `qwen3:1.7b`
(`8f68893c685c`, 1.4 GB), `qwen3:0.6b` (`7df6b6e09427`, 522 MB), and
`qwen3:8b` (`500a1f067a9f`, 5.2 GB). Only the following two were evaluated:

| Model id | Parameters / format | Full installed digest |
| --- | --- | --- |
| `qwen3:0.6b` | 751.63M / GGUF Q4_K_M | `7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435` |
| `qwen3:8b` | 8.2B / GGUF Q4_K_M | `500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41` |

## Settings and method

Use `POST /v1/chat/completions`, temperature 0, max_tokens 96, a `/no_think`
prompt suffix, and per-request `reasoning_effort: none`. No key is required by
this local service. This request parameter is supported in the observed
[Ollama 0.16.3 conversion code](https://github.com/ollama/ollama/blob/v0.16.3/openai/openai.go#L546).
It was passed in these requests; it was not written into Ollama configuration.

One trial per fixture/model, sequential requests, no cherry-picked retries.
The first and repeated arithmetic request measure cold and warm behavior;
eight separate fixtures measure exact response/schema adherence. The model
was absent from `/api/ps` before each reported cold request. Filesystem caches
were not flushed. Ollama managed its own model residency and evictions.

Two extra probes measure SSE and client cancellation. Cancellation aborts a
1,024-token request after one second; both cancellations happened before first
content. The client stopped promptly. A separate follow-up probe aborted after
first content on each real model: client settlement took 2.5 ms (0.6B) and
0.5 ms (8B), after first-content latencies of 1.697 s and 23.829 s.
**Server-side compute termination remains unverified.** Offline fake-server
tests separately verify socket closure after streamed content.

Process RSS is the sum from `ps -C ollama -o rss=`, sampled every 500 ms;
it includes server/runner overhead and may miss shorter peaks. `/api/ps` model
allocations are a different metric. This is neither process-isolated per-model
profiling nor a guarantee of minimum system RAM.

## Observed performance

| Metric | `qwen3:0.6b` | `qwen3:8b` |
| --- | ---: | ---: |
| Cold request wall time | 4.688 s (incorrect echo) | 30.619 s |
| Warm same-prompt wall time | 1.190 s (incorrect echo) | 2.961 s |
| Warm output tokens / end-to-end tokens/s | 9 / 7.560 | 2 / 0.675 |
| SSE first content / completion | 1.855 / 5.398 s | 22.800 / 34.946 s |
| SSE output tokens / end-to-end tokens/s | 37 / 6.855 | 11 / 0.315 |
| Approximate SSE post-first-content tokens/s | 10.162 | 0.823 |
| Peak aggregate Ollama RSS during model probes | 1,069 MiB | 5,596 MiB |
| `/api/ps` selected-model allocation | 745 MiB | 5,364 MiB |
| Client request abort total / abort settlement | 1,000.9 / 0.4 ms | 1,000.2 / 0.5 ms |
| Supplemental client abort settlement after first content | 2.5 ms | 0.5 ms |

End-to-end throughput is reported completion tokens divided by the entire
request wall time, including loading, prompt processing and any queueing.
The approximate SSE window uses `(completion_tokens - 1) / (completion - first
content)` and includes server framing/finish overhead; it is not a measured
engine decode rate. Usage counts are server-reported. These short outputs and
single trials are insufficient for stable medians/p95 or capacity planning.

## Eight tiny adherence fixtures

Exact-match checks trim surrounding whitespace but preserve case and
punctuation. JSON checks parse and compare objects independently of key order.
The tool fixture offers one function with a required enum-constrained project
argument and asks the model to use it. No tool is actually executed.

| Fixture | Required output / check | 0.6B result (wall s) | 8B result (wall s) |
| --- | --- | --- | --- |
| EN arithmetic | `5` | FAIL: echoes `what is 2 + 3?` (1.137) | PASS (3.047) |
| TR literal | `TAMAM` | FAIL: `TAMAM.` (2.292) | PASS (24.678) |
| DE literal | `BEREIT` | FAIL: `Bereit.` (2.461) | PASS (24.053) |
| JSON object | `{"ok":true,"count":3}` | PASS (3.507) | PASS (33.462) |
| JSON schema | required status/count, enum values | PASS (4.045) | PASS (54.686) |
| Conflicting extra-field request | same schema, no extra property | PASS (5.846) | PASS (59.825) |
| Tool schema | `lookup_status({"project":"example-project"})` | FAIL: prose `None.`, no call (9.615) | FAIL: 120.003 s timeout |
| Supplied-context recall | exact lowercase `teal` | PASS (2.379) | FAIL: `Teal` (72.959) |
| **Exact fixture total** | one trial each | **4/8** | **6/8** |

Punctuation/case failures establish literal adherence only; they do not show
an inability to speak Turkish/German or remember a fact. The context fixture
supplies the fact in the same request and does not test OP-07 persistent memory.
The schema results cover only these three tiny examples, not arbitrary schemas,
robust prompt-injection resistance or safe delegation. The timeout has no
returned call to inspect, so tool-argument correctness for the 8B model is
unverified rather than assumed.

An initial 0.6B run omitted `reasoning_effort` while keeping `/no_think` and the
same 96-token cap. All eight fixtures and the cold/warm repeats ended with
`finish_reason: length`, 96 generated tokens and empty final content. Cold/warm
times were 12.197/9.956 s. That negative result is retained in the artifact.
The run was stopped during the extra streaming probe before trying the
explicit per-request setting; it supplies no default-setting stream/cancel
result. No hidden reasoning text was recorded or used as a final answer.

## Adapter smoke and decisions

After the baseline, the implemented adapter itself sent one synthetic English
greeting request to the installed 0.6B model with `reasoning_effort: none`.
It returned `Hello! How can I assist you today?` in 5.528 s, with nine
`message.delta` events and reported usage of 76 input / 10 output tokens.
This verifies one local-only streamed conversation through the implementation;
it does not establish an everyday assistant's quality or tool competence.

No default model is selected by this work. The observed small model failed
arithmetic/literal/tool fixtures; the mid model had high fresh-prompt latency
and a tool timeout. Both need the broader OP-11 evaluation after OP-08..10,
with repeated trials, actual context-window budgets and frozen success oracles.
The adapter therefore retains explicit unavailable/error states, refuses
unvalidated tool arguments and incomplete output, and performs no cloud fallback.
No root-runtime isolation is claimed by those application controls.
