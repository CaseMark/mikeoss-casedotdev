import { createPostgresCompat } from "./postgresCompat";

/**
 * Server-side persistence client.
 *
 * Case DB is Postgres-compatible, so local/dev deployments use the lightweight
 * PostgREST-style compatibility client while the route layer is migrated
 * surgically.
 */
export function createServerDb() {
  return createPostgresCompat();
}

/**
 * Legacy route-handler helper. Express routes should use requireAuth, which
 * reads Better Auth's cookie session.
 */
export async function getUserIdFromRequest(_req: Request): Promise<string> {
  throw new Response("Better Auth session middleware is required", {
    status: 401,
  });
}
