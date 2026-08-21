export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE call_transcript_entries
      ADD COLUMN answer_sources jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE call_transcript_entries
      ADD CONSTRAINT call_transcript_entries_answer_sources_array
      CHECK (jsonb_typeof(answer_sources) = 'array');
  `);
}

export async function down(pgm) {
  pgm.sql('ALTER TABLE call_transcript_entries DROP COLUMN IF EXISTS answer_sources;');
}
