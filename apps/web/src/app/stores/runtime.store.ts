import { Injectable, signal } from "@angular/core";

@Injectable({ providedIn: "root" })
export class RuntimeStore {
  readonly runtimeByThread = signal<Record<string, Record<string, unknown> | null>>({});
  readonly workingThreadIds = signal<Record<string, boolean>>({});

  setRuntime(threadId: string, runtime: Record<string, unknown> | null): void {
    this.runtimeByThread.update((current) => ({
      ...current,
      [threadId]: runtime,
    }));
  }

  setWorking(threadId: string, working: boolean): void {
    this.workingThreadIds.update((current) => ({
      ...current,
      [threadId]: working,
    }));
  }

  setWorkingThreads(workingThreadIds: Record<string, boolean>): void {
    this.workingThreadIds.set({ ...workingThreadIds });
  }
}
