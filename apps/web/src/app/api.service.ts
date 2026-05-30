import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { Observable } from "rxjs";

export interface HealthResponse {
  ok: boolean;
  name: string;
  generatedAt: string;
}

export interface VersionResponse {
  name: string;
  version: string;
  commit?: string;
  branch?: string;
  generatedAt: string;
}

export interface ConnectorStatus {
  id: string;
  label: string;
  state: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface CodexAppServerStatus {
  ok: boolean;
  available?: boolean;
  command?: string;
  codexHome?: string;
  runtimeKind?: string;
  transport?: string;
  error?: string;
}

export interface CodexStoredThread {
  id: string;
  sessionId?: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  status?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export interface BrowserSession {
  id?: string;
  slug?: string;
  label?: string;
  type?: string;
  access?: string;
  status?: string;
  state?: string;
  purpose?: string;
  notes?: string;
  url?: string | null;
  desk_url?: string | null;
  cdp_url?: string | null;
  cdp_ok?: boolean | null;
  owner_service?: string | null;
  ownerUserId?: string | null;
  scope?: string | null;
  scopeLabel?: string | null;
  personal?: boolean;
  root_pid?: number | null;
  uptime?: string | null;
  profileDir?: string;
  profile?: string;
  profile_path?: string;
  configured?: boolean;
  control?: Record<string, boolean>;
  safe_cleanup?: boolean;
  launchDisabled?: boolean;
  launchError?: string | null;
  preparedAt?: string | null;
  lastOpenedAt?: string | null;
  stoppedAt?: string | null;
  cleanedAt?: string | null;
  debugPort?: number | null;
  lease?: Record<string, unknown> | null;
  leased?: boolean;
  leaseOwnerThreadId?: string | null;
  leaseOwnerLabel?: string | null;
  relatedThreads?: Array<Record<string, unknown>>;
  relatedThreadCount?: number;
}

export interface DesktopShareResponse {
  ok: boolean;
  url: string;
  subdomain?: string;
  wildcardSubdomainConfigured?: boolean;
  share?: {
    id?: string;
    desktopSlug?: string;
    ownerUserId?: string;
    status?: string;
    expiresAt?: string;
  };
}

export interface DesktopLeaseRecord {
  id?: string;
  desktopSlug?: string;
  ownerUserId?: string;
  threadId?: string;
  threadName?: string | null;
  mode?: string;
  purpose?: string | null;
  active?: boolean;
  stale?: boolean;
  expired?: boolean;
  stealable?: boolean;
  heartbeatAt?: string | null;
  acquiredAt?: string | null;
  expiresAt?: string | null;
  releasedAt?: string | null;
  ownerThreadLabel?: string | null;
  ownerThreadState?: string | null;
  [key: string]: unknown;
}

export interface WorkspaceFolderEntry {
  name: string;
  path: string;
  hidden?: boolean;
  type?: string;
  directory?: boolean;
  size?: number | null;
  modifiedAt?: string | null;
}

export interface WorkspaceFoldersResponse {
  ok: boolean;
  error?: string;
  path: string;
  parent?: string | null;
  roots: WorkspaceFolderEntry[];
  entries: WorkspaceFolderEntry[];
}

export interface FileBrowserResponse extends WorkspaceFoldersResponse {}

export interface SystemDoctorCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "error" | string;
  summary: string;
  severity?: string;
  repair?: string;
  command?: string;
  path?: string;
}

export interface SystemDoctorResponse {
  ok: boolean;
  status: string;
  summary: string;
  generatedAt: string;
  counts?: {
    total?: number;
    ok?: number;
    warnings?: number;
    errors?: number;
  };
  checks?: SystemDoctorCheck[];
  issues?: Array<Record<string, string>>;
  paths?: Record<string, string>;
}

export interface SetupStatus {
  setupState: string;
  home: string;
  connectors: ConnectorStatus[];
  config?: Record<string, Record<string, string>>;
  whatsappDefaults?: {
    chatNamePrefix?: string;
    replyPrefix?: string;
  };
  auth?: AuthStatus;
  overlay?: {
    configured?: boolean;
    valid?: boolean;
  };
  security?: SecurityStatus;
}

export interface StateBackupRecord {
  name: string;
  path: string;
  size: number;
  createdAt?: string;
  modifiedAt?: string;
}

export interface CodexMigrationResponse {
  ok?: boolean;
  dryRun?: boolean;
  migrated?: number;
  counts?: Record<string, number>;
  actions?: Array<Record<string, unknown>>;
  error?: string;
  [key: string]: unknown;
}

export interface BackupStatusResponse {
  ok: boolean;
  home: string;
  backupDir: string;
  backupCount: number;
  latestBackup?: StateBackupRecord | null;
  backups: StateBackupRecord[];
  excludes?: string[];
  restoreSupported?: string;
  migration?: {
    codexAppServer?: {
      available?: boolean;
      dryRunSupported?: boolean;
      apiPath?: string;
      command?: string;
      dryRun?: CodexMigrationResponse;
    };
  };
  generatedAt?: string;
}

export interface BackupCreateResponse {
  ok: boolean;
  backup: StateBackupRecord;
  warning?: string;
  status: BackupStatusResponse;
}

export interface BackupRestorePlanResponse {
  ok: boolean;
  executable: boolean;
  reason?: string;
  backup: StateBackupRecord;
  home: string;
  serviceName: string;
  commands: string[];
  generatedAt?: string;
}

export interface AuthStatus {
  provider?: string;
  configured?: boolean;
  summary?: string;
  login?: {
    passwordless?: boolean;
    emailRequired?: boolean;
    emailUnique?: boolean;
    phoneRequired?: boolean;
    phoneUnique?: boolean;
    requiredFactors?: string[];
  };
  keycloak?: {
    issuer?: string;
    realm?: string;
    clientId?: string;
    accountUrl?: string;
    adminUrl?: string;
    requiredActions?: string[];
  };
  mail?: {
    provider?: string;
    configured?: boolean;
    host?: string;
    user?: string;
    from?: string;
    note?: string;
  };
  storage?: {
    genericIdentityLinks?: boolean;
    perUserHome?: boolean;
    note?: string;
  };
}

export interface SecurityStatus {
  bindHost?: string;
  bindLocal?: boolean;
  proxyLocalBind?: boolean;
  externallyLocal?: boolean;
  authEnabled?: boolean;
  authRequired?: boolean;
  paired?: boolean;
  sessionCount?: number;
  challengeActive?: boolean;
  pendingChallengeCount?: number;
  remoteReady?: boolean;
  warnings?: string[];
  https?: {
    configured?: boolean;
    url?: string;
  };
  caddy?: {
    installed?: boolean;
    configured?: boolean;
    version?: string;
    error?: string;
  };
  mtls?: {
    enabled?: boolean;
    configured?: boolean;
    mode?: string;
    caConfigured?: boolean;
  };
  tailscale?: {
    installed?: boolean;
    configured?: boolean;
    version?: string;
    error?: string;
  };
}

export interface ConnectorConfigResponse {
  config: Record<string, string>;
}

export interface SecurityChallengeResponse {
  ok: boolean;
  challengeId: string;
  expiresAt: string;
  challenge?: SecurityChallenge;
}

export interface SecurityChallengeStatusResponse {
  ok: boolean;
  challenge: SecurityChallenge;
}

export interface SecurityChallengeListResponse {
  challenges: SecurityChallenge[];
}

export interface SecuritySessionListResponse {
  sessions: SecuritySession[];
}

export interface SecurityChallenge {
  id: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  userId?: string;
  role?: string;
  requestedUserAgent?: string;
  requestedIp?: string;
  approvedAt?: string;
  approvedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  consumedAt?: string;
}

export interface SecuritySession {
  id: string;
  challengeId?: string;
  userId?: string;
  role?: string;
  userAgent?: string;
  createdAt?: string;
  lastAccessedAt?: string;
  lastIp?: string;
  expiresAt?: string;
}

export interface SecurityPairResponse {
  ok: boolean;
  security: SecurityStatus;
  session?: {
    id: string;
    expiresAt: string;
  };
}

export interface GmailOAuthStartResponse {
  authorizeUrl: string;
  state?: string;
  redirectUri?: string;
}

export interface OutlookOAuthStartResponse {
  ok: boolean;
  provider: string;
  state: string;
  pendingId: string;
  account?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  message?: string;
  interval?: number;
  expiresAt?: number;
  scopes?: string[];
}

export interface OutlookOAuthPollResponse {
  ok: boolean;
  provider?: string;
  state: string;
  pendingId?: string;
  account?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  message?: string;
  interval?: number;
  expiresAt?: number;
}

export interface UserGmailOAuthStartResponse extends GmailOAuthStartResponse {
  ok?: boolean;
  userId?: string;
  identities?: UserIdentity[];
}

export interface UserOutlookOAuthStartResponse extends OutlookOAuthStartResponse {
  userId?: string;
  identities?: UserIdentity[];
}

export interface ConnectorActionResponse {
  ok?: boolean;
  connector?: string;
  action?: string;
  authorizeUrl?: string;
  auth_url?: string;
  url?: string;
  state?: string;
  message?: string;
  raw?: string;
}

export interface GmailMessageListResponse {
  messages: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  text?: string;
}

export interface GmailMessageResponse {
  message: GmailMessage;
}

export interface CodexDeviceAuthResponse {
  ok: boolean;
  state: string;
  command: string;
  codexHome: string;
  authUrl: string;
  code: string;
  expiresAt: string;
  startedAt: string;
  message?: string;
}

export interface CodexApiKeyLoginResponse {
  ok: boolean;
  state: string;
  command: string;
  codexHome: string;
  authMode: string;
  message?: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  tagline: string;
  connectors: string[];
  defaultTimer: {
    label: string;
    cadence: string;
    time: string;
  };
}

export interface Agent {
  id: string;
  name: string;
  state: string;
  connectors: string[];
}

export interface AgentMessage {
  id: string;
  role: string;
  state: string;
  text: string;
  promptFile?: string;
}

export interface AgentWithMessages extends Agent {
  messages: AgentMessage[];
}

export interface TimerRecord {
  id: string;
  label: string;
  target: string;
  targetType?: string;
  threadId?: string;
  cadence: string;
  nextRunAt: string;
  time?: string;
  every?: string | null;
  prompt?: string;
  promptFile?: string;
  enabled?: boolean;
  createdAt?: string;
}

export interface TimerDoctorIssue {
  severity: string;
  code: string;
  message: string;
  timerId?: string | null;
  timerLabel?: string | null;
  target?: string | null;
  targetType?: string | null;
  details?: Record<string, unknown>;
}

export interface TimerDoctorResponse {
  ok: boolean;
  status: string;
  summary: string;
  generatedAt: string;
  storePath?: string;
  storeExists?: boolean;
  counts?: Record<string, number>;
  issues: TimerDoctorIssue[];
}

export interface EventRecord {
  ts?: string;
  type: string;
  [key: string]: unknown;
}

export interface ThreadSummary {
  id: string;
  name?: string;
  title?: string;
  bindingName?: string;
  state?: string;
  status?: string;
  publicStatus?: string;
  publicStatusCode?: string;
  promptReady?: boolean;
  working?: boolean;
  typingActive?: boolean;
  backgroundWork?: boolean;
  pendingCount?: number;
  runningCount?: number;
  awaitingAckCount?: number;
  nextDeliveryAttemptAt?: string | null;
  progress?: {
    stateHint?: string | null;
    summary?: string | null;
    tailLines?: string[];
    tailHash?: string | null;
    capturedAt?: string | null;
    promptReady?: boolean;
    working?: boolean;
    codexMode?: string | null;
    planImplementationReady?: boolean;
    planImplementationMenuVisible?: boolean;
  } | null;
  progressSummary?: string | null;
  progressStateHint?: string | null;
  progressTailLines?: string[];
  progressCapturedAt?: string | null;
  activeRuntimeLeaseId?: string | null;
  hibernated?: boolean;
  lastError?: string | null;
  parentThreadId?: string | null;
  rootThreadId?: string | null;
  workerIndex?: number | null;
  workerLabel?: string | null;
  workerStatus?: string | null;
  repoPath?: string | null;
  repoRemoteUrl?: string | null;
  remoteBranch?: string | null;
  baseBranch?: string | null;
  branchName?: string | null;
  baseCommit?: string | null;
  gitAhead?: number | null;
  gitBehind?: number | null;
  gitBaseAhead?: number | null;
  gitChangedFiles?: number | null;
  gitParentHead?: string | null;
  gitParentAhead?: number | null;
  gitParentBehind?: number | null;
  gitParentChangedFiles?: number | null;
  gitRemoteAhead?: number | null;
  gitRemoteBehind?: number | null;
  gitRemoteChangedFiles?: number | null;
  gitDirtyFiles?: number | null;
  gitComparisonBase?: string | null;
  gitComparisonLabel?: string | null;
  gitRemoteBranchExists?: boolean | null;
  gitRemoteMissing?: boolean | null;
  worktreePath?: string | null;
  sourceDirty?: boolean;
  forkedFromCodexThreadId?: string | null;
  lastActivityAt?: string;
  lastMessageAt?: string | null;
  lastMessageRole?: string | null;
  lastMessagePhase?: string | null;
  lastMessageState?: string | null;
  lastMessageDeliveryState?: string | null;
  lastMessageError?: string | null;
  threadUpdatedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  sessionName?: string | null;
  paneId?: string | null;
  tmuxTarget?: string | null;
  runtimeKind?: string | null;
  threadId?: string;
  codexThreadId?: string | null;
  codexSessionId?: string | null;
  codexStatus?: Record<string, unknown> | null;
  activeTurnId?: string | null;
  importedFromCodex?: boolean;
  migrationRequired?: boolean;
  codexMode?: "code" | "plan" | string | null;
  codexModeLive?: "code" | "plan" | string | null;
  codexModeLabel?: string | null;
  codexModeSource?: string | null;
  planAvailable?: boolean;
  planImplementationReady?: boolean;
  planImplementationMenuVisible?: boolean;
  codexReasoningEffort?: string | null;
  codexModel?: string | null;
  codexModelProvider?: string | null;
  codexContextWindow?: number | null;
  codexTokenUsage?: Record<string, number> | null;
  codexTotalTokenUsage?: Record<string, number> | null;
  codexRateLimits?: {
    primary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
    secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
    plan_type?: string | null;
    rate_limit_reached_type?: string | null;
  } | null;
  desiredCodexMode?: "code" | "plan" | string | null;
  binding?: {
    connector?: string;
    chatId?: string;
    displayName?: string;
    avatarUrl?: string;
    iconUrl?: string;
    pictureUrl?: string;
    photoUrl?: string;
    profilePicUrl?: string;
    enabled?: boolean;
    allowOtherPeople?: boolean;
    additionalParticipantsEnabled?: boolean;
    additionalParticipantIds?: string[];
    additionalParticipantLabels?: Record<string, string>;
    mirrorToWhatsApp?: boolean;
    senderAccountId?: string | null;
    inboundAccountId?: string | null;
    responderAccountId?: string | null;
    outboundAccountId?: string | null;
    senderContactId?: string | null;
    responderContactId?: string | null;
    generated?: boolean;
    replyPrefix?: string;
  } | null;
  runtime?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ThreadMessage {
  id: string;
  role: string;
  source?: string;
  text?: string;
  promptFile?: string;
  createdAt?: string;
  timestamp?: string;
  state?: string;
  deliveryState?: string;
  phase?: string;
  cursor?: number;
  attachments?: Array<Record<string, unknown>>;
  error?: string;
  [key: string]: unknown;
}

export interface ThreadMessagesResponse {
  thread?: ThreadSummary;
  messages: ThreadMessage[];
  cursor?: number;
  currentCursor?: number;
  count?: number;
  state?: string;
}

export interface ThreadHistoryResponse {
  thread?: ThreadSummary;
  messages: ThreadMessage[];
  count?: number;
  updatedAt?: string | null;
}

export interface ThreadRuntimeResponse {
  thread?: ThreadSummary;
  runtime?: Record<string, unknown>;
}

export interface ThreadAttachResponse {
  ok: boolean;
  state?: string;
  thread?: ThreadSummary;
  runtime?: Record<string, unknown>;
  attachKind?: string;
  attachCommand?: string;
  launched?: boolean;
  terminal?: Record<string, unknown>;
  message?: string;
}

export interface ThreadUploadResponse {
  attachments: Array<Record<string, unknown>>;
}

export interface ThreadInputResponse {
  ok?: boolean;
  message?: ThreadMessage;
  queued?: boolean;
  deliveryState?: string;
  state?: string;
  observed?: boolean;
  observedVia?: string;
  [key: string]: unknown;
}

export interface ThreadWorkerResponse {
  parent?: ThreadSummary;
  thread?: ThreadSummary;
  worker: ThreadSummary;
  message?: ThreadMessage;
  repoPath?: string;
  worktreePath?: string;
  branchName?: string;
  remoteBranch?: string;
  baseBranch?: string;
  baseCommit?: string;
  gitAhead?: number | null;
  gitBehind?: number | null;
  gitBaseAhead?: number | null;
  gitChangedFiles?: number | null;
  gitParentHead?: string | null;
  gitParentAhead?: number | null;
  gitParentBehind?: number | null;
  gitParentChangedFiles?: number | null;
  gitRemoteAhead?: number | null;
  gitRemoteBehind?: number | null;
  gitRemoteChangedFiles?: number | null;
  gitDirtyFiles?: number | null;
  gitComparisonBase?: string | null;
  gitComparisonLabel?: string | null;
  gitRemoteBranchExists?: boolean | null;
  gitRemoteMissing?: boolean | null;
  sourceDirty?: boolean;
}

export interface ThreadSyncResponse {
  synced?: boolean;
  reason?: string;
  thread?: ThreadSummary;
  gitState?: Record<string, unknown>;
}

export interface ThreadRepoResponse {
  thread: ThreadSummary;
  repo?: {
    repoPath?: string | null;
    repoRemoteUrl?: string | null;
    remoteBranch?: string | null;
    branchName?: string | null;
    baseBranch?: string | null;
    baseCommit?: string | null;
    gitAhead?: number | null;
    gitBehind?: number | null;
    gitBaseAhead?: number | null;
    gitChangedFiles?: number | null;
    gitParentHead?: string | null;
    gitParentAhead?: number | null;
    gitParentBehind?: number | null;
    gitParentChangedFiles?: number | null;
    gitRemoteAhead?: number | null;
    gitRemoteBehind?: number | null;
    gitRemoteChangedFiles?: number | null;
    gitDirtyFiles?: number | null;
    gitComparisonBase?: string | null;
    gitComparisonLabel?: string | null;
    gitRemoteBranchExists?: boolean | null;
    gitRemoteMissing?: boolean | null;
    sourceDirty?: boolean;
  };
  detected?: Record<string, unknown>;
}

export interface ThreadBindingResponse {
  ok: boolean;
  thread: ThreadSummary;
  binding: NonNullable<ThreadSummary["binding"]>;
}

export interface WhatsAppAccount {
  accountId?: string;
  id?: string;
  label?: string;
  name?: string;
  state?: string;
  ready?: boolean;
  qrUrl?: string;
  [key: string]: unknown;
}

export interface WhatsAppChat {
  id: string;
  name?: string;
  isGroup?: boolean;
  unreadCount?: number;
  timestamp?: string | null;
  [key: string]: unknown;
}

export interface WhatsAppStatusResponse {
  state?: string;
  summary?: string;
  mode?: string;
  bridgeUrl?: string;
  qrAvailable?: boolean;
  qrUrl?: string;
  accounts?: WhatsAppAccount[];
  health?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface WhatsAppChatsResponse {
  accountId: string;
  state?: string;
  ready?: boolean;
  chats: WhatsAppChat[];
}

export interface WhatsAppChatCreateResponse {
  ok: boolean;
  chat: WhatsAppChat;
  senderAccountId?: string;
  responderAccountId?: string;
  senderContactId?: string;
  responderContactId?: string;
  participantIds?: string[];
  adminParticipantIds?: string[];
  adminPromotion?: Record<string, unknown> | null;
}

export interface WhatsAppParticipant {
  id: string;
  name?: string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  [key: string]: unknown;
}

export interface WhatsAppParticipantsResponse {
  accountId: string;
  chatId: string;
  ready?: boolean;
  participants: WhatsAppParticipant[];
}

export interface OrkestrUser {
  id: string;
  role: "admin" | "user" | string;
  displayName: string;
  email?: string;
  phoneNumber?: string;
  authProvider?: string;
  status: "active" | "disabled" | string;
  limits?: {
    maxThreads?: number | null;
    [key: string]: unknown;
  };
  resourceSummary?: {
    threadCount?: number;
    timerCount?: number;
    lastActivityAt?: string;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface UserIdentity {
  provider: string;
  accountId?: string;
  externalId?: string;
  chatId?: string;
  displayName?: string;
  source?: "manual" | "auto" | string;
  linkedAt?: string;
}

export interface UsersResponse {
  users: OrkestrUser[];
  generatedAt?: string;
}

export interface UserResponse {
  ok?: boolean;
  user: OrkestrUser;
}

export interface UserIdentitiesResponse {
  ok?: boolean;
  userId: string;
  identities: UserIdentity[];
}

export interface UserSkill {
  id: string;
  label: string;
  category: string;
  summary?: string;
  enabled: boolean;
  enabledByDefault?: boolean;
  scopes?: string[];
  requiresConnector?: string;
  requiresDesktop?: string;
  updatedAt?: string;
}

export interface UserSkillsResponse {
  userId: string;
  skills: UserSkill[];
  generatedAt?: string;
}

@Injectable({ providedIn: "root" })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly apiBase = this.resolveApiBase();

  private resolveApiBase(): string {
    const baseHref = globalThis.document?.querySelector("base")?.getAttribute("href") || "/";
    const normalized = baseHref.endsWith("/") ? baseHref.slice(0, -1) : baseHref;
    return `${normalized}/api`;
  }

  private api(path: string): string {
    return `${this.apiBase}${path}`;
  }

  threadSummaryStreamUrl(): string {
    const base = globalThis.location?.href || "http://localhost/";
    const url = new URL(this.api("/threads/summary/stream"), base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  health(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>(this.api("/health"));
  }

  version(): Observable<VersionResponse> {
    return this.http.get<VersionResponse>(this.api("/version"));
  }

  setupStatus(): Observable<SetupStatus> {
    return this.http.get<SetupStatus>(this.api("/setup/status"));
  }

  backupStatus(): Observable<BackupStatusResponse> {
    return this.http.get<BackupStatusResponse>(this.api("/setup/backup/status"));
  }

  createBackup(label = ""): Observable<BackupCreateResponse> {
    return this.http.post<BackupCreateResponse>(this.api("/setup/backup/create"), { label });
  }

  backupRestorePlan(backupPath: string): Observable<BackupRestorePlanResponse> {
    return this.http.post<BackupRestorePlanResponse>(this.api("/setup/backup/restore-plan"), { backupPath });
  }

  users(): Observable<UsersResponse> {
    return this.http.get<UsersResponse>(this.api("/users"));
  }

  currentUser(): Observable<UserResponse> {
    return this.http.get<UserResponse>(this.api("/users/me"));
  }

  createUser(body: Record<string, unknown>): Observable<UserResponse> {
    return this.http.post<UserResponse>(this.api("/users"), body);
  }

  updateUser(id: string, body: Record<string, unknown>): Observable<UserResponse> {
    return this.http.patch<UserResponse>(this.api(`/users/${encodeURIComponent(id)}`), body);
  }

  enableUser(id: string): Observable<UserResponse> {
    return this.http.post<UserResponse>(this.api(`/users/${encodeURIComponent(id)}/enable`), {});
  }

  disableUser(id: string): Observable<UserResponse> {
    return this.http.post<UserResponse>(this.api(`/users/${encodeURIComponent(id)}/disable`), {});
  }

  userIdentities(id: string): Observable<UserIdentitiesResponse> {
    return this.http.get<UserIdentitiesResponse>(this.api(`/users/${encodeURIComponent(id)}/identities`));
  }

  linkWhatsAppIdentity(id: string, body: Record<string, unknown>): Observable<UserIdentitiesResponse> {
    return this.http.post<UserIdentitiesResponse>(this.api(`/users/${encodeURIComponent(id)}/identities/whatsapp`), body);
  }

  unlinkWhatsAppIdentity(id: string, body: Record<string, unknown>): Observable<UserIdentitiesResponse> {
    return this.http.post<UserIdentitiesResponse>(this.api(`/users/${encodeURIComponent(id)}/identities/whatsapp/unlink`), body);
  }

  linkMailIdentity(id: string, provider: "gmail" | "outlook" | string, body: Record<string, unknown>): Observable<UserIdentitiesResponse> {
    return this.http.post<UserIdentitiesResponse>(
      this.api(`/users/${encodeURIComponent(id)}/identities/${encodeURIComponent(provider)}`),
      body,
    );
  }

  unlinkMailIdentity(id: string, provider: "gmail" | "outlook" | string, body: Record<string, unknown>): Observable<UserIdentitiesResponse> {
    return this.http.post<UserIdentitiesResponse>(
      this.api(`/users/${encodeURIComponent(id)}/identities/${encodeURIComponent(provider)}/unlink`),
      body,
    );
  }

  currentUserSkills(): Observable<UserSkillsResponse> {
    return this.http.get<UserSkillsResponse>(this.api("/users/me/skills"));
  }

  userSkills(id: string): Observable<UserSkillsResponse> {
    return this.http.get<UserSkillsResponse>(this.api(`/users/${encodeURIComponent(id)}/skills`));
  }

  updateCurrentUserSkill(skillId: string, enabled: boolean): Observable<{ ok: boolean; userId: string; skill: UserSkill }> {
    return this.http.patch<{ ok: boolean; userId: string; skill: UserSkill }>(
      this.api(`/users/me/skills/${encodeURIComponent(skillId)}`),
      { enabled },
    );
  }

  updateUserSkill(id: string, skillId: string, enabled: boolean): Observable<{ ok: boolean; userId: string; skill: UserSkill }> {
    return this.http.patch<{ ok: boolean; userId: string; skill: UserSkill }>(
      this.api(`/users/${encodeURIComponent(id)}/skills/${encodeURIComponent(skillId)}`),
      { enabled },
    );
  }

  startUserGmailOAuth(id: string, body: Record<string, unknown> = {}): Observable<UserGmailOAuthStartResponse> {
    return this.http.post<UserGmailOAuthStartResponse>(
      this.api(`/users/${encodeURIComponent(id)}/connectors/gmail/oauth/start`),
      body,
    );
  }

  startUserOutlookOAuth(id: string, body: Record<string, unknown> = {}): Observable<UserOutlookOAuthStartResponse> {
    return this.http.post<UserOutlookOAuthStartResponse>(
      this.api(`/users/${encodeURIComponent(id)}/connectors/outlook/oauth/start`),
      body,
    );
  }

  createSecurityChallenge(): Observable<SecurityChallengeResponse> {
    return this.http.post<SecurityChallengeResponse>(this.api("/setup/security/challenges"), {});
  }

  createSecurityChallengeForUser(userId: string): Observable<SecurityChallengeResponse> {
    return this.http.post<SecurityChallengeResponse>(this.api("/setup/security/challenges"), { userId });
  }

  securityChallenge(challengeId: string): Observable<SecurityChallengeStatusResponse> {
    return this.http.get<SecurityChallengeStatusResponse>(this.api(`/setup/security/challenges/${encodeURIComponent(challengeId)}`));
  }

  securityChallenges(): Observable<SecurityChallengeListResponse> {
    return this.http.get<SecurityChallengeListResponse>(this.api("/setup/security/challenges"));
  }

  approveSecurityChallenge(challengeId: string): Observable<SecurityChallengeStatusResponse> {
    return this.http.post<SecurityChallengeStatusResponse>(this.api(`/setup/security/challenges/${encodeURIComponent(challengeId)}/approve`), {});
  }

  rejectSecurityChallenge(challengeId: string): Observable<SecurityChallengeStatusResponse> {
    return this.http.post<SecurityChallengeStatusResponse>(this.api(`/setup/security/challenges/${encodeURIComponent(challengeId)}/reject`), {});
  }

  deleteSecurityChallenge(challengeId: string): Observable<{ ok: boolean; deleted: string }> {
    return this.http.delete<{ ok: boolean; deleted: string }>(this.api(`/setup/security/challenges/${encodeURIComponent(challengeId)}`));
  }

  setSecurityPairingEnabled(enabled: boolean): Observable<{ ok: boolean; security: SecurityStatus }> {
    return this.http.post<{ ok: boolean; security: SecurityStatus }>(this.api("/setup/security/enabled"), { enabled });
  }

  securitySessions(): Observable<SecuritySessionListResponse> {
    return this.http.get<SecuritySessionListResponse>(this.api("/setup/security/sessions"));
  }

  revokeSecuritySession(sessionId: string): Observable<{ ok: boolean; revoked: string[] }> {
    return this.http.post<{ ok: boolean; revoked: string[] }>(this.api(`/setup/security/sessions/${encodeURIComponent(sessionId)}/revoke`), {});
  }

  revokeAllSecuritySessions(): Observable<{ ok: boolean; revoked: string[] }> {
    return this.http.post<{ ok: boolean; revoked: string[] }>(this.api("/setup/security/sessions/revoke"), {});
  }

  pairSecurityBrowser(challengeId: string): Observable<SecurityPairResponse> {
    return this.http.post<SecurityPairResponse>(this.api("/setup/security/pair"), { challengeId });
  }

  saveConnectorConfig(id: string, body: Record<string, string>): Observable<ConnectorConfigResponse> {
    return this.http.post<ConnectorConfigResponse>(this.api(`/connectors/${encodeURIComponent(id)}/config`), body);
  }

  testConnector(id: string): Observable<ConnectorStatus> {
    return this.http.post<ConnectorStatus>(this.api(`/connectors/${encodeURIComponent(id)}/test`), {});
  }

  runConnectorAction(id: string, action: string, body: Record<string, unknown> = {}): Observable<ConnectorActionResponse> {
    return this.http.post<ConnectorActionResponse>(
      this.api(`/connectors/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`),
      body,
    );
  }

  startGmailOAuth(account = ""): Observable<GmailOAuthStartResponse> {
    const suffix = account.trim() ? `?account=${encodeURIComponent(account.trim())}` : "";
    return this.http.get<GmailOAuthStartResponse>(this.api(`/connectors/gmail/oauth/start${suffix}`));
  }

  startOutlookOAuth(account = ""): Observable<OutlookOAuthStartResponse> {
    return this.http.post<OutlookOAuthStartResponse>(this.api("/connectors/outlook/oauth/start"), { account });
  }

  pollOutlookOAuth(pendingId: string): Observable<OutlookOAuthPollResponse> {
    return this.http.post<OutlookOAuthPollResponse>(this.api("/connectors/outlook/oauth/poll"), { pendingId });
  }

  gmailMessages(maxResults = 5, query = ""): Observable<GmailMessageListResponse> {
    const params = new URLSearchParams();
    params.set("maxResults", String(maxResults));
    if (query.trim()) params.set("q", query.trim());
    return this.http.get<GmailMessageListResponse>(this.api(`/connectors/gmail/messages?${params.toString()}`));
  }

  gmailMessage(id: string): Observable<GmailMessageResponse> {
    return this.http.get<GmailMessageResponse>(this.api(`/connectors/gmail/messages/${encodeURIComponent(id)}`));
  }

  startCodexDeviceAuth(): Observable<CodexDeviceAuthResponse> {
    return this.http.post<CodexDeviceAuthResponse>(this.api("/connectors/codex/device-auth"), {});
  }

  loginCodexWithApiKey(apiKey = ""): Observable<CodexApiKeyLoginResponse> {
    return this.http.post<CodexApiKeyLoginResponse>(this.api("/connectors/codex/api-key"), { apiKey });
  }

  codexAppServerStatus(): Observable<CodexAppServerStatus> {
    return this.http.get<CodexAppServerStatus>(this.api("/codex/app-server/status"));
  }

  codexThreads(search = ""): Observable<{ threads: CodexStoredThread[]; nextCursor?: string | null }> {
    const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
    return this.http.get<{ threads: CodexStoredThread[]; nextCursor?: string | null }>(this.api(`/codex/threads${query}`));
  }

  importCodexThread(codexThreadId: string): Observable<{ thread: ThreadSummary; imported: boolean }> {
    return this.http.post<{ thread: ThreadSummary; imported: boolean }>(this.api("/codex/threads/import"), { codexThreadId });
  }

  migrateCodexThreads(dryRun = false): Observable<CodexMigrationResponse> {
    return this.http.post<CodexMigrationResponse>(this.api("/codex/migrate"), { dryRun });
  }

  whatsappStatus(): Observable<WhatsAppStatusResponse> {
    return this.http.get<WhatsAppStatusResponse>(this.api("/connectors/whatsapp/status"));
  }

  startWhatsAppAccount(accountId: string): Observable<Record<string, unknown>> {
    return this.http.post<Record<string, unknown>>(
      this.api(`/connectors/whatsapp/bridge/accounts/${encodeURIComponent(accountId)}/start`),
      {},
    );
  }

  logoutWhatsAppAccount(accountId: string): Observable<Record<string, unknown>> {
    return this.http.post<Record<string, unknown>>(
      this.api(`/connectors/whatsapp/bridge/accounts/${encodeURIComponent(accountId)}/logout`),
      {},
    );
  }

  whatsappBridgeChats(accountId: string): Observable<WhatsAppChatsResponse> {
    return this.http.get<WhatsAppChatsResponse>(
      this.api(`/connectors/whatsapp/bridge/accounts/${encodeURIComponent(accountId)}/chats`),
    );
  }

  createWhatsAppBridgeChat(body: Record<string, unknown>): Observable<WhatsAppChatCreateResponse> {
    return this.http.post<WhatsAppChatCreateResponse>(this.api("/connectors/whatsapp/bridge/chats"), body);
  }

  whatsappBridgeChatParticipants(accountId: string, chatId: string): Observable<WhatsAppParticipantsResponse> {
    return this.http.get<WhatsAppParticipantsResponse>(
      this.api(`/connectors/whatsapp/bridge/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}/participants`),
    );
  }

  promoteWhatsAppBridgeChatAdmins(accountId: string, chatId: string, participantIds: string[]): Observable<Record<string, unknown>> {
    return this.http.post<Record<string, unknown>>(
      this.api(`/connectors/whatsapp/bridge/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}/admins`),
      { participantIds },
    );
  }

  agentTemplates(): Observable<{ templates: AgentTemplate[] }> {
    return this.http.get<{ templates: AgentTemplate[] }>(this.api("/agents/templates"));
  }

  createAgentFromTemplate(id: string): Observable<{ agent: Agent }> {
    return this.http.post<{ agent: Agent }>(this.api(`/agents/templates/${encodeURIComponent(id)}`), {});
  }

  agents(): Observable<{ agents: Agent[] }> {
    return this.http.get<{ agents: Agent[] }>(this.api("/agents"));
  }

  agentMessages(id: string): Observable<{ messages: AgentMessage[] }> {
    return this.http.get<{ messages: AgentMessage[] }>(this.api(`/agents/${encodeURIComponent(id)}/messages`));
  }

  queueAgentMessage(id: string, text: string): Observable<{ message: AgentMessage }> {
    return this.http.post<{ message: AgentMessage }>(this.api(`/agents/${encodeURIComponent(id)}/messages`), { text });
  }

  runNextAgentMessage(id: string): Observable<unknown> {
    return this.http.post(this.api(`/agents/${encodeURIComponent(id)}/run-next`), { executorId: "noop" });
  }

  executors(): Observable<{ executors: Array<Record<string, unknown>> }> {
    return this.http.get<{ executors: Array<Record<string, unknown>> }>(this.api("/executors"));
  }

  executions(): Observable<{ executions: Array<Record<string, unknown>> }> {
    return this.http.get<{ executions: Array<Record<string, unknown>> }>(this.api("/executions"));
  }

  timers(): Observable<{ timers: TimerRecord[] }> {
    return this.http.get<{ timers: TimerRecord[] }>(this.api("/timers"));
  }

  timerDoctor(): Observable<TimerDoctorResponse> {
    return this.http.get<TimerDoctorResponse>(this.api("/timers/doctor"));
  }

  createTimer(body: Record<string, string>): Observable<{ timer: TimerRecord }> {
    return this.http.post<{ timer: TimerRecord }>(this.api("/timers"), body);
  }

  runTimer(id: string): Observable<unknown> {
    return this.http.post(this.api(`/timers/${encodeURIComponent(id)}/run`), {});
  }

  deleteTimer(id: string): Observable<unknown> {
    return this.http.delete(this.api(`/timers/${encodeURIComponent(id)}`));
  }

  events(limit = 50): Observable<{ events: EventRecord[] }> {
    return this.http.get<{ events: EventRecord[] }>(this.api(`/events?limit=${limit}`));
  }

  browsers(): Observable<{ browsers: BrowserSession[]; sessions?: BrowserSession[]; source?: string; error?: string; message?: string }> {
    return this.http.get<{ browsers: BrowserSession[]; sessions?: BrowserSession[]; source?: string; error?: string; message?: string }>(this.api("/browsers"));
  }

  runtimeLeases(): Observable<{ leases: Array<Record<string, unknown>>; budget?: Record<string, unknown> }> {
    return this.http.get<{ leases: Array<Record<string, unknown>>; budget?: Record<string, unknown> }>(this.api("/runtime-leases"));
  }

  systemSummary(): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(this.api("/system/summary"));
  }

  systemDoctor(): Observable<SystemDoctorResponse> {
    return this.http.get<SystemDoctorResponse>(this.api("/system/doctor"));
  }

  systemProcesses(sort = "cpu"): Observable<{ count: number; processes: Array<Record<string, unknown>> }> {
    return this.http.get<{ count: number; processes: Array<Record<string, unknown>> }>(this.api(`/system/processes?sort=${encodeURIComponent(sort)}`));
  }

  workspaceFolders(currentPath = ""): Observable<WorkspaceFoldersResponse> {
    const query = currentPath ? `?path=${encodeURIComponent(currentPath)}` : "";
    return this.http.get<WorkspaceFoldersResponse>(this.api(`/system/workspace-folders${query}`));
  }

  files(currentPath = ""): Observable<FileBrowserResponse> {
    const query = currentPath ? `?path=${encodeURIComponent(currentPath)}` : "";
    return this.http.get<FileBrowserResponse>(this.api(`/files${query}`));
  }

  createFileFolder(currentPath: string, name: string): Observable<FileBrowserResponse> {
    return this.http.post<FileBrowserResponse>(this.api("/files/folders"), { path: currentPath, name });
  }

  uploadFiles(currentPath: string, files: File[]): Observable<FileBrowserResponse & { files?: Array<Record<string, unknown>> }> {
    const body = new FormData();
    body.append("path", currentPath || "");
    for (const file of files) body.append("files", file, file.name);
    return this.http.post<FileBrowserResponse & { files?: Array<Record<string, unknown>> }>(this.api("/files/uploads"), body);
  }

  deleteFile(path: string): Observable<FileBrowserResponse> {
    return this.http.delete<FileBrowserResponse>(this.api(`/files?path=${encodeURIComponent(path)}`));
  }

  modelStatus(): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(this.api("/models/status"));
  }

  threads(options: { includeAllUsers?: boolean } = {}): Observable<{ threads: ThreadSummary[] }> {
    const query = options.includeAllUsers ? "?includeAllUsers=true" : "";
    return this.http.get<{ threads: ThreadSummary[] }>(this.api(`/threads${query}`));
  }

  createThread(body: Record<string, unknown>): Observable<{ thread: ThreadSummary }> {
    return this.http.post<{ thread: ThreadSummary }>(this.api("/threads"), body);
  }

  deleteThread(id: string, deleteWorkers = false): Observable<{ ok: boolean; deletedThreads: string[]; deletedCount: number; deletedTimers?: string[] }> {
    const suffix = deleteWorkers ? "?deleteWorkers=true" : "";
    return this.http.delete<{ ok: boolean; deletedThreads: string[]; deletedCount: number; deletedTimers?: string[] }>(
      this.api(`/threads/${encodeURIComponent(id)}${suffix}`),
    );
  }

  threadMessages(id: string, limit = 100): Observable<ThreadMessagesResponse> {
    return this.http.get<ThreadMessagesResponse>(this.api(`/threads/${encodeURIComponent(id)}/messages?limit=${limit}`));
  }

  threadRuntime(id: string): Observable<ThreadSummary> {
    return this.http.get<ThreadSummary>(this.api(`/threads/${encodeURIComponent(id)}/runtime-lite`));
  }

  threadWorkers(id: string): Observable<{ thread?: ThreadSummary; workers: ThreadSummary[] }> {
    return this.http.get<{ thread?: ThreadSummary; workers: ThreadSummary[] }>(this.api(`/threads/${encodeURIComponent(id)}/workers`));
  }

  createThreadWorker(id: string, body: Record<string, unknown>): Observable<ThreadWorkerResponse> {
    return this.http.post<ThreadWorkerResponse>(this.api(`/threads/${encodeURIComponent(id)}/workers`), body);
  }

  updateThreadBinding(id: string, body: Record<string, unknown>): Observable<ThreadBindingResponse> {
    return this.http.put<ThreadBindingResponse>(this.api(`/threads/${encodeURIComponent(id)}/binding`), body);
  }

  updateThreadRepo(id: string, body: Record<string, unknown>): Observable<ThreadRepoResponse> {
    return this.http.put<ThreadRepoResponse>(this.api(`/threads/${encodeURIComponent(id)}/repo`), body);
  }

  detectThreadRepo(id: string): Observable<ThreadRepoResponse> {
    return this.http.post<ThreadRepoResponse>(this.api(`/threads/${encodeURIComponent(id)}/repo/detect`), {});
  }

  syncThreadWithParent(id: string): Observable<ThreadSyncResponse> {
    return this.http.post<ThreadSyncResponse>(this.api(`/threads/${encodeURIComponent(id)}/sync-parent`), {});
  }

  sendThreadInput(id: string, text: string, attachments: Array<Record<string, unknown>> = []): Observable<ThreadInputResponse> {
    const body: Record<string, unknown> = { text, parseCommands: true, controlAllowed: true };
    if (attachments.length) body["attachments"] = attachments;
    return this.http.post<ThreadInputResponse>(this.api(`/threads/${encodeURIComponent(id)}/input`), body);
  }

  wakeThread(id: string): Observable<unknown> {
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/wake`), { reason: "ui_wake" });
  }

  sleepThread(id: string): Observable<unknown> {
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/sleep`), { reason: "ui_sleep", kill: false });
  }

