import type { Response } from 'express';
import type { ApiErrorBody, ErrorCode, ErrorParams } from '../contract/errors.js';

// Every failed call answers through here (contract/errors.ts): a code for
// the client to act on and localize, the API's own message for logs, and
// that same message again as `error` for PWAs cached before codes existed.
export function errorBody(code: ErrorCode, message: string, params?: ErrorParams): ApiErrorBody {
  return { code, message, ...(params ? { params } : {}), error: message };
}

export function sendError(res: Response, status: number, code: ErrorCode, message: string, params?: ErrorParams): void {
  res.status(status).json(errorBody(code, message, params));
}
