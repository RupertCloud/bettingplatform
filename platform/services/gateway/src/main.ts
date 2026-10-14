// Process entry point: reads configuration from the environment, migrates, listens, and shuts down on SIGTERM.
import { buildGateway } from './gateway.js';

const env = process.env;

const trustProxy = (raw: string | undefined): boolean | string => {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  return raw; // comma-separated addresses or CIDRs
};

const mfaKey = (raw: string | undefined): Buffer | undefined => {
  if (!raw) return undefined;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('MFA_KEY must be 32 bytes, base64-encoded');
  return key;
};

const main = async (): Promise<void> => {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PORT must be a TCP port number');

  const key = mfaKey(env.MFA_KEY);
  const { app } = await buildGateway({
    databaseUrl,
    demo: env.DEMO_MODE === 'true',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o !== ''),
    trustProxy: trustProxy(env.TRUST_PROXY),
    ...(key ? { mfaKey: key } : {}),
    logger: true,
  });
  if (!key) app.log.warn('MFA_KEY not set: using a random key, so MFA enrolments do not survive a restart');

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port });
};

main().catch((err: unknown) => {
  // Configuration and start-up errors only; DATABASE_URL itself is never printed.
  console.error('gateway failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
