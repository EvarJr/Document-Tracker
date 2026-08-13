import { API_BASE_URL } from '../config.js';

// sessionStorage (not localStorage): cleared when the tab closes, scoped
// to this tab only, and never sent anywhere automatically - unlike a
// cookie, it's only ever attached to a request because our own code does
// it explicitly below. That's what makes this immune to both cross-site
// cookie blocking AND CSRF, at the cost of needing every call site to
// remember to attach it (see authFetch).
const TOKEN_KEY = 'session_token';

export function loginWithGoogle() {
  // Full navigation, not a fetch - Google's consent screen has to be an
  // actual page, it can't be shown inside a fetch response.
  window.location.href = `${API_BASE_URL}/auth/google/login`;
}

function getStoredToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

function storeToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

function authHeaders() {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Trades the short-lived one-time code (from the ?code=... redirect param)
// for the real session token, and stores it. The code itself is useless
// after this single call - the backend deletes it immediately on use.
export async function exchangeCodeForSession(code) {
  try {
    const res = await fetch(`${API_BASE_URL}/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    storeToken(data.session_token);
    return { email: data.email };
  } catch {
    return null;
  }
}

export async function fetchCurrentUser() {
  const token = getStoredToken();
  if (!token) return null; // skip the network call entirely if we know we're logged out

  try {
    const res = await fetch(`${API_BASE_URL}/auth/me`, { headers: authHeaders() });
    if (!res.ok) {
      clearToken(); // stale/invalid token - don't keep sending it
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

export async function logout() {
  try {
    await fetch(`${API_BASE_URL}/auth/logout`, { method: 'POST', headers: authHeaders() });
  } finally {
    clearToken();
  }
}

// Drop-in replacement for fetch() that automatically attaches the bearer
// token — use this for every call to a protected backend route.
export async function authFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), ...authHeaders() },
  });

  if (res.status === 401) {
    // The token is provably dead (expired/revoked) - clear it now so a
    // page refresh correctly shows "signed out" instead of continuing to
    // silently fail every request with the same stale token.
    clearToken();
  }

  return res;
}
