import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import {
  VERSION, INVENTORY_SLOTS, Reader, PacketDecoder, packet, text,
  playerInfo, emptyInventoryItem, requestTiles, spawn, controls, worldInfo,
  isInventorySlot, INVENTORY_SLOT_RANGES, readControls, readTeleport, teleportAck,
} from '../src/protocol.js';

test('versão e layouts alterados em Terraria 1.4.5.8', () => {
  assert.equal(packet(1, text(VERSION)).toString('hex'), '0f00010b5465727261726961333236');
  assert.equal(INVENTORY_SLOTS, 350);
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
  assert.equal(readConfig(env).maxReconnectAttempts, 5);
  assert.equal(readConfig(env).maxProtocolReconnectAttempts, 1);
  assert.equal(readConfig(env).protocolReconnectDelayMs, 60000);
  for (const [key, invalid] of [['MAX_RECONNECT_ATTEMPTS', '21'], ['MAX_PROTOCOL_RECONNECT_ATTEMPTS', '4']]) {
    assert.throws(() => readConfig({ ...env, [key]: invalid }));
    assert.throws(() => readConfig({ ...env, [key]: '-1' }));
    assert.equal(readConfig({ ...env, [key]: '0' })[key === 'MAX_RECONNECT_ATTEMPTS' ? 'maxReconnectAttempts' : 'maxProtocolReconnectAttempts'], 0);
  }
});

test('regressão: IDs reservados não são posições existentes nos bancos', () => {
  // Oráculo independente: limites inclusivos dos arrays do servidor 1.4.5.8.
  const valid = [[0, 138], [299, 338], [499, 539], [700, 739], [900, 989]];
  let accepted = 0;
  for (let slot = -1; slot <= 1000; slot++) {
    const expected = valid.some(([first, last]) => slot >= first && slot <= last);
    assert.equal(isInventorySlot(slot), expected, `slot=${slot}`);
    if (expected) {
      const data = emptyInventoryItem(254, slot);
      assert.equal(data.length, 9);
      assert.equal(data.readInt16LE(1), slot);
      assert.deepEqual([...data.subarray(3)], [0, 0, 0, 0, 0, 0]);
      accepted++;
    } else {
      assert.throws(() => emptyInventoryItem(0, slot), /inventário inválido/);
    }
  }
  assert.equal(accepted, 350);
  assert.equal(INVENTORY_SLOT_RANGES.reduce((total, [, count]) => total + count, 0), accepted);
  assert.throws(() => emptyInventoryItem(0, 139), /139/);
  for (const slot of [NaN, Infinity, 1.5, '0', null]) assert.throws(() => emptyInventoryItem(0, slot));
});

test('serializadores rejeitam jogador, estatística e coordenada inválidos', () => {
  for (const slot of [-1, 255, 256, NaN, 1.5, null]) {
    assert.throws(() => playerInfo(slot, 'Bot'));
    assert.throws(() => emptyInventoryItem(slot, 0));
    assert.throws(() => spawn(slot));
    assert.throws(() => controls(slot, 0, 0));
    assert.throws(() => teleportAck(slot));
  }
  for (const id of [-1, 256, 1.5, NaN]) assert.throws(() => packet(id));
  for (const x of [NaN, Infinity, 1e100]) assert.throws(() => controls(0, x, 0));
  assert.throws(() => playerInfo(0, ''));
  assert.throws(() => spawn(0, 4));
});

test('PlayerControls consome todos os campos opcionais de 1.4.5.8', () => {
  const base = controls(7, 20, 30);
  assert.deepEqual([...base.subarray(0, 6)], [7, 64, 16, 0, 0, 0]);
  assert.deepEqual(readControls(base), { slot: 7, x: 20, y: 30 });
  base[2] |= 4 | 128;
  base[3] |= 64;
  base[4] |= 32;
  const full = Buffer.concat([base, Buffer.alloc(8 + 2 + 16 + 8)]);
  assert.deepEqual(readControls(full), { slot: 7, x: 20, y: 30 });
  for (let length = 0; length < full.length; length++) {
    assert.throws(() => readControls(full.subarray(0, length)));
  }
  assert.throws(() => readControls(Buffer.concat([full, Buffer.from([0])])));
});

test('ACK de teleporte é tipo 3 com payload completo de 12 bytes', () => {
  assert.equal(teleportAck(7).toString('hex'), '030700000000000000000000');
  const teleport = Buffer.alloc(16);
  teleport[0] = 8; // Tipo 0, informação extra int32 presente.
  teleport.writeInt16LE(7, 1);
  teleport.writeFloatLE(20, 3);
  teleport.writeFloatLE(30, 7);
  teleport[11] = 1;
  teleport.writeInt32LE(42, 12);
  assert.deepEqual(readTeleport(teleport), { entity: 7, type: 0, useCurrentPosition: false, x: 20, y: 30 });
  for (let length = 0; length < teleport.length; length++) {
    assert.throws(() => readTeleport(teleport.subarray(0, length)));
  }
});
