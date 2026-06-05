import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";

export type JsonErrorReporter = (input: {
  exception: unknown;
  statusCode: number;
  message: string;
  request?: unknown;
}) => void;

@Catch()
export class JsonErrorFilter implements ExceptionFilter {
  constructor(private readonly reporter: JsonErrorReporter | null = null) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest();
    const response = host.switchToHttp().getResponse();
    const statusCode = statusForException(exception);
    const message = messageForException(exception);
    if (statusCode >= 500) {
      this.reporter?.({ exception, statusCode, message, request });
    }

    response
      .status(statusCode)
      .header("cache-control", "no-store")
      .type("application/json; charset=utf-8")
      .send({ error: message });
  }
}

function statusForException(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  const value = exception as { statusCode?: unknown; status?: unknown };
  return Number(value?.statusCode || value?.status || 500) || 500;
}

function messageForException(exception: unknown): string {
  if (exception instanceof HttpException) {
    const body = exception.getResponse();
    if (typeof body === "string") return body;
    if (body && typeof body === "object") {
      const value = body as { error?: unknown; message?: unknown };
      if (typeof value.error === "string") return value.error;
      if (typeof value.message === "string") return value.message;
      if (Array.isArray(value.message)) return value.message.join("; ");
    }
  }
  const value = exception as { message?: unknown };
  return typeof value?.message === "string" && value.message ? value.message : "internal_error";
}
