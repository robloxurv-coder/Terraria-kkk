import { randomUUID } from 'node:crypto';

function integer(value, fallback, min, max, name) {
  const text = String(value ?? fallback);
  const result = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${name} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return result;
}

export function readConfig(env) {
  const host = env.SERVER_HOST?.trim();
  if (!host || /[\s/\x00-\x1f]/u.test(host)) {
    throw new Error('defina SERVER_HOST no .env, sem protocolo ou porta.');
  }
  const name = (env.CHARACTER_NAME ?? 'TerrariaBot').trim();
  // O servidor valida String.Length (.NET), isto é, unidades UTF-16.
  if (!name || name.length > 20 || /[\x00-\x1f\x7f]/u.test(name)) {
    throw new Error('CHARACTER_NAME deve conter de 1 a 20 caracteres, sem controles.');
  }
  const mode = env.CHARACTER_MODE ?? 'classic';
  if (!['classic', 'journey'].includes(mode)) {
    throw new Error('CHARACTER_MODE deve ser classic ou journey.');
  }
  const password = env.SERVER_PASSWORD ?? '';
  if (Buffer.byteLength(password) > 1024) throw new Error('SERVER_PASSWORD muito longa.');
  return {
    host,
    port: integer(env.SERVER_PORT, 7782, 1, 65535, 'SERVER_PORT'),
    name,
    password,
    journey: mode === 'journey',
    uuid: randomUUID(), // Mantido durante todas as reconexões deste processo.
    reconnectDelayMs: integer(env.RECONNECT_DELAY_MS, 5000, 1000, 60000, 'RECONNECT_DELAY_MS'),
    connectTimeoutMs: 15000,
    joinTimeoutMs: 120000,
    idleTimeoutMs: 60000,
    heartbeatMs: 1000,
  };
}
