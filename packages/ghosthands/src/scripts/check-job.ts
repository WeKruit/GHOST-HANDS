import { Client } from "pg";
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query(
    "SELECT id, status, error_code, error_details, result_data FROM gh_automation_jobs ORDER BY created_at DESC LIMIT 3"
);
for (const row of r.rows) {
    console.log("---");
    console.log("ID:", row.id);
    console.log("Status:", row.status);
    console.log("Error:", row.error_code);
    console.log("Details:", JSON.stringify(row.error_details, null, 2));
    console.log("Result:", JSON.stringify(row.result_data, null, 2));
}
await c.end();
