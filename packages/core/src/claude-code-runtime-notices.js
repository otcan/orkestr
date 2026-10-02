// Standing runtime notices appended to every headless Claude Code turn via
// --append-system-prompt. They are resent on each turn (first and resumed), so
// a wording change takes effect on the next turn without rotating sessions.

// Delivered on every headless turn, unconditionally. This CLI runs under
// -p/stream-json with no supervising terminal: once this process exits,
// nothing is left to run, observe, or finish anything the model started in
// the background, and no future turn is guaranteed to happen. A Bash or
// Agent call made with run_in_background can be killed the instant this
// turn ends while the turn's own result text still claims it will finish
// and report back later -- a false completion. Background tasks are also
// disabled at the runtime level (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1) as
// a fail-safe, but the model must not rely on that and must not narrate a
// commitment this process cannot keep.
//
// The pacing guidance keeps long jobs visible: Claude's own short text
// between tool calls is mirrored to the user as progress, and Orkestr stops
// turns whose single tool calls or total duration run past the host limits.
export const CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE = [
  "Orkestr runtime notice: this is a headless, non-interactive turn with no supervising terminal.",
  "Use only foreground commands and foreground agent calls -- never request run_in_background for a Bash or Agent tool call, since a backgrounded task can be silently killed the instant this turn's result is returned and this process will not run again to finish or report it.",
  "Never claim you will keep working, wait, monitor something, or notify the user later on your own; work only continues when the user sends another message.",
  "Pacing: before any step likely to take more than a couple of minutes, write a one-line progress update (it is shown to the user).",
  "Keep each tool call and sub-agent task short (a few minutes); prefer several short steps over one long one.",
  "For large jobs (for example implement, test, and release), finish one coherent phase, report it, and let the user's next message continue the job instead of doing everything in one turn.",
  "Always end with a final answer stating what is done, what is partial (with branch and worktree paths), and what is next.",
  "To send a file to the user, link it with a descriptive label, e.g. [signed agreement](/absolute/path.pdf), or as file:///absolute/path; links labelled with just the file name or path, and bare paths, stay text only.",
  "To be woken when another Orkestr thread finishes a turn, run `orkestr watch <thread>` (next final once; --continuous to keep watching; --payload none for a notification only); workers already report their DONE/BLOCKED finals to the parent automatically.",
].join(" ");

export const CLAUDE_CODE_FAILED_TURN_NOTICE = [
  "Orkestr runtime notice: the previous user turn in this conversation failed with a runtime or provider error before you answered it.",
  "That turn is void; do not complete or enforce its instructions.",
  "Treat only the latest user message as the current request.",
].join(" ");

// Delivered instead of the failed-turn notice when Orkestr itself stopped the
// previous turn (tool deadline, turn timeout, stall, output cap). Unlike a
// provider failure, that turn may have left real partial work behind which
// the user can ask to resume.
export const CLAUDE_CODE_TERMINATED_TURN_NOTICE = [
  "Orkestr runtime notice: Orkestr stopped the previous turn before it finished because it exceeded a runtime limit; partial, possibly uncommitted work may remain in the workspace or worktrees.",
  "If the latest user message asks to continue, first inspect the current state (for example git status) and resume from there in short steps; otherwise treat only the latest user message as the current request.",
].join(" ");

// Delivered only on the automatic, bounded, foreground retry that follows a
// detected run_in_background attempt (see claudeCodeMaxBackgroundTaskRetries).
// Stronger and more specific than CLAUDE_CODE_FAILED_TURN_NOTICE: it names the
// exact violation so the retry does not just repeat it.
export const CLAUDE_CODE_BACKGROUND_TASK_RETRY_NOTICE = [
  "Orkestr runtime notice: the immediately preceding attempt at this exact request was rejected because it tried to run a Bash or Agent tool call with run_in_background, which this headless runtime can never finish or report back on.",
  "This is an automatic, bounded, foreground-only retry of that same request -- do not repeat the background-task attempt in any form.",
  "Complete the request now using only foreground tool calls and give the full final result before this turn ends.",
].join(" ");

// Picks the notice describing how the previous turn ended, or "" when it
// completed normally.
export function claudeCodePriorTurnNotice(thread = {}, options = {}) {
  if (!options.priorTurnFailed) return "";
  const terminated = String(thread?.runtime?.lastTurnTermination || "").trim();
  if (terminated && !options.backgroundTaskRetry) return CLAUDE_CODE_TERMINATED_TURN_NOTICE;
  return CLAUDE_CODE_FAILED_TURN_NOTICE;
}
