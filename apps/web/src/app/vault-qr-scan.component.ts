import { Component, ElementRef, EventEmitter, OnDestroy, Output, ViewChild } from "@angular/core";
import { cameraScanSupported, qrScanSupported, scanQrCodes } from "./vault-secrets";

// "Scan QR" for otpauth:// and otpauth-migration:// codes. Renders nothing
// when the browser has no BarcodeDetector.
@Component({
  selector: "ork-vault-qr-scan",
  template: `
    @if (supported) {
      <div class="vault-qr">
        <label class="secondary vault-qr-button">
          Scan QR image
          <input type="file" accept="image/*" hidden (change)="scanFile($any($event.target))">
        </label>
        @if (cameraSupported) {
          <button class="secondary" type="button" (click)="cameraOn ? stopCamera() : startCamera()">{{ cameraOn ? "Stop camera" : "Use camera" }}</button>
        }
        @if (message) {<small>{{ message }}</small>}
      </div>
      @if (cameraOn) {
        <video #video class="vault-qr-video" autoplay muted playsinline></video>
      }
    }
  `,
  styles: [`
    .vault-qr { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .vault-qr small { color: rgba(235, 255, 230, 0.6); }
    .vault-qr-button { display: inline-flex !important; align-items: center; cursor: pointer; border: 1px solid rgba(119, 205, 126, 0.3); border-radius: 8px; padding: 5px 11px; font-size: 0.82rem; }
    .vault-qr-video { width: 100%; max-height: 260px; border-radius: 8px; background: #000; }
  `],
})
export class VaultQrScanComponent implements OnDestroy {
  @Output() readonly scanned = new EventEmitter<string[]>();
  @ViewChild("video") video?: ElementRef<HTMLVideoElement>;
  readonly supported = qrScanSupported();
  readonly cameraSupported = cameraScanSupported();
  cameraOn = false;
  message = "";
  private stream: MediaStream | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  async scanFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      this.report(await scanQrCodes(file));
    } catch {
      this.message = "Could not read that image.";
    }
  }

  async startCamera(): Promise<void> {
    try {
      this.stream = await globalThis.navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      this.cameraOn = true;
      this.message = "Point the camera at the QR code.";
      setTimeout(() => {
        const video = this.video?.nativeElement;
        if (!video || !this.stream) return;
        video.srcObject = this.stream;
        this.scanTimer = setInterval(() => void this.scanVideo(video), 500);
      });
    } catch {
      this.message = "Camera access was denied.";
      this.stopCamera();
    }
  }

  private async scanVideo(video: HTMLVideoElement): Promise<void> {
    if (video.readyState < 2) return;
    try {
      const values = await scanQrCodes(video);
      if (values.length) {
        this.stopCamera();
        this.report(values);
      }
    } catch {
      // Keep scanning; transient frame errors are expected.
    }
  }

  stopCamera(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
    this.cameraOn = false;
  }

  private report(values: string[]): void {
    this.message = values.length ? `Found ${values.length} authenticator code${values.length === 1 ? "" : "s"}.` : "No authenticator QR code found.";
    if (values.length) this.scanned.emit(values);
  }

  ngOnDestroy(): void {
    this.stopCamera();
  }
}
