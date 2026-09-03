import { DatePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, HushPairedDevice, HushProfileSummary } from "./api.service";

@Component({
  selector: "ork-hush-device-management-panel",
  imports: [DatePipe, FormsModule],
  templateUrl: "./hush-device-management-panel.component.html",
  styleUrls: ["./hush-device-management-panel.component.css"],
})
export class HushDeviceManagementPanelComponent implements OnInit {
  private readonly api = inject(ApiService);

  profiles: HushProfileSummary[] = [];
  devices: HushPairedDevice[] = [];
  selectedProfileId = "";
  pairingCode = "";
  pairingStatus = "";
  pairingExpiresAt = "";
  busy = false;
  approving = false;
  revokingDeviceId = "";
  error = "";
  notice = "";

  ngOnInit(): void {
    void this.load();
  }

  activeProfiles(): HushProfileSummary[] {
    return this.profiles.filter((profile) => String(profile.status || "").toLowerCase() === "active");
  }

  canApprove(): boolean {
    return Boolean(this.pairingCode.trim() && this.selectedProfileId && !this.approving && !this.busy);
  }

  async load(): Promise<void> {
    this.busy = true;
    try {
      const [profiles, devices] = await Promise.all([
        firstValueFrom(this.api.hushProfiles()),
        firstValueFrom(this.api.hushDevices()),
      ]);
      this.profiles = profiles.profiles || [];
      this.devices = devices.devices || [];
      const available = this.activeProfiles();
      if (!available.some((profile) => profile.id === this.selectedProfileId)) this.selectedProfileId = available[0]?.id || "";
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async approvePairing(): Promise<void> {
    const pairingCode = this.pairingCode.trim();
    const profileId = this.selectedProfileId;
    if (!pairingCode || !profileId || this.approving || this.busy) return;

    this.approving = true;
    this.error = "";
    this.notice = "";
    try {
      const result = await firstValueFrom(this.api.approveHushPairing(profileId, pairingCode));
      this.pairingStatus = String(result.pairing?.status || "approved");
      this.pairingExpiresAt = String(result.pairing?.expiresAt || "");
      this.notice = this.pairingNotice(this.pairingStatus);
      await this.load();
    } catch (error) {
      this.pairingStatus = "";
      this.pairingExpiresAt = "";
      this.error = this.errorText(error);
    } finally {
      // Pairing codes are short-lived bearer material; retain none after a request.
      this.pairingCode = "";
      this.approving = false;
    }
  }

  async revokeDevice(device: HushPairedDevice): Promise<void> {
    if (this.busy || this.approving || this.revokingDeviceId || !device.id) return;
    if (!window.confirm(`Revoke ${this.deviceLabel(device)}? The mobile app will need a new owner-approved pairing.`)) return;

    this.revokingDeviceId = device.id;
    this.error = "";
    this.notice = "";
    try {
      await firstValueFrom(this.api.revokeHushDevice(device.id));
      this.notice = "Device revoked. Its mobile credentials are no longer accepted.";
      await this.load();
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.revokingDeviceId = "";
    }
  }

  profileLabel(profile: HushProfileSummary): string {
    return profile.label || "Managed Hush profile";
  }

  deviceLabel(device: HushPairedDevice): string {
    return device.label || "Paired device";
  }

  deviceState(device: HushPairedDevice): string {
    const status = String(device.status || "unknown").toLowerCase();
    if (status === "paired") return "active";
    if (status === "pending") return "waiting";
    if (status === "revoked") return "revoked";
    if (status === "expired") return "expired";
    return "unavailable";
  }

  deviceCanRevoke(device: HushPairedDevice): boolean {
    const status = String(device.status || "").toLowerCase();
    return status === "paired" || status === "pending";
  }

  pairingNotice(status: string): string {
    switch (status.toLowerCase()) {
      case "approved":
        return "Pairing approved. The device can finish registration before its pairing window expires.";
      case "pending":
        return "Pairing is still waiting for device confirmation.";
      case "expired":
        return "That pairing window has expired. Start a new pairing request on the device.";
      case "revoked":
        return "That pairing request was revoked.";
      default:
        return "Pairing state updated. Refresh to review the managed device list.";
    }
  }

  pairingStateLabel(): string {
    switch (this.pairingStatus.toLowerCase()) {
      case "approved":
        return "approved";
      case "pending":
        return "waiting for device confirmation";
      case "expired":
        return "expired";
      case "revoked":
        return "revoked";
      default:
        return "updated";
    }
  }

  private errorText(error: unknown): string {
    const code = this.errorCode(error);
    if (code.includes("expired")) return "That pairing window has expired. Start a new pairing request on the device.";
    if (code.includes("revoked")) return "This pairing or device has been revoked.";
    if (code.includes("profile") || code.includes("owner") || code.includes("forbidden")) return "The selected managed Hush profile is not available to this owner.";
    if (code.includes("code") || code.includes("pairing") || code.includes("device")) return "The pairing code or managed device is no longer available.";
    return "This Hush device request could not be completed. Refresh and try again.";
  }

  private errorCode(error: unknown): string {
    if (!error || typeof error !== "object") return "";
    const record = error as { error?: unknown };
    if (!record.error || typeof record.error !== "object") return "";
    const body = record.error as { code?: unknown; error?: unknown };
    const code = body.code || body.error;
    return typeof code === "string" ? code.toLowerCase() : "";
  }
}
