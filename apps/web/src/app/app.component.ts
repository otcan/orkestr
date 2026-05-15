import { AsyncPipe } from "@angular/common";
import { Component, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { BehaviorSubject, combineLatest, firstValueFrom, forkJoin, map, of, startWith, switchMap } from "rxjs";
import { AgentWithMessages, ApiService } from "./api.service";

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

        <section class="split">
          <article class="panel">
            <div class="panel-head">
              <div>
                <h2>Agent Starters</h2>
                <p>Opinionated first-use flows.</p>
              </div>
            </div>
            <div class="stack">
              @for (template of vm.templates; track template.id) {
                <article class="mini-card">
                  <span class="state">{{ template.connectors.join(" + ") }}</span>
                  <h3>{{ template.name }}</h3>
                  <p>{{ template.tagline }}</p>
                  <small>{{ template.defaultTimer.label }} · {{ template.defaultTimer.cadence }} at {{ template.defaultTimer.time }}</small>
                  <button type="button" (click)="createAgent(template.id)">Create</button>
                </article>
              }
            </div>
          </article>

          <article class="panel">
            <div class="panel-head">
              <div>
                <h2>Configured Agents</h2>
                <p>Queue messages and run the next item.</p>
              </div>
            </div>
            <div class="stack">
              @for (agent of vm.agents; track agent.id) {
                <article class="mini-card">
                  <span class="state">{{ agent.state }}</span>
                  <h3>{{ agent.name }}</h3>
                  <small>{{ agent.id }} · {{ agent.connectors.join(", ") }}</small>
                  <div class="message-list">
                    @for (message of lastMessages(agent.messages); track message.id) {
                      <div class="message-row">
                        <strong>{{ message.role }} · {{ message.state }}</strong>
                        <p>{{ message.text || message.promptFile }}</p>
                      </div>
                    }
                  </div>
                  <textarea
                    rows="3"
                    placeholder="Send a test message to this agent"
                    [ngModel]="agentDrafts[agent.id] || ''"
                    (ngModelChange)="agentDrafts[agent.id] = $event"
                  ></textarea>
                  <div class="actions">
                    <button class="secondary" type="button" (click)="queueAgentMessage(agent.id)">Queue message</button>
                    <button type="button" (click)="runNextAgent(agent.id)">Run next</button>
                  </div>
                </article>
              } @empty {
                <p>No agents created yet.</p>
              }
            </div>
          </article>
        </section>

        <section class="split">
          <article class="panel">
            <div class="panel-head">
              <div>
                <h2>Timers</h2>
                <p>Recurring work from day one.</p>
              </div>
            </div>
            <form class="timer-form" (submit)="createTimer(); $event.preventDefault()">
              <input name="timer-label" placeholder="Morning recruiting scan" [(ngModel)]="timerDraft['label']" />
              <input name="timer-target" placeholder="job-search-assistant" [(ngModel)]="timerDraft['target']" />
              <select name="timer-cadence" [(ngModel)]="timerDraft['cadence']">
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="interval">Interval</option>
                <option value="once">Once</option>
              </select>
              <input name="timer-time" placeholder="09:00" [(ngModel)]="timerDraft['time']" />
              <textarea name="timer-prompt" rows="4" [(ngModel)]="timerDraft['prompt']"></textarea>
              <button type="submit">Create timer</button>
            </form>
            <div class="stack">
              @for (timer of vm.timers; track timer.id) {
                <article class="mini-card">
                  <span class="state connected">{{ timer.cadence }}</span>
                  <h3>{{ timer.label }}</h3>
                  <p>{{ timer.target }} · next {{ timer.nextRunAt }}</p>
                  @if (timer.promptFile) {
                    <small>{{ timer.promptFile }}</small>
                  }
                  <div class="actions">
                    <button class="secondary" type="button" (click)="runTimer(timer.id)">Run now</button>
                    <button class="danger" type="button" (click)="deleteTimer(timer.id)">Delete</button>
                  </div>
                </article>
              } @empty {
                <p>No timers yet.</p>
              }
            </div>
          </article>

          <article class="panel">
            <div class="panel-head">
              <div>
                <h2>Activity</h2>
                <p>Recent setup, timer, connector, and executor events.</p>
              </div>
            </div>
            <div class="event-list">
              @for (event of vm.events; track event.ts + event.type) {
                <div class="event-row">
                  <strong>{{ event.type }}</strong>
                  <span>{{ event.ts }}</span>
                </div>
              } @empty {
                <p>No events yet.</p>
              }
            </div>
          </article>
        </section>
      }
    </main>
  `,
})
export class AppComponent {
  private readonly api = inject(ApiService);
  private readonly refreshSignal$ = new BehaviorSubject(0);

  readonly drafts: Record<string, Record<string, string>> = {};
  readonly agentDrafts: Record<string, string> = {};
  readonly timerDraft: Record<string, string> = {
    label: "Morning recruiting scan",
    target: "job-search-assistant",
    cadence: "daily",
    time: "09:00",
    prompt: "Check Gmail and LinkedIn for recruiting messages. Send a WhatsApp summary and draft replies where useful.",
  };

  readonly vm$ = combineLatest({
    health: this.api.health().pipe(startWith(null)),
    setup: this.refreshSignal$.pipe(switchMap(() => this.api.setupStatus()), startWith(null)),
    templates: this.refreshSignal$.pipe(switchMap(() => this.api.agentTemplates()), map((payload) => payload.templates), startWith([])),
    agents: this.refreshSignal$.pipe(switchMap(() => this.loadAgents()), startWith([])),
    timers: this.refreshSignal$.pipe(switchMap(() => this.api.timers()), map((payload) => payload.timers), startWith([])),
    events: this.refreshSignal$.pipe(switchMap(() => this.api.events()), map((payload) => payload.events), startWith([])),
  }).pipe(
    map(({ health, setup, templates, agents, timers, events }) => ({
      health,
      setup,
      templates,
      agents,
      timers,
      events,
      connectorCount: setup?.connectors?.length || 0,
    })),
  );

  private loadAgents() {
    return this.api.agents().pipe(
      switchMap((payload) => {
        if (!payload.agents.length) return of([] as AgentWithMessages[]);
        return forkJoin(
          payload.agents.map((agent) =>
            this.api.agentMessages(agent.id).pipe(
              map((messagesPayload) => ({
                ...agent,
                messages: messagesPayload.messages,
              })),
            ),
          ),
        );
      }),
    );
  }

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

  lastMessages(messages: AgentWithMessages["messages"]): AgentWithMessages["messages"] {
    return messages.slice(-4);
  }

  async createAgent(templateId: string): Promise<void> {
    await firstValueFrom(this.api.createAgentFromTemplate(templateId));
    this.refresh();
  }

  async queueAgentMessage(agentId: string): Promise<void> {
    const text = String(this.agentDrafts[agentId] || "").trim();
    if (!text) return;
    await firstValueFrom(this.api.queueAgentMessage(agentId, text));
    this.agentDrafts[agentId] = "";
    this.refresh();
  }

  async runNextAgent(agentId: string): Promise<void> {
    await firstValueFrom(this.api.runNextAgentMessage(agentId));
    this.refresh();
  }

  async createTimer(): Promise<void> {
    const body = Object.fromEntries(Object.entries(this.timerDraft).filter(([, value]) => String(value).trim()));
    await firstValueFrom(this.api.createTimer(body));
    this.refresh();
  }

  async runTimer(timerId: string): Promise<void> {
    await firstValueFrom(this.api.runTimer(timerId));
    this.refresh();
  }

  async deleteTimer(timerId: string): Promise<void> {
    await firstValueFrom(this.api.deleteTimer(timerId));
    this.refresh();
  }
}
