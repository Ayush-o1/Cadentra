export class ApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (handler) => {
  onUnauthorized = handler;
};

async function request(method, path, { body, query, headers, silent = false } = {}) {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...headers },
      body,
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK',
      'Could not reach the server. Check your connection and try again.',
    );
  }

  if (response.status === 204) return { data: null, meta: {} };
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload?.error ?? {};
    if (response.status === 401 && !silent) onUnauthorized();
    throw new ApiError(
      response.status,
      error.code ?? 'ERROR',
      error.message ?? 'Something went wrong. Please try again.',
      error.details ?? [],
    );
  }
  return { data: payload?.data ?? null, meta: payload?.meta ?? {} };
}

const json = (body) => ({
  body: JSON.stringify(body ?? {}),
  headers: { 'Content-Type': 'application/json' },
});

export const api = {
  get: (path, query, options) => request('GET', path, { query, ...options }),
  post: (path, body, options) => request('POST', path, { ...json(body), ...options }),
  put: (path, body, options) => request('PUT', path, { ...json(body), ...options }),
  patch: (path, body, options) => request('PATCH', path, { ...json(body), ...options }),
  delete: (path, options) => request('DELETE', path, options),
  postCsv: (path, text, query) =>
    request('POST', path, { body: text, query, headers: { 'Content-Type': 'text/csv' } }),
};
