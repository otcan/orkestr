import { Injectable, signal } from "@angular/core";
import { ConnectorStatus, WhatsAppStatusResponse } from "../api.service";

@Injectable({ providedIn: "root" })
export class ConnectorStore {
  readonly connectors = signal<ConnectorStatus[]>([]);
  readonly whatsappStatus = signal<WhatsAppStatusResponse | null>(null);

  setConnectors(connectors: ConnectorStatus[]): void {
    this.connectors.set(connectors);
  }

  setWhatsAppStatus(status: WhatsAppStatusResponse | null): void {
    this.whatsappStatus.set(status);
  }
}
