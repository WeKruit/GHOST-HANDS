import { useState, useEffect } from 'react';
import type { UserProfile, AppSettings } from '../../shared/types';
import ProfileForm from '../components/ProfileForm';
import ResumeUpload from '../components/ResumeUpload';

interface Props {
  profile: UserProfile | null;
  onSaved: (profile: UserProfile) => void;
}

export default function Setup({ profile, onSaved }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [resumePath, setResumePath] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);

  useEffect(() => {
    window.ghosthands.getSettings().then(setSettings);
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

  const handleSettingsSave = async () => {
    if (!settings) return;
    await window.ghosthands.saveSettings(settings);
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 2000);
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

      {settings && (
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>LLM Configuration</h2>

          <label style={styles.label}>Provider</label>
          <select
            style={styles.select}
            value={settings.llmProvider}
            onChange={(e) =>
              setSettings({ ...settings, llmProvider: e.target.value as AppSettings['llmProvider'] })
            }
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="deepseek">DeepSeek</option>
          </select>

          <label style={styles.label}>Model</label>
          <input
            style={styles.input}
            value={settings.llmModel}
            onChange={(e) => setSettings({ ...settings, llmModel: e.target.value })}
            placeholder="gpt-4o"
          />

          <label style={styles.label}>API Key</label>
          <input
            style={styles.input}
            type="password"
            value={settings.llmApiKey}
            onChange={(e) => setSettings({ ...settings, llmApiKey: e.target.value })}
            placeholder="sk-..."
          />

          <div style={{ marginTop: 16 }}>
            <button style={styles.button} onClick={handleSettingsSave}>
              {settingsSaved ? 'Saved!' : 'Save Settings'}
            </button>
          </div>
        </section>
      )}
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
  select: {
    width: '100%',
    padding: '8px 12px',
    border: '1px solid #d0d0d0',
    borderRadius: 8,
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box',
    background: '#fff',
  },
  button: {
    padding: '10px 24px',
    border: 'none',
    borderRadius: 8,
    background: '#1a1a1a',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
