export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    UPDATE api_keys k
    SET revoked_at = COALESCE(k.revoked_at, now()),
        revoke_reason = COALESCE(k.revoke_reason, 'user_permanently_deleted')
    FROM users u
    WHERE k.created_by = u.id
      AND u.platform_role IS NULL
      AND u.deleted_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tenant_memberships active_membership
        WHERE active_membership.user_id = u.id
          AND active_membership.deleted_at IS NULL
      );

    DELETE FROM tenant_memberships membership
    USING users u
    WHERE membership.user_id = u.id
      AND u.platform_role IS NULL
      AND u.deleted_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tenant_memberships active_membership
        WHERE active_membership.user_id = u.id
          AND active_membership.deleted_at IS NULL
      );

    DELETE FROM users u
    WHERE u.platform_role IS NULL
      AND u.deleted_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tenant_memberships membership WHERE membership.user_id = u.id
      );
  `);
}

export async function down() {
  // Permanently deleted credentials cannot be restored.
}
