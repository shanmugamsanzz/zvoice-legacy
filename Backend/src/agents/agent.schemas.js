import { z } from 'zod';

const interruptionPhraseList = z.array(z.string().trim().min(1).max(160)).max(100);
const agentSettingsSchema = z.object({
  interruptionConfirmationMs: z.number().int().min(50).max(2000).optional(),
  interruptionMinWords: z.number().int().min(1).max(10).optional(),
  interruptionAcknowledgements: interruptionPhraseList.optional(),
  interruptionStopPhrases: interruptionPhraseList.optional(),
}).catchall(z.unknown());

const fields = {
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(5000).nullable().optional(),
  goal: z.string().trim().max(5000).nullable().optional(),
  language: z.string().trim().min(1).max(80).default('English (US)'),
  usageDirection: z.enum(['inbound', 'outbound', 'both']).default('both'),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  phoneNumberId: z.string().uuid().nullable().optional(),
  sttModelId: z.string().uuid(), llmModelId: z.string().uuid(), ttsModelId: z.string().uuid(),
  voiceId: z.string().trim().min(1).max(240),
  prompt: z.string().trim().min(1).max(100000),
  welcomeMessage: z.string().max(10000).nullable().optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  interruptionSensitivity: z.number().min(0).max(1).default(0.3),
  silenceTimeoutMs: z.number().int().min(100).max(120000).default(600),
  inactivityTimeoutSeconds: z.number().int().min(1).max(3600).default(5),
  settings: agentSettingsSchema.default({}),
};
export const createAgentSchema = z.object(fields);
export const updateAgentSchema = z.object(fields).partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const agentIdSchema = z.object({ agentId: z.string().uuid() });
export const agentStatusSchema = z.object({ status: z.enum(['draft', 'active', 'archived']) });
export const listAgentsSchema = z.object({
  search: z.string().trim().max(200).optional(), status: z.enum(['draft', 'active', 'archived']).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export function parseAgentInput(schema, value) { const result = schema.safeParse(value); if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) }; }
