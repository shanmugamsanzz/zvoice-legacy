import { withPlatformAdminContext } from '../src/infrastructure/database-context.js';
import { getB2Object } from '../src/rag/b2.client.js';
import { extractPlainText } from '../src/knowledge-bases/plain-text-extractor.js';
import { processExtractedCategory } from '../src/knowledge-bases/category-processors.js';

const result = await withPlatformAdminContext(null, (db) => db.query(
  `SELECT j.id AS job_id, j.status AS job_status, j.error_code, j.error_message,
          d.id AS document_id, d.original_filename, d.size_bytes,
          d.status AS document_status, v.id AS version_id, v.content_sha256,
          v.b2_object_key, d.mime_type, j.created_at
     FROM knowledge_processing_jobs j
     JOIN knowledge_documents d ON d.id = j.document_id
     JOIN knowledge_document_versions v ON v.id = j.document_version_id
    WHERE d.document_type = $1
    ORDER BY j.created_at DESC
    LIMIT 10`,
  ['workflow_rules'],
));

console.log('Latest workflow jobs:');
console.table(result.rows.map(({ b2_object_key: ignored, ...row }) => row));

const job = result.rows.find((row) => row.error_message?.includes('No workflow lines'));
if (!job) {
  console.log('No recent workflow job has the reported parsing error.');
  process.exit(0);
}

const source = await getB2Object({ key: job.b2_object_key, maxBytes: 10 * 1024 * 1024 });
const extraction = await extractPlainText(source.body);
const parsed = processExtractedCategory('workflow_rules', extraction);

console.log('Stored failed upload:');
console.log({
  jobId: job.job_id,
  filename: job.original_filename,
  databaseBytes: job.size_bytes,
  actualBytes: source.body.length,
  bytePrefix: source.body.subarray(0, 16).toString('hex'),
  lineCount: extraction.pages[0].lines.length,
  recordCount: parsed.recordCount,
  warnings: parsed.warnings,
  firstLines: extraction.pages[0].lines.slice(0, 3),
});
