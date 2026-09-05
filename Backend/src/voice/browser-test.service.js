import { randomUUID } from 'node:crypto';
import { withTenantContext, withAuthServiceContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { loadAgentRuntimeProfile } from './providers/provider-config.js';
import { registerImplementedProviderAdapters } from './providers/defaults.js';
import { assertRuntimeAdapterCompatibility } from './providers/registry.js';
import { createVoiceMediaToken } from './plivo-answer.service.js';
import { voiceCallOwnership } from './call-ownership.service.js';

export async function createBrowserTestCall(auth, agentId, dependencies = {}) {
  const context = dependencies.contextRunner ?? withTenantContext;
  const agent = await context(auth, async (client) => {
    const result = await client.query(`SELECT a.usage_direction,
      COALESCE(l.max_total_concurrency,20) AS concurrency_limit
      FROM voice_agents a LEFT JOIN tenant_limits l ON l.tenant_id=a.tenant_id
      WHERE a.id=$1 AND a.tenant_id=$2 AND a.workspace_id=$3
        AND a.status='active' AND a.deleted_at IS NULL`, [agentId, auth.tenantId, auth.workspaceId]);
    if (!result.rowCount) throw new AppError(404, 'Active agent was not found', 'AGENT_NOT_FOUND');
    return result.rows[0];
  });
  const direction = agent.usage_direction === 'outbound' ? 'outbound' : 'inbound';
  const profile = await (dependencies.loadProfile ?? loadAgentRuntimeProfile)({
    agentId, tenantId: auth.tenantId, workspaceId: auth.workspaceId, callDirection: direction,
  });
  registerImplementedProviderAdapters();
  (dependencies.preflight ?? assertRuntimeAdapterCompatibility)(profile);
  const call = { id: randomUUID(), providerCallId: `browser-${randomUUID()}` };
  // Sign before reserving capacity or inserting a row, so missing configuration leaves no orphan.
  const token = (dependencies.createToken ?? createVoiceMediaToken)(call);
  const ownership = dependencies.ownership ?? voiceCallOwnership;
  await ownership.acquire({ tenantId: auth.tenantId, providerCallId: call.providerCallId, limit: Number(agent.concurrency_limit) });
  try {
    await (dependencies.writeContext ?? withAuthServiceContext)((client) => client.query(`INSERT INTO call_sessions
      (id,tenant_id,workspace_id,provider_call_id,agent_id,agent_name,from_number,to_number,direction,status,provider_metadata)
      VALUES($1,$2,$3,$4,$5,$6,'browser','browser',$7,'connected',$8::jsonb)`, [
      call.id, auth.tenantId, auth.workspaceId, call.providerCallId, agentId, profile.agent.name, direction,
      JSON.stringify({ source: 'browser-test', createdBy: auth.userId,
        connectDeadline: new Date(Date.now() + 60_000).toISOString(),
        preCall: { status: 'skipped', context: { customer_name: 'Browser test' } } }),
    ]));
  } catch (error) {
    await ownership.release({ tenantId: auth.tenantId, providerCallId: call.providerCallId });
    throw error;
  }
  return { callId: call.id, providerCallId: call.providerCallId,
    mediaPath: `/webhooks/plivo/media?call_id=${call.id}&token=${encodeURIComponent(token)}`,
    protocol: 'audio.drachtio.org', maxDurationSeconds: 600 };
}

export async function claimBrowserTestCall(call, dependencies = {}) {
  if (call.providerMetadata?.source !== 'browser-test') return;
  const result = await (dependencies.contextRunner ?? withAuthServiceContext)((client) => client.query(
    `UPDATE call_sessions SET answered_at=now(),provider_metadata=provider_metadata||'{"mediaConnected":true}'::jsonb
     WHERE id=$1 AND ended_at IS NULL AND NOT (provider_metadata ? 'mediaConnected')
       AND (provider_metadata->>'connectDeadline')::timestamptz>now() RETURNING id`, [call.id]));
  if (!result.rowCount) throw new AppError(409, 'Browser test connection expired or was already used', 'BROWSER_TEST_EXPIRED');
}

// Also covers permission cancellation, a lost HTTP response, process restart, or initialization failure.
export async function reapBrowserTestCalls(dependencies = {}) {
  const result = await (dependencies.contextRunner ?? withAuthServiceContext)((client) => client.query(
    `UPDATE call_sessions SET status='failed',ended_at=now(),
      duration_seconds=CASE WHEN answered_at IS NULL THEN 0 ELSE GREATEST(0,ceil(extract(epoch FROM (now()-answered_at))))::int END
     WHERE provider_metadata->>'source'='browser-test' AND ended_at IS NULL AND (
       (answered_at IS NULL AND (provider_metadata->>'connectDeadline')::timestamptz<now())
       OR started_at<now()-interval '12 minutes') RETURNING tenant_id,provider_call_id`));
  await Promise.all(result.rows.map((row) => (dependencies.ownership ?? voiceCallOwnership)
    .releaseValidated({ tenantId: row.tenant_id, providerCallId: row.provider_call_id })));
}
