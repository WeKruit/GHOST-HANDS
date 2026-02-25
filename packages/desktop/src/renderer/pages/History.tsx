import { useState, useEffect } from 'react';
import type { ApplicationRecord } from '../../shared/types';

export default function History() {
  const [records, setRecords] = useState<ApplicationRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.ghosthands.getHistory().then((h) => {
      setRecords(h);
      setLoading(false);
    });
  }, []);

  const handleClear = async () => {
    await window.ghosthands.clearHistory();
    setRecords([]);
  };

  if (loading) return <p style={{ color: '#666' }}>Loading...</p>;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Application History</h1>
        {records.length > 0 && (
          <button style={styles.clearButton} onClick={handleClear}>Clear All</button>
        )}
      </div>

      {records.length === 0 ? (
        <div style={styles.empty}>
          <p style={{ color: '#999', fontSize: 15 }}>No applications yet.</p>
        </div>
      ) : (
        <div style={styles.list}>
          {records.map((record) => (
            <div key={record.id} style={styles.card}>
              <div style={styles.cardHeader}>
                <span style={statusStyle(record.status)}>{record.status.toUpperCase()}</span>
                <span style={styles.date}>
                  {new Date(record.startedAt).toLocaleDateString()}{' '}
                  {new Date(record.startedAt).toLocaleTimeString()}
                </span>
              </div>
              <div style={styles.company}>{record.company}</div>
              {record.jobTitle && <div style={styles.jobTitle}>{record.jobTitle}</div>}
              <div style={styles.url}>{record.url}</div>
              {record.error && <div style={styles.error}>{record.error}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function statusStyle(status: ApplicationRecord['status']): React.CSSProperties {
  const colors: Record<string, { bg: string; text: string }> = {
    success: { bg: '#e6f9e6', text: '#1a7a1a' },
    failed: { bg: '#fde8e8', text: '#c0392b' },
    running: { bg: '#e8f0fe', text: '#1a56db' },
    pending: { bg: '#f3f4f6', text: '#6b7280' },
  };
  const c = colors[status] || colors.pending;
  return {
    fontSize: 11,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 4,
    background: c.bg,
    color: c.text,
  };
}

const styles: Record<string, React.CSSProperties> = {
  page: { maxWidth: 700, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em' },
  clearButton: {
    padding: '6px 14px',
    border: '1px solid #d0d0d0',
    borderRadius: 8,
    background: '#fff',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    color: '#e74c3c',
  },
  empty: {
    textAlign: 'center',
    padding: 60,
    background: '#fff',
    borderRadius: 12,
    border: '1px solid #e0e0e0',
  },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: { background: '#fff', borderRadius: 10, padding: 16, border: '1px solid #e0e0e0' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  date: { fontSize: 12, color: '#999' },
  company: { fontSize: 16, fontWeight: 600 },
  jobTitle: { fontSize: 14, color: '#555', marginTop: 2 },
  url: { fontSize: 12, color: '#0066cc', marginTop: 6, wordBreak: 'break-all' },
  error: {
    fontSize: 12,
    color: '#e74c3c',
    marginTop: 6,
    background: '#fde8e8',
    padding: '4px 8px',
    borderRadius: 4,
  },
};
