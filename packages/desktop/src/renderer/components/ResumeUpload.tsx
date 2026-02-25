interface Props {
  path: string | null;
  onSelect: () => void;
}

export default function ResumeUpload({ path, onSelect }: Props) {
  const fileName = path ? path.split('/').pop() : null;

  return (
    <div style={{ marginTop: 4 }}>
      {fileName ? (
        <div style={styles.selected}>
          <span style={styles.fileName}>{fileName}</span>
          <button style={styles.changeButton} onClick={onSelect}>Change</button>
        </div>
      ) : (
        <button style={styles.selectButton} onClick={onSelect}>
          Select Resume (PDF, DOC, DOCX)
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  selected: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 14px',
    background: '#f0f8f0',
    borderRadius: 8,
    border: '1px solid #c8e6c8',
  },
  fileName: { flex: 1, fontSize: 14, fontWeight: 500, color: '#1a7a1a' },
  changeButton: {
    padding: '4px 12px',
    border: '1px solid #d0d0d0',
    borderRadius: 6,
    background: '#fff',
    fontSize: 13,
    cursor: 'pointer',
  },
  selectButton: {
    width: '100%',
    padding: '14px',
    border: '2px dashed #d0d0d0',
    borderRadius: 10,
    background: '#fafafa',
    fontSize: 14,
    color: '#666',
    cursor: 'pointer',
    textAlign: 'center' as const,
  },
};
