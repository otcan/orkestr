import { escapeHtml, publicRepoUrl, type PublicPage } from "./public-site-config.js";
import { ossCapabilityStatus, ossEvidenceLabels, ossStatusAsOf, type OssEvidence } from "./public-site-oss-status.js";

export const ossEntryLine = "Run your coding agent, leave your desk, and stay in control.";

const specDocs: Array<[string, string]> = [
  ["agent-job.md", "Agent Job: trigger, agent, task, permissions, runtime policy, notifications"],
  ["agent-job-runner.md", "How the runner works today, including what is runnable per provider"],
  ["runtime-guarantees.md", "Guarantees G1-G11, non-guarantees and the failure model"],
  ["adapter-interface.md", "The interface every provider adapter implements"],
  ["conformance.md", "The adapter conformance suite"],
];

function repoBlob(repo: string, path: string) {
  return `${escapeHtml(repo)}/blob/main/${path}`;
}

function evidenceBadge(evidence: OssEvidence) {
  return `<span class="oss-evidence oss-evidence-${evidence}">${ossEvidenceLabels[evidence].label}</span>`;
}

export function renderOssStatusTable() {
  const rows = ossCapabilityStatus.map((row) => `<tr><th scope="row">${escapeHtml(row.capability)}</th><td>${escapeHtml(row.status)}</td><td>${evidenceBadge(row.evidence)}</td><td>${escapeHtml(row.note)}</td></tr>`).join("");
  const legend = (Object.keys(ossEvidenceLabels) as OssEvidence[]).map((key) => `<div><dt>${evidenceBadge(key)}</dt><dd>${escapeHtml(ossEvidenceLabels[key].meaning)}</dd></div>`).join("");
  return `<div class="oss-table-wrap" role="region" aria-labelledby="oss-status-caption" tabindex="0"><table class="oss-status-table"><caption id="oss-status-caption">Orkestr OSS capability status as of ${ossStatusAsOf}</caption><thead><tr><th scope="col">Capability</th><th scope="col">Status</th><th scope="col">Evidence</th><th scope="col">Details</th></tr></thead><tbody>${rows}</tbody></table></div><dl class="oss-legend" aria-label="Evidence levels">${legend}</dl>`;
}

