interface Props {
  state: 'running' | 'success' | 'failed';
  message: string;
}

export default function StatusIndicator({ state, message }: Props) {
  return (
    <div style={{ ...styles.container, ...stateStyles[state] }}>
      <div style={styles.row}>
        {state === 'running' && <span style={styles.spinner} />}
        {state === 'success' && <span style={styles.icon}>&#10003;</span>}
        {state === 'failed' && <span style={styles.icon}>&#10007;</span>}
        <span style={styles.label}>
          {state === 'running' ? 'In Progress' : state === 'success' ? 'Completed' : 'Failed'}
        </span>
      </div>
      {message && <p style={styles.message}>{message}</p>}
    </div>
  );
}

const stateStyles: Record<string, React.CSSProperties> = {
  running: { borderColor: '#3b82f6', background: '#eff6ff' },
  success: { borderColor: '#22c55e', background: '#f0fdf4' },
  failed: { borderColor: '#ef4444', background: '#fef2f2' },
};

const styles: Record<string, React.CSSProperties> = {
  container: { padding: '12px 16px', borderRadius: 10, border: '1px solid', marginBottom: 12 },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  spinner: {
    display: 'inline-block',
    width: 14,
    height: 14,
    border: '2px solid #3b82f6',
    borderTopColor: 'transparent',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  icon: { fontSize: 16, fontWeight: 700 },
  label: { fontSize: 14, fontWeight: 600 },
  message: { fontSize: 13, color: '#555', marginTop: 6, marginBottom: 0 },
};
