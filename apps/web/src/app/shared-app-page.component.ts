import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from "@angular/core";
import { DatePipe } from "@angular/common";
import { firstValueFrom } from "rxjs";
import { ApiService, SecurityChallenge, SharedAppPayload, SharedAppPerson } from "./api.service";

@Component({
  selector: "ork-shared-app-page",
  imports: [DatePipe],
  templateUrl: "./shared-app-page.component.html",
  styleUrls: ["./shared-app-page.component.css"],
})
export class SharedAppPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private poller?: ReturnType<typeof setInterval>;
  private destroyed = false;

  payload: SharedAppPayload | null = null;
  people: SharedAppPerson[] = [];
  selectedId = "";
  statusFilter = "all";
  searchText = "";
  batchLimit = 50;
  batchOffset = 0;
  pagingTotal = 0;
  hasNextBatch = false;
  busy = false;
  error = "";
  notice = "";
  savingPersonId = "";
  noteDraft = "";
  noteSavingPersonId = "";
  noteNotice = "";
  messagesLoadingPersonId = "";
  private readonly loadedMessageIds = new Set<string>();
  pairingRequired = false;
  pairingBusy = false;
  pairingNotice = "";
  pairingError = "";
  challenge: SecurityChallenge | null = null;

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopPolling();
  }

  async load(): Promise<void> {
    this.busy = true;
    this.error = "";
    this.renderNow();
    try {
      const route = this.route();
      this.payload = await firstValueFrom(this.api.sharedApp(route.instanceId, route.appSlug, route.shareToken, {
        status: this.statusFilter,
        q: this.searchText,
        limit: this.batchLimit,
        offset: this.batchOffset,
      }));
      this.people = this.payload.data?.people || [];
      const paging = this.payload.data?.paging || {};
      this.pagingTotal = Number(paging.total || this.people.length || 0);
      this.batchLimit = Number(paging.limit || this.batchLimit);
      this.batchOffset = Number(paging.offset || this.batchOffset);
      this.hasNextBatch = Boolean(paging.hasNext);
      if (!this.people.some((person) => person.id === this.selectedId)) this.selectedId = this.people[0]?.id || "";
      this.syncNoteDraft(this.selectedPerson());
      if (this.selectedId) void this.loadMessages(this.selectedPerson());
      this.pairingRequired = false;
      this.pairingError = "";
      this.pairingNotice = "";
      this.stopPolling();
    } catch (error) {
      if (this.isPairingRequiredError(error)) {
        this.payload = null;
        this.people = [];
        this.pairingRequired = true;
        this.error = "";
        await this.ensureChallenge();
      } else {
        this.error = this.errorText(error);
      }
    } finally {
      this.busy = false;
      this.renderNow();
    }
  }

  title(): string {
    return this.payload?.app?.title || "Shared Review";
  }

  selectedPerson(): SharedAppPerson | null {
    return this.people.find((person) => person.id === this.selectedId) || this.people[0] || null;
  }

  select(person: SharedAppPerson): void {
    this.selectedId = person.id;
    this.notice = "";
    this.noteNotice = "";
    this.syncNoteDraft(person);
    void this.loadMessages(person);
  }

  labels(): string[] {
    return this.payload?.data?.labels || ["not_evaluated", "to_contact", "to_skip"];
  }

  labelText(label: string): string {
    return label.replace(/_/g, " ");
  }

  classifiedCount(): number {
    return this.people.filter((person) => person.currentClassification && person.currentClassification !== "not_evaluated").length;
  }

  batchLabel(): string {
    if (!this.pagingTotal) return "0 / 0";
    const start = this.batchOffset + 1;
    const end = Math.min(this.batchOffset + this.people.length, this.pagingTotal);
    return `${start}-${end} / ${this.pagingTotal}`;
  }

  statusOptions(): Array<{ value: string; label: string }> {
    return [
      { value: "all", label: "All" },
      { value: "not_evaluated", label: "Not evaluated" },
      { value: "to_contact", label: "To contact" },
      { value: "to_skip", label: "To skip" },
    ];
  }

  onSearchInput(event: Event): void {
    this.searchText = String((event.target as HTMLInputElement | null)?.value || "");
  }

  async applySearch(): Promise<void> {
    this.batchOffset = 0;
    this.selectedId = "";
    await this.load();
  }

  async setStatusFilter(status: string): Promise<void> {
    if (this.statusFilter === status) return;
    this.statusFilter = status;
    this.batchOffset = 0;
    this.selectedId = "";
    await this.load();
  }

  async nextBatch(): Promise<void> {
    if (!this.hasNextBatch) return;
    this.batchOffset += this.batchLimit;
    this.selectedId = "";
    await this.load();
  }

  async previousBatch(): Promise<void> {
    if (this.batchOffset <= 0) return;
    this.batchOffset = Math.max(0, this.batchOffset - this.batchLimit);
    this.selectedId = "";
    await this.load();
  }

  messageCount(person: SharedAppPerson): string {
    const total = Number(person.messageCount || person.messageHistory?.length || 0);
    const matched = Number(person.matchedMessageCount || 0);
    if (total && matched && matched !== total) return `${total} messages, ${matched} matched`;
    if (total === 1) return "1 message";
    return `${total} messages`;
  }

  messagesLoading(person: SharedAppPerson): boolean {
    return this.messagesLoadingPersonId === person.id;
  }

  canClassify(): boolean {
    return (this.payload?.data?.allowedActions || this.payload?.share?.allowedActionsJson || []).includes("setClassification");
  }

  canSaveNote(): boolean {
    return (this.payload?.data?.allowedActions || this.payload?.share?.allowedActionsJson || []).includes("setNote");
  }

  onNoteInput(event: Event): void {
    this.noteDraft = String((event.target as HTMLTextAreaElement | null)?.value || "");
    this.noteNotice = "";
  }

  approveCommand(): string {
    const code = this.challenge?.approveCode || this.challenge?.id || "<code>";
    return `orkestr connect approve ${code}`;
  }

  challengeStatusClass(): string {
    const status = this.challengeStatus();
    if (status === "approved" || status === "consumed") return "ready";
    if (status === "pending") return "partial";
    if (status === "rejected" || status === "expired") return "bad";
    return "idle";
  }

  challengeStatus(): string {
    return String(this.challenge?.status || "idle");
  }

  challengeClosed(): boolean {
    return ["consumed", "expired", "rejected"].includes(this.challengeStatus());
  }

  expiryLabel(): string {
    const timestamp = Date.parse(this.challenge?.expiresAt || "");
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "unknown";
  }

  async copyCommand(): Promise<void> {
    try {
      await globalThis.navigator?.clipboard?.writeText(this.approveCommand());
      this.pairingNotice = "Copied.";
    } catch {
      this.pairingNotice = "Select and copy the command.";
    }
    this.renderNow();
  }

  async ensureChallenge(): Promise<void> {
    if (this.challenge?.status === "pending" || this.pairingBusy) {
      this.startPolling();
      return;
    }
    this.pairingBusy = true;
    this.pairingError = "";
    this.pairingNotice = "";
    this.renderNow();
    try {
      const route = this.route();
      const result = await firstValueFrom(this.api.createSharedAppChallenge(route.instanceId, route.appSlug, route.shareToken, {
        requestedPath: `${globalThis.location?.pathname || ""}${globalThis.location?.search || ""}`,
      }));
      this.challenge = result.challenge || {
        id: result.challengeId,
        approveCode: "",
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: result.expiresAt,
        instanceId: route.instanceId,
      };
      this.pairingNotice = "Approve this shared review from WhatsApp or a trusted terminal.";
      if (this.challenge.status === "approved") await this.consumeChallenge();
      else this.startPolling();
    } catch (error) {
      this.pairingError = this.errorText(error);
      this.stopPolling();
    } finally {
      this.pairingBusy = false;
      this.renderNow();
    }
  }

  async refreshChallenge(): Promise<void> {
    if (!this.challenge?.id) {
      await this.ensureChallenge();
      return;
    }
    const route = this.route();
    try {
      const result = await firstValueFrom(this.api.sharedAppChallenge(route.instanceId, route.appSlug, route.shareToken, this.challenge.id));
      this.challenge = result.challenge;
      this.pairingError = "";
      const status = this.challengeStatus();
      if (status === "approved") {
        await this.consumeChallenge();
        return;
      }
      if (["consumed", "expired", "rejected"].includes(status)) this.stopPolling();
    } catch (error) {
      this.pairingError = this.errorText(error);
      this.stopPolling();
    } finally {
      this.renderNow();
    }
  }

  async setClassification(label: string): Promise<void> {
    const person = this.selectedPerson();
    if (!person || !this.canClassify()) return;
    const route = this.route();
    const previousClassification = person.currentClassification || "not_evaluated";
    const previousSelectedId = this.selectedId;
    this.savingPersonId = person.id;
    this.error = "";
    this.notice = "Saving...";
    this.people = this.people.map((item) => item.id === person.id ? { ...item, currentClassification: label } : item);
    this.selectNext();
    this.renderNow();
    try {
      const result = await firstValueFrom(this.api.sharedAppAction(route.instanceId, route.appSlug, route.shareToken, "setClassification", {
        personId: person.id,
        classification: label,
      }));
      if (result.data) this.payload = { ...this.payload, data: result.data };
      this.notice = "Saved.";
    } catch (error) {
      this.people = this.people.map((item) => item.id === person.id ? { ...item, currentClassification: previousClassification } : item);
      this.selectedId = previousSelectedId;
      this.error = this.errorText(error);
    } finally {
      this.savingPersonId = "";
      this.renderNow();
    }
  }

  async saveNote(): Promise<void> {
    const person = this.selectedPerson();
    if (!person || !this.canSaveNote()) return;
    const route = this.route();
    const previousNote = person.reviewNote || "";
    const note = this.noteDraft.trim();
    this.noteSavingPersonId = person.id;
    this.noteNotice = "Saving note...";
    this.error = "";
    this.people = this.people.map((item) => item.id === person.id ? { ...item, reviewNote: note } : item);
    this.renderNow();
    try {
      const result = await firstValueFrom(this.api.sharedAppAction(route.instanceId, route.appSlug, route.shareToken, "setNote", {
        personId: person.id,
        note,
      }));
      const savedNote = String(result.reviewNote ?? result.note ?? note);
      const savedClassification = result.currentClassification || person.currentClassification;
      this.people = this.people.map((item) => item.id === person.id ? {
        ...item,
        reviewNote: savedNote,
        currentClassification: savedClassification,
      } : item);
      this.noteDraft = savedNote;
      this.noteNotice = savedNote ? "Note saved." : "Note cleared.";
    } catch (error) {
      this.people = this.people.map((item) => item.id === person.id ? { ...item, reviewNote: previousNote } : item);
      this.noteDraft = previousNote;
      this.error = this.errorText(error);
    } finally {
      this.noteSavingPersonId = "";
      this.renderNow();
    }
  }

  selectNext(): void {
    if (!this.people.length) return;
    const index = Math.max(0, this.people.findIndex((person) => person.id === this.selectedId));
    this.selectedId = this.people[Math.min(this.people.length - 1, index + 1)]?.id || this.people[0].id;
    this.noteNotice = "";
    this.syncNoteDraft(this.selectedPerson());
    void this.loadMessages(this.selectedPerson());
  }

  private syncNoteDraft(person: SharedAppPerson | null): void {
    this.noteDraft = person?.reviewNote || "";
  }

  private async loadMessages(person: SharedAppPerson | null): Promise<void> {
    if (!person?.id || this.loadedMessageIds.has(person.id)) return;
    const route = this.route();
    this.messagesLoadingPersonId = person.id;
    this.renderNow();
    try {
      const result = await firstValueFrom(this.api.sharedAppPersonMessages(route.instanceId, route.appSlug, route.shareToken, person.id));
      this.people = this.people.map((item) => item.id === person.id ? { ...item, messageHistory: result.messages || [] } : item);
      this.loadedMessageIds.add(person.id);
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      if (this.messagesLoadingPersonId === person.id) this.messagesLoadingPersonId = "";
      this.renderNow();
    }
  }

  private async consumeChallenge(): Promise<void> {
    if (!this.challenge?.id) return;
    this.stopPolling();
    this.pairingBusy = true;
    this.pairingNotice = "Approved. Opening shared review.";
    this.pairingError = "";
    this.renderNow();
    try {
      const route = this.route();
      const result = await firstValueFrom(this.api.pairSharedAppBrowser(route.instanceId, route.appSlug, route.shareToken, this.challenge.id));
      this.challenge = null;
      this.pairingRequired = false;
      this.openPairedSharedApp(result.redirectPath || this.currentSharedPath());
    } catch (error) {
      this.pairingError = this.errorText(error);
    } finally {
      this.pairingBusy = false;
      this.renderNow();
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.poller = setInterval(() => void this.refreshChallenge(), 3000);
  }

  private stopPolling(): void {
    if (!this.poller) return;
    clearInterval(this.poller);
    this.poller = undefined;
  }

  private route(): { instanceId: string; appSlug: string; shareToken: string } {
    const parts = globalThis.location?.pathname?.split("/").filter(Boolean) || [];
    return {
      instanceId: decodeURIComponent(parts[1] || ""),
      appSlug: decodeURIComponent(parts[3] || ""),
      shareToken: decodeURIComponent(parts[5] || ""),
    };
  }

  private openPairedSharedApp(redirectPath = ""): void {
    const target = this.sameOriginPath(redirectPath) || this.currentSharedPath() || "/";
    globalThis.location?.replace(target);
  }

  private currentSharedPath(): string {
    return `${globalThis.location?.pathname || ""}${globalThis.location?.search || ""}${globalThis.location?.hash || ""}`;
  }

  private sameOriginPath(raw = ""): string {
    const value = String(raw || "").trim();
    if (!value) return "";
    const current = globalThis.location;
    if (!current?.origin) return "";
    try {
      const url = new URL(value, current.origin);
      if (url.origin !== current.origin) return "";
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return "";
    }
  }

  private renderNow(): void {
    if (this.destroyed) return;
    this.cdr.detectChanges();
  }

  private isPairingRequiredError(error: unknown): boolean {
    const record = error && typeof error === "object" ? error as { error?: { error?: unknown; code?: unknown }; message?: unknown } : null;
    const code = String(record?.error?.error || record?.error?.code || record?.message || error || "");
    return code.includes("browser_pairing_required") || code.includes("shared_app_session_required");
  }

  private errorText(error: unknown): string {
    const record = error && typeof error === "object" ? error as { error?: { error?: unknown }; message?: unknown } : null;
    return String(record?.error?.error || record?.message || error || "Unable to load shared app");
  }
}
