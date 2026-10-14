import { bootstrapApplication } from "@angular/platform-browser";
import { provideHttpClient } from "@angular/common/http";
import { ErrorHandler, Injectable } from "@angular/core";
import { AppComponent } from "./app/app.component";
import { installWebCryptoFallbackShim, redirectZeroHostToLocalhost } from "./app/browser-compat";

@Injectable()
class OrkestrErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    console.error(error);
    showBootError(error);
  }
}

function showBootError(error: unknown): void {
  const root = document.querySelector("ork-root");
  if (!root) return;
  const message = error instanceof Error ? error.message : String(error || "Unknown error");
  const existing = root.querySelector<HTMLElement>(".boot-shell.boot-error");
  const target = existing || document.createElement("main");
  target.className = "boot-shell boot-error";
  target.setAttribute("role", "alert");
  target.innerHTML = `
    <p class="boot-eyebrow">Orkestr</p>
    <h1>Orkestr failed to render</h1>
    <p>${escapeHtml(message)}</p>
  `;
  if (!existing) root.appendChild(target);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char] || char);
}

const redirecting = redirectZeroHostToLocalhost();
installWebCryptoFallbackShim();

if (!redirecting) bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    { provide: ErrorHandler, useClass: OrkestrErrorHandler },
  ],
}).catch((error) => {
  console.error(error);
  showBootError(error);
});
