import { ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, OnDestroy, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Subscription, timeout } from "rxjs";
import { ApiService, CodexModelControls } from "./api.service";

@Component({
  selector: "app-model-settings",
  standalone: true,
  imports: [FormsModule],
  template: `
    <section aria-label="Thread model settings" [attr.aria-busy]="loading || saving">
      @if (loading) { <p role="status">Loading available models…</p> }
      @if (error) { <p role="alert">{{ error }}</p> }
      @if (settings?.readOnly) { <p>{{ settings?.readOnlyReason }}</p> }
      @if (settings && !settings.readOnly) {
        <label>Model
          <select [(ngModel)]="model" (ngModelChange)="selectModel()" [disabled]="saving">
            @for (entry of settings.models; track entry.id) { <option [value]="entry.id">{{ entry.id }}</option> }
          </select>
        </label>
        <label>Reasoning effort
          <select [(ngModel)]="effort" [disabled]="saving || !efforts.length">
            @for (level of efforts; track level) { <option [value]="level">{{ level }}</option> }
          </select>
        </label>
        @if (settings.permissionModes?.length) {
          <label>Permissions
            <select [(ngModel)]="permissionMode" [disabled]="saving">
              @for (mode of settings.permissionModes; track mode) { <option [value]="mode">{{ permissionModeLabel(mode) }}</option> }
            </select>
          </label>
          @if (permissionMode === "bypassPermissions") { <p class="danger-note" role="alert">YOLO: Claude can run tools without permission prompts in this workspace.</p> }
        }
        <button type="button" (click)="save()" [disabled]="saving || reloadRequired || !model || !effort">{{ saving ? 'Applying…' : 'Apply' }}</button>
      }
      @if (notice) { <p role="status">{{ notice }}</p> }
      @if ((error || settings?.readOnly) && !saving) { <button type="button" (click)="load()">Reload settings</button> }
    </section>
  `,
  styles: [`section { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin: 16px 0; } label { display: grid; gap: 6px; flex: 1; min-width: 0; } select { width: 100%; min-width: 120px; padding: 8px; } select, button { min-height: 44px; } p { flex-basis: 100%; margin: 0; } .danger-note { color: #a22; }`],
})
export class ModelSettingsComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) threadId = "";
  @Output() saved = new EventEmitter<void>();
  private readonly api = inject(ApiService);
  private readonly detector = inject(ChangeDetectorRef);
  private request?: Subscription;
  settings: CodexModelControls | null = null;
  loading = false;
  saving = false;
  reloadRequired = false;
  model = "";
  effort = "";
  permissionMode = "";
  error = "";
  notice = "";
  efforts: string[] = [];

  ngOnChanges(): void { this.load(); }
  ngOnDestroy(): void { this.request?.unsubscribe(); }

  load(): void {
    this.request?.unsubscribe();
    this.settings = null;
    this.error = this.notice = "";
    this.loading = true;
    this.saving = false;
    this.reloadRequired = false;
    this.request = this.api.getModelSettings(this.threadId).pipe(timeout(7000)).subscribe({
      next: (settings) => {
        this.settings = settings;
        const selected = settings.models.find((entry) => entry.id === settings.model);
        this.model = selected?.id || (!settings.model ? settings.models.find((entry) => entry.isDefault)?.id || settings.models[0]?.id : "") || "";
        this.effort = settings.effort || "";
        this.permissionMode = settings.permissionMode || "";
        this.selectModel();
        if (settings.model && !selected && !settings.readOnly) this.notice = `Current model ${settings.model} is unavailable. Select an available model to change it.`;
        this.loading = false;
        this.detector.markForCheck();
      },
      error: () => { this.loading = false; this.error = "Could not load model settings. Try again."; this.detector.markForCheck(); },
    });
  }

  selectModel(): void {
    const entry = this.settings?.models.find((item) => item.id === this.model);
    this.efforts = (entry?.supportedReasoningEfforts || []).map((item) => typeof item === "string" ? item : item.reasoningEffort);
    if (!this.efforts.includes(this.effort)) this.effort = this.efforts.find((level) => level === entry?.defaultReasoningEffort) || this.efforts[0] || "";
    this.notice = "";
  }

  permissionModeLabel(mode: string): string {
    return ({ acceptEdits: "Auto-accept edits", plan: "Plan only", dontAsk: "Deny prompts", bypassPermissions: "YOLO (bypass permissions)" } as Record<string, string>)[mode] || mode;
  }

  save(): void {
    if (this.saving || this.reloadRequired || !this.settings || this.settings.readOnly || !this.efforts.includes(this.effort)) return;
    this.saving = true;
    this.error = this.notice = "";
    const request = this.permissionMode
      ? this.api.setModelSettings(this.threadId, this.model, this.effort, this.permissionMode)
      : this.api.setModelSettings(this.threadId, this.model, this.effort);
    this.request = request.pipe(timeout(20000)).subscribe({
      next: (result) => { this.saving = false; this.notice = `Model set to ${result.model} with ${result.effort} effort.`; this.saved.emit(); this.detector.markForCheck(); },
      error: (error) => {
        this.saving = false;
        // Validation and explicit runtime rejection leave the saved settings
        // unchanged. Network errors/timeouts must still require reconciliation.
        this.reloadRequired = ![400, 422].includes(error?.status);
        this.error = error?.error?.error || error?.error?.message || "Could not confirm the model change. Reload settings before trying again.";
        this.detector.markForCheck();
      },
    });
  }
}
