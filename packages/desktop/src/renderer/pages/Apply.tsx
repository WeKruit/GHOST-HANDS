import { useState, useEffect, useRef } from 'react';
import type { ProgressEvent } from '../../shared/types';
import BrowserView from '../components/BrowserView';
import StatusIndicator from '../components/StatusIndicator';

interface Props {
  hasProfile: boolean;
  onGoToSetup: () => void;
}

type RunState = 'idle' | 'running' | 'success' | 'failed';

export default function Apply({ hasProfile, onGoToSetup }: Props) {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<RunState>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [logs, setLogs] = useState<Array<{ type: string; message: string; time: string }>>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cleanup = window.ghosthands.onProgress((event: ProgressEvent) => {
      if (event.screenshot) setScreenshot(event.screenshot);
      if (event.message) {
        setStatusMessage(event.message);
        setLogs((prev) => [
          ...prev,
          {
            type: event.type,
            message: event.message!,
            time: new Date(event.timestamp).toLocaleTimeString(),
          },
        ]);
      }
      if (event.type === 'complete') setState('success');
    });
    return cleanup;
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleApply = async () => {
    if (!url.trim()) return;
    setState('running');
    setStatusMessage('Starting...');
    setScreenshot(null);
    setLogs([]);

    const result = await window.ghosthands.apply(url.trim());
    setState(result.success ? 'success' : 'failed');
    setStatusMessage(result.message);
  };

  const handleCancel = async () => {
    await window.ghosthands.cancelApply();
    setState('idle');
    setStatusMessage('Cancelled');
  };

  const handleReset = () => {
    setState('idle');
    setUrl('');
    setStatusMessage('');
    setScreenshot(null);
    setLogs([]);
  };

  if (!hasProfile) {
    return (
      <div style={styles.page}>
        <div style={styles.emptyState}>
          <h2 style={{ fontSize: 22, fontWeight: 600 }}>Welcome to GhostHands</h2>
          <p style={{ color: '#666', marginTop: 8 }}>
            Set up your profile to get started with automated job applications.
          </p>
          <button style={styles.button} onClick={onGoToSetup}>Set Up Profile</button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Apply to Job</h1>

      <div style={styles.inputRow}>
        <input
          style={styles.urlInput}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste Workday job URL here..."
          disabled={state === 'running'}
          onKeyDown={(e) => e.key === 'Enter' && state === 'idle' && handleApply()}
        />
        {state === 'idle' && (
          <button style={styles.button} onClick={handleApply} disabled={!url.trim()}>Apply</button>
        )}
        {state === 'running' && (
          <button style={styles.cancelButton} onClick={handleCancel}>Cancel</button>
        )}
        {(state === 'success' || state === 'failed') && (
          <button style={styles.secondaryButton} onClick={handleReset}>New Application</button>
        )}
      </div>

      {state !== 'idle' && <StatusIndicator state={state} message={statusMessage} />}

      {screenshot && (
        <div style={styles.browserSection}>
          <h3 style={styles.sectionTitle}>Live View</h3>
          <BrowserView screenshot={screenshot} />
        </div>
      )}

      {logs.length > 0 && (
        <div style={styles.logSection}>
          <h3 style={styles.sectionTitle}>Activity Log</h3>
          <div style={styles.logContainer}>
            {logs.map((log, i) => (
              <div key={i} style={styles.logEntry}>
                <span style={styles.logTime}>{log.time}</span>
                <span style={logTypeStyle(log.type)}>{log.type}</span>
                <span style={styles.logMessage}>{log.message}</span>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}

function logTypeStyle(type: string): React.CSSProperties {
  const colors: Record<string, string> = {
    action: '#0066cc',
    thought: '#8e44ad',
    status: '#27ae60',
    error: '#e74c3c',
    complete: '#27ae60',
  };
  return {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    color: colors[type] || '#666',
    minWidth: 60,
  };
}

const styles: Record<string, React.CSSProperties> = {
  page: { maxWidth: 800, margin: '0 auto' },
  title: { fontSize: 28, fontWeight: 700, marginBottom: 20, letterSpacing: '-0.02em' },
  emptyState: {
    textAlign: 'center',
    padding: 60,
    background: '#fff',
    borderRadius: 12,
    border: '1px solid #e0e0e0',
  },
  inputRow: { display: 'flex', gap: 8, marginBottom: 16 },
  urlInput: {
    flex: 1,
    padding: '12px 16px',
    border: '1px solid #d0d0d0',
    borderRadius: 10,
    fontSize: 15,
    outline: 'none',
    background: '#fff',
  },
  button: {
    padding: '12px 28px',
    border: 'none',
    borderRadius: 10,
    background: '#1a1a1a',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  cancelButton: {
    padding: '12px 28px',
    border: 'none',
    borderRadius: 10,
    background: '#e74c3c',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  secondaryButton: {
    padding: '12px 28px',
    border: '1px solid #d0d0d0',
    borderRadius: 10,
    background: '#fff',
    fontSize: 15,
    fontWeight: 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  browserSection: {
    marginTop: 20,
    background: '#fff',
    borderRadius: 12,
    padding: 16,
    border: '1px solid #e0e0e0',
  },
  sectionTitle: { fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#555' },
  logSection: {
    marginTop: 16,
    background: '#fff',
    borderRadius: 12,
    padding: 16,
    border: '1px solid #e0e0e0',
  },
  logContainer: {
    maxHeight: 200,
    overflowY: 'auto',
    fontFamily: 'SF Mono, Menlo, monospace',
    fontSize: 12,
  },
  logEntry: {
    display: 'flex',
    gap: 8,
    padding: '4px 0',
    borderBottom: '1px solid #f0f0f0',
    alignItems: 'baseline',
  },
  logTime: { fontSize: 11, color: '#999', minWidth: 70 },
  logMessage: { fontSize: 12, color: '#333' },
};
