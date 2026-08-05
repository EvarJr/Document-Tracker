import { useEffect, useState } from 'react';
import { API_BASE_URL } from '../config.js';
import { loginWithGoogle } from '../lib/auth.js';
import './TemplatesLibrary.css';

export default function TemplatesLibrary({ user, authChecked }) {
  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadTemplates = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/templates`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setTemplates(data.templates || []);
    } catch (err) {
      console.error(err);
      setError('Could not load templates from Drive. Try refreshing.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (!authChecked) {
    return (
      <div className="templates-page">
        <p className="mono-label">CHECKING SIGN-IN STATUS...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="templates-page">
        <div className="signin-prompt">
          <p>Sign in with Google to see templates saved to your Drive.</p>
          <button className="auth-btn primary" onClick={loginWithGoogle}>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="templates-page">
      <div className="templates-header">
        <h1>Your templates</h1>
        <button className="refresh-btn" onClick={loadTemplates} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <p className="templates-error">{error}</p>}

      {!error && templates && templates.length === 0 && (
        <p className="templates-empty">
          No templates saved yet. Create one from the Upload &amp; process tab, then Save template.
        </p>
      )}

      {templates && templates.length > 0 && (
        <div className="templates-grid">
          {templates.map((t) => (
            <div key={t.id} className="template-card">
              <div className="template-card-bracket tl" />
              <div className="template-card-bracket tr" />
              <div className="template-card-bracket bl" />
              <div className="template-card-bracket br" />
              <p className="template-card-name">{t.name.replace(/\.json$/, '')}</p>
              <p className="mono-label template-card-meta">
                {t.modifiedTime ? new Date(t.modifiedTime).toLocaleDateString() : ''}
              </p>
            </div>
          ))}
        </div>
      )}

      <p className="templates-footnote mono-label">
        STORED IN GOOGLE DRIVE · FOLDER: DocumentScannerTemplates
      </p>
    </div>
  );
}
