import { Component, EventEmitter, Input, OnChanges, Output, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import type { ThreadSummary } from "./api.service";
import { VaultApiService, VaultItem } from "./vault-api.service";
import { vaultErrorMessage } from "./vault-secrets";

const searchThreshold = 8;

@Component({
  selector: "ork-vault-grants-dialog",
  templateUrl: "./vault-grants-dialog.component.html",
  styleUrl: "./vault-dialog.css",
})
export class VaultGrantsDialogComponent implements OnChanges {
  private readonly api = inject(VaultApiService);
  @Input({ required: true }) item!: VaultItem;
  @Input() threads: ThreadSummary[] = [];
  @Output() readonly saved = new EventEmitter<VaultItem>();
  @Output() readonly close = new EventEmitter<void>();

  selected = new Set<string>();
  query = "";
  busy = false;
  error = "";

  ngOnChanges(): void {
    this.selected = new Set((this.item?.threadGrants || []).map((grant) => grant.threadId));
  }

  threadTitle(thread: ThreadSummary): string {
    return String(thread.bindingName || thread.name || thread.title || thread.id);
  }

  searchVisible(): boolean {
    return this.threads.length > searchThreshold;
  }

  visibleThreads(): ThreadSummary[] {
    const query = this.query.trim().toLowerCase();
    if (!query) return this.threads;
    return this.threads.filter((thread) => this.threadTitle(thread).toLowerCase().includes(query) || this.selected.has(thread.id));
  }

  toggle(threadId: string, checked: boolean): void {
    const next = new Set(this.selected);
    if (checked) next.add(threadId);
    else next.delete(threadId);
    this.selected = next;
  }

  async submit(): Promise<void> {
    this.busy = true;
    this.error = "";
    try {
      const result = await firstValueFrom(this.api.setGrants(this.item.id, [...this.selected]));
      this.saved.emit(result?.item || { ...this.item, threadGrants: [...this.selected].map((threadId) => ({ threadId })) });
    } catch (error) {
      this.error = vaultErrorMessage(error, "Could not update thread access.");
    } finally {
      this.busy = false;
    }
  }
}
