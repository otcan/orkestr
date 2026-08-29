import {
  clean,
  graphEmailConfig,
  graphEmailConfigured,
  mailProvider,
  sendEmail,
  smtpEmailConfig,
  splitEmailList,
} from "./email-notifications.js";

export function projectInquiryNotificationConfig(env = process.env) {
  const recipients = splitEmailList(
    env.ORKESTR_PROJECT_DISCOVERY_NOTIFY_EMAILS ||
    env.ORKESTR_PROJECT_DISCOVERY_NOTIFY_EMAIL ||
    env.ORKESTR_WORKFLOW_PILOT_NOTIFY_EMAILS ||
    env.ORKESTR_WORKFLOW_PILOT_NOTIFY_EMAIL ||
    env.ORKESTR_WAITLIST_NOTIFY_EMAILS ||
    env.ORKESTR_WAITLIST_NOTIFY_EMAIL,
  );
  const provider = mailProvider(env);
  const mail = provider === "graph" ? graphEmailConfig(env) : smtpEmailConfig(env);
  return {
    configured: provider === "graph"
      ? Boolean(recipients.length && mail.from && graphEmailConfigured(env))
      : Boolean(recipients.length && mail.host && mail.from),
    provider,
    recipients,
    from: mail.from,
  };
}

export async function sendProjectInquiryNotification(inquiry = {}, env = process.env) {
  const config = projectInquiryNotificationConfig(env);
  if (!config.configured) {
    return { ok: false, configured: false, skippedReason: "project_discovery_email_not_configured", recipients: config.recipients };
  }
  const lines = [
    "A new Orkestr Project Discovery inquiry was submitted.",
    "",
    `Intake: ${clean(inquiry.intakeMode) || "detailed"}`,
    `Contact: ${clean(inquiry.contactName)} <${clean(inquiry.workEmail)}>`,
    `Company / role: ${clean(inquiry.company)} / ${clean(inquiry.role)}`,
    `Project type: ${clean(inquiry.projectType)}`,
    `Project: ${clean(inquiry.projectName)}`,
    `Desired outcome: ${clean(inquiry.desiredOutcome)}`,
    `Current situation: ${clean(inquiry.currentSituation)}`,
    `Users / volume: ${clean(inquiry.usersAndVolume)}`,
    `Systems / sources: ${clean(inquiry.systemsOrSources)}`,
    `Decision owner: ${clean(inquiry.decisionOwner)}`,
    `Constraints: ${clean(inquiry.constraints)}`,
    `Success criteria: ${clean(inquiry.successCriteria)}`,
    `Timeframe: ${clean(inquiry.timeframe)}`,
    `Discovery readiness: ${inquiry.readiness?.ready ? "ready" : "review required"}`,
    `Submitted: ${clean(inquiry.createdAt)}`,
    `Inquiry ID: ${clean(inquiry.id)}`,
    "",
    "Review the stored inquiry in the private Orkestr deployment. Do not copy its contents into the public repository or public issue tracker.",
  ];
  const sent = await sendEmail({
    to: config.recipients,
    from: config.from,
    subject: `Orkestr Project Discovery: ${clean(inquiry.company) || "new company"} · ${clean(inquiry.projectName) || "project"}`,
    text: lines.join("\n"),
  }, env);
  return { ...sent, recipients: config.recipients };
}
