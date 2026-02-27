import { useState, useEffect } from 'react';
import type { UserProfile, AuthSession } from '../shared/types';
import Setup from './pages/Setup';
import Apply from './pages/Apply';
import History from './pages/History';
import Login from './pages/Login';

type Page = 'setup' | 'apply' | 'history';

export default function App() {
  const [page, setPage] = useState<Page>('apply');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loading, setLoading] = useState(true);

  // Check for existing session on mount
  useEffect(() => {
    window.ghosthands.getSession().then((s) => {
      setSession(s);
      setAuthChecked(true);
    });
  }, []);

  // Load profile once authenticated
  useEffect(() => {
    if (!authChecked || !session) return;
    window.ghosthands.getProfile().then((p) => {
      setProfile(p);
      if (!p) setPage('setup');
      setLoading(false);
    });
  }, [authChecked, session]);

  const handleSignedIn = () => {
    window.ghosthands.getSession().then((s) => {
      setSession(s);
    });
  };

  const handleSignOut = async () => {
    await window.ghosthands.signOut();
    setSession(null);
    setProfile(null);
    setLoading(true);
  };

  const handleProfileSaved = (p: UserProfile) => {
    setProfile(p);
    setPage('apply');
  };

  // Still checking auth
  if (!authChecked) {
    return (
      <div style={styles.loading}>
        <p>Loading...</p>
      </div>
    );
  }

  // Not signed in — show login
  if (!session) {
    return <Login onSignedIn={handleSignedIn} />;
  }

  // Signed in but still loading profile
  if (loading) {
    return (
      <div style={styles.loading}>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <nav style={styles.nav}>
        <div style={styles.navBrand}>GhostHands</div>
        <div style={styles.navLinks}>
          <button
            style={page === 'apply' ? styles.navActive : styles.navButton}
            onClick={() => setPage('apply')}
          >
            Apply
          </button>
          <button
            style={page === 'history' ? styles.navActive : styles.navButton}
            onClick={() => setPage('history')}
          >
            History
          </button>
          <button
            style={page === 'setup' ? styles.navActive : styles.navButton}
            onClick={() => setPage('setup')}
          >
            Settings
          </button>
        </div>
        <div style={styles.navUser}>
          <span style={styles.userEmail}>{session.user.email}</span>
          <button style={styles.signOutButton} onClick={handleSignOut}>
            Sign Out
          </button>
        </div>
      </nav>

      <main style={styles.main}>
        {page === 'setup' && <Setup profile={profile} onSaved={handleProfileSaved} />}
        {page === 'apply' && <Apply hasProfile={!!profile} onGoToSetup={() => setPage('setup')} />}
        {page === 'history' && <History />}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    color: '#1a1a1a',
    backgroundColor: '#f5f5f7',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    fontSize: 18,
    color: '#666',
  },
  nav: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 24px',
    backgroundColor: '#fff',
    borderBottom: '1px solid #e0e0e0',
    ...({ WebkitAppRegion: 'drag' } as any),
  },
  navBrand: { fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em' },
  navLinks: { display: 'flex', gap: 4, ...({ WebkitAppRegion: 'no-drag' } as any) },
  navButton: {
    padding: '6px 16px',
    border: 'none',
    borderRadius: 8,
    background: 'transparent',
    fontSize: 14,
    fontWeight: 500,
    color: '#666',
    cursor: 'pointer',
  },
  navActive: {
    padding: '6px 16px',
    border: 'none',
    borderRadius: 8,
    background: '#f0f0f0',
    fontSize: 14,
    fontWeight: 600,
    color: '#1a1a1a',
    cursor: 'pointer',
  },
  navUser: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    ...({ WebkitAppRegion: 'no-drag' } as any),
  },
  userEmail: {
    fontSize: 13,
    color: '#666',
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  signOutButton: {
    padding: '4px 12px',
    border: '1px solid #e0e0e0',
    borderRadius: 6,
    background: 'transparent',
    fontSize: 13,
    color: '#666',
    cursor: 'pointer',
  },
  main: { flex: 1, overflow: 'auto', padding: 24 },
};
