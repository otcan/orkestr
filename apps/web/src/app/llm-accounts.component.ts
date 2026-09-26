import { ChangeDetectorRef, Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, LlmAccountDiagnostics, LlmAccountLoginSession, LlmAccountProfile } from "./api.service";

@Component({
  selector: "app-llm-accounts",
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="llm-accounts" aria-label="Coding agent accounts">
      <header>
        <div><h4>Coding agent accounts</h4><small>Server-managed Claude Code subscription profiles. Credential files are never returned to this page.</small></div>
        <button class="secondary" type="button" (click)="load()" [disabled]="busy">Refresh</button>
      </header>
      @if (error) { <p class="error" role="alert">{{ error }}</p> }
      @if (notice) { <p role="status">{{ notice }}</p> }
      @if (!enabled) { <p class="notice">Claude Code is disabled on this host. Enable the server runtime before adding profiles.</p> }
      <form (submit)="create(); $event.preventDefault()">
        <label>Profile label <input name="llm-account-label" [(ngModel)]="label" placeholder="Claude Max" maxlength="120" [disabled]="busy || !enabled" /></label>
        <button type="submit" [disabled]="busy || !enabled || !label.trim()">Add Claude subscription</button>
      </form>
      <div class="profiles">
        @for (account of accounts; track account.id) {
          <article>
            <div><strong>{{ account.label }}</strong><span>{{ account.provider }} · {{ account.state }}</span></div>
            <div class="actions">
              @if (account.state === 'login_required' || account.state === 'error') {
                <button type="button" (click)="connect(account)" [disabled]="busy">Connect</button>
              }
              <button class="secondary" type="button" (click)="verify(account)" [disabled]="busy || account.state === 'revoked'">
                {{ account.state === 'rate_limited' ? 'Recheck after plan change' : 'Verify login' }}
              </button>
              <button class="secondary danger-soft" type="button" (click)="revoke(account)" [disabled]="busy || account.state === 'revoked'">Revoke</button>
              @if (account.state !== 'revoked') {
                <button class="secondary" type="button" (click)="toggleDiagnostics(account)" [disabled]="busy" aria-label="Show account diagnostics">
                  {{ diagProfileId === account.id ? 'Hide diagnostics' : 'Diagnostics' }}
                </button>
              }
            </div>
            @if (account.state === 'rate_limited') {
              <small class="profile-note">Recheck confirms the server login only. It cannot verify the subscription tier or remaining quota, and it never replays failed prompts.</small>
            }
            @if (activeLoginProfileId === account.id && account.state !== 'ready') {
              <form class="code-form" (submit)="completeLogin(account); $event.preventDefault()">
                <label>One-time authorization code
                  <input type="password" name="claude-authorization-code" [(ngModel)]="authorizationCode" autocomplete="off" [disabled]="busy" />
                </label>
                <button type="submit" [disabled]="busy || !authorizationCode.trim()">Complete login</button>
              </form>
            }
            @if (diagProfileId === account.id) {
              @if (diagError) { <p class="error diag-row" role="alert">{{ diagError }}</p> }
              @if (diagData) {
                <aside class="diag-row" aria-label="Account diagnostics">
                  <dl>
                    <dt>Authenticated</dt><dd>{{ diagData.authenticated ? 'yes' : 'no' }} (CLI {{ diagData.available ? 'available' : 'unavailable' }})</dd>
                    <dt>Stored state</dt><dd>{{ diagData.profileState }}</dd>
                    @if (diagData.authMethod) { <dt>Auth method</dt><dd>{{ diagData.authMethod }}</dd> }
                    @if (diagData.apiProvider) { <dt>API provider</dt><dd>{{ diagData.apiProvider }}</dd> }
                    <dt>Subscription tier</dt><dd>{{ diagData.providerReportedSubscription?.tier || 'not reported by CLI' }}</dd>
                    <dt>Quota</dt><dd>not reported by auth status</dd>
                    <dt>Multiplier</dt><dd>not reported by any source</dd>
                    @if (diagData.failureCode) { <dt>Failure code</dt><dd>{{ diagData.failureCode }}</dd> }
                    <dt>Last verified</dt><dd>{{ diagData.lastVerifiedAt || 'never' }}</dd>
                  </dl>
                  <small>Read-only snapshot. Subscription multiplier and quota are not reported by the auth status command. Tier comes directly from the CLI; it is not inferred from the profile label.</small>
                </aside>
              }
            }
          </article>
        } @empty { <p>No Claude Code account profiles yet.</p> }
      </div>
      <small>Connect starts Claude's attended login. Orkestr returns only an allowlisted provider authorization URL; credential paths, tokens and CLI output remain server-side.</small>
    </section>
  `,
  styles: [`
    .llm-accounts { display:grid; gap:14px; }
    header, article, form, .actions { display:flex; gap:12px; align-items:center; justify-content:space-between; }
    header div, article div:first-child, label { display:grid; gap:4px; }
    form { justify-content:flex-start; flex-wrap:wrap; }
    input { min-width:220px; padding:8px; }
    .profiles { display:grid; gap:8px; }
    article { border:1px solid var(--line, #d7d7d7); border-radius:10px; padding:12px; flex-wrap:wrap; }
    .code-form { width:100%; justify-content:flex-start; flex-wrap:wrap; }
    .profile-note { flex:1 1 100%; }
    .diag-row { flex:1 1 100%; width:100%; }
    aside.diag-row { border-top:1px solid var(--line,#d7d7d7); padding-top:10px; margin-top:4px; }
    dl { display:grid; grid-template-columns:max-content 1fr; gap:3px 12px; }
    dt { opacity:.65; }
    article span, small { opacity:.75; }
    .error { color:var(--danger, #a22); }
  `],
})
export class LlmAccountsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly detector = inject(ChangeDetectorRef);
  accounts: LlmAccountProfile[] = [];
  enabled = false;
  label = "";
  busy = false;
  error = "";
  notice = "";
  activeLoginProfileId = "";
  authorizationCode = "";
  diagProfileId = "";
  diagData: LlmAccountDiagnostics | null = null;
  diagError = "";

  ngOnInit(): void { void this.load(); }

  async load(): Promise<void> {
    this.busy = true; this.error = "";
    try {
      const result = await firstValueFrom(this.api.llmAccounts("claude-code"));
      this.enabled = result.enabled === true;
      this.accounts = result.accounts || [];
    }
    catch { this.enabled = false; this.error = "Could not load coding agent accounts."; }
    finally { this.busy = false; this.detector.markForCheck(); }
  }

  async create(): Promise<void> {
    if (!this.enabled || !this.label.trim()) return;
    this.busy = true; this.error = this.notice = "";
    try {
      const result = await firstValueFrom(this.api.createLlmAccount({ provider: "claude-code", label: this.label.trim(), authMode: "subscription" }));
      this.accounts = [...this.accounts, result.account];
      this.label = "";
      this.notice = "Claude profile created. Complete its attended server login, then verify it here.";
    } catch (error: any) { this.error = error?.error?.message || error?.error?.error || "Could not create the Claude profile."; }
    finally { this.busy = false; this.detector.markForCheck(); }
  }

  async verify(account: LlmAccountProfile): Promise<void> {
    const recheckingPlanChange = account.state === "rate_limited";
    this.busy = true; this.error = this.notice = "";
    try {
      const result = await firstValueFrom(this.api.verifyLlmAccount(account.id));
      this.replace(result.account);
      if (recheckingPlanChange) {
        this.notice = result.status.authenticated
          ? `${account.label} login is valid. The subscription tier and remaining quota were not verified. Failed prompts were not replayed; retry one explicitly when ready.`
          : `${account.label} still needs an attended Claude login. The subscription tier and remaining quota were not verified, and failed prompts were not replayed.`;
      } else {
        this.notice = result.status.authenticated ? `${account.label} is ready.` : `${account.label} still needs an attended Claude login.`;
      }
    } catch (error: any) { this.error = error?.error?.message || error?.error?.error || "Could not verify the Claude profile."; }
    finally { this.busy = false; this.detector.markForCheck(); }
  }

  async connect(account: LlmAccountProfile): Promise<void> {
    this.busy = true; this.error = this.notice = "";
    const authWindow = window.open("about:blank", "_blank");
    if (authWindow) authWindow.opener = null;
    try {
      const result = await firstValueFrom(this.api.startLlmAccountLogin(account.id));
      const login = result.login.authUrl ? result.login : await this.waitForAuthUrl(account.id, result.login);
      if (login.authUrl) {
        this.activeLoginProfileId = account.id;
        this.authorizationCode = "";
        if (authWindow) authWindow.location.href = login.authUrl;
        else window.open(login.authUrl, "_blank", "noopener,noreferrer");
        this.notice = `Claude login opened for ${account.label}. Authorize it, then paste the one-time code here.`;
      } else if (login.state === "failed") {
        authWindow?.close();
        this.error = login.failureCode || "Claude login could not be started.";
      } else {
        authWindow?.close();
        this.notice = `Claude login started for ${account.label}. Verify after completing the provider prompt.`;
      }
    } catch (error: any) { authWindow?.close(); this.error = error?.error?.message || error?.error?.error || "Could not start Claude login."; }
    finally { this.busy = false; this.detector.markForCheck(); }
  }

  async completeLogin(account: LlmAccountProfile): Promise<void> {
    const code = this.authorizationCode.trim();
    if (!code || this.activeLoginProfileId !== account.id) return;
    this.busy = true; this.error = this.notice = "";
    this.authorizationCode = "";
    try {
      let login = (await firstValueFrom(this.api.submitLlmAccountLoginCode(account.id, code))).login;
      for (let attempt = 0; attempt < 30 && !["failed", "completed"].includes(login.state); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        login = (await firstValueFrom(this.api.llmAccountLoginStatus(account.id))).login || login;
      }
      if (login.state === "failed") throw new Error(login.failureCode || "Claude login failed.");
      if (login.state !== "completed") {
        this.notice = `Claude login is still completing for ${account.label}.`;
        return;
      }
      const verified = await firstValueFrom(this.api.verifyLlmAccount(account.id));
      this.replace(verified.account);
      this.activeLoginProfileId = "";
      this.notice = verified.status.authenticated ? `${account.label} is ready.` : `${account.label} still needs an attended Claude login.`;
    } catch (error: any) {
      this.error = error?.error?.message || error?.error?.error || error?.message || "Could not complete the Claude login.";
    } finally {
      this.authorizationCode = "";
      this.busy = false;
      this.detector.markForCheck();
    }
  }

  async revoke(account: LlmAccountProfile): Promise<void> {
    this.busy = true; this.error = this.notice = "";
    try {
      const result = await firstValueFrom(this.api.revokeLlmAccount(account.id));
      this.replace(result.account);
      this.notice = `${account.label} revoked${result.interruptedThreads ? `; ${result.interruptedThreads} attached thread(s) were fenced` : ""}.`;
    } catch (error: any) { this.error = error?.error?.message || error?.error?.error || "Could not revoke the Claude profile."; }
    finally { this.busy = false; this.detector.markForCheck(); }
  }

  async toggleDiagnostics(account: LlmAccountProfile): Promise<void> {
    if (this.diagProfileId === account.id) {
      this.diagProfileId = ""; this.diagData = null; this.diagError = "";
      this.detector.markForCheck();
      return;
    }
    this.busy = true; this.diagProfileId = account.id; this.diagData = null; this.diagError = "";
    try {
      this.diagData = await firstValueFrom(this.api.llmAccountDiagnostics(account.id));
    } catch (error: any) {
      this.diagError = error?.error?.error || "Could not load diagnostics.";
    } finally {
      this.busy = false; this.detector.markForCheck();
    }
  }

  private replace(account: LlmAccountProfile): void {
    this.accounts = this.accounts.map((entry) => entry.id === account.id ? account : entry);
  }

  private async waitForAuthUrl(profileId: string, initial: LlmAccountLoginSession): Promise<LlmAccountLoginSession> {
    let login = initial;
    for (let attempt = 0; attempt < 20 && !login?.authUrl && !["failed", "completed"].includes(login?.state); attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      login = (await firstValueFrom(this.api.llmAccountLoginStatus(profileId))).login || login;
    }
    return login;
  }
}
