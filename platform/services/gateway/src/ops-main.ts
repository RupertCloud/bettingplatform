// Ops service entry point: internal only (Cloud Run --ingress internal, no --allow-unauthenticated).
import { buildOps, parseStaffTokens } from './ops.js';

const env = process.env;

const main = async (): Promise<void> => {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PORT must be a TCP port number');
  const staffTokens = parseStaffTokens(env.STAFF_TOKENS);
  if (staffTokens.length === 0) throw new Error('STAFF_TOKENS is required: nobody could call the ops service');
  const raw = env.MFA_KEY;
  const mfaKey = raw ? Buffer.from(raw, 'base64') : undefined;
  if (!mfaKey || mfaKey.length !== 32) throw new Error('MFA_KEY (32 bytes, base64) is required: staff MFA resets use it');
  const resultSources = env.RESULT_SOURCES === '1' ? 1 : 2;

  const { app } = await buildOps({ databaseUrl, staffTokens, mfaKey, resultSources, trustProxy: false, logger: true });
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  await app.listen({ host: '0.0.0.0', port });
};

main().catch((err: unknown) => {
  console.error('ops failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
