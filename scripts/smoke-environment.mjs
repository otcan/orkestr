// A disposable smoke server must not inherit production routing, state paths,
// connector credentials or lifecycle settings from the deployment process.
export function isolatedSmokeBaseEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/^(ORKESTR_|WHATSAPP_|WA_|GMAIL_|GOOGLE_|OUTLOOK_|KEYCLOAK_)/.test(name)));
}
