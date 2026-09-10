import { priceQuestionPattern, hasKnowledgePrice } from '../knowledge-bases/catalog-matching.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middleware/errors.js';
import { appendTranscriptEntry } from '../calls/call.service.js';
import { routeKnowledgeQuery } from '../knowledge-bases/knowledge-runtime.service.js';
import { ProviderIndependentAudioEngine } from './audio/audio-engine.js';
import { completeVoiceCall } from './call-completion.service.js';
import { CallController } from './call-controller.js';
import { callStates } from './call-state-machine.js';
import { ProviderUsageTracker } from './provider-usage-tracker.js';
import { loadAgentRuntimeProfile } from './providers/provider-config.js';
import { createRuntimeAdapters, providerAdapterRegistry } from './providers/registry.js';
import { registerImplementedProviderAdapters } from './providers/defaults.js';
import { createSelectedLlmStream } from './providers/llm/llm-response.service.js';
import { executeAgentTools } from './tools/tool-executor.service.js';
import { LlmCircuitBreaker } from './providers/llm/streaming-runtime.js';
import { welcomeAudioCache } from './welcome-audio-cache.service.js';
import { tenantProviderHealth } from './provider-health.service.js';
import { renderWelcomeTemplate, welcomeTemplateContext } from './welcome-template.service.js';
import { interruptionDecision } from './interruption/interruption-policy.js';

const bookingIntent = /\b(?:appointment|book(?:ing)?|schedule|visit)\b|\u0B85\u0BAA\u0BCD\u0BAA\u0BBE\u0BAF\u0BBF\u0BA3\u0BCD\u0B9F\u0BCD\u0BAE\u0BC6\u0BA3\u0BCD\u0B9F\u0BCD|\u0BAA\u0BC1\u0B95\u0BCD\s*\u0BAA\u0BA3\u0BCD\u0BA3/iu;
const relativeDatePattern = /\b(?:today|tomorrow|day after tomorrow)\b|\u0B87\u0BA9\u0BCD\u0BB1\u0BC1|\u0BA8\u0BBE\u0BB3\u0BC8(?:\u0B95\u0BCD\u0B95\u0BC1)?|\u0BA8\u0BBE\u0BB3\u0BC8\s*\u0BAE\u0BB1\u0BC1\u0BA8\u0BBE\u0BB3\u0BCD/iu;
const appointmentForCallerPattern = /\b(?:for me|myself)\b|\u0B8E\u0BA9\u0B95\u0BCD\u0B95\u0BC1(?:\s*\u0BA4\u0BBE\u0BA9\u0BCD)?|\u0BA8\u0BBE\u0BA9\u0BCD\s*\u0BA4\u0BBE\u0BA9\u0BCD/iu;
const monthPattern = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b|\u0B86\u0B95\u0BB8\u0BCD\u0B9F\u0BCD/iu;
const comparisonIntent = /\b(?:compare|comparison|difference|different|versus|vs\.?)\b|வித்தியாசம்|ஒப்பிட/iu;
const ordinalCatalogReference = /\b(?:first(?:\s+one|\s+of\s+all)?|second(?:\s+one)?|third(?:\s+one)?)\b|(?:முதல்|முதலாவது|ரெண்டாவது|இரண்டாவது|மூன்றாவது)(?:\s+ஒன்று|\s+ஒன்னு)?/iu;

function runtimeClock(timeZone, now = new Date()) {
  const resolvedTimeZone = String(timeZone ?? '').trim() || 'UTC';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: resolvedTimeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    timeZone: resolvedTimeZone,
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localWeekday: parts.weekday,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function missingPackageSelectionAnswer(language) {
  return /(?:tamil|\bta(?:-|\b))/i.test(String(language ?? ''))
    ? 'Appointment எந்த exact Package-க்கு book பண்ணணும்னு சொல்லுங்க.'
    : 'Please tell me the exact package you want to book.';
}

function bookingToolAvailable(tools = []) {
  return tools.some((tool) => /(?:appointment|book|booking|schedule|visit)/i
    .test(String(tool.name ?? '') + ' ' + String(tool.description ?? '')));
}

export function unansweredUserTurns(history = []) {
  const pending = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role === 'assistant') break;
    if (message.role === 'user' && String(message.content ?? '').trim()) pending.unshift(String(message.content).trim());
  }
  return pending;
}

function preferredDateExpression(query) {
  return String(query ?? '').match(relativeDatePattern)?.[0] ?? null;
}

function contextualCatalogQuery(query, state) {
  const match = String(query ?? '').match(ordinalCatalogReference)?.[0]?.toLowerCase();
  const items = state.lastCatalogItems ?? [];
  if (!match || !items.length) return query;
  const index = /second|ரெண்டாவது|இரண்டாவது/u.test(match)
    ? 1 : (/third|மூன்றாவது/u.test(match) ? 2 : 0);
  const item = items[index];
  return item?.name ? `${query} ${item.name}` : query;
}

export function resolveRelativeDate(expression, clock) {
  const value = String(expression ?? '').toLowerCase();
  const days = /day after tomorrow|\u0BA8\u0BBE\u0BB3\u0BC8\s*\u0BAE\u0BB1\u0BC1\u0BA8\u0BBE\u0BB3\u0BCD/u.test(value)
    ? 2 : (/tomorrow|\u0BA8\u0BBE\u0BB3\u0BC8/u.test(value) ? 1 : 0);
  const [year, month, day] = clock.localDate.split('-').map(Number);
  const resolved = new Date(Date.UTC(year, month - 1, day + days));
  return {
    isoDate: resolved.toISOString().slice(0, 10),
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(resolved),
  };
}

function lastAssistantTurn(history) {
  return [...history].reverse().find((message) => message.role === 'assistant')?.content ?? '';
}

export function phoneValidation(query, history) {
  if (!/\b(?:phone|mobile|contact)\b/i.test(String(lastAssistantTurn(history)))) return null;
  const digits = String(query ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return national.length === 10
    ? { valid: true, phoneNumber: national }
    : { valid: false, digitCount: digits.length };
}

export function monthDateInput(query, clock) {
  const value = String(query ?? '');
  const monthMatch = value.match(monthPattern);
  if (!monthMatch) return null;
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'];
  const spokenMonth = monthMatch[1]?.toLowerCase() ?? 'august';
  const month = monthNames.indexOf(spokenMonth) + 1;
  const suffix = value.slice((monthMatch.index ?? 0) + monthMatch[0].length);
  const dayMatch = suffix.match(/^\s*(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (!dayMatch) return { incomplete: true, month: spokenMonth };
  const day = Number(dayMatch[1]);
  const explicitYear = suffix.slice(dayMatch[0].length).match(/^\s*,?\s*(20\d{2})\b/)?.[1];
  const year = Number(explicitYear ?? clock.localDate.slice(0, 4));
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    return { invalid: true, month: spokenMonth, day };
  }
  const isoDate = candidate.toISOString().slice(0, 10);
  return {
    month: spokenMonth, day, year, isoDate,
    yearRequired: !explicitYear && isoDate < clock.localDate,
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(candidate),
  };
}

function catalogAttribute(item, key) {
  const attribute = (item?.attributes ?? []).find((entry) => entry.key === key);
  return attribute?.value ?? null;
}

function nextBookingField(state) {
  if (!state.bookingRequested || state.packageSelectionRequired || !state.selectedItem) return null;
  return state.bookingFields.appointmentFor ? null : 'appointmentFor';
}

export function normalizeVoiceResponse(text) {
  const numberWords = new Map([
    ['0', 'zero'], ['1', 'one'], ['2', 'two'], ['3', 'three'], ['4', 'four'], ['5', 'five'],
    ['6', 'six'], ['7', 'seven'], ['8', 'eight'], ['9', 'nine'], ['10', 'ten'], ['11', 'eleven'],
    ['12', 'twelve'], ['13', 'thirteen'], ['14', 'fourteen'], ['15', 'fifteen'], ['16', 'sixteen'],
    ['17', 'seventeen'], ['18', 'eighteen'], ['19', 'nineteen'], ['20', 'twenty'], ['24', 'twenty four'],
  ]);
  return String(text ?? '')
    .replace(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})(?=\s*(?:hours?|hrs?|\u0BAE\u0BA3\u0BBF\s*\u0BA8\u0BC7\u0BB0\u0BAE\u0BCD))/giu,
      (_match, start, end) => (numberWords.get(start) ?? start) + ' to ' + (numberWords.get(end) ?? end))
    ;
}

