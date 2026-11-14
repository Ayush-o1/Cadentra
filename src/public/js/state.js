import { api } from './api.js';

/** The signed-in user and their workspace, shared by every page. */
export const state = { user: null, workspace: null };

export async function loadSession() {
  const { data } = await api.get('/auth/session');
  if (!data) return false;
  state.user = data.user;
  await refreshWorkspace();
  return true;
}

export async function refreshWorkspace() {
  const { data } = await api.get('/workspace');
  state.workspace = data;
  return data;
}

export function setIdentity(identity) {
  state.user = identity.user;
}

export function clearSession() {
  state.user = null;
  state.workspace = null;
}
