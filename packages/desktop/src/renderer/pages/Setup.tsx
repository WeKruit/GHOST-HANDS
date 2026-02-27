import { useState, useEffect } from 'react';
import type { UserProfile } from '../../shared/types';
import ProfileForm from '../components/ProfileForm';
import ResumeUpload from '../components/ResumeUpload';

interface Props {
  profile: UserProfile | null;
  onSaved: (profile: UserProfile) => void;
}

export default function Setup({ profile, onSaved }: Props) {
  const [resumePath, setResumePath] = useState<string | null>(null);

  useEffect(() => {
    window.ghosthands.getResumePath().then(setResumePath);
  }, []);

  const handleProfileSave = async (p: UserProfile) => {
    await window.ghosthands.saveProfile(p);
    onSaved(p);
  };

  const handleResumeSelect = async () => {
    const path = await window.ghosthands.selectResume();
    if (path) setResumePath(path);
  };

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Settings</h1>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Personal Information</h2>
        <ProfileForm initial={profile} onSave={handleProfileSave} />
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Resume</h2>
        <ResumeUpload path={resumePath} onSelect={handleResumeSelect} />
      </section>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { maxWidth: 640, margin: '0 auto' },
  title: { fontSize: 28, fontWeight: 700, marginBottom: 24, letterSpacing: '-0.02em' },
  section: {
    background: '#fff',
    borderRadius: 12,
    padding: 24,
    marginBottom: 20,
    border: '1px solid #e0e0e0',
  },
  sectionTitle: { fontSize: 18, fontWeight: 600, marginBottom: 16 },
  label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#555', marginBottom: 4, marginTop: 12 },
  input: {
    width: '100%',
    padding: '8px 12px',
    border: '1px solid #d0d0d0',
    borderRadius: 8,
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box',
  },
};