export function openSourcePage(env = process.env): PublicPage {
  const repo = publicRepoUrl(env);
  return {
    id: "open-source",
    title: "Orkestr Open Source: Persistent Agent Runtime",
    summary: "Orkestr OSS is a self-hosted, provider-independent runtime for persistent agent jobs, with no telemetry. Try the labelled simulation in a minute, then run jobs on your own Codex login.",
    body: `<main id="main-content">
      <section class="page-hero"><p class="section-index">ORKESTR OPEN SOURCE</p><h1>${ossEntryLine}</h1><p class="lead">Orkestr is an open-source runtime that keeps agent jobs running on your own machine or VPS. It is built so jobs resume after restarts, sensitive actions wait for your approval, and every run leaves an audit record. Exactly what has been verified so far, and how, is listed in the status table below.</p><div class="actions"><a class="button" href="${escapeHtml(repo)}" rel="noreferrer">View on GitHub</a><a class="button button-outline" href="${repoBlob(repo, "docs/quickstart.md")}" rel="noreferrer">Read the quickstart</a></div></section>
      <section class="section oss-boundary" aria-labelledby="oss-what-title"><div><p class="section-index">WHAT ORKESTR OSS IS</p><h2 id="oss-what-title">A runtime for agent jobs that outlive your terminal.</h2></div><dl>
        <div><dt>Persistent agent runtime</dt><dd>An Agent Job has a trigger (API, webhook, schedule or message), an agent, a task, tool permissions and notifications. Its state is on disk, so a crash or deploy does not lose the run, and recovery reconciles side effects instead of blindly repeating them.</dd></div>
        <div><dt>Self-hosted</dt><dd>You run it on infrastructure you control. No account with us is needed; the only credentials are the provider and connector logins you choose to add.</dd></div>
        <div><dt>No telemetry</dt><dd>The runtime does not send usage data to us. It talks to the providers and connectors you configure.</dd></div>
        <div><dt>Provider-independent</dt><dd>Providers sit behind one adapter interface, so a job is not tied to one vendor. Today only Codex jobs are verified on a real provider; see the status table below.</dd></div>
      </dl></section>
      <section class="code-section" aria-labelledby="oss-demo-title"><div><p class="section-index">ONE-MINUTE QUICKSTART</p><h2 id="oss-demo-title">Try the simulation.</h2><p><strong class="oss-sim-flag">SIMULATION</strong> <code>orkestr demo</code> uses a simulated AI and a fake code host in a throwaway directory. No API key and no account are needed, and no real job is created. Cloning and <code>npm ci</code> download the code; after that, the demo itself makes no network calls.</p><p>It queues a job, kills the worker after a pull request was opened, recovers without opening a second one, pauses for approval before merging, and prints the audit trail and guarantee checks.</p></div><pre aria-label="Simulation quickstart"><code>git clone ${escapeHtml(repo)}.git
cd orkestr
npm ci
# SIMULATION: simulated AI, fake code host, no real job
node apps/cli/bin/orkestr-oss.js demo --yes</code></pre></section>
      <section class="section oss-real" aria-labelledby="oss-real-title"><div><p class="section-index">WITH A REAL PROVIDER</p><h2 id="oss-real-title">Run your first real job.</h2><p class="section-lead">Real jobs need a connected provider on the same host. Codex is the verified path today: run <code>codex login</code> first.</p></div><div><pre class="oss-code" aria-label="First real Agent Job"><code>node apps/cli/bin/orkestr-oss.js init my-jobs   # writes a job for your connected provider
node apps/cli/bin/orkestr-oss.js run my-jobs
node apps/cli/bin/orkestr-oss.js jobs list</code></pre><p class="oss-hint">With the package on your <code>PATH</code> (for example via <code>npm link</code>), the commands are <code>orkestr init</code> and <code>orkestr run</code>. If no provider is connected, <code>orkestr init</code> stops and tells you to connect one. Real jobs never fall back to the simulation.</p></div></section>
      <section class="section oss-status" id="status" aria-labelledby="oss-status-title"><div><p class="section-index">WHAT WORKS TODAY</p><h2 id="oss-status-title">Capability status, without rounding up.</h2><p class="section-lead">Each row says how it was checked: simulation, offline tests, or a live run. Anything not listed here should be treated as unverified.</p></div>${renderOssStatusTable()}</section>
      <section class="section limitations" aria-labelledby="oss-limits-title"><div><p class="section-index">PUBLIC-ALPHA LIMITS</p><h2 id="oss-limits-title">What this page is not.</h2></div><ul><li>There is no public or hosted job runner here. Jobs run only on a machine you install Orkestr on.</li><li>After this page loads, it sends nothing back: no analytics, no data uploads. It has no forms and runs no page code.</li><li>Interfaces, job spec fields and CLI output can change between releases.</li><li>Self-hosting means you own security, backups and updates for that machine.</li><li>The simulation demonstrates the runtime's recovery and approval logic. It says nothing about the quality of any real model.</li></ul></section>
      <section class="section oss-docs" aria-labelledby="oss-docs-title"><div><p class="section-index">READ THE SOURCE AND THE SPEC</p><h2 id="oss-docs-title">Check every claim yourself.</h2></div><ul class="oss-doc-list">
        <li><a href="${escapeHtml(repo)}" rel="noreferrer">GitHub repository</a><span>Source, issues and the MIT license.</span></li>
        <li><a href="${repoBlob(repo, "docs/quickstart.md")}" rel="noreferrer">docs/quickstart.md</a><span>The simulation and your first real Agent Job.</span></li>
        ${specDocs.map(([file, text]) => `<li><a href="${repoBlob(repo, `docs/spec/${file}`)}" rel="noreferrer">docs/spec/${file}</a><span>${escapeHtml(text)}</span></li>`).join("\n        ")}
      </ul></section>
    </main>`,
  };
}