function enforceNextBookingQuestion(text, flowState, language) {
  if (flowState.nextBookingField !== 'appointmentFor') return text;
  if (/(?:who[^.!?]{0,80}appointment|appointment[^.!?]{0,100}(?:\u0BAF\u0BBE\u0BB0\u0BC1\u0B95\u0BCD\u0B95\u0BBE\u0B95|yarukkaga)|(?:\u0BAF\u0BBE\u0BB0\u0BC1\u0B95\u0BCD\u0B95\u0BBE\u0B95|yarukkaga)[^.!?]{0,100}appointment)/iu.test(String(text ?? ''))) return text;
  const question = /(?:tamil|\bta(?:-|\b))/i.test(String(language ?? ''))
    ? 'Appointment \u0BAF\u0BBE\u0BB0\u0BC1\u0B95\u0BCD\u0B95\u0BBE\u0B95 book \u0BAA\u0BA3\u0BCD\u0BA3\u0BA3\u0BC1\u0BAE\u0BCD?'
    : 'Who is the appointment for?';
  const withoutSkippedQuestion = String(text ?? '').replace(
    /(?:Appointment[^.!?]*(?:patient|name)[^.!?]*[.!?]?|(?:Please\s+)?(?:tell|provide)[^.!?]*patient[^.!?]*name[^.!?]*[.!?]?)$/iu,
    '',
  ).replace(/[^.!?]*\?\s*$/u, '').trim();
  return withoutSkippedQuestion + (withoutSkippedQuestion ? ' ' : '') + question;
}

function languageCode(value) {
  const match = String(value ?? '').match(/\b([a-z]{2,3})(?:-[A-Z]{2})?\b/);
  if (match) return match[1].toLowerCase();
  const names = { english: 'en', tamil: 'ta', hindi: 'hi', telugu: 'te', kannada: 'kn', malayalam: 'ml' };
  const lower = String(value ?? '').toLowerCase();
  return Object.entries(names).find(([name]) => lower.includes(name))?.[1] ?? 'en';
}

function fallbackClosing(profile) {
  const configured = profile.integrations?.postCall?.dynamicClosing;
  if (typeof configured === 'string' && configured.trim() && configured !== 'true') return configured.trim();
  return profile.agent.language?.toLowerCase().includes('tamil') || profile.agent.language?.toLowerCase().includes('ta')
    ? 'அழைத்ததற்கு நன்றி. வணக்கம்.' : 'Thank you for calling. Goodbye.';
}

function fallbackRecovery(profile) {
  return String(profile.agent.settings?.errorRecoveryMessage ?? '').trim()
    || (profile.agent.language?.toLowerCase().includes('tamil')
      ? 'மன்னிக்கவும், ஒரு சிறிய சிக்கல் ஏற்பட்டது. மீண்டும் சொல்ல முடியுமா?'
      : 'Sorry, I had a temporary problem. Could you please say that again?');
}

function exactCatalogPriceAnswer(query, knowledge, language) {
  if (knowledge?.route !== 'catalog' || !priceQuestionPattern.test(String(query ?? ''))) return null;
  const name = String(knowledge.item?.name ?? '').trim();
  const rawPrice = knowledge.item?.price;
  if (!name || rawPrice === null || rawPrice === undefined || rawPrice === '') return null;
  const numericPrice = Number(rawPrice);
  const price = Number.isFinite(numericPrice)
    ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(numericPrice)
    : String(rawPrice).trim();
  const currency = String(knowledge.item?.currency ?? '').trim().toUpperCase();
  const spokenCurrency = currency === 'INR' ? 'rupees' : currency;
  const amount = `${name} Price ${price}${spokenCurrency ? ` ${spokenCurrency}` : ''}.`;
  const tamil = /(?:tamil|\bta(?:-|\b))/i.test(String(language ?? ''));
  return tamil
    ? `${amount} Appointment book \u0BAA\u0BA3\u0BCD\u0BA3\u0BB2\u0BBE\u0BAE\u0BBE, \u0B87\u0BB2\u0BCD\u0BB2 \u0BB5\u0BC7\u0BB1 Package details \u0BB5\u0BC7\u0BA3\u0BC1\u0BAE\u0BBE?`
    : `${amount} Would you like to book an appointment or hear about another package?`;
}

function unverifiedCatalogPriceAnswer(query, knowledge) {
  if (knowledge?.ambiguous) return 'Please confirm the product and plan name so I can give you the correct price.';
  if (!priceQuestionPattern.test(String(query ?? '')) || exactCatalogPriceAnswer(query, knowledge)) return null;
  if (knowledge?.route === 'catalog' && knowledge.items?.length) return null;
  if (knowledge?.route !== 'catalog' && hasKnowledgePrice(knowledge)) return null;
  return 'I could not verify that package price from the approved catalog. Please confirm the package name.';
}

function toolResultFallback(toolResults, language, query) {
  const results = Array.isArray(toolResults) ? toolResults : [];
  if (!results.length) return '';
  const tamil = /(?:tamil|\bta(?:-|\b))/i.test(String(language ?? ''));
  if (results.some((result) => result.success !== true)) {
    return tamil
      ? 'Sorry nga, request complete aagala. Human assistance arrange pannattuma?'
      : 'Sorry, I could not complete that request. Would you like human assistance?';
  }
  const bookingToolUsed = bookingIntent.test(String(query ?? ''))
    || results.some((result) => /(?:appointment|book|schedule|visit)/i.test(String(result.name ?? '')));
  if (bookingToolUsed) {
    return tamil
      ? 'Unga appointment successfully book aayiduchu. Vera edhavadhu help venuma nga?'
      : 'Your appointment was booked successfully. Is there anything else I can help with?';
  }
  return tamil
    ? 'Unga request successfully complete aayiduchu. Vera edhavadhu help venuma nga?'
    : 'Your request was completed successfully. Is there anything else I can help with?';
}

