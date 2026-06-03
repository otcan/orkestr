import {
  archiveCodexAppServerThread,
  codexAppServerThreadStatus,
  compactCodexAppServerThread,
  deliverCodexAppServerPendingInputs,
  interruptCodexAppServerThread,
  resumeCodexAppServerThread,
  startCodexAppServerThread,
  syncCodexAppServerThreadMessages,
  threadNeedsCodexAppServerMigration,
  threadUsesCodexAppServer,
} from "./codex-app-server.js";

export const archiveCodexRuntimeThread = archiveCodexAppServerThread;
export const codexRuntimeThreadStatus = codexAppServerThreadStatus;
export const compactCodexRuntimeThread = compactCodexAppServerThread;
export const deliverCodexRuntimePendingInputs = deliverCodexAppServerPendingInputs;
export const interruptCodexRuntimeThread = interruptCodexAppServerThread;
export const resumeCodexRuntimeThread = resumeCodexAppServerThread;
export const startCodexRuntimeThread = startCodexAppServerThread;
export const syncCodexRuntimeThreadMessages = syncCodexAppServerThreadMessages;
export const threadNeedsNativeCodexRuntimeMigration = threadNeedsCodexAppServerMigration;
export const threadUsesNativeCodexRuntime = threadUsesCodexAppServer;

export {
  archiveCodexAppServerThread,
  codexAppServerThreadStatus,
  compactCodexAppServerThread,
  deliverCodexAppServerPendingInputs,
  interruptCodexAppServerThread,
  resumeCodexAppServerThread,
  startCodexAppServerThread,
  syncCodexAppServerThreadMessages,
  threadNeedsCodexAppServerMigration,
  threadUsesCodexAppServer,
};

export async function codexRuntimeStatus(thread, env = process.env, counts = {}) {
  return codexRuntimeThreadStatus(thread, env, counts);
}
