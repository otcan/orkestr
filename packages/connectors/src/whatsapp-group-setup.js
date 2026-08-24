function clean(value) {
  return String(value || "").trim();
}

function retryDelaysMs(env = process.env) {
  const configured = clean(env.ORKESTR_WHATSAPP_GROUP_SETUP_RETRY_DELAYS_MS);
  const values = (configured || "0,300,900,1800")
    .split(/[\s,]+/g)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .slice(0, 10);
  return values.length ? values : [0];
}

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retrySetupOperation(operation, accepts, env = process.env) {
  const delays = retryDelaysMs(env);
  let lastResult = null;
  let lastError = null;
  for (let index = 0; index < delays.length; index += 1) {
    await delay(delays[index]);
    try {
      lastResult = await operation();
      lastError = null;
      if (accepts(lastResult)) return { ...lastResult, attemptCount: index + 1 };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    ...(lastResult && typeof lastResult === "object" ? lastResult : {}),
    ok: false,
    attemptCount: delays.length,
    error: clean(lastError?.message || lastError || lastResult?.error) || "whatsapp_group_setup_incomplete",
  };
}

export async function provisionWhatsAppGroupSetup({
  adminParticipantIds = [],
  generatePicture = true,
  promoteAdmins,
  setPicture,
} = {}, env = process.env) {
  const admins = Array.isArray(adminParticipantIds) ? adminParticipantIds.filter(Boolean) : [];
  const adminPromotion = admins.length && typeof promoteAdmins === "function"
    ? await retrySetupOperation(
        () => promoteAdmins(admins),
        (result) => result?.ok === true,
        env,
      )
    : null;
  const picture = generatePicture && typeof setPicture === "function"
    ? await retrySetupOperation(
        () => setPicture(),
        (result) => result?.updated === true,
        env,
      )
    : null;
  return {
    ok: (!adminPromotion || adminPromotion.ok === true) && (!picture || picture.updated === true),
    adminPromotion,
    picture,
  };
}
