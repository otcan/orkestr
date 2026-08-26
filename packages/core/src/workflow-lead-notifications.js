import {
  clean,
  graphEmailConfig,
  graphEmailConfigured,
  mailProvider,
  sendEmail,
  smtpEmailConfig,
  splitEmailList,
} from "./email-notifications.js";

export function workflowLeadNotificationConfig(env = process.env) {
  const recipients = splitEmailList(
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

export async function sendWorkflowLeadNotification(lead = {}, env = process.env) {
  const config = workflowLeadNotificationConfig(env);
  if (!config.configured) {
    return { ok: false, configured: false, skippedReason: "workflow_pilot_email_not_configured", recipients: config.recipients };
  }
  const lines = [
    "A new Orkestr Workflow Pilot map was submitted.",
    "",
    `Contact: ${clean(lead.contactName)} <${clean(lead.workEmail)}>`,
    `Company / role: ${clean(lead.company)} / ${clean(lead.role)}`,
    `Workflow: ${clean(lead.workflowName)}`,
    `Frequency / monthly volume: ${clean(lead.frequency)} / ${Number(lead.monthlyVolume || 0)}`,
    `Systems: ${clean(lead.systems)}`,
    `Owner: ${clean(lead.workflowOwner)}`,
    `Approvals: ${clean(lead.approvals)}`,
    `Current cost or delay: ${clean(lead.costOrDelay)}`,
    `Success criteria: ${clean(lead.successCriteria)}`,
    `Qualification: ${lead.qualification?.qualified ? "qualified" : "review required"}`,
    `Submitted: ${clean(lead.createdAt)}`,
    `Lead ID: ${clean(lead.id)}`,
    "",
    "Review the stored lead in the private Orkestr deployment. Do not copy its contents into the public repository or public issue tracker.",
  ];
  const sent = await sendEmail({
    to: config.recipients,
    from: config.from,
    subject: `Orkestr Workflow Pilot: ${clean(lead.company) || "new company"} · ${clean(lead.workflowName) || "workflow"}`,
    text: lines.join("\n"),
  }, env);
  return { ...sent, recipients: config.recipients };
}
