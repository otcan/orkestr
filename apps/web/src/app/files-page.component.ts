import { DatePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, FileBrowserResponse, WorkspaceFolderEntry } from "./api.service";

@Component({
  selector: "ork-files-page",
  imports: [DatePipe, FormsModule],
  templateUrl: "./files-page.component.html",
})
export class FilesPageComponent implements OnInit {
  private readonly api = inject(ApiService);

  busy = false;
  uploadBusy = false;
  deletingPath = "";
  error = "";
  notice = "";
  currentPath = "";
  parentPath: string | null = null;
  roots: WorkspaceFolderEntry[] = [];
  entries: WorkspaceFolderEntry[] = [];
  newFolderName = "";

  ngOnInit(): void {
    void this.loadFiles();
  }

  async loadFiles(path = this.currentPath): Promise<void> {
    this.busy = true;
    try {
      this.applyListing(await firstValueFrom(this.api.files(path)));
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
      this.applyListing(await firstValueFrom(this.api.createFileFolder(this.currentPath, name)));
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
      const result = await firstValueFrom(this.api.uploadFiles(this.currentPath, selected));
      this.applyListing(result);
      this.notice = `${result.files?.length || selected.length} file${selected.length === 1 ? "" : "s"} uploaded.`;
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.uploadBusy = false;
    }
  }

  async deleteEntry(entry: WorkspaceFolderEntry): Promise<void> {
    if (!entry.path || this.deletingPath) return;
    this.deletingPath = entry.path;
    try {
      this.applyListing(await firstValueFrom(this.api.deleteFile(entry.path)));
      this.notice = "Deleted.";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.deletingPath = "";
    }
  }

  openEntry(entry: WorkspaceFolderEntry): void {
    if (!entry.directory || !entry.path) return;
    void this.loadFiles(entry.path);
  }

  openPath(path = ""): void {
    void this.loadFiles(path);
  }

  formatBytes(value: unknown): string {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
    return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
  }

  entryKind(entry: WorkspaceFolderEntry): string {
    return entry.directory ? "folder" : "file";
  }

  private applyListing(payload: FileBrowserResponse): void {
    this.currentPath = payload.path || "";
    this.parentPath = payload.parent || null;
    this.roots = payload.roots || [];
    this.entries = payload.entries || [];
    this.error = payload.ok === false ? payload.error || "file_browser_error" : "";
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
