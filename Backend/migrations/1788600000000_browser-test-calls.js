export async function up(pgm) {
  pgm.sql(`CREATE INDEX call_sessions_pending_browser_idx ON call_sessions(started_at)
    WHERE ended_at IS NULL AND provider_metadata->>'source'='browser-test';`);
  for (const side of ['from', 'to']) {
    pgm.sql(`ALTER TABLE call_sessions DROP CONSTRAINT call_sessions_${side}_e164;
      ALTER TABLE call_sessions ADD CONSTRAINT call_sessions_${side}_e164 CHECK (
        ${side}_number ~ '^\\+[1-9][0-9]{6,14}$' OR
        (${side}_number='browser' AND COALESCE(provider_metadata->>'source','')='browser-test'
          AND telephony_account_id IS NULL AND phone_number_id IS NULL)
      );`);
  }
}

export async function down(pgm) {
  pgm.sql('DROP INDEX call_sessions_pending_browser_idx;');
  // Keep test history intact; rollback requires removing browser calls explicitly first.
  for (const side of ['from', 'to']) {
    pgm.sql(`ALTER TABLE call_sessions DROP CONSTRAINT call_sessions_${side}_e164;
      ALTER TABLE call_sessions ADD CONSTRAINT call_sessions_${side}_e164
      CHECK (${side}_number ~ '^\\+[1-9][0-9]{6,14}$');`);
  }
}
