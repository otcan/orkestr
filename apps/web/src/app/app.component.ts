import { AsyncPipe } from "@angular/common";
import { Component, inject } from "@angular/core";
import { combineLatest, map, startWith } from "rxjs";
import { ApiService } from "./api.service";

@Component({
  selector: "ork-root",
  imports: [AsyncPipe],
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
            <small>{{ vm.connectorCount }} connectors</small>
          </article>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>Connectors</h2>
              <p>First Angular parity target after the shell.</p>
            </div>
          </div>
          <div class="connector-list">
            @for (connector of vm.setup?.connectors || []; track connector.id) {
              <article class="connector">
                <strong>{{ connector.label }}</strong>
                <span>{{ connector.state }}</span>
                <p>{{ connector.summary }}</p>
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

  readonly vm$ = combineLatest({
    health: this.api.health().pipe(startWith(null)),
    setup: this.api.setupStatus().pipe(startWith(null)),
  }).pipe(
    map(({ health, setup }) => ({
      health,
      setup,
      connectorCount: setup?.connectors?.length || 0,
    })),
  );
}
