export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE agent_tools
      DROP CONSTRAINT IF EXISTS agent_tools_tenant_id_agent_id_name_key;

    CREATE UNIQUE INDEX agent_tools_active_name_unique_idx
      ON agent_tools (tenant_id, agent_id, name)
      WHERE deleted_at IS NULL;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS agent_tools_active_name_unique_idx;

    ALTER TABLE agent_tools
      ADD CONSTRAINT agent_tools_tenant_id_agent_id_name_key
      UNIQUE (tenant_id, agent_id, name);
  `);
}
