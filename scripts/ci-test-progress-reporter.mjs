// node:test reporter used by scripts/ci-test-runner.mjs alongside the default
// TAP reporter. It emits one marker line per test *file* start/finish so the
// runner can report progress and name in-flight files when a run hangs. The
// TAP output on stdout is unchanged; these lines go to the reporter
// destination (stderr) and are stripped by the runner.
import path from "node:path";

export const progressMarker = "::orkestr-ci-test::";

function fileEvent(event, cwd) {
  const data = event?.data || {};
  if (data.nesting !== 0 || !data.file || !data.name) return null;
  // File-level tests are named after the file path relative to the cwd; tests
  // declared at the top of a file share nesting 0 but carry their own names.
  const relative = path.relative(cwd, data.file).split(path.sep).join("/");
  if (data.name !== relative) return null;
  if (event.type === "test:dequeue") return { type: "start", file: relative };
  if (event.type === "test:complete") {
    return { type: "done", file: relative, passed: data.details?.passed !== false };
  }
  return null;
}

export default async function* ciTestProgressReporter(source) {
  const cwd = process.cwd();
  for await (const event of source) {
    const item = fileEvent(event, cwd);
    if (item) yield `${progressMarker}${JSON.stringify({ ...item, at: Date.now() })}\n`;
  }
}
