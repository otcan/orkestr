import { spawn } from "node:child_process";

// Each scanner owns a separate POSIX process group, including its Git children.
// Never signal the wrapper's group or discover targets by executable name.
export function runScanner(binary, args, options, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve({ status: null, error: new Error("scan_interrupted") });
    const grouped = process.platform !== "win32";
    const capture = options.stdio !== "ignore";
    const child = spawn(binary, args, { env: options.env, cwd: options.cwd,
      detached: grouped, stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"] });
    let error, size = 0;
    const chunks = [];
    const stop = reason => {
      error ||= new Error(reason);
      if (!child.pid) return;
      try {
        // Immediate termination also handles scanners that ignore SIGTERM.
        if (grouped) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (cause) { if (cause.code !== "ESRCH") error = cause; }
    };
    const abort = () => stop("scan_interrupted");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("scanner_timeout"), options.timeout);
    child.stdout?.on("data", chunk => {
      size += chunk.length;
      if (size > (options.maxBuffer || 4096)) stop("scanner_output_limit");
      else chunks.push(chunk);
    });
    child.on("error", cause => { error = cause; });
    child.on("close", status => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve({ status, error, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

export function scannerLifecycle(runner) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGTERM", interrupt);
  process.on("SIGINT", interrupt);
  const check = () => { if (controller.signal.aborted) throw new Error("scan_interrupted"); };
  return {
    get interrupted() { return controller.signal.aborted; },
    check,
    async run(binary, args, options) {
      check();
      const result = await (runner ? runner(binary, args, options) : runScanner(binary, args, options, controller.signal));
      check();
      return result;
    },
    dispose() {
      process.removeListener("SIGTERM", interrupt);
      process.removeListener("SIGINT", interrupt);
    },
  };
}
