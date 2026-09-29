// Layouts conferidos no servidor dedicado oficial 1.4.5.8:
// https://terraria.org/api/download/pc-dedicated-server/terraria-server-1458.zip
// Não usar "Terraria1.4.5.8" nem o protocolo 279 (1.4.4.9).
export const VERSION = 'Terraria326';
export const INVENTORY_SLOTS = 990; // 4 bancos de 200 slots e 3 loadouts.

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
  const data = Buffer.alloc(5);
  data[0] = slot;
  data.writeInt16LE(current, 1);
  data.writeInt16LE(maximum, 3);
  return data;
}

export function emptyInventoryItem(slot, itemSlot) {
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
  const data = Buffer.alloc(15);
  data[0] = slot;
  data.writeInt16LE(-1, 1); // Sem cama: usar spawn do mundo.
  data.writeInt16LE(-1, 3);
  // respawnTimer int32, mortes PvE/PvP int16, equipe byte.
  data[14] = context; // 1 = entrada no mundo; 0 = renascimento.
  return data;
}

export function controls(slot, x, y) {
  const data = Buffer.alloc(14);
  data[0] = slot;
  data[1] = 0x40; // Olhando para a direita, sem pressionar teclas.
  data[2] = 0x10; // Gravidade normal, velocidade zero.
  data.writeFloatLE(x, 6);
  data.writeFloatLE(y, 10);
  return data;
}
