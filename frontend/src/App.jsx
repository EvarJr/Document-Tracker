import { useEffect, useState } from 'react';
import { API_BASE_URL } from './config.js';
import TemplateUpload from './components/TemplateUpload.jsx';
import TemplatesLibrary from './components/TemplatesLibrary.jsx';
import ScanDocument from './components/ScanDocument.jsx';
import { loginWithGoogle, fetchCurrentUser, exchangeCodeForSession, authFetch, logout } from './lib/auth.js';
import './styles/tokens.css';
import './App.css';

function App() {
  const [backendStatus, setBackendStatus] = useState('checking...');
  const [tab, setTab] = useState('status');
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authNotice, setAuthNotice] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE_URL}/health`)
      .then((res) => res.json())
      .then((data) => setBackendStatus(data.status === 'ok' ? 'connected' : 'unexpected response'))
      .catch(() => setBackendStatus('unreachable (backend may be waking up, try again shortly)'));
  }, []);

  useEffect(() => {
    async function init() {
      const params = new URLSearchParams(window.location.search);
      const authResult = params.get('auth');
      const code = params.get('code');
      let currentUser = null;

      if (authResult === 'success' && code) {
        // Redeem the one-time code from the login redirect for a real session token.
        const result = await exchangeCodeForSession(code);
        if (result) {
          currentUser = result;
          setAuthNotice({ type: 'success', message: 'Signed in successfully.' });
        } else {
          setAuthNotice({ type: 'error', message: 'Sign-in failed during token exchange. Please try again.' });
        }
      } else if (authResult === 'needs_consent') {
        setAuthNotice({
          type: 'error',
          message: 'Please approve Drive access when prompted — sign in again to try once more.',
        });
      } else if (authResult === 'error') {
        setAuthNotice({ type: 'error', message: 'Sign-in failed. Please try again.' });
      } else {
        // Normal page load/refresh — check for an existing stored token.
        currentUser = await fetchCurrentUser();
      }

      if (authResult) {
        const url = new URL(window.location.href);
        url.searchParams.delete('auth');
        url.searchParams.delete('code');
        window.history.replaceState({}, '', url);
      }

      setUser(currentUser);
      setAuthChecked(true);

      // Finish any template save that was interrupted by a login redirect
      // (see FieldBoxEditor's saveTemplate) — now that we're signed in.
      if (currentUser) {
        const pending = localStorage.getItem('pendingTemplateSave');
        if (pending) {
          let templateName = 'template';
          try {
            const parsed = JSON.parse(pending);
            templateName = parsed.name || templateName;

            const res = await authFetch(`${API_BASE_URL}/templates`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: pending,
            });

            if (res.ok) {
              setAuthNotice({
                type: 'success',
                message: `Signed in — "${templateName}" was saved to your Google Drive.`,
              });
            } else {
              setAuthNotice({
                type: 'error',
                message: `Signed in, but saving "${templateName}" failed. Open the field editor and click Save template again.`,
              });
            }
          } catch (err) {
            console.error(err);
          } finally {
            localStorage.removeItem('pendingTemplateSave');
          }
        }
      }
    }

    init();
  }, []);

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  return (
    <div className="app-root">
      <nav className="top-nav">
        <div className="brand">
          <span className="brand-mark" />
          Document Scanner
        </div>
        <div className="nav-tabs">
          <button className={tab === 'status' ? 'active' : ''} onClick={() => setTab('status')}>
            System status
          </button>
          <button className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}>
            Upload &amp; process
          </button>
          <button className={tab === 'templates' ? 'active' : ''} onClick={() => setTab('templates')}>
            Templates
          </button>
          <button className={tab === 'scan' ? 'active' : ''} onClick={() => setTab('scan')}>
            Scan document
          </button>
        </div>
        <div className="auth-area">
          {!authChecked && <span className="mono-label">CHECKING...</span>}
          {authChecked && user && (
            <>
              <span className="user-email">{user.email}</span>
              <button className="auth-btn" onClick={handleLogout}>Sign out</button>
            </>
          )}
          {authChecked && !user && (
            <button className="auth-btn primary" onClick={loginWithGoogle}>
              Sign in with Google
            </button>
          )}
        </div>
      </nav>

      {authNotice && (
        <div className={`auth-notice ${authNotice.type}`}>
          {authNotice.message}
          <button className="dismiss-btn" onClick={() => setAuthNotice(null)}>×</button>
        </div>
      )}

      {tab === 'status' && (
        <div className="app-shell">
          <header>
            <h1>Document Scanner</h1>
            <p className="subtitle">MVP scaffold — pipeline pieces get added step by step from here.</p>
          </header>

          <section className="status-card">
            <h2>System status</h2>
            <ul>
              <li>Frontend: running</li>
              <li>Backend: {backendStatus}</li>
              <li>Google account: {user ? `signed in (${user.email})` : 'not signed in'}</li>
            </ul>
          </section>

          <section className="next-steps">
            <h2>Coming next</h2>
            <ol>
              <li className="done">Template upload + OpenCV.js preprocessing</li>
              <li className="done">Field-box editor (draw &amp; label fields on canvas)</li>
              <li className={user ? 'done' : ''}>Google Sign-In + Drive storage</li>
              <li>Scan flow: align → crop → OCR → review</li>
              <li>Excel export</li>
            </ol>
          </section>
        </div>
      )}

      {tab === 'upload' && <TemplateUpload />}
      {tab === 'templates' && <TemplatesLibrary user={user} authChecked={authChecked} />}
      {tab === 'scan' && <ScanDocument user={user} authChecked={authChecked} />}
    </div>
  );
}

export default App;
