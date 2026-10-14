import { ChangeDetectorRef, Component, EventEmitter, Input, OnInit, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService } from "./api.service";

// First visit: the owner picks a username and password. Later visits: sign in.
@Component({
  selector: "ork-owner-login-page",
  imports: [FormsModule],
  styles: [`
    :host { display: grid; min-height: 100vh; place-items: center; padding: 18px; background: #f7f8f5; color: #111827; }
    .owner-login { display: grid; gap: 14px; width: min(400px, 100%); border: 1px solid #d7ded5; border-radius: 8px; background: #fff; padding: 22px; }
    h1 { margin: 0; font-size: 1.4rem; }
    p { margin: 0; color: #3f4d59; line-height: 1.45; }
    label { display: grid; gap: 5px; font-weight: 700; font-size: 0.85rem; }
    input { min-height: 40px; border: 1px solid #cfd7cf; border-radius: 6px; padding: 0 10px; font: inherit; }
    button { min-height: 42px; border: 1px solid #111827; border-radius: 6px; background: #111827; color: #fff; font-weight: 800; }
    button.link { min-height: 0; border: 0; background: none; color: #3f4d59; font-weight: 600; text-decoration: underline; justify-self: start; padding: 0; }
    .error { color: #8f2418; }
  `],
  template: `
    <section class="owner-login" [attr.aria-label]="mode === 'setup' ? 'Create your login' : 'Sign in'">
      @if (mode === "loading") {
        <p>Loading…</p>
      } @else {
        <h1>{{ mode === "setup" ? "Create your login" : "Sign in" }}</h1>
        <p>
          @if (mode === "setup") {
            Pick the username and password you will use to open this Orkestr from now on.
          } @else {
            Sign in to this Orkestr.
          }
        </p>
        <form (submit)="submit(); $event.preventDefault()">
          <label>Username
            <input name="owner-username" autocomplete="username" [(ngModel)]="username" required maxlength="64" />
          </label>
          <label>Password
            <input name="owner-password" type="password" [attr.autocomplete]="mode === 'setup' ? 'new-password' : 'current-password'" [(ngModel)]="password" required />
          </label>
          @if (mode === "setup") {
            <label>Repeat password
              <input name="owner-password-repeat" type="password" autocomplete="new-password" [(ngModel)]="passwordRepeat" required />
            </label>
          }
          @if (error) {
            <p class="error" role="alert">{{ error }}</p>
          }
          <button type="submit" [disabled]="busy || !username.trim() || !password">
            {{ busy ? "One moment…" : mode === "setup" ? "Create login" : "Sign in" }}
          </button>
        </form>
        @if (mode === "setup" && canSkip) {
          <button class="link" type="button" (click)="skipped.emit()">Later</button>
        }
        @if (mode === "login" && allowPairing) {
          <button class="link" type="button" (click)="pairingRequested.emit()">Approve this browser with a command instead</button>
        }
      }
    </section>
  `,
})
export class OwnerLoginPageComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  @Input() canSkip = false;
  @Input() allowPairing = true;
  @Output() signedIn = new EventEmitter<void>();
  @Output() skipped = new EventEmitter<void>();
  @Output() pairingRequested = new EventEmitter<void>();

  mode: "loading" | "setup" | "login" = "loading";
  username = "";
  password = "";
  passwordRepeat = "";
  busy = false;
  error = "";

  async ngOnInit(): Promise<void> {
    try {
      const status = await firstValueFrom(this.api.ownerLoginStatus());
      this.mode = status.configured ? "login" : "setup";
    } catch {
      this.mode = "login";
    }
    this.cdr.markForCheck();
  }

  async submit(): Promise<void> {
    this.error = "";
    if (this.mode === "setup") {
      if (this.password.length < 8) {
        this.error = "Use at least 8 characters for the password.";
        return;
      }
      if (this.password !== this.passwordRepeat) {
        this.error = "The passwords do not match.";
        return;
      }
    }
    this.busy = true;
    try {
      if (this.mode === "setup") await firstValueFrom(this.api.ownerLoginSetup(this.username.trim(), this.password));
      else await firstValueFrom(this.api.ownerLogin(this.username.trim(), this.password));
      this.password = "";
      this.passwordRepeat = "";
      this.signedIn.emit();
    } catch (error) {
      this.error = loginErrorText(error);
      if ((error as { error?: { error?: string } })?.error?.error === "owner_login_exists") this.mode = "login";
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }
}

function loginErrorText(error: unknown): string {
  const code = String((error as { error?: { error?: string } })?.error?.error || "");
  const messages: Record<string, string> = {
    owner_login_invalid: "Wrong username or password.",
    owner_login_rate_limited: "Too many attempts. Wait 15 minutes and try again.",
    owner_login_exists: "A login already exists. Sign in with it.",
    owner_username_invalid: "Use letters, numbers, dot, dash, underscore or @ for the username.",
    owner_password_too_short: "Use at least 8 characters for the password.",
  };
  return messages[code] || "That did not work. Try again.";
}
