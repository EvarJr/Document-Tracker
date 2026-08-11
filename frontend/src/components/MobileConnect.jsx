import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { API_BASE_URL } from '../config.js';
import { authFetch } from '../lib/auth.js';
import './MobileConnect.css';

const POLL_INTERVAL_MS = 2000;

// A single small overlay used from both TemplateUpload and ScanDocument.
// The two callers differ in what they do with arriving photos (template
// creation uses the first one immediately; scanning accumulates a batch),
// so this component just reports arrivals via onImagesReceived and lets
// the caller decide - it doesn't know or care which flow it's feeding.
export default function MobileConnect({ onImagesReceived, onClose, footer }) {
  const [pairingId, setPairingId] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [receivedCount, setReceivedCount] = useState(0);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  const onImagesReceivedRef = useRef(onImagesReceived);
  onImagesReceivedRef.current = onImagesReceived; // avoid restarting the poll interval every render

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`${API_BASE_URL}/pairing`, { method: 'POST' });
        if (!res.ok) throw new Error('Could not start a phone pairing session.');
        const data = await res.json();
        if (cancelled) return;

        setPairingId(data.pairingId);
        setExpiresAt(data.expiresAt);

        const mobileUrl = `${window.location.origin}${window.location.pathname}?mobile=1&pairing=${data.pairingId}`;
        const qr = await QRCode.toDataURL(mobileUrl, { width: 260, margin: 1 });
        if (!cancelled) setQrDataUrl(qr);
      } catch (err) {
        console.error(err);
        if (!cancelled) setError('Could not set up the phone connection. Try again.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!pairingId) return;

    pollRef.current = setInterval(async () => {
      try {
        const res = await authFetch(`${API_BASE_URL}/pairing/${pairingId}/images`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.images && data.images.length > 0) {
          const files = await Promise.all(data.images.map(dataUrlToFile));
          setReceivedCount((c) => c + files.length);
          onImagesReceivedRef.current(files);
        }
      } catch (err) {
        console.error('Pairing poll failed', err);
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(pollRef.current);
  }, [pairingId]);

  const minutesLeft = expiresAt ? Math.max(0, Math.round((expiresAt * 1000 - Date.now()) / 60000)) : null;

  return (
    <div className="mobile-connect-overlay" onClick={onClose}>
      <div className="mobile-connect-panel" onClick={(e) => e.stopPropagation()}>
        <div className="mobile-connect-header">
          <h2>Connect your phone</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        {error && <p className="scan-error">{error}</p>}

        {qrDataUrl && !error && (
          <>
            <img src={qrDataUrl} alt="QR code to connect your phone" className="qr-image" />
            <p className="scan-subtitle">Scan with your phone's camera app, then take a photo.</p>
            {minutesLeft !== null && <p className="mono-label">EXPIRES IN ~{minutesLeft} MIN</p>}
            <p className="mono-label pairing-status">
              {receivedCount === 0
                ? 'WAITING FOR PHOTOS...'
                : `${receivedCount} PHOTO${receivedCount === 1 ? '' : 'S'} RECEIVED`}
            </p>
          </>
        )}

        {!qrDataUrl && !error && <p className="mono-label">GENERATING QR CODE...</p>}

        {footer}
      </div>
    </div>
  );
}

async function dataUrlToFile(imageObj) {
  const res = await fetch(imageObj.dataUrl);
  const blob = await res.blob();
  return new File([blob], `mobile_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`, {
    type: blob.type || 'image/jpeg',
  });
}
