import { Component, OnInit, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { ApiService, UserSkill } from "./api.service";

@Component({
  selector: "ork-user-skills-page",
  templateUrl: "./user-skills-page.component.html",
})
export class UserSkillsPageComponent implements OnInit {
  private readonly api = inject(ApiService);

  busy = false;
  error = "";
  notice = "";
  activeSkillId = "";
  skills: UserSkill[] = [];

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.busy = true;
    try {
      const payload = await firstValueFrom(this.api.currentUserSkills());
      this.skills = payload.skills || [];
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  enabledSkills(): UserSkill[] {
    return this.skills.filter((skill) => skill.enabled === true);
  }

  disabledSkills(): UserSkill[] {
    return this.skills.filter((skill) => skill.enabled !== true);
  }

  async updateSkill(skill: UserSkill, enabled: boolean): Promise<void> {
    if (!skill.id || this.busy) return;
    this.busy = true;
    this.activeSkillId = skill.id;
    try {
      const payload = await firstValueFrom(this.api.updateCurrentUserSkill(skill.id, enabled));
      this.skills = this.skills.map((item) => item.id === skill.id ? { ...item, ...(payload.skill || {}), enabled } : item);
      this.notice = `${skill.label || skill.id} ${enabled ? "enabled" : "disabled"}.`;
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.activeSkillId = "";
      this.busy = false;
    }
  }

  requirementLabel(skill: UserSkill): string {
    const parts = [
      skill.requiresConnector ? `${skill.requiresConnector} connector` : "",
      skill.requiresDesktop ? `${skill.requiresDesktop} desktop` : "",
    ].filter(Boolean);
    return parts.join(" · ") || "No connector required";
  }

  scopeLabel(skill: UserSkill): string {
    return (skill.scopes || []).join(" · ") || "own account";
  }

  skillBusy(skill: UserSkill): boolean {
    return this.busy && (!this.activeSkillId || this.activeSkillId === skill.id);
  }

  skillStateLabel(skill: UserSkill): string {
    return skill.enabled ? "Enabled" : "Available";
  }

  skillStateClass(skill: UserSkill): string {
    return skill.enabled ? "live" : "ready";
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
