// Error details that are safe to persist in diagnostics: the error class, a
// code only when it is a plain machine code, and an opaque id that can be
// handed to the client for correlation. Raw messages are never kept, since
// they can contain request content or other private data.
import { randomBytes } from "node:crypto";

const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/;
const SNAKE_CODE = /^[a-z][a-z0-9_]{2,63}$/;

export function safeErrorDiagnostics(error) {
  const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : typeof error;
  const rawCode = typeof error?.code === "string" || typeof error?.code === "number" ? String(error.code) : "";
  const message = typeof error?.message === "string" ? error.message : "";
  const errorCode = CODE_PATTERN.test(rawCode) ? rawCode : SNAKE_CODE.test(message) ? message : null;
  return { errorClass: name, errorCode, errorId: `err_${randomBytes(8).toString("hex")}` };
}
