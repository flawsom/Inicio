import { buildApp } from './app.js';
import { env } from './env.js';

const app = await buildApp();
await app.listen({ port: env.PORT, host: '0.0.0.0' });
app.log.info(`Inicio API listening on :${env.PORT}`);
