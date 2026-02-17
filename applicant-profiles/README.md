# Applicant Profiles

This directory contains structured applicant profiles that can be used by the automation agent to fill job application forms.

## 📁 File Structure

```
applicant-profiles/
├── joy-kim.json           # Sample profile (Software Engineer)
├── README.md              # This file
└── templates/
    └── profile-template.json  # Template for creating new profiles
```

## 🎯 Profile Format

Each profile is a JSON file with the following structure:

```json
{
  "meta": { /* profile metadata */ },
  "personal": { /* basic info: name, email, phone, location */ },
  "links": { /* linkedin, github, portfolio */ },
  "education": { /* degree, school, gpa, graduation */ },
  "experience": [ /* array of work experiences */ ],
  "skills": { /* programming languages, frameworks, tools */ },
  "projects": [ /* personal/open-source projects */ ],
  "workPreferences": { /* desired roles, locations, sponsorship */ },
  "questionsAndAnswers": { /* common application questions */ },
  "documents": { /* paths to resume, cover letter, etc. */ }
}
```

## 🚀 Usage

### Option 1: Use the provided script

```bash
# Navigate to magnitude-source directory
cd magnitude-source

# Set environment variable
export SILICONFLOW_API_KEY=your_key_here
# or
export ANTHROPIC_API_KEY=your_key_here

# Run with a Workday job URL
bun run workday-profile https://workday-job-url.com
```

### Option 2: Programmatic usage

```typescript
import { readFileSync } from "fs";

// Load profile
const profile = JSON.parse(
  readFileSync("../applicant-profiles/joy-kim.json", "utf-8")
);

// Use in agent
await agent.act(`
  Fill the form with:
  Name: ${profile.personal.firstName} ${profile.personal.lastName}
  Email: ${profile.personal.email}
  ...
`);
```

## 📝 Creating a New Profile

1. Copy `joy-kim.json` as a template
2. Update all fields with the applicant's information
3. Save as `firstname-lastname.json`
4. Use the profile with the automation script

## 🔑 Key Fields Mapping

Common ATS fields and their profile mappings:

| ATS Field | Profile Path |
|-----------|-------------|
| First Name | `personal.firstName` |
| Last Name | `personal.lastName` |
| Email | `personal.email` |
| Phone | `personal.phone` |
| City | `personal.location.city` |
| State | `personal.location.state` |
| LinkedIn | `links.linkedin` |
| Current Company | `experience[0].company` |
| Current Title | `experience[0].title` |
| Degree | `education.degree` |
| School | `education.school` |
| GPA | `education.gpa` |

## 📋 Common Questions Responses

The `questionsAndAnswers` section contains pre-written responses to common application questions:

- **whyThisCompany**: Why do you want to work here?
- **whyThisRole**: Why are you interested in this position?
- **greatestStrength**: What is your greatest strength?
- **greatestWeakness**: What is your greatest weakness?
- **conflictResolution**: Describe a time you resolved a conflict
- **careerGoals**: Where do you see yourself in 5 years?
- **whyLeaving**: Why are you leaving your current role?
- **expectedSalary**: What are your salary expectations?

These responses use placeholders like `[COMPANY]` and `[MISSION]` that can be dynamically replaced.

## ⚠️ Privacy & Security

- **Never commit real personal information** to public repositories
- Use `.env` files for API keys
- Consider encrypting sensitive profile data
- Replace real contact info with test data for demos

## 🎨 Customization

You can customize the profile structure by:

1. Adding new fields as needed
2. Creating domain-specific profiles (e.g., "data-scientist-profile.json")
3. Adding custom question/answer pairs
4. Extending the field mappings in the automation script

## 📊 Profile Validation

Before using a profile, ensure:

- ✅ All required fields are filled
- ✅ Phone numbers are in correct format
- ✅ Email addresses are valid
- ✅ URLs are properly formatted
- ✅ Dates are in ISO format (YYYY-MM-DD)
- ✅ Document paths are relative and accessible

## 🔄 Profile Updates

When updating a profile:

1. Increment the `meta.version` number
2. Add a comment explaining changes
3. Test with the automation script
4. Update this README if adding new fields

## 📞 Support

For questions or issues:
- Check the main project README
- Review example profiles
- Test with the smoke test script first

