interface Props {
  screenshot: string;
}

export default function BrowserView({ screenshot }: Props) {
  return (
    <div style={styles.container}>
      <img src={`data:image/png;base64,${screenshot}`} alt="Browser view" style={styles.image} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { borderRadius: 8, overflow: 'hidden', border: '1px solid #e0e0e0', background: '#000' },
  image: { width: '100%', display: 'block' },
};
