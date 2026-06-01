import { Injectable, signal } from "@angular/core";
import { ThreadMessage, ThreadSummary } from "../api.service";

@Injectable({ providedIn: "root" })
export class ThreadStore {
  readonly threads = signal<ThreadSummary[]>([]);
  readonly selectedId = signal("");
  readonly messagesByThread = signal<Record<string, ThreadMessage[]>>({});
  readonly loadingByThread = signal<Record<string, boolean>>({});

  selectThread(id: string): void {
    this.selectedId.set(id);
  }

  setThreads(threads: ThreadSummary[]): void {
    this.threads.set(threads);
  }

  setThreadMessages(threadId: string, messages: ThreadMessage[]): void {
    this.messagesByThread.update((current) => ({
      ...current,
      [threadId]: messages,
    }));
  }

  setMessagesByThread(messagesByThread: Record<string, ThreadMessage[]>): void {
    this.messagesByThread.set({ ...messagesByThread });
  }

  setThreadLoading(threadId: string, loading: boolean): void {
    this.loadingByThread.update((current) => ({
      ...current,
      [threadId]: loading,
    }));
  }

  setLoadingByThread(loadingByThread: Record<string, boolean>): void {
    this.loadingByThread.set({ ...loadingByThread });
  }
}
