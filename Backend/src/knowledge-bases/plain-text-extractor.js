import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';

export async function extractPlainText(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Text input must be a Buffer');
  let fullText = buffer.toString('utf8').replace(/^\uFEFF/u, '').normalize('NFKC');
  if (fullText.includes('\u0000') || fullText.includes('\uFFFD')) {
    throw new AppError(422, 'The text file must use valid UTF-8 encoding', 'TEXT_ENCODING_INVALID');
  }
  fullText = fullText.replace(/\r\n?/gu, '\n').trim();
  if (!fullText) throw new AppError(422, 'The text file does not contain any text', 'TEXT_EMPTY');
  if (fullText.length > env.KNOWLEDGE_EXTRACTED_TEXT_MAX_CHARS) {
    throw new AppError(422, 'Text file content exceeds the configured limit', 'TEXT_LIMIT_EXCEEDED');
  }
  const lines = fullText.split('\n').map((line) => line.trim()).filter(Boolean);
  return {
    pageCount: 1,
    characterCount: fullText.length,
    wordCount: fullText.split(/\s+/u).filter(Boolean).length,
    pages: [{ pageNumber: 1, text: fullText, lines, characterCount: fullText.length }],
    fullText,
  };
}