function hasCompletedActionClaim(text) {
  const value = String(text ?? '');
  return /\b(?:successfully\s+(?:booked|sent|transferred|connected|completed)|(?:has been|was|is now)\s+(?:booked|sent|transferred|connected|completed)|you\s+are\s+being\s+(?:transferred|connected)|(?:transferring|connecting)\s+you\s+now|book(?:ing)?\s+aayiduchu|complete\s+aayiduchu)\b|\u0BB5\u0BC6\u0BB1\u0BCD\u0BB1\u0BBF\u0B95\u0BB0\u0BAE\u0BBE\u0B95[^.!?]{0,80}(?:book|\u0BAA\u0BC1\u0B95\u0BCD)|\u0BAE\u0BBE\u0BB1\u0BCD\u0BB1\u0BAA\u0BCD\u0BAA\u0B9F\u0BC1\u0B95\u0BBF\u0BB1|\u0B87\u0BA3\u0BC8\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F|\u0B85\u0BA9\u0BC1\u0BAA\u0BCD\u0BAA\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F/iu.test(value);
}

function hasUnverifiedActionProgressClaim(text) {
  const value = String(text ?? '');
  return hasCompletedActionClaim(value)
    || /\b(?:i(?:'m| am)\s+(?:sending|booking|transferring|connecting)|i(?:'ll| will)\s+(?:send|book|transfer|connect)|(?:sending|booking|transferring|connecting)\s+(?:it|you|the\s+(?:location|brochure|appointment))?\s*now)\b|\b(?:location|brochure|appointment)\s+(?:will\s+be|is\s+being)\s+(?:sent|booked)|அனுப்பி\s*(?:வைக்கிறேன்|விடுகிறேன்|வைக்கப்படும்)|புக்\s*பண்ண(?:றேன்|ுகிறேன்)/iu.test(value);
}

function unverifiedActionResponse(profile) {
  const configured = String(profile.agent.settings?.unverifiedActionMessage ?? '').trim();
  if (configured) return configured;
  const tamil = /(?:tamil|\bta(?:-|\b))/i.test(String(profile.agent.language ?? ''));
  return tamil
    ? 'Request \u0B87\u0BA9\u0BCD\u0BA9\u0BC1\u0BAE\u0BCD complete \u0B86\u0B95\u0BB2. Action successful \u0B86\u0BA9 \u0BAA\u0BBF\u0BB1\u0B95\u0BC1 confirm \u0BAA\u0BA3\u0BCD\u0BA3\u0BB1\u0BC7\u0BA9\u0BCD.'
    : 'The request has not been completed yet. I will confirm it only after the action succeeds.';
}

function answerSources(knowledge, { toolUsed = false } = {}) {
  if (!knowledge?.found) {
    return [{ type: toolUsed ? 'agent_tool' : 'model', label: toolUsed ? 'Agent tool result' : 'AI model (no Knowledge Base match)' }];
  }
  const candidates = knowledge.matches?.length ? knowledge.matches : [knowledge.source ?? {}];
  const knowledgeSources = candidates.slice(0, toolUsed ? 2 : 3).map((source) => ({
    type: 'knowledge_base',
    label: source.documentName ?? source.knowledgeBaseName ?? 'Knowledge Base',
    route: knowledge.route,
    recordId: source.id ?? source.recordId ?? null,
    knowledgeBaseId: source.knowledgeBaseId ?? null,
    knowledgeBaseName: source.knowledgeBaseName ?? null,
    documentId: source.documentId ?? null,
    documentName: source.documentName ?? null,
    pageNumber: source.pageNumber ?? null,
  }));
  return toolUsed
    ? [{ type: 'agent_tool', label: 'Agent tool result' }, ...knowledgeSources]
    : knowledgeSources;
}

