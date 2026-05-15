import { AsyncPipe } from "@angular/common";
import { Component, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { BehaviorSubject, combineLatest, firstValueFrom, map, startWith, switchMap } from "rxjs";
import { ApiService } from "./api.service";

interface ConnectorField {
  name: string;
  label: string;
  type?: string;
  placeholder?: string;
}

const connectorFields: Record<string, ConnectorField[]> = {
  openai: [{ name: "openaiApiKey", label: "API key", type: "password", placeholder: "sk-..." }],
  gmail: [
    { name: "clientId", label: "OAuth client ID", placeholder: "123.apps.googleusercontent.com" },
    { name: "clientSecret", label: "OAuth client secret", type: "password", placeholder: "GOCSPX-..." },
    { name: "redirectUri", label: "Redirect URI", placeholder: "http://localhost:19812/oauth/gmail/callback" },
  ],
  whatsapp: [{ name: "bridgeUrl", label: "Bridge URL", placeholder: "http://127.0.0.1:8787" }],
};

@Component({
  selector: "ork-root",
  imports: [AsyncPipe, FormsModule],
  template: `
    <main class="shell">
      <section class="hero">
        <p class="eyebrow">Angular shell</p>
        <h1>Orkestr control plane</h1>
        <p class="lede">Setup, connectors, agents, WhatsApp, browsers, and timers will move here incrementally.</p>
      </section>

      @if (vm$ | async; as vm) {
        <section class="status-grid">
          <article class="card">
            <span class="state" [class.connected]="vm.health?.ok">{{ vm.health?.ok ? "online" : "loading" }}</span>
            <h2>API</h2>
            <p>{{ vm.health?.name || "checking" }}</p>
            <small>{{ vm.health?.generatedAt || "" }}</small>
          </article>

          <article class="card">
            <span class="state">{{ vm.setup?.setupState || "loading" }}</span>
            <h2>Setup</h2>
            <p>{{ vm.setup?.home || "waiting for setup status" }}</p>
            <small>{{ vm.connectorCount }} connectors · overlay {{ vm.setup?.overlay?.configured ? "configured" : "not configured" }}</small>
          </article>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>Connectors</h2>
              <p>Configure and test local connector surfaces.</p>
            </div>
            <button class="secondary" type="button" (click)="refresh()">Refresh</button>
          </div>
          <div class="connector-list">
            @for (connector of vm.setup?.connectors || []; track connector.id) {
              <article class="connector-card">
                <div>
                  <span class="state" [class.connected]="connector.state === 'connected'">{{ connector.state }}</span>
                  <h3>{{ connector.label }}</h3>
                  <p>{{ connector.summary }}</p>
                  @if (connector.details?.["bridgeUrl"]) {
                    <small>{{ connector.details?.["bridgeUrl"] }}</small>
                  }
                </div>

                <div class="actions">
                  <button type="button" (click)="testConnector(connector.id)">Test</button>
                  @if (connector.id === "gmail") {
                    <button class="secondary" type="button" (click)="startGmailOAuth()">Start OAuth</button>
                  }
                </div>

                @if (fieldsFor(connector.id).length) {
                  <form class="connector-form" (submit)="saveConnector(connector.id); $event.preventDefault()">
                    @for (field of fieldsFor(connector.id); track field.name) {
                      <label>
                        <small>{{ field.label }}</small>
                        <input
                          [name]="connector.id + '-' + field.name"
                          [type]="field.type || 'text'"
                          [placeholder]="placeholderFor(vm.setup?.config, connector.id, field)"
                          [ngModel]="draftValue(connector.id, field.name)"
                          (ngModelChange)="setDraftValue(connector.id, field.name, $event)"
                        />
                      </label>
                    }
                    <button class="secondary" type="submit">Save config</button>
                  </form>
                }
              </article>
            }
          </div>
        </section>
      }
    </main>
  `,
})
export class AppComponent {
  private readonly api = inject(ApiService);
  private readonly refreshSignal$ = new BehaviorSubject(0);

  readonly drafts: Record<string, Record<string, string>> = {};

  readonly vm$ = combineLatest({
    health: this.api.health().pipe(startWith(null)),
    setup: this.refreshSignal$.pipe(switchMap(() => this.api.setupStatus()), startWith(null)),
  }).pipe(
    map(({ health, setup }) => ({
      health,
      setup,
      connectorCount: setup?.connectors?.length || 0,
    })),
  );

  fieldsFor(connectorId: string): ConnectorField[] {
    return connectorFields[connectorId] || [];
  }

  placeholderFor(config: Record<string, Record<string, string>> | undefined, connectorId: string, field: ConnectorField): string {
    return config?.[connectorId]?.[field.name] || field.placeholder || "";
  }

  draftValue(connectorId: string, fieldName: string): string {
    return this.drafts[connectorId]?.[fieldName] || "";
  }

  setDraftValue(connectorId: string, fieldName: string, value: string): void {
    this.drafts[connectorId] = {
      ...(this.drafts[connectorId] || {}),
      [fieldName]: value,
    };
  }

  refresh(): void {
    this.refreshSignal$.next(Date.now());
  }

  async saveConnector(connectorId: string): Promise<void> {
    const body = Object.fromEntries(
      Object.entries(this.drafts[connectorId] || {}).filter(([, value]) => String(value).trim()),
    );
    if (!Object.keys(body).length) return;
    await firstValueFrom(this.api.saveConnectorConfig(connectorId, body));
    this.drafts[connectorId] = {};
    this.refresh();
  }

  async testConnector(connectorId: string): Promise<void> {
    await firstValueFrom(this.api.testConnector(connectorId));
    this.refresh();
  }

  async startGmailOAuth(): Promise<void> {
    const payload = await firstValueFrom(this.api.startGmailOAuth());
    window.open(payload.authorizeUrl, "_blank", "noopener,noreferrer");
    this.refresh();
  }
}
