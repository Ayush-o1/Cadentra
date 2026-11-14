import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, type ErrorDetail } from '../lib/errors.js';

type ErrorBody = { error: { code: string; message: string; details?: ErrorDetail[] } };

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

function zodDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function statusFromHttpError(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  let status = 500;
  let body: ErrorBody = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } };

  if (error instanceof AppError) {
    status = error.status;
    body = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  } else if (error instanceof ZodError) {
    status = 422;
    body = {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request contains invalid data',
        details: zodDetails(error),
      },
    };
  } else {
    const httpStatus = statusFromHttpError(error);
    if (httpStatus === 413) {
      status = 413;
      body = { error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large' } };
    } else if (httpStatus) {
      status = httpStatus;
      body = { error: { code: 'BAD_REQUEST', message: 'The request could not be processed' } };
    }
  }

  if (status >= 500) {
    req.log.error({ err: error }, 'Unhandled error');
  }
  res.status(status).json(body);
};