export class RealtimeConversationOrchestrator {
  constructor(mediaSession, dependencies = {}) {
    if (!mediaSession?.callId) throw new TypeError('A Plivo media session is required');
    this.mediaSession = mediaSession;
    this.call = mediaSession.call;
    this.dependencies = dependencies;
    this.log = dependencies.logger ?? mediaSession.log ?? logger;
    this.registry = dependencies.registry ?? providerAdapterRegistry;
    this.startedAt = Date.now();
    this.epoch = 0;
    this.errorCount = 0;
    this.recoveryActive = false;
    this.finalized = false;
    this.closing = false;
    this.activeLlm = null;
    this.activeSynthesisCount = 0;
    this.inactivityTimer = null;
    this.bargeInTimer = null;
    this.bargeInText = '';
    this.bargeInStartedAt = 0;
    this.callerSpeechActive = false;
    this.utteranceOverlappedAgent = null;
    this.listeners = [];
    this.runtimeMetrics = { knowledge: [], tools: [], latency: {} };
    this.conversationFlowState = {
      stage: 'awaiting_first_response', turnNumber: 0,
      selectedCategory: null, selectedItem: null,
      bookingRequested: false, packageSelectionRequired: false, lastAction: null,
      bookingFields: { appointmentFor: null, preferredDateExpression: null },
      lastCatalogItems: [],
    };
    this.llmCircuitBreaker = new LlmCircuitBreaker();
    this.providerHealth = dependencies.providerHealth ?? tenantProviderHealth;
    this.#attach();
    this.ready = this.#prepare();
    void this.ready.catch((error) => this.#recover(error, 'initialize')).catch((recoveryError) => {
      this.log.error({ err: recoveryError, callId: this.call.id }, 'Voice initialization recovery failed');
    });
  }

  #attach() {
    const bind = (event, handler) => {
      this.mediaSession.on(event, handler);
      this.listeners.push([event, handler]);
    };
    bind('start', () => void this.#guard('start', () => this.#onStart()));
    bind('media', ({ audio }) => void this.#guard('media', () => this.#onMedia(audio)));
    bind('dtmf', ({ digit }) => void this.#guard('dtmf', () => this.#onDtmf(digit)));
    bind('stop', () => void this.#finalize('completed', 'plivo_stream_stopped'));
    bind('failure', ({ error }) => void this.#guard('plivo_media', async () => { throw error; }));
    bind('closed', ({ code, reason }) => void this.#finalize(
      code === 1000 ? 'completed' : 'failed', reason || 'media_closed',
    ));
  }

  async #prepare() {
    const loadProfile = this.dependencies.loadProfile ?? loadAgentRuntimeProfile;
    this.runtimeProfile = await loadProfile({
      agentId: this.call.agentId,
      tenantId: this.call.tenantId,
      workspaceId: this.call.workspaceId,
      callDirection: this.call.direction,
    });
    this.log = this.log.child?.({
      tenantId: this.runtimeProfile.agent.tenantId,
      workspaceId: this.runtimeProfile.agent.workspaceId,
      agentId: this.runtimeProfile.agent.id,
      callId: this.call.id,
    }) ?? this.log;
    this.preCallContext = this.call.providerMetadata?.preCall?.context ?? {};
    const renderedWelcome = renderWelcomeTemplate(
      this.runtimeProfile.agent.welcomeMessage,
      welcomeTemplateContext(this.call),
      {
        language: this.runtimeProfile.agent.language,
        fallbackMessage: this.runtimeProfile.agent.settings?.welcomeFallbackMessage,
      },
    );
    this.runtimeProfile = {
      ...this.runtimeProfile,
      agent: { ...this.runtimeProfile.agent, welcomeMessage: renderedWelcome.text },
    };
    this.personalizedWelcome = renderedWelcome.personalized;
    if (renderedWelcome.dynamic) {
      this.log.info({
        icon: '👤', stage: 'welcome.template_rendered', callId: this.call.id,
        personalized: renderedWelcome.personalized,
        resolvedVariables: renderedWelcome.resolvedVariables,
        missingVariables: renderedWelcome.missingVariables,
      }, renderedWelcome.personalized
        ? '👤 Personalized welcome message prepared'
        : '👤 Generic welcome fallback prepared');
    }
    this.welcomeCache = this.dependencies.welcomeCache ?? welcomeAudioCache;
    this.cachedWelcomePromise = this.runtimeProfile.agent.welcomeMessage && !this.personalizedWelcome
      ? this.welcomeCache.get(this.runtimeProfile, this.runtimeProfile.agent.welcomeMessage)
      : Promise.resolve(null);
    this.controller = new CallController({
      callSession: this.call,
      runtimeProfile: this.runtimeProfile,
      hooks: {
        onTranscript: async (entry) => (this.dependencies.appendTranscript ?? appendTranscriptEntry)({
          ...entry,
          offsetMs: Math.max(0, entry.at - this.startedAt),
        }),
        onInterrupt: async ({ reason }) => this.log.info({
          icon: '🛑', stage: 'conversation.barge_in', callId: this.call.id, reason,
        }, '🛑 Caller interrupted active agent output'),
        onStateChange: async ({ previous, current, reason }) => this.log.info({
          icon: '🔄', stage: 'conversation.state', callId: this.call.id, previous, current, reason,
        }, `🔄 Voice call state: ${previous} → ${current}`),
      },
    });
    this.usageTracker = new ProviderUsageTracker(this.runtimeProfile);
    registerImplementedProviderAdapters(this.registry);
    const createAdapters = this.dependencies.createAdapters ?? createRuntimeAdapters;
    const runtimeContext = {
      callId: this.call.id,
      fetch: this.dependencies.fetchImpl,
      fetchImpl: this.dependencies.fetchImpl,
      webSocketFactory: this.dependencies.webSocketFactory,
      breaker: this.llmCircuitBreaker,
    };
    this.adapters = await createAdapters(this.runtimeProfile, runtimeContext, this.registry);
    this.audioEngine = (this.dependencies.createAudioEngine ?? ((options) => new ProviderIndependentAudioEngine(options)))({
      runtimeProfile: this.runtimeProfile,
      mediaSession: this.mediaSession,
      onError: (error) => void this.#guard('audio_output', async () => { throw error; }),
      onUnderrun: (details) => {
        this.runtimeMetrics.latency.audioUnderruns = Number(this.runtimeMetrics.latency.audioUnderruns ?? 0) + 1;
        this.log.warn({ stage: 'audio.underrun', callId: this.call.id, ...details }, 'Agent audio queue underrun detected');
      },
      onPacket: (details) => {
        this.runtimeMetrics.latency.audioPackets = Number(this.runtimeMetrics.latency.audioPackets ?? 0) + 1;
        this.log.debug({ stage: 'audio.packet', callId: this.call.id, ...details }, 'Agent audio packet delivered');
      },
    });
    this.unsubscribeStt = this.adapters.stt.onEvent((event) => (
      void this.#guard('stt_event', () => this.#handleSttEvent(event))
    ));
    try {
      await this.adapters.stt.connect();
      this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'stt', this.runtimeProfile.providers.stt, 'success');
    } catch (error) {
      this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'stt', this.runtimeProfile.providers.stt, 'failure', {
        code: error.code,
      });
      throw error;
    }
    if (this.finalized) {
      await Promise.allSettled(Object.values(this.adapters).map((adapter) => adapter.close()));
      await this.audioEngine.close();
      return this;
    }
    this.log.info({
      icon: '✅', stage: 'conversation.ready', callId: this.call.id,
      agentId: this.runtimeProfile.agent.id,
      stt: this.runtimeProfile.providers.stt.modelKey,
      llm: this.runtimeProfile.providers.llm.modelKey,
      tts: this.runtimeProfile.providers.tts.modelKey,
    }, '✅ Real-time voice pipeline initialized');
    return this;
  }

  async #guard(stage, operation) {
    try { await operation(); } catch (error) {
      try { await this.#recover(error, stage); } catch (recoveryError) {
        this.log.error({ err: recoveryError, callId: this.call.id, stage }, 'Voice pipeline recovery failed');
        if (!this.mediaSession.closed) this.mediaSession.close(1011, 'voice recovery failed');
      }
    }
  }

  async #onStart() {
    await this.ready;
    if (this.finalized) return;
    this.audioEngine.start();
    this.mediaStartedAt = Date.now();
    void this.#guard('audio_input', () => this.#pumpInbound());
    const action = await this.controller.initialize();
    if (action.action === 'speak') {
      const epoch = this.epoch;
      void this.#guard('welcome', async () => {
        await this.#synthesizeWelcome(action.text, `welcome-${epoch}`);
        if (epoch === this.epoch && this.controller.state === callStates.GREETING) {
          await this.controller.greetingComplete();
          this.#armInactivity();
        }
      });
    } else this.#armInactivity();
  }

  async #onMedia(audio) {
    await this.ready;
    if (!this.finalized) await this.audioEngine.enqueueInbound(audio, { callId: this.call.id });
  }

  async #pumpInbound() {
    while (!this.finalized) {
      const frame = await this.audioEngine.readInbound();
      if (!frame) return;
      this.adapters.stt.sendAudio(frame.data);
    }
  }

  async #handleSttEvent(event) {
    if (this.finalized) return;
    if (event.type === 'usage') {
      this.usageTracker.record('stt', { audioInputMs: event.audioDurationMs, durationMs: event.processingLatencyMs ?? 0 });
      return;
    }
    if (event.type === 'error') {
      await this.#recover(Object.assign(new Error(event.message), { code: event.code, retryable: event.retryable }), 'stt');
      return;
    }
    if (event.type === 'speech_started') {
      this.utteranceOverlappedAgent = [callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state);
      this.#clearInactivity();
      if ([callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state)) {
        this.#startBargeInConfirmation();
      }
      return;
    }
    if (event.type === 'partial_transcript') {
      this.utteranceOverlappedAgent ??= [callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state);
      await this.#considerTranscriptInterruption(event.text, false);
      return;
    }
    if (event.type === 'speech_ended') {
      this.callerSpeechActive = false;
      this.#clearBargeInTimer();
      try { this.adapters.stt.flush(); } catch (error) { this.log.debug({ err: error, callId: this.call.id }, 'STT flush was not required'); }
      return;
    }
    if (event.type !== 'final_transcript') return;
    const overlappedAgent = this.utteranceOverlappedAgent;
    this.utteranceOverlappedAgent = null;
    this.#clearInactivity();
    const phraseDecision = interruptionDecision(event.text, this.#interruptionOptions());
    if (!phraseDecision.text || (phraseDecision.acknowledgement && overlappedAgent === true)) {
      this.callerSpeechActive = false;
      this.#clearBargeInTimer();
      this.#armInactivity();
      return;
    }
    if (phraseDecision.explicitStop || phraseDecision.callCheck) {
      this.log.info({ stage: 'conversation.phrase_rule', callId: this.call.id, reason: phraseDecision.reason }, 'Configured speech phrase matched');
      await this.#cancelActive(phraseDecision.explicitStop ? 'caller_explicit_stop' : 'caller_call_check');
      if (this.controller.state !== callStates.LISTENING || this.finalized) return;
      const epoch = ++this.epoch;
      await this.controller.receiveFinalTranscript(event.text);
      if (epoch !== this.epoch || this.finalized) return;
      if (phraseDecision.explicitStop) {
        await this.controller.interrupt('caller_requested_listening');
        this.#armInactivity();
      } else {
        void this.#guard('call_check', () => this.#respondToCallCheck(epoch));
      }
      return;
    }
    if ([callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state)) {
      const interrupted = await this.#considerTranscriptInterruption(event.text, true);
      if (!interrupted) return;
    }
    if (this.controller.state !== callStates.LISTENING || !event.text.trim()) return;
    const action = await this.controller.receiveFinalTranscript(event.text);
    const epoch = ++this.epoch;
    void this.#guard('turn', () => this.#runTurn(event.text, action.history, epoch));
  }

  #interruptionOptions() {
    const settings = this.runtimeProfile?.agent?.settings ?? {};
    return {
      confirmationMs: Number(settings.interruptionConfirmationMs ?? env.VOICE_BARGE_IN_CONFIRMATION_MS),
      minimumWords: Number(settings.interruptionMinWords ?? env.VOICE_BARGE_IN_MIN_WORDS),
      acknowledgements: Array.isArray(settings.interruptionAcknowledgements) ? settings.interruptionAcknowledgements : [],
      explicitStopPhrases: Array.isArray(settings.interruptionStopPhrases) ? settings.interruptionStopPhrases : [],
      callCheckPhrases: String(settings.callCheckResponse ?? '').trim() && Array.isArray(settings.callCheckPhrases)
        ? settings.callCheckPhrases : [],
      requireTranscript: ['interruptionAcknowledgements', 'interruptionStopPhrases', 'callCheckPhrases']
        .some((key) => Array.isArray(settings[key])),
    };
  }

  async #respondToCallCheck(epoch) {
    if (this.finalized || epoch !== this.epoch) return;
    const text = String(this.runtimeProfile.agent.settings.callCheckResponse).trim();
    await this.controller.setAssistantResponse(text, Date.now(), [{ type: 'agent_config', label: 'Agent call-check response' }]);
    if (this.finalized || epoch !== this.epoch) return;
    await this.#synthesize(text, `call-check-${epoch}`);
    if (!this.finalized && epoch === this.epoch && this.controller.state === callStates.SPEAKING) {
      await this.controller.playbackComplete();
      this.#armInactivity();
    }
  }

  #clearBargeInTimer() {
    clearTimeout(this.bargeInTimer);
    this.bargeInTimer = null;
  }

  #startBargeInConfirmation() {
    if (!this.callerSpeechActive) {
      this.bargeInStartedAt = Date.now();
      this.bargeInText = '';
    }
    this.callerSpeechActive = true;
    if (this.bargeInTimer) return;
    const { confirmationMs } = this.#interruptionOptions();
    this.log.debug({
      stage: 'conversation.barge_in_candidate', callId: this.call.id,
      decision: 'waiting_for_sustained_speech', confirmationMs,
    }, 'Caller speech detected while agent output is active');
    this.bargeInTimer = setTimeout(() => void this.#guard('barge_in_confirmation', async () => {
      this.bargeInTimer = null;
      if (!this.callerSpeechActive || this.finalized
        || ![callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state)) return;
      const options = this.#interruptionOptions();
      if (options.requireTranscript) {
        // A duration-only decision can fire before STT identifies a long acknowledgement.
        // With phrase rules configured, wait for recognizable words instead.
        if (this.bargeInText) await this.#considerTranscriptInterruption(this.bargeInText, false);
        return;
      }
      this.log.info({
        stage: 'conversation.barge_in_decision', callId: this.call.id,
        decision: 'confirmed', reason: 'sustained_speech', confirmationMs,
      }, 'Sustained caller speech confirmed interruption');
      await this.#cancelActive('caller_barge_in_sustained');
    }), confirmationMs);
    this.bargeInTimer.unref?.();
  }

  async #considerTranscriptInterruption(text, final) {
    if (![callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state)) return false;
    // STT may revise an earlier multi-word partial down to a single word.
    // The confirmation timer must always evaluate the latest transcript.
    this.bargeInText = text;
    const decision = interruptionDecision(text, this.#interruptionOptions());
    this.log[decision.confirmed ? 'info' : 'debug']({
      stage: 'conversation.barge_in_decision', callId: this.call.id,
      decision: decision.confirmed ? 'confirmed' : 'ignored', reason: decision.reason,
      wordCount: decision.wordCount, final,
    }, decision.confirmed ? 'Caller transcript confirmed interruption' : 'Caller transcript did not confirm interruption');
    if (!decision.confirmed) {
      if (final || decision.acknowledgement || decision.callCheck) {
        this.callerSpeechActive = false;
        this.#clearBargeInTimer();
      }
      return false;
    }
    if (!final && !decision.explicitStop) {
      if (!this.callerSpeechActive) this.#startBargeInConfirmation();
      this.bargeInText = text;
      if (Date.now() - this.bargeInStartedAt < this.#interruptionOptions().confirmationMs) return false;
    }
    this.callerSpeechActive = false;
    this.#clearBargeInTimer();
    await this.#cancelActive(decision.explicitStop ? 'caller_barge_in_explicit_stop' : 'caller_barge_in_transcript');
    return true;
  }

  async #knowledge(query, history = [], options = {}) {
    try {
      const routeKnowledge = this.dependencies.routeKnowledge ?? routeKnowledgeQuery;
      const result = await routeKnowledge({
        tenantId: this.runtimeProfile.agent.tenantId,
        workspaceId: this.runtimeProfile.agent.workspaceId,
        userId: null,
        role: 'COMPANY_DEVELOPER',
      }, {
        agentId: this.runtimeProfile.agent.id,
        query,
        usageDirection: this.call.direction,
        language: languageCode(this.runtimeProfile.agent.language),
        routeHint: 'auto',
        history,
        ...(options.includeCatalogHierarchy ? { includeCatalogHierarchy: true } : {}),
      });
      this.runtimeMetrics.knowledge.push({
        route: result.route, found: result.found === true, durationMs: Number(result.durationMs ?? 0),
      });
      return result;
    } catch (error) {
      this.log.warn({ err: error, callId: this.call.id }, 'Knowledge retrieval failed; continuing without unverified context');
      return { route: 'none', found: false, content: null, source: null, error: error.code ?? 'KNOWLEDGE_UNAVAILABLE' };
    }
  }

  #advanceConversationFlow(query, history, knowledge, clock) {
    const state = this.conversationFlowState;
    state.turnNumber += 1;
    state.validationError = null;
    const dateExpression = preferredDateExpression(query);
    if (dateExpression && (state.bookingRequested || bookingIntent.test(String(query ?? '')))) {
      const resolved = resolveRelativeDate(dateExpression, clock);
      state.bookingFields.preferredDateExpression = resolved.isoDate;
      state.bookingFields.preferredDateWeekday = resolved.weekday;
      state.bookingFields.pendingDateMonth = null;
      if (resolved.weekday === 'Sunday') {
        state.validationError = { type: 'sunday_date', isoDate: resolved.isoDate };
      }
    }
    if (state.bookingRequested && appointmentForCallerPattern.test(String(query ?? ''))) {
      state.bookingFields.appointmentFor = 'caller';
    }
    const firstUserTurn = history.filter((message) => message.role === 'user').length === 1;
    if (firstUserTurn) state.stage = 'opening_response';
    if (knowledge?.route === 'catalog') {
      if (knowledge.items?.length) {
        state.lastCatalogItems = knowledge.items.map((item) => ({ key: item.key, name: item.name }));
      }
      if (knowledge.item) {
        state.selectedItem = {
          key: knowledge.item.key ?? null,
          name: knowledge.item.name ?? null,
          preparation: {
            fasting: catalogAttribute(knowledge.item, 'fasting'),
            water: catalogAttribute(knowledge.item, 'water'),
            recommendedVisitTime: catalogAttribute(knowledge.item, 'recommended_visit_time'),
            bringPreviousReports: catalogAttribute(knowledge.item, 'bring_previous_reports'),
          },
        };
        state.selectedCategory = knowledge.item.category ?? state.selectedCategory;
        state.stage = state.bookingRequested ? 'booking_collection' : 'package_explanation';
      } else if (knowledge.candidates || knowledge.ambiguous) {
        state.selectedItem = null;
        state.packageSelectionRequired = true;
        state.stage = 'package_selection';
      } else if (knowledge.category || knowledge.list) {
        state.selectedCategory = knowledge.category ?? null;
        state.stage = 'package_selection';
      }
    }
    if (comparisonIntent.test(String(query ?? ''))) {
      state.selectedItem = null;
      state.packageSelectionRequired = true;
      state.stage = 'package_selection';
    }
    if (bookingIntent.test(String(query ?? ''))) {
      state.bookingRequested = true;
      state.packageSelectionRequired = !state.selectedItem;
      state.stage = state.packageSelectionRequired ? 'package_selection' : 'booking_collection';
    }
    if (state.bookingRequested) {
      const phone = phoneValidation(query, history);
      if (phone?.valid) state.bookingFields.phoneNumber = phone.phoneNumber;
      else if (phone) state.validationError = { type: 'invalid_phone', digitCount: phone.digitCount };

      const dateInput = monthDateInput(query, clock);
      if (dateInput?.incomplete) {
        state.bookingFields.pendingDateMonth = dateInput.month;
        state.validationError = { type: 'incomplete_date', month: dateInput.month };
      } else if (dateInput?.invalid) {
        state.validationError = { type: 'invalid_date' };
      } else if (dateInput?.yearRequired) {
        state.validationError = { type: 'year_required', month: dateInput.month, day: dateInput.day };
      } else if (dateInput?.isoDate) {
        state.bookingFields.preferredDateExpression = dateInput.isoDate;
        state.bookingFields.preferredDateWeekday = dateInput.weekday;
        state.bookingFields.pendingDateMonth = null;
        if (dateInput.weekday === 'Sunday') {
          state.validationError = { type: 'sunday_date', isoDate: dateInput.isoDate };
        }
      } else if (state.bookingFields.pendingDateMonth && /\b\d{1,2}\b/.test(String(query ?? ''))) {
        state.validationError = { type: 'incomplete_date', month: state.bookingFields.pendingDateMonth };
      }
    }
    const pendingUserTurns = unansweredUserTurns(history);
    const hasBookingTool = bookingToolAvailable(this.runtimeProfile.tools);
    return {
      ...state,
      bookingFields: { ...state.bookingFields },
      pendingUserTurns,
      nextBookingField: hasBookingTool ? nextBookingField(state) : null,
      bookingToolAvailable: hasBookingTool,
      firstUserTurn,
      hasApprovedConversationFlow: Boolean(knowledge?.conversationGuidance?.nodes?.length),
    };
  }

  async #llmAttempt(query, history, knowledge, context = {}) {
    const { disableTools = false, ...runtimeContext } = context;
    const session = await createSelectedLlmStream(this.runtimeProfile, {
      callId: this.call.id,
      query,
      history,
      knowledge,
      context: {
        callId: this.call.id,
        direction: this.call.direction,
        clock: runtimeClock(this.runtimeProfile.agent.timezone, this.dependencies.now?.() ?? new Date()),
        availableTools: (this.runtimeProfile.tools ?? []).map((tool) => tool.name),
        preCall: this.preCallContext,
        ...runtimeContext,
      },
      toolsEnabled: !disableTools,
      usageDirection: this.call.direction,
    }, { registry: this.registry, adapter: this.adapters.llm, skipDefaultRegistration: true });
    this.activeLlm = session;
    let text = '';
    let toolCalls = [];
    try {
      for await (const event of session.events) {
        if (event.type === 'text_delta') text += event.delta;
        else if (event.type === 'tool_call') toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
        else if (event.type === 'usage') this.usageTracker.record('llm', event.usage);
        else if (event.type === 'error') throw Object.assign(new Error(event.message), { code: event.code, retryable: event.retryable });
        else if (event.type === 'cancelled') return { cancelled: true, text: '', toolCalls: [] };
        else if (event.type === 'completed') {
          toolCalls = event.toolCalls?.length ? event.toolCalls : toolCalls;
          if (event.durationMs) this.usageTracker.record('llm', { requests: 0, durationMs: event.durationMs });
          this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'llm', this.runtimeProfile.providers.llm, 'success', {
            latencyMs: event.durationMs,
          });
        }
      }
      return { cancelled: false, text: text.trim(), toolCalls };
    } finally {
      if (this.activeLlm === session) this.activeLlm = null;
      await session.close();
    }
  }

  async #llm(query, history, knowledge, context = {}) {
    let lastError;
    for (let attempt = 0; attempt <= env.VOICE_PROVIDER_MAX_RETRIES; attempt += 1) {
      try {
        return await this.#llmAttempt(query, history, knowledge, context);
      } catch (error) {
        lastError = error;
        if (error?.retryable !== true || attempt >= env.VOICE_PROVIDER_MAX_RETRIES) throw error;
        const delayMs = env.VOICE_PROVIDER_RETRY_BASE_MS * (2 ** attempt);
        this.log.warn({
          stage: 'llm.retry', attempt: attempt + 1, delayMs,
          providerId: this.runtimeProfile.providers.llm.providerId,
          modelId: this.runtimeProfile.providers.llm.modelId,
        }, 'Retrying selected LLM after transient failure');
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  async #runTurn(query, history, epoch) {
    const turnStartedAt = Date.now();
    const firstUserTurn = history.filter((message) => message.role === 'user').length === 1;
    const phraseDecision = interruptionDecision(query, this.#interruptionOptions());
    const pendingUserTurns = unansweredUserTurns(history);
    const pendingQuery = pendingUserTurns.length > 1 ? pendingUserTurns.join(' ') : query;
    const retrievalQuery = contextualCatalogQuery(pendingQuery, this.conversationFlowState);
    const knowledge = await this.#knowledge(retrievalQuery, history, {
      includeCatalogHierarchy: firstUserTurn && phraseDecision.acknowledgement,
    });
    if (epoch !== this.epoch || this.finalized) return;
    const clock = runtimeClock(this.runtimeProfile.agent.timezone, this.dependencies.now?.() ?? new Date());
    const flowState = this.#advanceConversationFlow(query, history, knowledge, clock);
    const missingPackage = bookingIntent.test(String(query ?? '')) && flowState.packageSelectionRequired
      && flowState.pendingUserTurns.length === 1 && flowState.bookingToolAvailable
      ? missingPackageSelectionAnswer(this.runtimeProfile.agent.language) : null;
    const exactPrice = exactCatalogPriceAnswer(query, knowledge, this.runtimeProfile.agent.language);
    const unverifiedPrice = unverifiedCatalogPriceAnswer(query, knowledge);
    let response = missingPackage || exactPrice || unverifiedPrice
      ? { cancelled: false, text: missingPackage ?? exactPrice ?? unverifiedPrice, toolCalls: [] }
      : null;
    if (!response) {
      try {
        response = await this.#llm(query, history, knowledge, { conversationFlow: flowState });
      } catch (error) {
        this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'llm', this.runtimeProfile.providers.llm, 'failure', {
          code: error.code,
        });
        if (!knowledge.found || !String(knowledge.content ?? '').trim()) throw error;
        this.log.warn({
          stage: 'llm.verified_knowledge_fallback', code: error.code,
          providerId: this.runtimeProfile.providers.llm.providerId,
        }, 'Selected LLM failed; using verified knowledge response for this call');
        response = { cancelled: false, text: String(knowledge.content).trim(), toolCalls: [] };
      }
    }
    if (response.cancelled || epoch !== this.epoch) return;
    let toolUsed = false;
    let verifiedToolSuccess = false;
    if (response.toolCalls.length) {
      toolUsed = true;
      const toolResults = await (this.dependencies.executeTools ?? executeAgentTools)(
        this.runtimeProfile, this.call, response.toolCalls, { fetchImpl: this.dependencies.fetchImpl },
      );
      this.runtimeMetrics.tools.push(...toolResults.map((result) => ({
        name: result.name, success: result.success, durationMs: Number(result.durationMs ?? 0),
      })));
      const successful = toolResults.length > 0 && toolResults.every((result) => result.success === true);
      verifiedToolSuccess = successful;
      this.conversationFlowState.lastAction = {
        names: toolResults.map((result) => result.name), successful,
      };
      const bookingAction = toolResults.some((result) => /(?:appointment|book|booking|schedule|visit)/i
        .test(String(result.name ?? '')));
      if (successful && bookingAction) {
        this.conversationFlowState.bookingRequested = false;
        this.conversationFlowState.packageSelectionRequired = false;
        this.conversationFlowState.bookingFields = { appointmentFor: null, preferredDateExpression: null };
      }
      this.conversationFlowState.stage = successful ? 'action_completed' : 'action_failed';
      if (epoch !== this.epoch) return;
      response = await this.#llm(query, history, knowledge, {
        conversationFlow: { ...this.conversationFlowState },
        toolResults,
        disableTools: true,
        instruction: 'Use these tool results to answer the caller. Never claim an unsuccessful tool completed.',
      });
      if (!String(response.text ?? '').trim()) {
        response = { ...response, text: toolResultFallback(toolResults, this.runtimeProfile.agent.language, query), toolCalls: [] };
      }
    }
    if (response.cancelled || epoch !== this.epoch || this.finalized) return;
    if (!verifiedToolSuccess && hasUnverifiedActionProgressClaim(response.text)) {
      this.log.warn({ stage: 'tool.unverified_claim_blocked', callId: this.call.id }, 'Unverified action claim was blocked');
      response = { ...response, text: unverifiedActionResponse(this.runtimeProfile), toolCalls: [] };
    }
    const answer = normalizeVoiceResponse(enforceNextBookingQuestion(
      response.text || String(this.runtimeProfile.agent.settings?.noResponseMessage ?? 'Sorry, I could not form a response.'),
      toolUsed ? { ...flowState, nextBookingField: null } : flowState,
      this.runtimeProfile.agent.language,
    ));
    await this.controller.setAssistantResponse(answer, Date.now(), answerSources(knowledge, { toolUsed }));
    await this.#synthesize(answer, `turn-${epoch}`, { kind: 'response', startedAt: turnStartedAt });
    if (epoch !== this.epoch || this.finalized || this.controller.state !== callStates.SPEAKING) return;
    await this.controller.playbackComplete();
    this.errorCount = 0;
    this.#armInactivity();
  }

  async #synthesizeWelcome(text, generationId) {
    const cached = await this.cachedWelcomePromise;
    if (cached?.length) {
      this.audioEngine.beginOutputGeneration(generationId);
      this.runtimeMetrics.latency.welcomeCacheHit = true;
      this.runtimeMetrics.latency.welcomeAudioStartMs = Math.max(0, Date.now() - this.mediaStartedAt);
      await this.audioEngine.enqueueSynthesized(cached, generationId);
      await this.audioEngine.flushSynthesized(generationId);
      await this.audioEngine.drainOutput();
      return true;
    }
    const chunks = [];
    const result = await this.#synthesize(text, generationId, {
      kind: 'welcome', startedAt: this.mediaStartedAt, capture: chunks,
    });
    this.runtimeMetrics.latency.welcomeCacheHit = false;
    if (result && chunks.length && !this.personalizedWelcome) {
      void this.welcomeCache.set(this.runtimeProfile, text, Buffer.concat(chunks));
    }
    return result;
  }

  async #synthesizeAttempt(text, generationId, options = {}) {
    this.audioEngine.beginOutputGeneration(generationId);
    let completed = false;
    let firstAudio = true;
    try {
      for await (const event of this.adapters.tts.synthesizeStream({ text, generationId })) {
        if (event.type === 'audio_chunk') {
          if (firstAudio) {
            firstAudio = false;
            const latencyMs = Math.max(0, Date.now() - (options.startedAt ?? Date.now()));
            if (options.kind === 'welcome') this.runtimeMetrics.latency.welcomeAudioStartMs = latencyMs;
            if (options.kind === 'response') {
              this.runtimeMetrics.latency.firstResponseAudioMs ??= [];
              this.runtimeMetrics.latency.firstResponseAudioMs.push(latencyMs);
            }
          }
          if (options.capture) options.capture.push(Buffer.from(event.audio));
          if (!await this.audioEngine.enqueueSynthesized(event.audio, generationId)) return false;
        } else if (event.type === 'usage') this.usageTracker.record('tts', event.usage);
        else if (event.type === 'completed') {
          completed = true;
          this.providerHealth.record(this.runtimeProfile.agent.tenantId, 'tts', this.runtimeProfile.providers.tts, 'success', {
            latencyMs: event.firstAudioLatencyMs,
          });
        }
        else if (event.type === 'cancelled') return false;
        else if (event.type === 'error') throw Object.assign(new Error(event.message), { code: event.code, retryable: event.retryable });
      }
    } catch (error) {
      error.audioStarted = !firstAudio;
      throw error;
    }
    if (!completed) throw new AppError(502, 'TTS stream ended without completion', 'TTS_STREAM_INCOMPLETE');
    await this.audioEngine.flushSynthesized(generationId);
    await this.audioEngine.drainOutput();
    return true;
  }

  async #synthesize(text, generationId, options = {}) {
    this.#clearInactivity();
    this.activeSynthesisCount += 1;
    try {
      let lastError;
      const transientTransportRetries = Math.max(env.VOICE_PROVIDER_MAX_RETRIES, 3);
      for (let attempt = 0; attempt <= transientTransportRetries; attempt += 1) {
        try {
          return await this.#synthesizeAttempt(text, generationId, options);
        } catch (error) {
          lastError = error;
          const retryLimit = error?.code === 'TTS_PROVIDER_UNAVAILABLE'
            ? transientTransportRetries : env.VOICE_PROVIDER_MAX_RETRIES;
          const canRetry = error?.retryable === true && error.audioStarted !== true
            && attempt < retryLimit;
          if (!canRetry) throw error;
          if (options.capture) options.capture.length = 0;
          const delayMs = env.VOICE_PROVIDER_RETRY_BASE_MS * (2 ** attempt);
          this.log.warn({
            stage: 'tts.retry', attempt: attempt + 1, delayMs,
            providerId: this.runtimeProfile.providers.tts.providerId,
            modelId: this.runtimeProfile.providers.tts.modelId,
          }, 'Retrying selected TTS before audio playback started');
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      throw lastError;
    } finally {
      this.activeSynthesisCount = Math.max(0, this.activeSynthesisCount - 1);
    }
  }

  async #onDtmf(digit) {
    await this.ready;
    if (digit === '#') await this.#close('caller_pressed_hash');
  }

  async #cancelActive(reason = 'cancelled', transition = true) {
    this.callerSpeechActive = false;
    this.#clearBargeInTimer();
    this.epoch += 1;
    this.activeLlm?.cancel(reason);
    this.adapters?.llm?.cancel?.(reason);
    this.adapters?.tts?.cancel?.(reason);
    this.audioEngine?.cancelStaleAudio?.(reason);
    if (transition && this.controller && [callStates.GREETING, callStates.THINKING, callStates.SPEAKING].includes(this.controller.state)) {
      await this.controller.interrupt(reason);
    }
  }

  #clearInactivity() {
    clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  #armInactivity() {
    this.#clearInactivity();
    if (this.finalized || this.activeSynthesisCount > 0 || this.controller.state !== callStates.LISTENING) return;
    const seconds = Number(this.runtimeProfile.agent.inactivityTimeoutSeconds ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.inactivityTimer = setTimeout(() => void this.#guard('inactivity', () => this.#handleInactivity()), seconds * 1000);
    this.inactivityTimer.unref?.();
  }

  async #handleInactivity() {
    if (this.finalized || this.activeSynthesisCount > 0 || this.controller.state !== callStates.LISTENING) return;
    const action = await this.controller.handleSilence();
    if (action.action === 'close') return this.#close(action.reason);
    if (action.action !== 'inactivity_response') return;
    await this.controller.setAssistantResponse(action.text, Date.now(), [{ type: 'agent_config', label: 'Agent inactivity message' }]);
    const epoch = ++this.epoch;
    await this.#synthesize(action.text, `silence-${epoch}`);
    if (epoch === this.epoch && this.controller.state === callStates.SPEAKING) {
      await this.controller.playbackComplete();
      this.#armInactivity();
    }
  }

  async #closingMessage(reason) {
    const prompt = String(this.runtimeProfile.integrations?.postCall?.prompt ?? '').trim();
    const dynamic = String(this.runtimeProfile.integrations?.postCall?.messageType ?? '').toLowerCase() === 'dynamic'
      || this.runtimeProfile.integrations?.postCall?.dynamicClosing === true;
    if (!dynamic && !prompt) return fallbackClosing(this.runtimeProfile);
    try {
      const response = await this.#llm(
        `End the call now. Reason: ${reason}. Generate one brief natural closing sentence.${prompt ? ` Closing instruction: ${prompt}` : ''}`,
        this.controller.history,
        { route: 'none', found: false },
        { closingReason: reason },
      );
      return response.text || fallbackClosing(this.runtimeProfile);
    } catch { return fallbackClosing(this.runtimeProfile); }
  }

  async #close(reason) {
    if (this.closing || this.finalized) return;
    this.closing = true;
    this.#clearInactivity();
    await this.#cancelActive(reason);
    await this.controller.requestClose(reason);
    const message = await this.#closingMessage(reason);
    if (message && !this.mediaSession.closed) {
      await this.controller.recordAssistantMessage(message, Date.now(), [{ type: 'agent_config', label: 'Agent closing message' }]);
      try { await this.#synthesize(message, `closing-${this.epoch}`); } catch (error) {
        this.log.warn({ err: error, callId: this.call.id }, 'Dynamic closing audio failed');
      }
    }
    await this.#finalize('completed', reason);
    if (!this.mediaSession.closed) this.mediaSession.close(1000, reason);
  }

  async #recover(error, stage) {
    if (this.finalized) return;
    if (this.recoveryActive) {
      this.log.warn({ stage, callId: this.call.id }, 'Duplicate voice recovery was suppressed');
      return;
    }
    this.recoveryActive = true;
    try {
    this.errorCount += 1;
    const kind = stage === 'stt' ? 'stt' : (stage.startsWith('tts') || stage === 'audio_output' ? 'tts' : (stage.startsWith('llm') || stage === 'turn' ? 'llm' : null));
    if (kind) this.providerHealth.record(
      this.runtimeProfile?.agent?.tenantId,
      kind,
      this.runtimeProfile?.providers?.[kind] ?? {},
      'failure',
      { code: error?.code },
    );
    this.log.error({ err: error, icon: '⚠️', stage, callId: this.call.id, recoverableAttempt: this.errorCount }, '⚠️ Voice pipeline error');
    if (!this.controller || this.errorCount > env.VOICE_RUNTIME_MAX_RECOVERABLE_ERRORS || error?.retryable === false) {
      await this.#finalize('failed', error?.code ?? `${stage}_failed`);
      if (!this.mediaSession.closed) this.mediaSession.close(1011, 'voice runtime failed');
      return;
    }
    await this.#cancelActive(`${stage}_recovery`);
    if (stage === 'stt' && error?.retryable) {
      try { await this.adapters.stt.connect(); } catch { return this.#finalize('failed', 'stt_reconnect_failed'); }
    }
    const ttsFailed = stage === 'audio_output' || stage.startsWith('tts') || String(error?.code ?? '').startsWith('TTS_');
    if (!ttsFailed && this.controller.state === callStates.LISTENING) {
      try {
        const message = fallbackRecovery(this.runtimeProfile);
        await this.controller.beginSystemResponse('error_recovery');
        await this.controller.setAssistantResponse(message, Date.now(), [{ type: 'agent_config', label: 'Agent recovery message' }]);
        await this.#synthesize(message, `recovery-${this.epoch}`);
        if (this.controller.state === callStates.SPEAKING) await this.controller.playbackComplete();
      } catch (recoveryError) {
        this.log.error({ err: recoveryError, callId: this.call.id }, 'Voice error recovery message failed');
      }
    }
    this.#armInactivity();
    } finally {
      this.recoveryActive = false;
    }
  }

  async #finalize(outcome, reason) {
    if (this.finalized) return;
    this.finalized = true;
    this.#clearInactivity();
    this.callerSpeechActive = false;
    this.#clearBargeInTimer();
    this.epoch += 1;
    this.activeLlm?.cancel(reason);
    this.adapters?.tts?.cancel?.(reason);
    this.unsubscribeStt?.();
    await this.audioEngine?.close?.();
    if (!this.controller || !this.runtimeProfile || !this.usageTracker) return;
    try {
      await (this.dependencies.completeCall ?? completeVoiceCall)({
        controller: this.controller,
        runtimeProfile: this.runtimeProfile,
        usageTracker: this.usageTracker,
        adapters: this.adapters ?? {},
        outcome,
        reason,
        metrics: this.runtimeMetrics,
      }, this.dependencies.completionDependencies ?? {});
    } catch (error) {
      this.log.error({ err: error, callId: this.call.id }, 'Voice call finalization failed');
    }
  }
}

export function attachRealtimeConversationOrchestrator(mediaSession, dependencies = {}) {
  return new RealtimeConversationOrchestrator(mediaSession, dependencies);
}
