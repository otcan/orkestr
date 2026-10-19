# Claude usage metadata compatibility

Claude Code 2.1.295's usage schema `Hn` declares optional nullable `speed`
with `standard` and `fast` modes. Its `qH` schema declares the integer
`output_tokens_details.thinking_tokens`. The examined executable is identified
in [the input transformation note](claude-input-transformations.md); these
declarations are at offsets 207493508 and 207493098 respectively.

Anthropic's primary SDK definitions at commit
[`bcd55fe1d3f0f1240765f8cef04295b67337f55a`](https://github.com/anthropics/anthropic-sdk-python/tree/bcd55fe1d3f0f1240765f8cef04295b67337f55a/src/anthropic/types/beta)
corroborate these fields in `BetaUsage` and `BetaOutputTokensDetails`. The prior
stream validator rejected them even though no execution behavior depends on
them. This correction is a separate source-backed compatibility change; it is
not a diagnosis of a previously unnamed header key.

The broker accepts only absent/null/`standard`/`fast` for `speed` and applies its
existing strict nonnegative integer bound below 2^53 to `thinking_tokens`.
Boolean, fractional, negative, nonfinite, unknown, and oversized values refuse.
The previously supported `reasoning_tokens` member is retained for compatibility.
No other usage field or nested shape is added. Nonzero server-tool counts still
refuse, and fallback-credit/iteration restrictions are unchanged.

Metadata is validated and discarded in streamed headers, matching full assistant
messages, and final message deltas. It cannot produce visible text or native
Stop evidence, choose a billing mode, change the selected provider, or request
any settings. Existing raw-wire/frame budgets include every byte. Correlation,
replay, text digest, and terminal guards are unchanged.

```sh
cd v2/provider-broker
python3 -B -m unittest test_claude_usage_metadata -v
python3 -B -m unittest discover -p 'test_claude*.py' -v
```

The synthetic process fixture also sends these usage fields through the actual
owned native stdin/FD3 path. No account is accessed by these tests.
