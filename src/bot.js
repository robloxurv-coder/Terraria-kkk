import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  VERSION, INVENTORY_SLOTS, PacketDecoder, Reader, packet, text,
  playerInfo, stat, emptyInventoryItem, requestTiles, worldInfo, spawn, controls,
} from './protocol.js';

function safeMessage(value) {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f]/gu, '').slice(0, 500);
}

// Cliente passivo: entra e mantém presença; não implementa IA, combate,
// renderização, física completa, comandos ou autenticação de plugins TShock.
export class TerrariaBot extends EventEmitter {
  constructor(config, logger = console) {
    super();
    this.config = config;
    this.logger = logger;
    this.stopped = true;
    this.state = 'offline';
    this.retryDelay = config.reconnectDelayMs;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    this.logger.log('Tentando conectar...');
    this.state = 'connecting';
    this.slot = null;
    this.world = null;
    this.tilesRequested = false;
    this.lastReceived = Date.now();
    const socket = new net.Socket();
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    const decoder = new PacketDecoder((id, data) => {
      if (!socket.destroyed) this.handlePacket(id, data);
    });
    socket.on('connect', () => {
      clearTimeout(this.connectTimer);
      this.state = 'handshake';
      this.send(1, text(VERSION));
      this.joinTimer = setTimeout(() => this.fail('Tempo limite para entrar no mundo.'), this.config.joinTimeoutMs);
      this.tickTimer = setInterval(() => this.tick(), this.config.heartbeatMs);
    });
    socket.on('data', (chunk) => {
      this.lastReceived = Date.now();
      try {
        decoder.push(chunk);
      } catch (error) {
        this.fail(`Erro de protocolo: ${error.message}`);
      }
    });
    socket.on('error', (error) => this.logger.error(`Erro de conexão: ${safeMessage(error.code ?? error.message)}`));
    socket.on('close', () => {
      this.clearSessionTimers();
      this.socket = null;
      this.state = 'offline';
      this.logger.log('Desconectado.');
      this.emit('disconnected');
      if (this.stopped) return;
      const delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, 60000);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.logger.log('Tentando reconectar...');
        this.connect();
      }, delay);
    });
    this.connectTimer = setTimeout(() => this.fail('Tempo limite de conexão TCP.'), this.config.connectTimeoutMs);
    socket.connect({ host: this.config.host, port: this.config.port });
  }

  send(id, payload) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return;
    // Evitar filas ilimitadas caso o outro lado deixe de ler.
    if (this.socket.writableLength > 1024 * 1024) {
      this.fail('Servidor não está consumindo os dados.');
      return;
    }
    this.socket.write(packet(id, payload));
  }

  handlePacket(id, data) {
    const r = new Reader(data);
    switch (id) {
      case 2:
        this.fail(`Servidor encerrou a conexão: ${r.networkText()}`);
        break;
      case 37:
        if (this.state !== 'handshake') throw new Error('Pedido de senha fora de sequência.');
        this.send(38, text(this.config.password));
        break;
      case 3:
        if (this.state !== 'handshake') throw new Error('Slot recebido fora de sequência.');
        this.slot = r.u8();
        r.u8(); // ServerSpecialFlags.
        if (this.slot === 255) throw new Error('Slot de jogador inválido.');
        this.state = 'loading';
        this.sendCharacter();
        this.send(6);
        break;
      case 7:
        if (this.slot === null) throw new Error('Mundo recebido antes do slot.');
        this.world = worldInfo(data);
        if (!this.tilesRequested) {
          this.tilesRequested = true;
          this.send(8, requestTiles());
        }
        break;
      case 49:
        if (this.state !== 'loading' || !this.world) break;
        this.state = 'spawning';
        this.resetPosition();
        this.send(12, spawn(this.slot));
        break;
      case 129: // Confirmação enviada DEPOIS que o servidor aceita o spawn.
        if (this.state !== 'spawning') break;
        this.state = 'online';
        clearTimeout(this.joinTimer);
        this.retryDelay = this.config.reconnectDelayMs;
        this.sendControls();
        this.logger.log('Conectado ao servidor.');
        this.emit('online');
        break;
      case 13: {
        // Respeitar correções de posição enviadas pelo servidor/plugins.
        if (r.u8() !== this.slot) break;
        r.take(5);
        this.x = r.f32();
        this.y = r.f32();
        break;
      }
      case 65: {
        const flags = r.u8();
        const entity = r.i16();
        const x = r.f32();
        const y = r.f32();
        if (entity === this.slot && (flags & 3) !== 1 && !(flags & 4)) {
          this.x = x;
          this.y = y;
          if (this.state === 'online') this.sendControls();
        }
        break;
      }
      // Seções de mapa, entidades e chat são consumidos pelo enquadrador TCP.
      // Não reenviar pacotes desconhecidos nem tratar tráfego como confirmação.
      default:
        break;
    }
  }

  sendCharacter() {
    const { name, uuid, journey } = this.config;
    this.send(4, playerInfo(this.slot, name, journey));
    this.send(68, text(uuid));
    this.send(16, stat(this.slot, 100, 100));
    this.send(42, stat(this.slot, 20, 20));
    this.send(50, Buffer.from([this.slot, 0, 0])); // Buffs terminados por uint16 zero.
    this.send(147, Buffer.from([this.slot, 0, 0, 0]));
    this.socket.cork();
    try {
      for (let slot = 0; slot < INVENTORY_SLOTS; slot++) {
        this.send(5, emptyInventoryItem(this.slot, slot));
      }
      // Não fabricar itens: o personagem passivo começa com inventário vazio.
    } finally {
      this.socket.uncork();
    }
  }

  resetPosition() {
    this.x = this.world.spawnX * 16 + 8 - 10;
    this.y = this.world.spawnY * 16 - 42;
  }

  sendControls() {
    this.send(13, controls(this.slot, this.x, this.y));
  }

  tick() {
    // Keepalive TCP sozinho não mantém uma sessão Terraria ativa.
    // Verificar LEITURAS: escritas periódicas não devem mascarar servidor mudo.
    if (Date.now() - this.lastReceived > this.config.idleTimeoutMs) {
      this.fail('Servidor sem responder.');
      return;
    }
    if (this.state === 'online') this.sendControls();
  }

  fail(message) {
    if (this.socket && !this.socket.destroyed) {
      this.logger.error(safeMessage(message));
      this.socket.destroy();
    }
  }

  clearSessionTimers() {
    clearTimeout(this.connectTimer);
    clearTimeout(this.joinTimer);
    clearInterval(this.tickTimer);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.clearSessionTimers();
    this.socket?.destroy();
  }
}
