// Layouts conferidos no servidor dedicado oficial 1.4.5.8:
// https://terraria.org/api/download/pc-dedicated-server/terraria-server-1458.zip
// Não usar "Terraria1.4.5.8" nem o protocolo 279 (1.4.4.9).
export const VERSION = 'Terraria326';
// PlayerItemSlotID reserva 200 IDs por banco, mas Chest.CreateBank cria
// arrays de 40 itens. Count=990 é o limite de IDs, NÃO uma faixa contínua.
// Faixas [início, quantidade] verificadas em PlayerItemSlotID, Player e Chest.
export const INVENTORY_SLOT_RANGES = Object.freeze([
  [0, 59], [59, 20], [79, 10], [89, 5], [94, 5],
  [99, 40], [299, 40], [499, 1], [500, 40], [700, 40],
  [900, 20], [920, 10], [930, 20], [950, 10], [960, 20], [980, 10],
].map((range) => Object.freeze(range)));
export const INVENTORY_SLOTS = 350; // Quantidade real, não usar como limite de IDs.

export function isInventorySlot(slot) {
  return Number.isInteger(slot) && INVENTORY_SLOT_RANGES.some(
    ([start, count]) => slot >= start && slot < start + count,
  );
}

function playerSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= 255) {
    throw new Error('Slot de jogador inválido (esperado 0..254).');
  }
}

function position(x, y) {
  if (![x, y].every((n) => Number.isFinite(n) && Number.isFinite(Math.fround(n)))) {
    throw new Error('Coordenada inválida.');
  }
}

export function text(value) {
  const data = Buffer.from(value, 'utf8');
  const prefix = [];
  let length = data.length;
  do {
    const next = length & 0x7f;
    length >>>= 7;
    prefix.push(next | (length ? 0x80 : 0));
  } while (length);
  return Buffer.concat([Buffer.from(prefix), data]);
}

export function packet(id, payload = Buffer.alloc(0)) {
  if (!Number.isInteger(id) || id < 0 || id > 255) throw new Error('ID de pacote inválido.');
  const size = payload.length + 3;
  if (size > 65535) throw new Error('Pacote excede 65535 bytes.');
  const result = Buffer.allocUnsafe(size);
  result.writeUInt16LE(size, 0);
  result[2] = id;
  payload.copy(result, 3);
  return result;
}

export class Reader {
  constructor(buffer) { this.buffer = buffer; this.offset = 0; }
  take(size) {
    if (size < 0 || this.offset + size > this.buffer.length) throw new Error('Pacote truncado.');
    const value = this.buffer.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
  u8() { return this.take(1).readUInt8(); }
  i16() { return this.take(2).readInt16LE(); }
  i32() { return this.take(4).readInt32LE(); }
  f32() {
    const value = this.take(4).readFloatLE();
    if (!Number.isFinite(value)) throw new Error('Coordenada inválida.');
    return value;
  }
  string() {
    let length = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      length += (byte & 127) * 2 ** (7 * i);
      if (length > 65535) throw new Error('String de rede muito longa.');
      if (!(byte & 128)) return this.take(length).toString('utf8');
    }
    throw new Error('Comprimento de string inválido.');
  }
  networkText(depth = 0) {
    if (depth > 8) throw new Error('NetworkText muito aninhado.');
    const mode = this.u8();
    if (mode > 2) throw new Error('NetworkText inválido.');
    const value = this.string();
    if (mode === 0) return value;
    const count = this.u8();
    const args = Array.from({ length: count }, () => this.networkText(depth + 1));
    // Sem o catálogo do jogo: preservar a chave e seus argumentos.
    return args.length ? `${value} (${args.join(', ')})` : value;
  }
}

// TCP pode fragmentar um pacote ou entregar vários juntos.
// O buffer é limitado ao tamanho máximo de UM pacote Terraria.
export class PacketDecoder {
  constructor(onPacket) {
    this.buffer = Buffer.allocUnsafe(65535);
    this.used = 0;
    this.expected = 2;
    this.onPacket = onPacket;
  }
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const count = Math.min(this.expected - this.used, chunk.length - offset);
      chunk.copy(this.buffer, this.used, offset, offset + count);
      this.used += count;
      offset += count;
      if (this.used !== this.expected) continue;
      if (this.expected === 2) {
        this.expected = this.buffer.readUInt16LE(0);
        if (this.expected < 3) throw new Error('Comprimento de pacote inválido.');
      } else {
        // Copiar: callbacks podem guardar o conteúdo após a próxima leitura.
        const frame = Buffer.from(this.buffer.subarray(0, this.expected));
        this.used = 0;
        this.expected = 2;
        this.onPacket(frame[2], frame.subarray(3));
      }
    }
  }
}

