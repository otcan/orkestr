export const threadUiBoundaryComponents = [
  "ThreadSidebarComponent",
  "ChatViewComponent",
  "ComposerComponent",
  "RuntimeStatusBarComponent",
  "ThreadSettingsComponent",
  "WorkersTreeComponent",
  "GitStatusBadgeComponent",
  "WhatsAppBindingPanel",
] as const;

export type ThreadUiBoundaryComponent = typeof threadUiBoundaryComponents[number];
