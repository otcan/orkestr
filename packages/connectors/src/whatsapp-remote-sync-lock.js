import {createKeyedSerial} from './scoped-relay-serial.js';
const serial = createKeyedSerial();
export const withRemoteThreadSync = (threadId, env, work) =>
  serial(`${env.ORKESTR_HOME || ''}:${threadId}`, work);
