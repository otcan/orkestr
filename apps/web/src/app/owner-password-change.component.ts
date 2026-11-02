import { ChangeDetectorRef, Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService } from "./api.service";

// Settings card for the signed-in owner to change their own password. It only
// renders when the owner-password login is in use and this browser is signed in
// as the owner, so the scope check mirrors the server (POST /api/auth/owner/password
// rejects anything but an owner-password session). The current password is
// verified server-side; this browser's session is re-issued on success while
// every other session is signed out.
@Component({
  selector: "ork-owner-password-change",
  imports: [FormsModule],
  styles: [`
    :host { display: block; }
    .owner-password { display: grid; gap: 12px; }
    label { display: grid; gap: 5px; font-weight: 700; font-size: 0.85rem; }
    input { min-height: 40px; border: 1px solid #cfd7cf; border-radius: 6px; padding: 0 10px; font: inherit; }
    .actions { display: flex; gap: 10px; align-items: center; }
    button { min-height: 40px; border: 1px solid #111827; border-radius: 6px; background: #111827; color: #fff; font-weight: 800; padding: 0 16px; }
    button[disabled] { opacity: 0.55; }
    .error { color: #8f2418; margin: 0; }
    .ok { color: #1f6f3b; margin: 0; }
    .subline { color: #3f4d59; margin: 0; }
  `],
  template: `
    @if (visible) {
      <section class="card">
        <p class="eyebrow">Account</p>
        <h3>Change owner password</h3>
        <p class="subline">Signed in as <strong>{{ username }}</strong>. Changing the password signs out every other browser; this one stays signed in.</p>
        <form class="owner-password" (submit)="submit(); $event.preventDefault()">
          <label>Current password
            <input name="owner-current-password" type="password" autocomplete="current-password" [(ngModel)]="currentPassword" required />
          </label>
          <label>New password
            <input name="owner-new-password" type="password" autocomplete="new-password" [(ngModel)]="newPassword" required />
          </label>
          <label>Confirm new password
            <input name="owner-new-password-repeat" type="password" autocomplete="new-password" [(ngModel)]="newPasswordRepeat" required />
          </label>
          @if (error) {
            <p class="error" role="alert">{{ error }}</p>
          }
          @if (done) {
            <p class="ok" role="status">Password changed. Other sessions were signed out.</p>
          }
          <div class="actions">
            <button type="submit" [disabled]="busy || !currentPassword || !newPassword">
              {{ busy ? "Saving…" : "Change password" }}
            </button>
          </div>
        </form>
      </section>
    }
  `,
})
export class OwnerPasswordChangeComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  visible = false;
  username = "";
  currentPassword = "";
  newPassword = "";
  newPasswordRepeat = "";
  busy = false;
  error = "";
  done = false;

  async ngOnInit(): Promise<void> {
    try {
      const status = await firstValueFrom(this.api.ownerLoginStatus());
      this.visible = Boolean(status.signedIn);
      this.username = String(status.username || "");
    } catch {
      this.visible = false;
    }
    this.cdr.markForCheck();
  }

  async submit(): Promise<void> {
    this.error = "";
    this.done = false;
    if (this.newPassword.length < 8) {
      this.error = "Use at least 8 characters for the new password.";
      return;
    }
    if (this.newPassword !== this.newPasswordRepeat) {
      this.error = "The new passwords do not match.";
      return;
    }
    this.busy = true;
    try {
      await firstValueFrom(this.api.ownerChangePassword(this.currentPassword, this.newPassword));
      this.currentPassword = "";
      this.newPassword = "";
      this.newPasswordRepeat = "";
      this.done = true;
    } catch (error) {
      this.error = passwordErrorText(error);
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }
}

function passwordErrorText(error: unknown): string {
  const code = String((error as { error?: { error?: string } })?.error?.error || "");
  const messages: Record<string, string> = {
    owner_login_invalid: "The current password is wrong.",
    owner_session_required: "Sign in as the owner to change the password.",
    owner_password_too_short: "Use at least 8 characters for the new password.",
    owner_login_missing: "No owner login is configured.",
  };
  return messages[code] || "That did not work. Try again.";
}
