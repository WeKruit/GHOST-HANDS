import { useState } from 'react';
import type { UserProfile, EducationEntry, ExperienceEntry } from '../../shared/types';

interface Props {
  initial: UserProfile | null;
  onSave: (profile: UserProfile) => void;
}

const emptyEducation: EducationEntry = { school: '', degree: '', field: '', startDate: '' };
const emptyExperience: ExperienceEntry = { company: '', title: '', startDate: '', description: '' };

export default function ProfileForm({ initial, onSave }: Props) {
  const [profile, setProfile] = useState<UserProfile>(
    initial || {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      linkedIn: '',
      education: [{ ...emptyEducation }],
      experience: [],
    },
  );
  const [saved, setSaved] = useState(false);
  const [skillInput, setSkillInput] = useState('');

  const update = (field: keyof UserProfile, value: any) => {
    setProfile((p) => ({ ...p, [field]: value }));
  };

  const updateEducation = (index: number, field: keyof EducationEntry, value: any) => {
    const edu = [...profile.education];
    edu[index] = { ...edu[index], [field]: value };
    update('education', edu);
  };

  const updateExperience = (index: number, field: keyof ExperienceEntry, value: any) => {
    const exp = [...profile.experience];
    exp[index] = { ...exp[index], [field]: value };
    update('experience', exp);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(profile);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <form onSubmit={handleSubmit}>
      <div style={styles.row}>
        <div style={styles.field}>
          <label style={styles.label}>First Name</label>
          <input style={styles.input} value={profile.firstName} onChange={(e) => update('firstName', e.target.value)} required />
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Last Name</label>
          <input style={styles.input} value={profile.lastName} onChange={(e) => update('lastName', e.target.value)} required />
        </div>
      </div>

      <div style={styles.row}>
        <div style={styles.field}>
          <label style={styles.label}>Email</label>
          <input style={styles.input} type="email" value={profile.email} onChange={(e) => update('email', e.target.value)} required />
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Phone</label>
          <input style={styles.input} type="tel" value={profile.phone} onChange={(e) => update('phone', e.target.value)} />
        </div>
      </div>

      <label style={styles.label}>LinkedIn (optional)</label>
      <input style={styles.input} value={profile.linkedIn || ''} onChange={(e) => update('linkedIn', e.target.value)} placeholder="https://linkedin.com/in/..." />

      {/* Address */}
      <div style={styles.sectionHeader}>
        <h3 style={styles.subtitle}>Address</h3>
      </div>
      <label style={styles.label}>Street Address</label>
      <input style={styles.input} value={profile.address || ''} onChange={(e) => update('address', e.target.value)} placeholder="123 Main St" />
      <div style={styles.row}>
        <div style={styles.field}>
          <label style={styles.label}>City</label>
          <input style={styles.input} value={profile.city || ''} onChange={(e) => update('city', e.target.value)} />
        </div>
        <div style={{ ...styles.field, maxWidth: 120 }}>
          <label style={styles.label}>State</label>
          <input style={styles.input} value={profile.state || ''} onChange={(e) => update('state', e.target.value)} placeholder="CA" />
        </div>
        <div style={{ ...styles.field, maxWidth: 120 }}>
          <label style={styles.label}>Zip Code</label>
          <input style={styles.input} value={profile.zipCode || ''} onChange={(e) => update('zipCode', e.target.value)} placeholder="90001" />
        </div>
      </div>

      {/* Education */}
      <div style={styles.sectionHeader}>
        <h3 style={styles.subtitle}>Education</h3>
        <button type="button" style={styles.addButton} onClick={() => update('education', [...profile.education, { ...emptyEducation }])}>+ Add</button>
      </div>
      {profile.education.map((edu, i) => (
        <div key={i} style={styles.subCard}>
          <div style={styles.row}>
            <div style={styles.field}>
              <label style={styles.label}>School</label>
              <input style={styles.input} value={edu.school} onChange={(e) => updateEducation(i, 'school', e.target.value)} />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Degree</label>
              <input style={styles.input} value={edu.degree} onChange={(e) => updateEducation(i, 'degree', e.target.value)} placeholder="B.S., M.S., etc." />
            </div>
          </div>
          <div style={styles.row}>
            <div style={styles.field}>
              <label style={styles.label}>Field of Study</label>
              <input style={styles.input} value={edu.field} onChange={(e) => updateEducation(i, 'field', e.target.value)} />
            </div>
            <div style={{ ...styles.field, maxWidth: 100 }}>
              <label style={styles.label}>GPA</label>
              <input style={styles.input} value={edu.gpa || ''} onChange={(e) => updateEducation(i, 'gpa', e.target.value || undefined)} placeholder="3.8" />
            </div>
          </div>
          <div style={styles.row}>
            <div style={styles.field}>
              <label style={styles.label}>Start Date</label>
              <input style={styles.input} value={edu.startDate} onChange={(e) => updateEducation(i, 'startDate', e.target.value)} placeholder="2022-09" />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>End Date</label>
              <input style={styles.input} value={edu.endDate || ''} onChange={(e) => updateEducation(i, 'endDate', e.target.value || undefined)} placeholder="2026-05 or present" />
            </div>
          </div>
          {profile.education.length > 1 && (
            <button type="button" style={styles.removeButton} onClick={() => update('education', profile.education.filter((_, j) => j !== i))}>Remove</button>
          )}
        </div>
      ))}

      {/* Experience */}
      <div style={styles.sectionHeader}>
        <h3 style={styles.subtitle}>Work Experience</h3>
        <button type="button" style={styles.addButton} onClick={() => update('experience', [...profile.experience, { ...emptyExperience }])}>+ Add</button>
      </div>
      {profile.experience.map((exp, i) => (
        <div key={i} style={styles.subCard}>
          <div style={styles.row}>
            <div style={styles.field}>
              <label style={styles.label}>Company</label>
              <input style={styles.input} value={exp.company} onChange={(e) => updateExperience(i, 'company', e.target.value)} />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Title</label>
              <input style={styles.input} value={exp.title} onChange={(e) => updateExperience(i, 'title', e.target.value)} />
            </div>
          </div>
          <label style={styles.label}>Location</label>
          <input style={styles.input} value={exp.location || ''} onChange={(e) => updateExperience(i, 'location', e.target.value || undefined)} placeholder="San Francisco, CA" />
          <div style={styles.row}>
            <div style={styles.field}>
              <label style={styles.label}>Start Date</label>
              <input style={styles.input} value={exp.startDate} onChange={(e) => updateExperience(i, 'startDate', e.target.value)} placeholder="2023-01" />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>End Date</label>
              <input style={styles.input} value={exp.endDate || ''} onChange={(e) => updateExperience(i, 'endDate', e.target.value || undefined)} placeholder="present" />
            </div>
          </div>
          <label style={styles.label}>Description</label>
          <textarea style={{ ...styles.input, minHeight: 60, resize: 'vertical' } as React.CSSProperties} value={exp.description} onChange={(e) => updateExperience(i, 'description', e.target.value)} />
          <button type="button" style={styles.removeButton} onClick={() => update('experience', profile.experience.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}

      {/* Skills */}
      <div style={styles.sectionHeader}>
        <h3 style={styles.subtitle}>Skills</h3>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ ...styles.input, flex: 1 }}
          value={skillInput}
          onChange={(e) => setSkillInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const val = skillInput.trim();
              if (val && !(profile.skills || []).includes(val)) {
                update('skills', [...(profile.skills || []), val]);
              }
              setSkillInput('');
            }
          }}
          placeholder="Type a skill and press Enter"
        />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {(profile.skills || []).map((skill, i) => (
          <span
            key={i}
            style={styles.skillTag}
            onClick={() => update('skills', (profile.skills || []).filter((_, j) => j !== i))}
          >
            {skill} &times;
          </span>
        ))}
      </div>

      {/* Legal & Self-Identification */}
      <div style={styles.sectionHeader}>
        <h3 style={styles.subtitle}>Legal & Self-Identification</h3>
      </div>
      <div style={styles.row}>
        <div style={styles.field}>
          <label style={styles.label}>Work Authorization</label>
          <select style={styles.input} value={profile.workAuthorization || ''} onChange={(e) => update('workAuthorization', e.target.value || undefined)}>
            <option value="">Default (Yes)</option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Visa Sponsorship</label>
          <select style={styles.input} value={profile.visaSponsorship || ''} onChange={(e) => update('visaSponsorship', e.target.value || undefined)}>
            <option value="">Default (No)</option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </select>
        </div>
      </div>
      <div style={styles.row}>
        <div style={styles.field}>
          <label style={styles.label}>Gender</label>
          <select style={styles.input} value={profile.gender || ''} onChange={(e) => update('gender', e.target.value || undefined)}>
            <option value="">Default (Male)</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
            <option value="Decline to Self Identify">Decline to Self Identify</option>
            <option value="I do not wish to answer">I do not wish to answer</option>
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Race / Ethnicity</label>
          <select style={styles.input} value={profile.raceEthnicity || ''} onChange={(e) => update('raceEthnicity', e.target.value || undefined)}>
            <option value="">Default (Asian)</option>
            <option value="American Indian or Alaska Native">American Indian or Alaska Native</option>
            <option value="Asian (Not Hispanic or Latino)">Asian (Not Hispanic or Latino)</option>
            <option value="Black or African American (Not Hispanic or Latino)">Black or African American (Not Hispanic or Latino)</option>
            <option value="Hispanic or Latino">Hispanic or Latino</option>
            <option value="Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)">Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)</option>
            <option value="Two or More Races (Not Hispanic or Latino)">Two or More Races (Not Hispanic or Latino)</option>
            <option value="White (Not Hispanic or Latino)">White (Not Hispanic or Latino)</option>
            <option value="I do not wish to answer">I do not wish to answer</option>
          </select>
        </div>
      </div>
      <div style={styles.row}>
        <div style={styles.field}>
          <label style={styles.label}>Veteran Status</label>
          <select style={styles.input} value={profile.veteranStatus || ''} onChange={(e) => update('veteranStatus', e.target.value || undefined)}>
            <option value="">Default (Not a protected veteran)</option>
            <option value="I am a protected veteran">I am a protected veteran</option>
            <option value="I am not a protected veteran">I am not a protected veteran</option>
            <option value="I do not wish to answer">I do not wish to answer</option>
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Disability Status</label>
          <select style={styles.input} value={profile.disabilityStatus || ''} onChange={(e) => update('disabilityStatus', e.target.value || undefined)}>
            <option value="">Default (No disability)</option>
            <option value="Yes, I Have A Disability">Yes, I Have A Disability</option>
            <option value="No, I Don't Have A Disability">No, I Don't Have A Disability</option>
            <option value="I do not wish to answer">I do not wish to answer</option>
          </select>
        </div>
      </div>

      <button type="submit" style={styles.saveButton}>{saved ? 'Saved!' : 'Save Profile'}</button>
    </form>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', gap: 12 },
  field: { flex: 1 },
  label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#555', marginBottom: 4, marginTop: 10 },
  input: { width: '100%', padding: '8px 12px', border: '1px solid #d0d0d0', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' as const },
  subtitle: { fontSize: 15, fontWeight: 600, margin: 0 },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, marginBottom: 8 },
  subCard: { background: '#f9f9f9', borderRadius: 8, padding: 12, marginBottom: 8, border: '1px solid #eee' },
  addButton: { padding: '4px 12px', border: '1px solid #d0d0d0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: 'pointer' },
  removeButton: { padding: '4px 10px', border: 'none', background: 'none', fontSize: 12, color: '#e74c3c', cursor: 'pointer', marginTop: 4 },
  saveButton: { padding: '10px 24px', border: 'none', borderRadius: 8, background: '#1a1a1a', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', marginTop: 20 },
  skillTag: { display: 'inline-flex', alignItems: 'center', padding: '4px 10px', background: '#e8e8e8', borderRadius: 14, fontSize: 13, cursor: 'pointer', color: '#333' },
};