  stopThread(id: string): Observable<unknown> {
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/stop`), { reason: "ui_stop" });
  }

  resumeThread(id: string): Observable<unknown> {
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/resume`), { reason: "ui_resume" });
  }

  recoverThread(id: string): Observable<unknown> {
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/recover`), {});
  }

  interruptThread(id: string, text = "", attachments: Array<Record<string, unknown>> = []): Observable<ThreadInputResponse> {
    const body: Record<string, unknown> = { text };
    if (attachments.length) body["attachments"] = attachments;
    return this.http.post<ThreadInputResponse>(this.api(`/threads/${encodeURIComponent(id)}/interrupt`), body);
  }

  approveThread(id: string, text = "Approved. Proceed."): Observable<unknown> {
    return this.http.post(this.api(`/threads/${encodeURIComponent(id)}/approve`), { text });
  }

  setCodexMode(id: string, mode: "code" | "plan"): Observable<{ thread?: ThreadSummary }> {
    return this.http.post<{ thread?: ThreadSummary }>(this.api(`/threads/${encodeURIComponent(id)}/codex-mode`), { mode });
  }

  threadRuntimeFull(id: string): Observable<ThreadRuntimeResponse> {
    return this.http.get<ThreadRuntimeResponse>(this.api(`/threads/${encodeURIComponent(id)}/runtime`));
  }

  attachThread(id: string): Observable<ThreadAttachResponse> {
    return this.http.post<ThreadAttachResponse>(this.api(`/threads/${encodeURIComponent(id)}/attach`), {});
  }

  threadHistory(id: string): Observable<ThreadHistoryResponse> {
    return this.http.get<ThreadHistoryResponse>(this.api(`/threads/${encodeURIComponent(id)}/history`));
  }

  threadTimers(id: string): Observable<{ timers: TimerRecord[] }> {
    return this.http.get<{ timers: TimerRecord[] }>(this.api(`/threads/${encodeURIComponent(id)}/timers`));
  }

  createThreadTimer(id: string, body: Record<string, string>): Observable<{ timer: TimerRecord }> {
    return this.http.post<{ timer: TimerRecord }>(this.api(`/threads/${encodeURIComponent(id)}/timers`), body);
  }

  deleteThreadTimer(id: string, timerId: string): Observable<unknown> {
    return this.http.delete(this.api(`/threads/${encodeURIComponent(id)}/timers/${encodeURIComponent(timerId)}`));
  }

  uploadThreadFiles(id: string, files: File[]): Observable<ThreadUploadResponse> {
    const body = new FormData();
    for (const file of files) {
      body.append("files", file, file.name);
    }
    return this.http.post<ThreadUploadResponse>(this.api(`/threads/${encodeURIComponent(id)}/uploads`), body);
  }

  browserSessions(): Observable<{ sessions: BrowserSession[]; browsers?: BrowserSession[]; source?: string; error?: string; message?: string }> {
    return this.http.get<{ sessions: BrowserSession[]; browsers?: BrowserSession[]; source?: string; error?: string; message?: string }>(this.api("/browser-sessions"));
  }

  browserAction(slug: string, action: string, body: Record<string, unknown> = {}): Observable<{ browser: BrowserSession }> {
    return this.http.post<{ browser: BrowserSession }>(this.api(`/browser-sessions/${encodeURIComponent(slug)}/${encodeURIComponent(action)}`), body);
  }

  desktopLeases(includeReleased = false): Observable<{ ok: boolean; desktopLeases: DesktopLeaseRecord[]; staleAfterMs?: number; generatedAt?: string }> {
    const query = includeReleased ? "?include=released" : "";
    return this.http.get<{ ok: boolean; desktopLeases: DesktopLeaseRecord[]; staleAfterMs?: number; generatedAt?: string }>(this.api(`/desktops/leases${query}`));
  }

  acquireDesktopLease(slug: string, body: Record<string, unknown>): Observable<{ ok: boolean; lease?: DesktopLeaseRecord }> {
    return this.http.post<{ ok: boolean; lease?: DesktopLeaseRecord }>(this.api(`/desktops/${encodeURIComponent(slug)}/acquire`), body);
  }

  releaseDesktopLease(slug: string, body: Record<string, unknown>): Observable<{ ok: boolean; lease?: DesktopLeaseRecord | null }> {
    return this.http.post<{ ok: boolean; lease?: DesktopLeaseRecord | null }>(this.api(`/desktops/${encodeURIComponent(slug)}/release`), body);
  }

  createDesktopShare(slug: string): Observable<DesktopShareResponse> {
    return this.http.post<DesktopShareResponse>(this.api(`/desktops/${encodeURIComponent(slug)}/share`), {});
  }
}
