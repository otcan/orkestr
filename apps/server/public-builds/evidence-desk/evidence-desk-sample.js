// Fictional sample dataset: an invented town's community tool library.
// No real people, places, organisations, numbers or health topics. Every
// source record below was written for this demo and is labelled synthetic.
import { addClaim, addEvidence, addSource, emptyState, linkContradiction, recordDecision } from "./evidence-desk-state.js";

export const SAMPLE_TOPIC = "Brindlemere Tool Library";
export const SAMPLE_DESCRIPTION = "Brindlemere is an invented town and its tool library is an invented community lending service. Every claim, source record and number in this demo was written for the demo.";
export const SAMPLE_ACTOR = "Sample reviewer (fictional)";
const PROVENANCE = "Synthetic record written for the Orkestr evidence desk demo. Fictional; not drawn from any real organisation.";

const SOURCES = [
  { title: "Brindlemere loan ledger, Jan–May", kind: "Loan ledger (synthetic)", excerpt: "Winter months: 118 loans. Spring months: 241 loans." },
  { title: "Volunteer shift notes, spring", kind: "Shift notes (synthetic)", excerpt: "Queues at the counter most Saturday mornings in April." },
  { title: "Saturday sign-up sheet tally", kind: "Membership tally (synthetic)", excerpt: "New members on Saturdays: 34 in the first eight weeks." },
  { title: "Brindlemere Bulletin, issue 12", kind: "Community newsletter (synthetic)", excerpt: "“The new Saturday hours are proving popular.”" },
  { title: "Door-counter log, weekly totals", kind: "Visitor counter (synthetic)", excerpt: "Weekly visitors flat at roughly 90 before and after Saturday opening." },
  { title: "Return log, Jan–May", kind: "Return log (synthetic)", excerpt: "On-time returns: 87% of 359 loans." },
  { title: "Reminder message report", kind: "System report (synthetic)", excerpt: "Reminder sent two days before due date; 9 in 10 items returned by the due date." },
  { title: "Board meeting minutes, March", kind: "Meeting minutes (synthetic)", excerpt: "One board member felt Saturdays “changed nothing”." },
];

// Fixed synthetic timestamps, one minute apart, keep the sample deterministic.
function sampleClock() {
  let minute = 0;
  return () => ({ at: new Date(Date.UTC(2026, 2, 2, 9, minute++)).toISOString(), actor: SAMPLE_ACTOR });
}

export function sampleState() {
  const meta = sampleClock();
  let state = emptyState();
  const sourceIds = SOURCES.map((fields) => {
    const result = addSource(state, { ...fields, provenance: PROVENANCE });
    state = result.state;
    return result.id;
  });
  const claim = (text) => {
    const result = addClaim(state, text, meta());
    state = result.state;
    return result.id;
  };
  const evidence = (claimId, source, fields) => {
    state = addEvidence(state, claimId, { sourceId: sourceIds[source], ...fields }, meta()).state;
  };
  const c1 = claim("The Brindlemere tool library lent more items in spring than in winter.");
  const c2 = claim("Opening on Saturdays brought in more first-time borrowers.");
  const c3 = claim("Most borrowed tools come back on time.");
  claim("Late returns mostly involve garden equipment.");
  const c5 = claim("Saturday opening made no difference to borrowing.");
  evidence(c1, 0, { type: "primary-record", strength: "strong", stance: "supports", note: "Spring loans are roughly double winter loans in the invented ledger." });
  evidence(c1, 1, { type: "observation", strength: "moderate", stance: "supports" });
  evidence(c2, 2, { type: "measurement", strength: "moderate", stance: "supports" });
  evidence(c2, 3, { type: "secondary-report", strength: "weak", stance: "supports" });
  evidence(c2, 4, { type: "measurement", strength: "moderate", stance: "contradicts", note: "Visitor totals stay flat after Saturday opening." });
  evidence(c3, 5, { type: "primary-record", strength: "strong", stance: "supports" });
  evidence(c3, 6, { type: "secondary-report", strength: "moderate", stance: "supports" });
  evidence(c5, 7, { type: "anecdote", strength: "weak", stance: "supports" });
  state = linkContradiction(state, c2, c5, meta());
  state = recordDecision(state, c3, "accepted", "Two independent synthetic records agree.", meta());
  return state;
}
