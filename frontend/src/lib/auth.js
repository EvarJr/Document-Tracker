import { API_BASE_URL } from '../config.js';

// Redirects the whole page to the backend, which redirects to Google.
// This has to be a full navigation (not a fetch) because Google's consent
// screen can't be shown inside a fetch response.
export function loginWithGoogle() {
  window.location.href = `${API_BASE_URL}/auth/google/login`;
}

export async function fetchCurrentUser() {
  try {
    // credentials: 'include' is required on every authenticated call -
    // without it, the browser won't send the session cookie cross-site.
    const res = await fetch(`${API_BASE_URL}/auth/me`, { credentials: 'include' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function logout() {
  await fetch(`${API_BASE_URL}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
}