export function playerInfo(slot, name, journey = false) {
  playerSlot(slot);
  if (typeof name !== 'string' || !name.trim() || name.length > 20 || /[\x00-\x1f\x7f]/u.test(name)) {
    throw new Error('Nome de jogador inválido.');
  }
  const header = Buffer.alloc(8);
  header[0] = slot;
  header[1] = 0; // Aparência.
  header[2] = 1; // Voice variant; pitch float32 nos bytes 3..6 (1.4.5).
  header[7] = 0; // Cabelo.
  const colors = Buffer.from([
    151, 107, 75, 255, 125, 90, 105, 90, 75,
    175, 165, 140, 160, 180, 215, 255, 230, 175, 160, 105, 60,
  ]);
  return Buffer.concat([
    header, text(name), Buffer.alloc(4), // hairDye, visibilidade uint16, hideMisc.
    colors, Buffer.from([journey ? 8 : 0, 0, 0]),
  ]);
}

export function stat(slot, current, maximum) {
  playerSlot(slot);
  if (![current, maximum].every((n) => Number.isInteger(n) && n >= 0 && n <= 32767) || current > maximum) {
    throw new Error('Estatística de jogador inválida.');
  }
  const data = Buffer.alloc(5);
  data[0] = slot;
  data.writeInt16LE(current, 1);
  data.writeInt16LE(maximum, 3);
  return data;
}

// Utilitário preservado, mas NÃO usado pelo cliente passivo ao entrar.
export function emptyInventoryItem(slot, itemSlot) {
  playerSlot(slot);
  if (!isInventorySlot(itemSlot)) throw new Error(`Slot de inventário inválido: ${itemSlot}.`);
  const data = Buffer.alloc(9);
  data[0] = slot;
  data.writeInt16LE(itemSlot, 1);
  // stack int16, prefix byte, type int16, flags byte (novo em 1.4.5).
  return data;
}

export function requestTiles() {
  const data = Buffer.alloc(9);
  data.writeInt32LE(-1, 0);
  data.writeInt32LE(-1, 4);
  return data; // Último byte: equipe.
}

export function worldInfo(data) {
  const r = new Reader(data);
  r.take(6); // Tempo, flags, fase da lua.
  const width = r.i16();
  const height = r.i16();
  const spawnX = r.i16();
  const spawnY = r.i16();
  if (width <= 0 || height <= 0 || spawnX < 0 || spawnX >= width || spawnY < 0 || spawnY >= height) {
    throw new Error('Spawn do mundo inválido.');
  }
  return { width, height, spawnX, spawnY };
}

export function spawn(slot, context = 1) {
  playerSlot(slot);
  if (![0, 1, 2].includes(context)) throw new Error('Contexto de spawn inválido.');
  const data = Buffer.alloc(15);
  data[0] = slot;
  data.writeInt16LE(-1, 1); // Sem cama: usar spawn do mundo.
  data.writeInt16LE(-1, 3);
  // respawnTimer int32, mortes PvE/PvP int16, equipe byte.
  data[14] = context; // 1 = entrada no mundo; 0 = renascimento.
  return data;
}

export function controls(slot, x, y) {
  playerSlot(slot);
  position(x, y);
  const data = Buffer.alloc(14);
  data[0] = slot;
  data[1] = 0x40; // Olhando para a direita, sem pressionar teclas.
  data[2] = 0x10; // Gravidade normal, velocidade zero.
  data.writeFloatLE(x, 6);
  data.writeFloatLE(y, 10);
  return data;
}

// MessageBuffer case 65: responder SOMENTE ao teleporte tipo 0 do próprio
// jogador. Tipo 3 é ACK, não solicita teleporte nem altera o mundo.
export function teleportAck(slot) {
  playerSlot(slot);
  const data = Buffer.alloc(12);
  data[0] = 3;
  data.writeInt16LE(slot, 1);
  return data;
}

export function readControls(data) {
  const r = new Reader(data);
  const slot = r.u8();
  playerSlot(slot);
  r.u8();
  const flags2 = r.u8();
  const flags3 = r.u8();
  const flags4 = r.u8();
  r.u8(); // Item selecionado; nunca o retransmitir.
  const x = r.f32();
  const y = r.f32();
  if (flags2 & 4) { r.f32(); r.f32(); }
  if (flags2 & 128) r.take(2); // Mount uint16.
  if (flags3 & 64) { r.f32(); r.f32(); r.f32(); r.f32(); }
  if (flags4 & 32) { r.f32(); r.f32(); }
  if (r.offset !== data.length) throw new Error('PlayerControls com layout incompatível.');
  return { slot, x, y };
}

export function readTeleport(data) {
  const r = new Reader(data);
  const flags = r.u8();
  const entity = r.i16();
  const x = r.f32();
  const y = r.f32();
  r.u8(); // Estilo.
  if (flags & 8) r.i32(); // Informação extra opcional.
  if (r.offset !== data.length) throw new Error('TeleportEntity com layout incompatível.');
  return { entity, type: flags & 3, useCurrentPosition: Boolean(flags & 4), x, y };
}
