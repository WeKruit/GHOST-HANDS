import { useState } from 'react';

export default function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.ghosthands.signInWithGoogle();
      if (result.success && result.session) {
        onSignedIn();
      } else {
        setError(result.error ?? 'Sign-in failed');
      }
    } catch (err: any) {
      setError(err.message ?? 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.brand}>GhostHands</div>
        <p style={styles.subtitle}>Automated job applications, powered by AI</p>

        {loading ? (
          <div style={styles.loadingContainer}>
            <div style={styles.spinner} />
            <p style={styles.loadingText}>Opening browser... Complete sign-in in your browser</p>
          </div>
        ) : (
          <button style={styles.googleButton} onClick={handleSignIn}>
            <svg style={styles.googleIcon} viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Sign in with Google
          </button>
        )}

        {error && <p style={styles.error}>{error}</p>}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    backgroundColor: '#f5f5f7',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '48px 40px',
    backgroundColor: '#fff',
    borderRadius: 16,
    border: '1px solid #e0e0e0',
    maxWidth: 400,
    width: '100%',
  },
  brand: {
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 32,
    textAlign: 'center' as const,
  },
  googleButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 24px',
    fontSize: 15,
    fontWeight: 500,
    color: '#1a1a1a',
    backgroundColor: '#fff',
    border: '1px solid #dadce0',
    borderRadius: 8,
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  },
  googleIcon: {
    width: 20,
    height: 20,
  },
  loadingContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid #e0e0e0',
    borderTopColor: '#1a1a1a',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  loadingText: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center' as const,
  },
  error: {
    marginTop: 16,
    fontSize: 13,
    color: '#d93025',
    textAlign: 'center' as const,
  },
};
