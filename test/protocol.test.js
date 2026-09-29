import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import {
  VERSION, INVENTORY_SLOTS, Reader, PacketDecoder, packet, text,
  playerInfo, emptyInventoryItem, requestTiles, spawn, controls, worldInfo,
} from '../src/protocol.js';

test('versão e layouts alterados em Terraria 1.4.5.8', () => {
  assert.equal(packet(1, text(VERSION)).toString('hex'), '0f00010b5465727261726961333236');
  assert.equal(INVENTORY_SLOTS, 990);
  const r = new Reader(playerInfo(7, 'Bot', true));
  assert.equal(r.u8(), 7);
  assert.equal(r.u8(), 0);
  assert.equal(r.u8(), 1);
  assert.equal(r.f32(), 0);
  assert.equal(r.u8(), 0);
  assert.equal(r.string(), 'Bot');
  r.take(25);
  assert.deepEqual([...r.take(3)], [8, 0, 0]);
  assert.equal(r.offset, r.buffer.length);
  assert.equal(emptyInventoryItem(7, 989).toString('hex'), '07dd03000000000000');
  assert.equal(requestTiles().toString('hex'), 'ffffffffffffffff00');
  assert.equal(spawn(7).toString('hex'), '07ffffffff00000000000000000001');
  assert.equal(controls(7, 20, 30).length, 14);
});

test('strings UTF-8 usam comprimento 7-bit do BinaryWriter', () => {
  for (const input of ['', 'João', 'ç'.repeat(180)]) {
    assert.equal(new Reader(text(input)).string(), input);
  }
  assert.throws(() => new Reader(Buffer.from([0x80])).string());
  assert.throws(() => new Reader(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x7f])).string());
});

test('enquadramento aceita fragmentos de um byte e pacotes concatenados', () => {
  const frames = [packet(3, Buffer.from([5, 0])), packet(49), packet(129)];
  for (const fragment of [1, 2, 5, 100]) {
    const received = [];
    const decoder = new PacketDecoder((id, data) => received.push(packet(id, data)));
    const stream = Buffer.concat(frames);
    for (let i = 0; i < stream.length; i += fragment) decoder.push(stream.subarray(i, i + fragment));
    assert.deepEqual(received, frames);
  }
});

test('enquadramento rejeita tamanho inválido e suporta tamanho máximo', () => {
  for (const length of [0, 1, 2]) {
    assert.throws(() => new PacketDecoder(() => {}).push(Buffer.from([length, 0])));
  }
  const frame = packet(10, Buffer.alloc(65532, 42));
  let received;
  const decoder = new PacketDecoder((id, payload) => { received = packet(id, payload); });
  decoder.push(frame.subarray(0, 100));
  decoder.push(frame.subarray(100));
  assert.deepEqual(received, frame);
  assert.throws(() => packet(10, Buffer.alloc(65533)));
});

test('motivo de kick literal e localizado', () => {
  assert.equal(new Reader(Buffer.concat([Buffer.from([0]), text('Senha inválida')])).networkText(), 'Senha inválida');
  const reason = Buffer.concat([Buffer.from([2]), text('Net.NameInUse'), Buffer.from([1, 0]), text('Bot')]);
  assert.equal(new Reader(reason).networkText(), 'Net.NameInUse (Bot)');
  assert.throws(() => new Reader(Buffer.from([3])).networkText());
});

test('validação da configuração e mundo', () => {
  const env = { SERVER_HOST: '127.0.0.1', CHARACTER_NAME: 'João' };
  assert.equal(readConfig(env).port, 7782);
  for (const port of ['0', '65536', '12x', '1.5', '']) {
    assert.throws(() => readConfig({ ...env, SERVER_PORT: port }));
  }
  assert.throws(() => readConfig({}));
  assert.throws(() => readConfig({ ...env, CHARACTER_NAME: 'a'.repeat(21) }));
  assert.throws(() => readConfig({ ...env, CHARACTER_NAME: '\n' }));
  assert.throws(() => readConfig({ ...env, CHARACTER_MODE: 'invalid' }));
  assert.throws(() => worldInfo(Buffer.alloc(14)));
});
