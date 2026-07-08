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
  tag?: string;
  describe?: string;
  releaseId?: string;
  releaseLabel?: string;
  releaseVersion?: string;
  buildId?: string;
  channel?: string;
  distribution?: {
    kind?: string;
    track?: string;
    repoRole?: string;
    managed?: boolean;
    oss?: boolean;
  };
  distributionKind?: string;
  deploymentTrack?: string;
  repoRole?: string;
  deployedAt?: string;
  generatedAt: string;
}

export interface ReleaseInstanceVersion {
  name?: string;
  version?: string;
  releaseId?: string;
  commit?: string;
  shortCommit?: string;
  branch?: string;
  tag?: string;
  describe?: string;
  channel?: string;
  releaseLabel?: string;
  releaseVersion?: string;
  buildId?: string;
  deployedAt?: string;
  dirty?: boolean;
}

export interface ReleaseInstance {
  id: string;
  displayName?: string;
  kind?: string;
  source?: string;
  sourceId?: string;
  enabled?: boolean;
  status?: string;
  releaseTrainEnabled?: boolean;
  updateStrategy?: string;
  hasDeployCommand?: boolean;
  hasConnectivityCommand?: boolean;
  hasConnectivityRecoveryCommand?: boolean;
  baseUrl?: string;
  healthUrl?: string;
  versionUrl?: string;
  serviceName?: string;
  home?: string;
  deployRoot?: string;
  ref?: string;
  channel?: string;
  labels?: Record<string, string>;
  currentVersion?: ReleaseInstanceVersion | null;
  targetVersion?: ReleaseInstanceVersion | null;
  lastProbe?: {
    ok?: boolean;
    checkedAt?: string;
    latencyMs?: number | null;
    statusCode?: number | null;
    error?: string;
  } | null;
  downtime?: {
    state?: string;
    since?: string;
    lastUpAt?: string | null;
    lastDownAt?: string | null;
    durationSeconds?: number | null;
  } | null;
  lastReachableAt?: string;
  lastUnreachableAt?: string;
  lastError?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface ReleaseInstancesResponse {
  instances: ReleaseInstance[];
  counts?: Record<string, number>;
  generatedAt?: string;
}

export interface ReleaseRolloutResult {
  id?: string;
  displayName?: string;
  kind?: string;
  status?: string;
  reason?: string;
  code?: number;
  signal?: string;
  error?: string;
}

export interface ReleaseRolloutResponse {
  ok?: boolean;
  ref?: string;
  channel?: string;
  dryRun?: boolean;
  execute?: boolean;
  requestedInstanceIds?: string[];
  matchedInstanceIds?: string[];
  counts?: Record<string, number>;
  results?: ReleaseRolloutResult[];
  generatedAt?: string;
}

export interface TenantVmWhatsAppRoute {
  chatId?: string;
  chatName?: string;
  accountId?: string;
  target?: string;
  routeMode?: string;
  targetSource?: string;
  tokenConfigured?: boolean;
  tokenPreview?: string;
  diagnostics?: {
    nextAction?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TenantVm {
  id: string;
  displayName?: string;
  ownerUserId?: string;
  status?: string;
  trust?: {
    enrollmentStatus?: string;
    trustLevel?: string;
    fingerprint?: string;
    reviewedBy?: string;
    enrolledAt?: string;
    trustedAt?: string;
    revokedAt?: string;
    lastReason?: string;
    [key: string]: unknown;
  };
  endpoint?: {
    baseUrl?: string;
    brokerBaseUrl?: string;
    [key: string]: unknown;
  };
  whatsappRoute?: TenantVmWhatsAppRoute | null;
  [key: string]: unknown;
}

export interface TenantVmsResponse {
  tenantVms?: TenantVm[];
  vms?: TenantVm[];
  count?: number;
  generatedAt?: string;
}

export interface WatcherAlert {
  id: string;
  severity?: string;
  source?: string;
  code?: string;
  message?: string;
  status?: string;
  threadId?: string;
  messageId?: string;
  routerTraceId?: string;
  watcherThreadId?: string | null;
  watcherMessageId?: string | null;
  createdAt?: string;
  details?: Record<string, unknown>;
  error?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WatcherAlertsResponse {
  alerts: WatcherAlert[];
  count?: number;
  total?: number;
  updatedAt?: string;
  generatedAt?: string;
}

export interface WatcherAlertActionResponse {
  ok?: boolean;
  action?: string;
  alert?: WatcherAlert;
  message?: Record<string, unknown> | null;
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
  redacted?: boolean;
  urls?: {
    primaryDomain?: string;
    appUrl?: string;
    authUrl?: string;
    connectUrl?: string;
    sameOriginAuth?: boolean;
  };
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
  settings?: Record<string, unknown>;
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
    appUrl?: string;
    authUrl?: string;
    primaryDomain?: string;
  };
  approval?: {
    sshCommand?: string;
    approveCommand?: string;
    sudoApproveCommand?: string;
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

export interface SharedAppPersonMessage {
  id?: string;
  at?: string;
  from?: string;
  text?: string;
  direction?: string;
  channel?: string;
  matched?: boolean;
}

export interface SharedAppPerson {
  id: string;
  name: string;
  profileUrl?: string;
  headline?: string;
  messageCount?: number;
  matchedMessageCount?: number;
  firstMatchAt?: string;
  lastMatchAt?: string;
  lastMessagePreview?: string;
  messageHistory?: SharedAppPersonMessage[];
  currentClassification?: string;
}

export interface SharedAppPayload {
  ok?: boolean;
  app?: {
    id?: string;
    instanceId?: string;
    appSlug?: string;
    appType?: string;
    title?: string;
    description?: string;
  };
  share?: {
    id?: string;
    allowedActionsJson?: string[];
    expiresAt?: string;
  };
  data?: {
    people?: SharedAppPerson[];
    labels?: string[];
    allowedActions?: string[];
    liveSource?: {
      backingSystem?: string;
      queueKey?: string;
      generatedAt?: string;
    };
    paging?: {
      total?: number;
      limit?: number;
      offset?: number;
      hasNext?: boolean;
      status?: string;
      q?: string;
    };
  };
}

export interface SharedAppMessagesResponse {
  ok?: boolean;
  personId?: string;
  messages?: SharedAppPersonMessage[];
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
  approveCode?: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  instanceId?: string;
  userId?: string;
  role?: string;
  shareId?: string;
  appSlug?: string;
  requestedPath?: string;
  allowedActions?: string[];
  authIntent?: Record<string, string>;
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
  instanceId?: string;
  userId?: string;
  role?: string;
  userAgent?: string;
  createdAt?: string;
  lastAccessedAt?: string;
  lastIp?: string;
  allowedActions?: string[];
  authIntent?: Record<string, string>;
  expiresAt?: string;
}

export interface SecurityPairResponse {
  ok: boolean;
  security: SecurityStatus;
  redirectPath?: string;
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

export interface SecureSecretMetadata {
  id: string;
  name: string;
  handle: string;
  scope: "user" | "global" | string;
  ownerUserId?: string | null;
  managedBy?: string;
  setByUserId?: string;
  status?: string;
  configured?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastUsedAt?: string | null;
  usedBy?: string[];
  valueFingerprint?: string | null;
}

export interface SecureSecretListResponse {
  ok: boolean;
  secrets: SecureSecretMetadata[];
}

export interface SecureSecretMutationResponse {
  ok: boolean;
  secret: SecureSecretMetadata;
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
  timezone?: string;
  every?: string | null;
  prompt?: string;
  promptFile?: string;
  requiredDesktop?: string;
  requiredConnector?: string;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
  lastError?: string;
}

export interface AutomationRecord {
  automationId: string;
  rawId: string;
  type: string;
  provider?: string;
  verb?: string;
  object?: string;
  label: string;
  enabled: boolean;
  targetType?: string;
  target?: string;
  schedule?: {
    cadence?: string;
    type?: string;
    time?: string;
    timezone?: string;
    every?: string;
    runAt?: string;
    nextRunAt?: string;
    intervalMs?: number;
  };
  requirements?: {
    desktop?: string;
    connector?: string;
  };
  prompt?: string;
  promptTemplate?: string;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
  lastDeliveredAt?: string;
  lastError?: string;
}

export interface AutomationDoctorIssue {
  severity: string;
  code: string;
  message: string;
  automationId?: string | null;
  automationLabel?: string | null;
  automationType?: string | null;
  target?: string | null;
  targetType?: string | null;
  details?: Record<string, unknown>;
}

export interface AutomationDoctorResponse {
  ok: boolean;
  status: string;
  summary: string;
  generatedAt: string;
  counts?: {
    total?: number;
    enabled?: number;
    paused?: number;
    due?: number;
    errors?: number;
    warnings?: number;
    byType?: Record<string, number>;
  };
  issues: AutomationDoctorIssue[];
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
  actorUserId?: string;
  ownerUserId?: string;
  resourceType?: string;
  action?: string;
  outcome?: string;
  connector?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface EventArchive {
  name: string;
  size: number;
  compressed: boolean;
  createdAt: string;
  modifiedAt: string;
}

export interface EventStorageStatus {
  currentPath: string;
  currentSize: number;
  maxBytes: number;
  maxEventBytes: number;
  archiveCount: number;
  archiveBytes: number;
  latestArchiveAt?: string;
  gzipBacklog: number;
  truncationRecent: boolean;
  archives?: EventArchive[];
}

export interface EventArchivesResponse {
  storage: EventStorageStatus;
  archives: EventArchive[];
}

export interface ThreadSummary {
  id: string;
  ownerUserId?: string;
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
  turnLifecycle?: {
    state?: string;
    active?: boolean;
    running?: boolean;
    queued?: boolean;
    awaitingApproval?: boolean;
    terminal?: boolean;
    typingActive?: boolean;
    sidebarWorking?: boolean;
    activeTurnId?: string | null;
    activeMessageId?: string | null;
    pendingCount?: number;
    runningCount?: number;
    awaitingAckCount?: number;
    updatedAt?: string;
  } | null;
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
  lastMessageCursor?: number | null;
  lastMessageId?: string | null;
  lastMessageRole?: string | null;
  lastMessagePhase?: string | null;
  lastMessageState?: string | null;
  lastMessageDeliveryState?: string | null;
  lastMessageError?: string | null;
  lastMessageRecovered?: boolean;
  threadUpdatedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  sessionName?: string | null;
  paneId?: string | null;
  tmuxTarget?: string | null;
  runtimeKind?: string | null;
  runtimeMode?: "codex-api" | "codex-tmux" | "attached-terminal" | "agent" | "sleeping" | "unknown" | string | null;
  runtimeModeLabel?: string | null;
  runtimeControlPath?: string | null;
  runtimeTransport?: string | null;
  isCodexAppServer?: boolean;
  isCodexTmux?: boolean;
  isAgentRuntime?: boolean;
  terminalAttached?: boolean;
  rawTerminalActive?: boolean;
  paneAvailable?: boolean;
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
    receivingAccountId?: string | null;
    replyAccountId?: string | null;
    bridgeAccountId?: string | null;
    senderAccountId?: string | null;
    inboundAccountId?: string | null;
    responderConnectorAccountId?: string | null;
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
  oldestCursor?: number | null;
  hasMoreBefore?: boolean;
  count?: number;
  since?: number;
  before?: number;
  limit?: number;
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

export interface RouterTracePhase {
  phase: string;
  ts?: string;
  reason?: string;
  error?: string;
  [key: string]: unknown;
}

export interface RouterTraceRecord {
  routerTraceId: string;
  turnId?: string;
  connector?: string;
  accountId?: string;
  chatId?: string;
  sourceEventId?: string;
  threadId?: string;
  messageId?: string;
  currentPhase?: string;
  terminal?: boolean;
  terminalState?: string;
  retryCount?: number;
  lastError?: string;
  ownerProcess?: string;
  createdAt?: string;
  updatedAt?: string;
  phases?: RouterTracePhase[];
  diagnostics?: {
    stuck?: boolean;
    ageMs?: number;
    terminal?: boolean;
    currentPhase?: string;
    recovery?: string;
    lastError?: string;
  };
  [key: string]: unknown;
}

export interface RouterTraceListResponse {
  traces: RouterTraceRecord[];
}

export interface RouterTraceDetailResponse {
  trace: RouterTraceRecord | null;
  turns: Array<Record<string, unknown>>;
  outbox: Array<Record<string, unknown>>;
}

export interface WhatsAppOutboxJob {
  id: string;
  tenantId?: string;
  ownerUserId?: string;
  connector?: string;
  accountId?: string;
  chatId?: string;
  threadId?: string;
  sourceMessageId?: string;
  sourceRevision?: string;
  deliveryType?: string;
  state?: string;
  attemptCount?: number;
  claimedBy?: string;
  claimExpiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
  terminalAt?: string;
  deliveredAt?: string;
  failedAt?: string;
  skippedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WhatsAppOutboxListResponse {
  jobs: WhatsAppOutboxJob[];
  count: number;
  total: number;
  generatedAt?: string;
  filters?: Record<string, unknown>;
}

export interface WhatsAppOutboxActionResponse {
  ok?: boolean;
  action?: string;
  previousState?: string;
  job?: WhatsAppOutboxJob;
  results?: WhatsAppOutboxActionResponse[];
  count?: number;
}

export interface WhatsAppDoctorAccount extends WhatsAppAccount {
  authenticated?: boolean;
  paired?: boolean;
  started?: boolean;
  commsReady?: boolean;
  sendReady?: boolean;
  inboundReady?: boolean;
  autostart?: boolean;
  runtimeAccountId?: string;
  phoneIdentity?: string;
  legacyRoleAliases?: string[];
  pairingPhoneNumber?: string;
  phoneNumber?: string;
  phone?: string;
  number?: string;
  contactId?: string;
  pushName?: string;
  nextAction?: string;
  updatedAt?: string | null;
  error?: string;
}

export interface WhatsAppDoctorBinding {
  id?: string;
  bindingId?: string;
  threadId?: string;
  threadName?: string;
  displayName?: string;
  chatId?: string;
  state?: string;
  reason?: string;
  nextAction?: string;
  enabled?: boolean;
  routeEligible?: boolean;
  mirrorToWhatsApp?: boolean;
  responderAccountId?: string;
  responderConnectorAccountId?: string;
  replyAccountId?: string;
  bridgeAccountId?: string;
  runtimeAccountId?: string;
  authorizedContactIds?: string[];
  accountIds?: string[];
  acl?: {
    send?: { mode?: string; users?: string[] };
    read?: { mode?: string; users?: string[] };
    receive?: { mode?: string; users?: string[] };
    manage?: { mode?: string; users?: string[] };
    [key: string]: unknown;
  };
  updatedAt?: string;
  lastEvaluationAt?: string;
  [key: string]: unknown;
}

export interface WhatsAppDoctorResponse {
  ok?: boolean;
  status?: string;
  summary?: string;
  accountId?: string;
  counts?: Record<string, number>;
  accounts?: WhatsAppDoctorAccount[];
  bindings?: WhatsAppDoctorBinding[];
  checks?: Array<Record<string, unknown>>;
}

export interface ThreadAttachResponse {
  ok: boolean;
  attachable?: boolean;
  watchOnly?: boolean;
  takeoverAvailable?: boolean;
  state?: string;
  thread?: ThreadSummary;
  runtime?: Record<string, unknown>;
  attachKind?: string;
  attachCommand?: string;
  watchText?: string;
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
  runtimeAccountId?: string;
  phoneIdentity?: string;
  phoneNumber?: string;
  contactId?: string;
  legacyRoleAliases?: string[];
  state?: string;
  ready?: boolean;
  qrUrl?: string;
  capabilities?: string[];
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
  receivingAccountId?: string;
  replyAccountId?: string;
  bridgeAccountId?: string;
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

export interface OnboardingProfile {
  displayName?: string;
  timezone?: string;
  locale?: string;
  preferences?: string;
  toolRequests?: string;
  notes?: string;
  updatedAt?: string;
}

export interface UserOnboardingState {
  schemaVersion?: number;
  userId?: string;
  state?: string;
  invite?: Record<string, unknown> | null;
  profile?: OnboardingProfile;
  updatedAt?: string;
}

export interface UserOnboardingResponse {
  ok?: boolean;
  user?: OrkestrUser;
  onboarding: UserOnboardingState;
}

export interface UserIdentitiesResponse {
  ok?: boolean;
  userId: string;
  identities: UserIdentity[];
}

export interface WaitlistNotification {
  state?: "sent" | "skipped" | "failed" | "unknown" | string;
  recipients?: string[];
  sentAt?: string;
  updatedAt?: string;
  error?: string;
  skippedReason?: string;
}

export interface WaitlistEntry {
  id: string;
  displayName: string;
  phoneNumber: string;
  email?: string;
  timezone?: string;
  intendedUse?: string;
  status: "pending" | "contacted" | "approved" | "rejected" | "paused" | string;
  acceptedTerms?: boolean;
  consentToContact?: boolean;
  source?: {
    ip?: string;
    userAgent?: string;
  };
  adminNote?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  notification?: WaitlistNotification | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface WaitlistResponse {
  ok: boolean;
  entries: WaitlistEntry[];
  total: number;
}

export interface WaitlistUpdateResponse {
  ok: boolean;
  entry: WaitlistEntry;
}

export interface WaitlistApproveResponse {
  ok: boolean;
  entry: WaitlistEntry;
  user?: OrkestrUser;
  thread?: ThreadSummary;
  onboarding?: Record<string, unknown>;
  firstPrompt?: string;
  whatsapp?: Record<string, unknown>;
}

export interface UserSkill {
  id: string;
  name?: string;
  label: string;
  category: string;
  description?: string;
  summary?: string;
  instructions?: string;
  enabled: boolean;
  enabledByDefault?: boolean;
  builtIn?: boolean;
  createdBy?: string;
  scopes?: string[];
  requiresConnector?: string;
  requiresDesktop?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface UserSkillsResponse {
  userId: string;
  query?: string;
  skills: UserSkill[];
  generatedAt?: string;
}

export interface CreditUsageRecord {
  id: string;
  tenantId?: string;
  threadId?: string;
  messageId?: string;
  responseId?: string;
  runtimeKind?: string;
  sourceChannel?: string;
  callKind?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  estimatedCostUsd?: number;
  status?: string;
  error?: string;
  createdAt?: string;
}

export interface CreditUsageSummary {
  tenantId?: string | null;
  totalUsd?: number;
  todayUsd?: number;
  monthUsd?: number;
  remainingDailyUsd?: number | null;
  remainingMonthlyUsd?: number | null;
  budget?: {
    dailyUsd?: number | null;
    monthlyUsd?: number | null;
    warningUsd?: number | null;
  };
  byModel?: Record<string, number>;
  count?: number;
  recent?: CreditUsageRecord[];
  generatedAt?: string;
}

export interface CreditUsageResponse {
  usage: CreditUsageSummary;
}

export interface AdminCreditUsageResponse {
  generatedAt?: string;
  tenants: CreditUsageSummary[];
  total: CreditUsageSummary;
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

  private query(params: Record<string, unknown> = {}): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : "";
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

  releaseInstances(probe = true): Observable<ReleaseInstancesResponse> {
    return this.http.get<ReleaseInstancesResponse>(this.api(`/release/instances?probe=${probe ? "1" : "0"}`));
  }

  releaseRollout(body: { ref?: string; channel?: string; instanceIds?: string[]; execute?: boolean; skipLocal?: boolean }): Observable<ReleaseRolloutResponse> {
    return this.http.post<ReleaseRolloutResponse>(this.api("/release/instances/rollout"), body);
  }

  tenantVms(): Observable<TenantVmsResponse> {
    return this.http.get<TenantVmsResponse>(this.api("/tenant-vms"));
  }

  updateTenantVmTrust(tenantVmId: string, body: Record<string, unknown>): Observable<{ ok?: boolean; tenantVm?: TenantVm }> {
    return this.http.post<{ ok?: boolean; tenantVm?: TenantVm }>(
      this.api(`/tenant-vms/${encodeURIComponent(tenantVmId)}/trust`),
      body,
    );
  }

  setupStatus(): Observable<SetupStatus> {
    return this.http.get<SetupStatus>(this.api("/setup/status"));
  }

  saveSetupDemoPreferences(body: Record<string, unknown>): Observable<{ ok: boolean; demo?: Record<string, unknown>; settings?: Record<string, unknown> }> {
    return this.http.post<{ ok: boolean; demo?: Record<string, unknown>; settings?: Record<string, unknown> }>(
      this.api("/setup/demo-preferences"),
      body,
    );
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

  waitlist(status = "", limit = 200): Observable<WaitlistResponse> {
    const params = new URLSearchParams();
    if (status.trim()) params.set("status", status.trim());
    params.set("limit", String(limit));
    return this.http.get<WaitlistResponse>(this.api(`/users/onboarding/waitlist?${params.toString()}`));
  }

  updateWaitlistEntry(id: string, body: Record<string, unknown>): Observable<WaitlistUpdateResponse> {
    return this.http.patch<WaitlistUpdateResponse>(this.api(`/users/onboarding/waitlist/${encodeURIComponent(id)}`), body);
  }

  approveWaitlistEntry(id: string, body: Record<string, unknown>): Observable<WaitlistApproveResponse> {
    return this.http.post<WaitlistApproveResponse>(this.api(`/users/onboarding/waitlist/${encodeURIComponent(id)}/approve`), body);
  }

  currentUser(): Observable<UserResponse> {
    return this.http.get<UserResponse>(this.api("/users/me"));
  }

  myOnboarding(): Observable<UserOnboardingResponse> {
    return this.http.get<UserOnboardingResponse>(this.api("/users/me/onboarding"));
  }

  updateMyOnboardingProfile(profile: OnboardingProfile): Observable<UserOnboardingResponse> {
    return this.http.patch<UserOnboardingResponse>(this.api("/users/me/onboarding"), { profile });
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

  currentUserSkill(skillId: string): Observable<{ ok: boolean; userId: string; skill: UserSkill }> {
    return this.http.get<{ ok: boolean; userId: string; skill: UserSkill }>(
      this.api(`/users/me/skills/${encodeURIComponent(skillId)}`),
    );
  }

  searchCurrentUserSkills(query: string): Observable<UserSkillsResponse> {
    return this.http.get<UserSkillsResponse>(this.api(`/users/me/skills/search?q=${encodeURIComponent(query)}`));
  }

  createCurrentUserSkill(body: Record<string, unknown>): Observable<{ ok: boolean; userId: string; skill: UserSkill }> {
    return this.http.post<{ ok: boolean; userId: string; skill: UserSkill }>(this.api("/users/me/skills"), body);
  }

  updateCurrentUserSkill(skillId: string, enabled: boolean): Observable<{ ok: boolean; userId: string; skill: UserSkill }> {
    return this.http.patch<{ ok: boolean; userId: string; skill: UserSkill }>(
      this.api(`/users/me/skills/${encodeURIComponent(skillId)}`),
      { enabled },
    );
  }

  deleteCurrentUserSkill(skillId: string): Observable<{ ok: boolean; userId: string; skillId: string; deleted?: boolean; disabled?: boolean }> {
    return this.http.delete<{ ok: boolean; userId: string; skillId: string; deleted?: boolean; disabled?: boolean }>(
      this.api(`/users/me/skills/${encodeURIComponent(skillId)}`),
    );
  }

  userSkill(id: string, skillId: string): Observable<{ ok: boolean; userId: string; skill: UserSkill }> {
    return this.http.get<{ ok: boolean; userId: string; skill: UserSkill }>(
      this.api(`/users/${encodeURIComponent(id)}/skills/${encodeURIComponent(skillId)}`),
    );
  }

  searchUserSkills(id: string, query: string): Observable<UserSkillsResponse> {
    return this.http.get<UserSkillsResponse>(this.api(`/users/${encodeURIComponent(id)}/skills/search?q=${encodeURIComponent(query)}`));
  }

  createUserSkill(id: string, body: Record<string, unknown>): Observable<{ ok: boolean; userId: string; skill: UserSkill }> {
    return this.http.post<{ ok: boolean; userId: string; skill: UserSkill }>(
      this.api(`/users/${encodeURIComponent(id)}/skills`),
      body,
    );
  }

  updateUserSkill(id: string, skillId: string, enabled: boolean): Observable<{ ok: boolean; userId: string; skill: UserSkill }> {
    return this.http.patch<{ ok: boolean; userId: string; skill: UserSkill }>(
      this.api(`/users/${encodeURIComponent(id)}/skills/${encodeURIComponent(skillId)}`),
      { enabled },
    );
  }

  deleteUserSkill(id: string, skillId: string): Observable<{ ok: boolean; userId: string; skillId: string; deleted?: boolean; disabled?: boolean }> {
    return this.http.delete<{ ok: boolean; userId: string; skillId: string; deleted?: boolean; disabled?: boolean }>(
      this.api(`/users/${encodeURIComponent(id)}/skills/${encodeURIComponent(skillId)}`),
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

  creditUsage(): Observable<AdminCreditUsageResponse> {
    return this.http.get<AdminCreditUsageResponse>(this.api("/users/credit-usage"));
  }

  userCreditUsage(id: string): Observable<CreditUsageResponse> {
    return this.http.get<CreditUsageResponse>(this.api(`/users/${encodeURIComponent(id)}/credit-usage`));
  }

  myCreditUsage(): Observable<CreditUsageResponse> {
    return this.http.get<CreditUsageResponse>(this.api("/users/me/credit-usage"));
  }

  createSecurityChallenge(instanceId = "", scope: Record<string, unknown> = {}): Observable<SecurityChallengeResponse> {
    return this.http.post<SecurityChallengeResponse>(this.api("/setup/security/challenges"), {
      ...(instanceId ? { instanceId } : {}),
      ...scope,
    });
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

  secureSecrets(options: { scope?: "user" | "global"; userId?: string } = {}): Observable<SecureSecretListResponse> {
    const params = new URLSearchParams();
    if (options.scope) params.set("scope", options.scope);
    if (options.userId?.trim()) params.set("userId", options.userId.trim());
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return this.http.get<SecureSecretListResponse>(this.api(`/secure-input/secrets${suffix}`));
  }

  setSecureSecret(body: { name: string; value: string; scope?: "user" | "global"; userId?: string }): Observable<SecureSecretMutationResponse> {
    return this.http.post<SecureSecretMutationResponse>(this.api("/secure-input/secrets"), body);
  }

  deleteSecureSecret(name: string, options: { scope?: "user" | "global"; userId?: string } = {}): Observable<SecureSecretMutationResponse> {
    const params = new URLSearchParams();
    if (options.scope) params.set("scope", options.scope);
    if (options.userId?.trim()) params.set("userId", options.userId.trim());
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return this.http.delete<SecureSecretMutationResponse>(this.api(`/secure-input/secrets/${encodeURIComponent(name)}${suffix}`));
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

  demoteWhatsAppBridgeChatAdmins(accountId: string, chatId: string, participantIds: string[]): Observable<Record<string, unknown>> {
    return this.http.post<Record<string, unknown>>(
      this.api(`/connectors/whatsapp/bridge/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}/admins/demote`),
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

  automations(): Observable<{ automations: AutomationRecord[] }> {
    return this.http.get<{ automations: AutomationRecord[] }>(this.api("/automations"));
  }

  automationDoctor(): Observable<AutomationDoctorResponse> {
    return this.http.get<AutomationDoctorResponse>(this.api("/automations/doctor"));
  }

  timerDoctor(): Observable<TimerDoctorResponse> {
    return this.http.get<TimerDoctorResponse>(this.api("/timers/doctor"));
  }

  createTimer(body: Record<string, string>): Observable<{ timer: TimerRecord }> {
    return this.http.post<{ timer: TimerRecord }>(this.api("/timers"), body);
  }

  createAutomation(body: Record<string, unknown>): Observable<{ automation: AutomationRecord }> {
    return this.http.post<{ automation: AutomationRecord }>(this.api("/automations"), body);
  }

  updateAutomation(id: string, body: Record<string, unknown>): Observable<{ automation: AutomationRecord }> {
    return this.http.patch<{ automation: AutomationRecord }>(this.api(`/automations/${encodeURIComponent(id)}`), body);
  }

  pauseAutomation(id: string): Observable<{ automation: AutomationRecord }> {
    return this.http.post<{ automation: AutomationRecord }>(this.api(`/automations/${encodeURIComponent(id)}/pause`), {});
  }

  resumeAutomation(id: string): Observable<{ automation: AutomationRecord }> {
    return this.http.post<{ automation: AutomationRecord }>(this.api(`/automations/${encodeURIComponent(id)}/resume`), {});
  }

  runAutomation(id: string): Observable<unknown> {
    return this.http.post(this.api(`/automations/${encodeURIComponent(id)}/run`), {});
  }

  deleteAutomation(id: string): Observable<unknown> {
    return this.http.delete(this.api(`/automations/${encodeURIComponent(id)}`));
  }

  updateTimer(id: string, body: Record<string, unknown>): Observable<{ timer: TimerRecord }> {
    return this.http.patch<{ timer: TimerRecord }>(this.api(`/timers/${encodeURIComponent(id)}`), body);
  }

  pauseTimer(id: string): Observable<{ timer: TimerRecord }> {
    return this.http.post<{ timer: TimerRecord }>(this.api(`/timers/${encodeURIComponent(id)}/pause`), {});
  }

  resumeTimer(id: string): Observable<{ timer: TimerRecord }> {
    return this.http.post<{ timer: TimerRecord }>(this.api(`/timers/${encodeURIComponent(id)}/resume`), {});
  }

  runTimer(id: string): Observable<unknown> {
    return this.http.post(this.api(`/timers/${encodeURIComponent(id)}/run`), {});
  }

  deleteTimer(id: string): Observable<unknown> {
    return this.http.delete(this.api(`/timers/${encodeURIComponent(id)}`));
  }

  events(limit = 50, filters: Record<string, string> = {}): Observable<{ events: EventRecord[] }> {
    const params = new URLSearchParams({ limit: String(limit) });
    for (const [key, value] of Object.entries(filters)) {
      if (String(value || "").trim()) params.set(key, String(value).trim());
    }
    return this.http.get<{ events: EventRecord[] }>(this.api(`/events?${params.toString()}`));
  }

  eventArchives(): Observable<EventArchivesResponse> {
    return this.http.get<EventArchivesResponse>(this.api("/events/archives"));
  }

  rotateEvents(): Observable<{ ok: boolean; rotation: Record<string, unknown>; storage: EventStorageStatus }> {
    return this.http.post<{ ok: boolean; rotation: Record<string, unknown>; storage: EventStorageStatus }>(this.api("/events/rotate"), {});
  }

  eventArchiveDownloadUrl(name: string): string {
    return this.api(`/events/archives/${encodeURIComponent(name)}/download`);
  }

  watcherAlerts(limit = 20): Observable<WatcherAlertsResponse> {
    return this.http.get<WatcherAlertsResponse>(this.api(`/system/alerts?limit=${encodeURIComponent(String(limit))}`));
  }

  watcherAlertAction(alertId: string, action: string, body: Record<string, unknown> = {}): Observable<WatcherAlertActionResponse> {
    return this.http.post<WatcherAlertActionResponse>(this.api(`/system/alerts/${encodeURIComponent(alertId)}/action`), { ...body, action });
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

  threadMessages(
    id: string,
    options: number | { limit?: number; since?: number | null; before?: number | null } = 100,
  ): Observable<ThreadMessagesResponse> {
    const query = new URLSearchParams();
    if (typeof options === "number") {
      query.set("limit", String(options));
    } else {
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      if (options.since !== undefined && options.since !== null) query.set("since", String(options.since));
      if (options.before !== undefined && options.before !== null) query.set("before", String(options.before));
    }
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.http.get<ThreadMessagesResponse>(this.api(`/threads/${encodeURIComponent(id)}/messages${suffix}`));
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

  setRuntimeSurface(id: string, runtime: "api" | "terminal"): Observable<ThreadInputResponse> {
    return this.sendThreadInput(id, `/switch ${runtime}`);
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

  routerTraces(options: { threadId?: string; stuck?: boolean } = {}): Observable<RouterTraceListResponse> {
    const query = new URLSearchParams();
    if (options.threadId) query.set("threadId", options.threadId);
    if (options.stuck) query.set("stuck", "true");
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.http.get<RouterTraceListResponse>(this.api(`/router-traces${suffix}`));
  }

  routerTrace(id: string): Observable<RouterTraceDetailResponse> {
    return this.http.get<RouterTraceDetailResponse>(this.api(`/router-traces/${encodeURIComponent(id)}`));
  }

  whatsappDoctor(): Observable<WhatsAppDoctorResponse> {
    return this.http.get<WhatsAppDoctorResponse>(this.api("/connectors/whatsapp/doctor"));
  }

  whatsappOutbox(options: { threadId?: string; state?: string; accountId?: string; chatId?: string; deliveryType?: string; limit?: number } = {}): Observable<WhatsAppOutboxListResponse> {
    const query = new URLSearchParams();
    if (options.threadId) query.set("threadId", options.threadId);
    if (options.state) query.set("state", options.state);
    if (options.accountId) query.set("accountId", options.accountId);
    if (options.chatId) query.set("chatId", options.chatId);
    if (options.deliveryType) query.set("deliveryType", options.deliveryType);
    if (options.limit) query.set("limit", String(options.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.http.get<WhatsAppOutboxListResponse>(this.api(`/connectors/whatsapp/outbox${suffix}`));
  }

  whatsappOutboxAction(jobId: string, action: string, body: Record<string, unknown> = {}): Observable<WhatsAppOutboxActionResponse> {
    return this.http.post<WhatsAppOutboxActionResponse>(
      this.api(`/connectors/whatsapp/outbox/${encodeURIComponent(jobId)}/${encodeURIComponent(action)}`),
      body,
    );
  }

  updateWhatsAppBinding(bindingId: string, body: Record<string, unknown>): Observable<{ ok?: boolean; binding?: WhatsAppDoctorBinding; thread?: ThreadSummary }> {
    return this.http.put<{ ok?: boolean; binding?: WhatsAppDoctorBinding; thread?: ThreadSummary }>(
      this.api(`/connectors/whatsapp/bindings/${encodeURIComponent(bindingId)}`),
      body,
    );
  }

  attachThread(id: string, body: Record<string, unknown> = {}): Observable<ThreadAttachResponse> {
    return this.http.post<ThreadAttachResponse>(this.api(`/threads/${encodeURIComponent(id)}/attach`), body);
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

  pauseThreadTimer(id: string, timerId: string): Observable<{ timer: TimerRecord }> {
    return this.http.post<{ timer: TimerRecord }>(this.api(`/threads/${encodeURIComponent(id)}/timers/${encodeURIComponent(timerId)}/pause`), {});
  }

  resumeThreadTimer(id: string, timerId: string): Observable<{ timer: TimerRecord }> {
    return this.http.post<{ timer: TimerRecord }>(this.api(`/threads/${encodeURIComponent(id)}/timers/${encodeURIComponent(timerId)}/resume`), {});
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

  sharedApp(instanceId: string, appSlug: string, shareToken: string, params: Record<string, unknown> = {}): Observable<SharedAppPayload> {
    return this.http.get<SharedAppPayload>(this.api(`/shared-apps/i/${encodeURIComponent(instanceId)}/a/${encodeURIComponent(appSlug)}/s/${encodeURIComponent(shareToken)}${this.query(params)}`));
  }

  sharedAppPersonMessages(instanceId: string, appSlug: string, shareToken: string, personId: string): Observable<SharedAppMessagesResponse> {
    return this.http.get<SharedAppMessagesResponse>(
      this.api(`/shared-apps/i/${encodeURIComponent(instanceId)}/a/${encodeURIComponent(appSlug)}/s/${encodeURIComponent(shareToken)}/people/${encodeURIComponent(personId)}/messages`),
    );
  }

  createSharedAppChallenge(instanceId: string, appSlug: string, shareToken: string, body: Record<string, unknown> = {}): Observable<SecurityChallengeResponse> {
    return this.http.post<SecurityChallengeResponse>(
      this.api(`/shared-apps/i/${encodeURIComponent(instanceId)}/a/${encodeURIComponent(appSlug)}/s/${encodeURIComponent(shareToken)}/challenge`),
      body,
    );
  }

  sharedAppChallenge(instanceId: string, appSlug: string, shareToken: string, challengeId: string): Observable<SecurityChallengeStatusResponse> {
    return this.http.get<SecurityChallengeStatusResponse>(
      this.api(`/shared-apps/i/${encodeURIComponent(instanceId)}/a/${encodeURIComponent(appSlug)}/s/${encodeURIComponent(shareToken)}/challenges/${encodeURIComponent(challengeId)}`),
    );
  }

  pairSharedAppBrowser(instanceId: string, appSlug: string, shareToken: string, challengeId: string): Observable<SecurityPairResponse> {
    return this.http.post<SecurityPairResponse>(
      this.api(`/shared-apps/i/${encodeURIComponent(instanceId)}/a/${encodeURIComponent(appSlug)}/s/${encodeURIComponent(shareToken)}/pair`),
      { challengeId },
    );
  }

  sharedAppAction(instanceId: string, appSlug: string, shareToken: string, action: string, body: Record<string, unknown>): Observable<SharedAppPayload> {
    return this.http.post<SharedAppPayload>(
      this.api(`/shared-apps/i/${encodeURIComponent(instanceId)}/a/${encodeURIComponent(appSlug)}/s/${encodeURIComponent(shareToken)}/actions/${encodeURIComponent(action)}`),
      body,
    );
  }
}
