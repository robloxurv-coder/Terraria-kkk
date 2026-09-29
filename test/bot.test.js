import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { TerrariaBot } from '../src/bot.js';
import { readConfig } from '../src/config.js';
import { PacketDecoder, Reader, packet, text } from '../src/protocol.js';

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

test('senha, inventário, spawn, confirmação real, heartbeat e reconexão', { timeout: 3000 }, async (t) => {
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
      assert.equal(inventoryCount, 990);
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
  assert.ok(errors.includes('Servidor sem responder.'));
});
