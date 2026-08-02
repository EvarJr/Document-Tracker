import { useEffect, useState } from 'react';
import { API_BASE_URL } from './config.js';
import './App.css';

function App() {
  const [backendStatus, setBackendStatus] = useState('checking...');

  useEffect(() => {
    // Warm-up ping: fires the moment the app loads, so if Render's backend
    // is asleep, the wake-up starts now instead of when the user submits a scan.
    fetch(`${API_BASE_URL}/health`)
      .then((res) => res.json())
      .then((data) => setBackendStatus(data.status === 'ok' ? 'connected' : 'unexpected response'))
      .catch(() => setBackendStatus('unreachable (backend may be waking up, try again shortly)'));
  }, []);

  return (
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
        </ul>
      </section>

      <section className="next-steps">
        <h2>Coming next</h2>
        <ol>
          <li>Template upload + OpenCV.js preprocessing</li>
          <li>Field-box editor (draw &amp; label fields on canvas)</li>
          <li>Google Sign-In + Drive storage</li>
          <li>Scan flow: align → crop → OCR → review</li>
          <li>Excel export</li>
        </ol>
      </section>
    </div>
  );
}

export default App;
