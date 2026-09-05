# Browser agent test calls

1. Apply backend migrations (`cd Backend` then `npm run db:migrate`) and restart the backend. Normal backend startup also applies pending migrations.
2. Start/rebuild the frontend. Sign in, open Agents, and choose **Test Agent** on an active agent.
3. Select **Start test call**, allow microphone access, and speak. Use headphones. Mute and End call are available in the dialog; closing the dialog or navigating away ends the connection.
4. After hanging up, the dialog loads the saved transcript and status. Open Reports / Call Logs for the call history, Analytics for totals, and VQA Voice for provider usage and latency. Browser calls display `browser` as the caller/destination and are included in the existing call totals.

Requirements: HTTPS (or localhost), microphone permission, a running backend with PostgreSQL and Redis, configured voice media signing, and working STT/LLM/TTS provider credentials on the agent. No Plivo number or telephone call is required. The existing `VITE_API_BASE_URL` determines the WebSocket host and supports a relative `/api` prefix; production proxies must forward WebSocket upgrades. The bundled nginx configuration does this.

Browser tests use the normal agent prompt, voice, knowledge bases, tools, post-call integration, transcript persistence, and provider usage tracking. Pre-call caller lookup is skipped and the caller name is `Browser test`. Configured tools and post-call integrations run normally. Browser audio recordings are not stored; transcript reports remain available. Calls have a 10-minute limit and consume provider API usage.

`POST /agents/:agentId/test-call` requires an interactive authenticated tenant session and an active agent in that workspace. It returns a short-lived signed media URL, accepted only once for browser calls. Provider credentials stay on the backend. The browser speaks the existing mu-law 8 kHz WebSocket protocol, including playback checkpoints and interruption acknowledgments. Abandoned connection reservations and interrupted server sessions are periodically finalized as failed.

Run `npm run verify:browser-test` in Backend for isolated lifecycle and audio conversion checks, and `npm run verify:browser-call` in Frontend for browser connection, playback, mute, and cleanup checks. Live voice verification requires the configured services and a browser microphone.
