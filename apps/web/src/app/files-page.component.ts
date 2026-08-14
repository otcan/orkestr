import { DatePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, InstanceFileEntry, InstanceFileMount, InstanceFilePreviewResponse, InstanceFilesResponse } from "./api.service";

@Component({
  selector: "ork-files-page",
  imports: [DatePipe, FormsModule],
  templateUrl: "./files-page.component.html",
})
export class FilesPageComponent implements OnInit {
  private readonly api = inject(ApiService);

  busy = false;
  uploadBusy = false;
  previewBusy = false;
  error = "";
  notice = "";
  currentMount = "";
  currentPath = "";
  parentPath: string | null = null;
  mounts: InstanceFileMount[] = [];
  entries: InstanceFileEntry[] = [];
  preview: InstanceFilePreviewResponse | null = null;
  newFolderName = "";

  ngOnInit(): void {
    void this.loadFiles();
  }

  async loadFiles(path = this.currentPath, mount = this.currentMount): Promise<void> {
    this.busy = true;
    try {
      this.applyListing(await firstValueFrom(this.api.instanceFiles(mount, path)));
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async createFolder(): Promise<void> {
    const name = this.newFolderName.trim();
    if (!name || this.busy) return;
    this.busy = true;
    try {
      this.applyListing(await firstValueFrom(this.api.createInstanceFolder(this.currentMount, this.currentPath, name)));
      this.newFolderName = "";
      this.notice = "Folder created.";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  async uploadSelected(files: FileList | null): Promise<void> {
    const selected = Array.from(files || []);
    if (!selected.length || this.uploadBusy) return;
    this.uploadBusy = true;
    try {
      const result = await firstValueFrom(this.api.uploadInstanceFiles(this.currentMount, this.currentPath, selected));
      this.applyListing(result);
      this.notice = `${result.files?.length || selected.length} file${selected.length === 1 ? "" : "s"} uploaded.`;
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.uploadBusy = false;
    }
  }

  async previewEntry(entry: InstanceFileEntry): Promise<void> {
    if (entry.directory || !entry.previewable || this.previewBusy) return;
    this.previewBusy = true;
    try {
      this.preview = await firstValueFrom(this.api.instanceFilePreview(this.currentMount, entry.path));
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.previewBusy = false;
    }
  }

  openEntry(entry: InstanceFileEntry): void {
    if (!entry.path) return;
    if (entry.directory) void this.loadFiles(entry.path);
    else void this.previewEntry(entry);
  }

  openPath(path = "", mount = this.currentMount): void {
    this.preview = null;
    void this.loadFiles(path, mount);
  }

  downloadUrl(entry: InstanceFileEntry): string {
    return this.api.instanceFileDownloadUrl(this.currentMount, entry.path);
  }

  formatBytes(value: unknown): string {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
    return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
  }

  entryKind(entry: InstanceFileEntry): string {
    return entry.directory ? "folder" : "file";
  }

  private applyListing(payload: InstanceFilesResponse): void {
    this.currentMount = payload.mount?.id || this.currentMount;
    this.currentPath = payload.path || "";
    this.parentPath = payload.parent || null;
    this.mounts = payload.mounts || [];
    this.entries = payload.entries || [];
    this.error = payload.ok === false ? "file_browser_error" : "";
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object") {
      const record = error as { error?: unknown; message?: unknown; status?: unknown; statusText?: unknown };
      if (record.error && typeof record.error === "object" && "error" in record.error) {
        const detail = (record.error as { error?: unknown }).error;
        if (detail) return String(detail);
      }
      if (record.message) return String(record.message);
      if (record.status) return `HTTP ${record.status}${record.statusText ? ` ${record.statusText}` : ""}`;
    }
    return String(error || "Unknown error");
  }
}
