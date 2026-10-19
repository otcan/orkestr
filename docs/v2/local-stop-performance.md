# Bounded local Stop performance

`v2/acceptance/stop_performance.py` reuses the exact ordinary executable/synthetic native fixture. Ten configured conversations share one disposable loopback Store. Ten fresh Stop requests start behind one barrier after genuine native Running/progress. No external provider/account or production state is used.

Latency measures HTTP through receipt, including durable cancellation commit. Correctness separately requires ten cancellation rows and cancellation-requested runs, one actual interrupt per child, correlated interrupted terminals, and disappearance of every observed native PID/start identity. Terminal waits are not model latency. All attempted requests count; nearest-rank p95 with ten samples is the maximum. This small checkpoint does not characterize throughput or a tail distribution.

Run with immutable server, exact source export containing v2/tests, v2/provider-broker and the existing intake_performance.py, a new private evidence directory, and expected server SHA256. The separate existing intake probe measures 300 requests with ten concurrent clients and verifies acknowledged input after restart. Neither probe exercises a browser/public network path.

First schema39 debug checkpoint: source 65e7730298afefae0812cd98455f7c9d9ec5973e, server SHA256 e2675229ec03ae0fe2bd176c141f562e12413a1c1d3e852f7544703e78476f8c. Paired web files were hash-verified, not executed. Intake 300/300 HTTP202: p95 62.264518 ms. Stop 10/10 HTTP200: p95 140.938879 ms. Both pass the exclusive 250 ms local threshold. Every Stop child was reaped and state removed. Existing intake unit tests 10/10 and new probe unit tests 2/2 passed.

Private qualification evidence retains raw request samples, traces/receipts, pair and fixture/probe hashes, environment and cleanup results. Environment includes CPU count, platform, Python, filesystem, memory and post-run load. Workloads ran sequentially. No failed measurement was discarded/repeated to improve p95. This does not qualify release, real-provider, schema40 workspace, installed-manager or public-path performance.
