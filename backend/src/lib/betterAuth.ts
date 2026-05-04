import type { Request } from "express";
import { randomUUID } from "crypto";
import { getPostgresPool } from "./postgresCompat";

// Vercel's file tracer needs static dependency edges, while runtime still needs
// native dynamic import because better-auth is ESM-only in this CommonJS build.
require.resolve("better-auth");
require.resolve("better-auth/node");

type BetterAuthInstance = {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession: (input: { headers: Headers }) => Promise<{
      session: unknown;
      user: { id: string; email?: string | null; name?: string | null } | null;
    } | null>;
  };
};

type BetterAuthNodeModule = {
  toNodeHandler: (auth: BetterAuthInstance) => (req: unknown, res: unknown) => unknown;
  fromNodeHeaders: (headers: Request["headers"]) => Headers;
};

type BetterAuthModule = {
  betterAuth: (options: Record<string, unknown>) => BetterAuthInstance;
};

const importEsm = new Function(
  "specifier",
  "return import(specifier)",
) as <T>(specifier: string) => Promise<T>;

let authPromise: Promise<BetterAuthInstance> | null = null;
let nodeModulePromise: Promise<BetterAuthNodeModule> | null = null;

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function getBetterAuth(): Promise<BetterAuthInstance> {
  if (!authPromise) {
    authPromise = importEsm<BetterAuthModule>("better-auth").then(({ betterAuth }) =>
      betterAuth({
        appName: "Mike",
        baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3001",
        secret: process.env.BETTER_AUTH_SECRET,
        trustedOrigins: [
          process.env.FRONTEND_URL ?? "http://localhost:3000",
          ...splitCsv(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
        ],
        database: getPostgresPool(),
        emailAndPassword: {
          enabled: true,
          minPasswordLength: 8,
          autoSignIn: true,
        },
        advanced: {
          database: {
            generateId: () => randomUUID(),
          },
        },
      }),
    );
  }
  return authPromise;
}

export async function getBetterAuthNodeHandler() {
  const [auth, { toNodeHandler }] = await Promise.all([
    getBetterAuth(),
    getBetterAuthNodeModule(),
  ]);
  return toNodeHandler(auth);
}

async function getBetterAuthNodeModule(): Promise<BetterAuthNodeModule> {
  if (!nodeModulePromise) {
    nodeModulePromise = importEsm<BetterAuthNodeModule>("better-auth/node");
  }
  return nodeModulePromise;
}

export async function getBetterAuthSession(req: Request) {
  const [auth, { fromNodeHeaders }] = await Promise.all([
    getBetterAuth(),
    getBetterAuthNodeModule(),
  ]);
  return auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
}
