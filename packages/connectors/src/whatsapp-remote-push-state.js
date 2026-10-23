const watches = new Map();
const key = (env, id) => `${env.ORKESTR_HOME || ''}:${id}`;
export function noteRemotePushWatch(id, env = process.env) {
  watches.set(key(env, id), Date.now() + 60000);
}
export function remoteBackendHasPushWatch(id, env = process.env) {
  return (watches.get(key(env, id)) || 0) > Date.now();
}
