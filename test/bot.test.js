import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { spawn as spawnProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { TerrariaBot } from '../src/bot.js';
import { readConfig } from '../src/config.js';
import { PacketDecoder, Reader, packet, text, controls, teleportAck } from '../src/protocol.js';

async function fixture(t, receive, overrides = {}) {
  const clients = new Set();
  const errors = [];
  const logs = [];
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    const decoder = new PacketDecoder((id, data) => receive(socket, id, data));
    socket.on('data', (chunk) => decoder.push(chunk));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    ...readConfig({ SERVER_HOST: '127.0.0.1' }),
    port: server.address().port,
    reconnectDelayMs: 30, connectTimeoutMs: 300, joinTimeoutMs: 500,
    idleTimeoutMs: 300, heartbeatMs: 20,
    ...overrides,
  };
  const bot = new TerrariaBot(config, { log: (s) => logs.push(s), error: (s) => errors.push(s) });
  t.after(async () => {
    bot.stop();
    for (const socket of clients) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { bot, logs, errors, clients };
}

function sendWorld(socket) {
  const world = Buffer.alloc(14);
  world.writeInt16LE(4200, 6);
  world.writeInt16LE(1200, 8);
  world.writeInt16LE(2100, 10);
  world.writeInt16LE(300, 12);
  socket.write(packet(7, world));
}

test('senha, nenhum inventário, spawn, confirmação real, heartbeat e reconexão', { timeout: 3000 }, async (t) => {
  let connections = 0;
  let inventoryCount = 0;
  let heartbeatCount = 0;
  const { bot, logs } = await fixture(t, (socket, id, data) => {
    if (id === 1) {
      assert.equal(new Reader(data).string(), 'Terraria326');
      connections++;
      inventoryCount = 0;
      socket.write(packet(37));
    } else if (id === 38) {
      assert.equal(new Reader(data).string(), 'secret');
      const frame = packet(3, Buffer.from([4, 0]));
      socket.write(frame.subarray(0, 1));
      socket.write(frame.subarray(1));
    } else if (id === 5) {
      assert.equal(data.length, 9);
      inventoryCount++;
    } else if (id === 6) {
      assert.equal(inventoryCount, 0, 'entrada passiva não envia Message 5');
      sendWorld(socket);
    } else if (id === 8) {
      assert.equal(data.length, 9);
      sendWorld(socket); // Não deve gerar outro pedido de tiles.
      socket.write(Buffer.concat([packet(10, Buffer.alloc(1000)), packet(49)]));
    } else if (id === 12) {
      assert.equal(data.length, 15);
      assert.ok(!logs.includes('Conectado ao servidor.') || connections > 1);
      socket.write(packet(129));
    } else if (id === 13) {
      heartbeatCount++;
      socket.write(packet(18)); // Mantém atividade de leitura no teste.
    }
  }, { password: 'secret' });
  const firstOnline = once(bot, 'online');
  bot.start();
  await firstOnline;
  await wait(70);
  assert.ok(heartbeatCount >= 2);
  assert.equal(bot.x, 33598);
  assert.equal(bot.y, 4758);
  const secondOnline = once(bot, 'online');
  bot.socket.destroy();
  await secondOnline;
  assert.equal(connections, 2);
  assert.ok(logs.includes('Desconectado.'));
  assert.ok(logs.includes('Tentando reconectar...'));
  bot.stop();
  await wait(100);
  assert.equal(connections, 2, 'SIGINT/stop não pode reconectar');
});

test('TCP conectado não é anunciado como entrada no mundo', { timeout: 2000 }, async (t) => {
  const { bot, logs, errors } = await fixture(t, () => {}, { joinTimeoutMs: 60 });
  const closed = once(bot, 'disconnected');
  bot.start();
  await closed;
  bot.stop();
  assert.ok(!logs.includes('Conectado ao servidor.'));
  assert.ok(errors.some((s) => s.includes('Tempo limite')));
});

test('kick mostra motivo sem escapar controles do terminal', { timeout: 2000 }, async (t) => {
  const { bot, logs, errors } = await fixture(t, (socket, id) => {
    if (id === 1) socket.write(packet(2, Buffer.concat([Buffer.from([0]), text('Senha incorreta\x1b[2J')])));
  });
  const closed = once(bot, 'disconnected');
  bot.start();
  await closed;
  bot.stop();
  assert.ok(errors[0].includes('Senha incorreta'));
  assert.ok(!errors[0].includes('\x1b'));
  assert.ok(!logs.includes('Conectado ao servidor.'));
});

test('pacote inválido fecha sessão sem derrubar o processo', { timeout: 2000 }, async (t) => {
  const { bot, errors } = await fixture(t, (socket, id) => {
    if (id === 1) socket.write(Buffer.from([2, 0]));
  });
  const closed = once(bot, 'disconnected');
  bot.start();
  await closed;
  bot.stop();
  assert.ok(errors.some((s) => s.includes('protocolo')));
});

test('servidor silencioso é detectado mesmo com escritas periódicas', { timeout: 2000 }, async (t) => {
  const { bot, errors } = await fixture(t, (socket, id) => {
    if (id === 1) socket.write(packet(3, Buffer.from([0, 0])));
    if (id === 6) sendWorld(socket);
    if (id === 8) socket.write(packet(49));
    if (id === 12) socket.write(packet(129));
  }, { idleTimeoutMs: 80 });
  const online = once(bot, 'online');
  bot.start();
  await online;
  const closed = once(bot, 'disconnected');
  await closed;
  bot.stop();
  assert.ok(errors.some((message) => message.includes('Servidor sem responder.')));
});

test('handshake só envia pacotes passivos e não ecoa inventário ou ações', { timeout: 2000 }, async (t) => {
  const sent = [];
  let requests = 0;
  let spawns = 0;
  const { bot } = await fixture(t, (socket, id, data) => {
    sent.push(id);
    if (id === 1) socket.write(packet(3, Buffer.from([0, 0])));
    if (id === 50) assert.deepEqual([...data], [0, 0, 0]);
    if (id === 147) assert.deepEqual([...data], [0, 0, 0, 0]);
    if (id === 6) sendWorld(socket);
    if (id === 8) {
      requests++;
      socket.write(Buffer.concat([packet(5, Buffer.alloc(9)), packet(49), packet(49)]));
    }
    if (id === 12) { spawns++; socket.write(Buffer.concat([packet(129), packet(129)])); }
    if (id === 13) socket.write(packet(18));
  });
  const online = once(bot, 'online');
  bot.start();
  await online;
  await wait(65);
  assert.deepEqual(sent.slice(0, 10), [1, 4, 68, 16, 42, 50, 147, 6, 8, 12]);
  assert.ok(sent.slice(10).every((id) => id === 13));
  assert.equal(requests, 1);
  assert.equal(spawns, 1);
  for (const id of [5, 17, 21, 28, 61]) assert.throws(() => bot.send(id, Buffer.alloc(0)), /não permitido/);
});

test('teleporte confirma apenas tipo 0 próprio, inclusive posição atual', { timeout: 2000 }, async (t) => {
  let acks = 0;
  const { bot, clients } = await fixture(t, (socket, id, data) => {
    if (id === 1) socket.write(packet(3, Buffer.from([0, 0])));
    if (id === 6) sendWorld(socket);
    if (id === 8) socket.write(packet(49));
    if (id === 12) socket.write(packet(129));
    if (id === 13) socket.write(packet(18));
    if (id === 65) { assert.deepEqual(data, teleportAck(0)); acks++; }
  });
  const online = once(bot, 'online');
  bot.start();
  await online;
  const socket = [...clients][0];
  const frames = [];
  for (const [flags, entity] of [[0, 0], [4, 0], [0, 1], [1, 0], [2, 0], [3, 0]]) {
    const payload = Buffer.alloc(12);
    payload[0] = flags;
    payload.writeInt16LE(entity, 1);
    payload.writeFloatLE(100, 3);
    payload.writeFloatLE(200, 7);
    frames.push(packet(65, payload));
  }
  socket.write(Buffer.concat(frames));
  await wait(60);
  assert.equal(acks, 2);
  assert.equal(bot.x, 100);
  assert.equal(bot.y, 200);
  socket.write(packet(13, controls(0, 300, 400)));
  await wait(30);
  assert.equal(bot.x, 300);
  assert.equal(bot.y, 400);
});

test('spawn breve não zera backoff nem orçamento de reconexão', { timeout: 3000 }, async (t) => {
  let connections = 0;
  const { bot, logs } = await fixture(t, (socket, id) => {
    if (id === 1) { connections++; socket.write(packet(3, Buffer.from([0, 0]))); }
    if (id === 6) sendWorld(socket);
    if (id === 8) socket.write(packet(49));
    if (id === 12) socket.write(packet(129));
    if (id === 13) socket.end();
  }, { maxReconnectAttempts: 3 });
  const halted = once(bot, 'halted');
  bot.start();
  await halted;
  assert.equal(connections, 4);
  assert.deepEqual(logs.filter((s) => s.startsWith('Reconexão ')), [
    'Reconexão 1/3 em 30 ms.', 'Reconexão 2/3 em 60 ms.', 'Reconexão 3/3 em 120 ms.',
  ]);
  await wait(150);
  assert.equal(connections, 4);
  assert.equal(bot.stopped, true);
});

test('erro de protocolo tem cooldown, contexto e limite separado', { timeout: 2000 }, async (t) => {
  let connections = 0;
  const { bot, logs, errors } = await fixture(t, (socket, id) => {
    if (id === 1) { connections++; socket.write(packet(3, Buffer.from([255, 0]))); }
  }, { protocolReconnectDelayMs: 80, maxProtocolReconnectAttempts: 1 });
  const halted = once(bot, 'halted');
  bot.start();
  await halted;
  assert.equal(connections, 2);
  assert.ok(logs.includes('Reconexão 1/5 em 80 ms.'));
  assert.ok(errors.some((s) => s.includes('Slot de jogador inválido') && s.includes('recebido=3')));
  await wait(120);
  assert.equal(connections, 2);
});

test('kick não reconecta automaticamente e fechamento sem motivo é explícito', { timeout: 2000 }, async (t) => {
  let connections = 0;
  const { bot, errors } = await fixture(t, (socket, id) => {
    if (id === 1) { connections++; socket.write(packet(2, Buffer.concat([Buffer.from([0]), text('Versão incompatível')]))); }
  });
  const halted = once(bot, 'halted');
  bot.start();
  await halted;
  await wait(100);
  assert.equal(connections, 1);
  assert.ok(errors.some((s) => s.includes('Versão incompatível')));
  const other = await fixture(t, (socket) => socket.end(), { maxReconnectAttempts: 0 });
  const otherHalted = once(other.bot, 'halted');
  other.bot.start();
  await otherHalted;
  assert.ok(other.errors.some((s) => s.includes('sem motivo informado')));
});

// Opt-in: inicia SOMENTE um servidor local descartável, nunca SERVER_HOST/.env.
// TERRARIA_TEST_SERVER=/caminho/TerrariaServer.bin.x86_64 npm test
const realServer = process.env.TERRARIA_TEST_SERVER;
const soakMs = Number(process.env.TERRARIA_TEST_SOAK_MS ?? 60000);
test('servidor oficial 1.4.5.8: senha, dois clientes e permanência sem Message 5', {
  skip: !realServer,
  timeout: 240000 + (Number.isFinite(soakMs) ? soakMs : 0),
}, async (t) => {
  assert.ok(Number.isInteger(soakMs) && soakMs >= 1000 && soakMs <= 3600000);
  const root = path.resolve('.research/integration');
  await mkdir(root, { recursive: true });
  let serverLog = '';
  const errors = [];
  const clients = [];
  const sent = new Map();
  const executable = path.resolve(realServer);
  const server = spawnProcess(executable, [
    '-world', path.join(root, 'ProtocolTest.wld'), '-autocreate', '1',
    '-worldname', 'ProtocolTest', '-seed', '12345', '-port', '17777',
    '-ip', '127.0.0.1', '-maxplayers', '8', '-password', 'local-test-only',
    '-noupnp', '-savedirectory', root,
  ], {
    cwd: path.dirname(executable),
    env: { ...process.env, HOME: root, XDG_DATA_HOME: root, TMPDIR: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  server.stdin.on('error', () => {});
  server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  let spawnError;
  server.on('error', (error) => { spawnError = error; });
  t.after(async () => {
    for (const bot of clients) bot.stop();
    const exit = once(server, 'close');
    server.stdin.end('exit-nosave\n');
    const killer = setTimeout(() => server.kill('SIGKILL'), 5000);
    await exit;
    clearTimeout(killer);
    await writeFile(path.join(root, 'server.log'), serverLog);
  });
  const deadline = Date.now() + 200000;
  while (!serverLog.includes('Server started')) {
    if (spawnError) throw spawnError;
    assert.equal(server.exitCode, null, serverLog.slice(-4000));
    assert.ok(Date.now() < deadline, serverLog.slice(-4000));
    await wait(100);
  }
  assert.match(serverLog, /Terraria Server v1\.4\.5\.8/);
  async function join(name) {
    const bot = new TerrariaBot({
      ...readConfig({ SERVER_HOST: '127.0.0.1', SERVER_PORT: '17777', CHARACTER_NAME: name, SERVER_PASSWORD: 'local-test-only', MAX_RECONNECT_ATTEMPTS: '0' }),
    }, { log: (s) => t.diagnostic(`${name}: ${s}`), error: (s) => errors.push(`${name}: ${s}`) });
    clients.push(bot);
    const send = bot.send.bind(bot);
    bot.send = (id, payload) => { sent.set(id, (sent.get(id) ?? 0) + 1); return send(id, payload); };
    const online = once(bot, 'online');
    bot.start();
    await Promise.race([online, once(bot, 'halted').then(([reason]) => { throw new Error(reason); })]);
    return bot;
  }
  const first = await join('TerrariaBot');
  await wait(1000);
  const second = await join('SecondClient');
  const started = Date.now();
  while (Date.now() - started < soakMs) {
    assert.equal(first.state, 'online', errors.join('\n'));
    assert.equal(second.state, 'online', errors.join('\n'));
    assert.equal(server.exitCode, null);
    assert.doesNotMatch(serverLog, /Invariant Failed|IndexOutOfRangeException|Error on message/i);
    await wait(250);
  }
  assert.deepEqual(errors, []);
  assert.equal(sent.get(5) ?? 0, 0);
  assert.equal(first.reconnectAttempts, 0);
  assert.equal(second.reconnectAttempts, 0);
  assert.match(serverLog, /TerrariaBot has joined/);
  assert.match(serverLog, /SecondClient has joined/);
  assert.doesNotMatch(serverLog, /has left/);
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ soakMs, errors, sent: Object.fromEntries(sent), first: first.state, second: second.state }, null, 2));
  t.diagnostic(`Permanência de ${soakMs} ms; pacotes enviados: ${JSON.stringify(Object.fromEntries(sent))}`);
});
