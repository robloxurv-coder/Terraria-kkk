import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  VERSION, PacketDecoder, Reader, packet, text,
  playerInfo, stat, requestTiles, worldInfo, spawn, controls,
  readControls, readTeleport, teleportAck,
} from './protocol.js';

// Sem inventário, tiles, itens, combate ou comandos de mundo.
const OUTBOUND = new Set([1, 4, 6, 8, 12, 13, 16, 38, 42, 50, 65, 68, 147]);

function safeMessage(value) {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f]/gu, '').slice(0, 500);
}

// Cliente passivo: não implementa IA, combate, física completa ou login TShock.
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
    this.reconnectAttempts = 0;
    this.protocolReconnectAttempts = 0;
    this.retryDelay = this.config.reconnectDelayMs;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    this.logger.log('Tentando conectar...');
    this.state = 'connecting';
    this.slot = null;
    this.world = null;
    this.tilesRequested = false;
    this.passwordSent = false;
    this.onlineSince = null;
    this.failureKind = 'transport';
    this.disconnectReason = null;
    this.lastSentId = null;
    this.lastReceivedId = null;
    this.lastReceived = Date.now();
    const socket = new net.Socket();
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    const decoder = new PacketDecoder((id, data) => {
      if (!socket.destroyed) {
        this.lastReceivedId = id;
        this.handlePacket(id, data);
      }
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
        this.fail(`Erro de protocolo: ${error.message}`, 'protocol');
      }
    });
    socket.on('error', (error) => this.fail(`Erro de conexão: ${error.code ?? error.message}`));
    socket.on('close', () => {
      this.clearSessionTimers();
      if (!this.stopped && !this.disconnectReason) {
        this.disconnectReason = 'Conexão TCP encerrada sem motivo informado; consulte o log do servidor.';
        this.logger.error(`${this.disconnectReason} ${this.sessionContext()}`);
      }
      this.socket = null;
      this.state = 'offline';
      this.logger.log('Desconectado.');
      this.emit('disconnected');
      if (this.stopped) return;
      if (this.failureKind === 'rejected') {
        this.halt('Servidor recusou a sessão; corrija a causa antes de iniciar novamente.');
        return;
      }
      if (this.reconnectAttempts >= this.config.maxReconnectAttempts ||
          (this.failureKind === 'protocol' && this.protocolReconnectAttempts >= this.config.maxProtocolReconnectAttempts)) {
        this.halt('Limite de reconexões atingido; revise os logs antes de iniciar novamente.');
        return;
      }
      this.reconnectAttempts++;
      if (this.failureKind === 'protocol') this.protocolReconnectAttempts++;
      // Entrada breve não reinicia o backoff. Limites totais só reiniciam
      // por start() explícito, nunca automaticamente após um spawn.
      if (this.onlineSince !== null && Date.now() - this.onlineSince >= this.config.stableConnectionMs) {
        this.retryDelay = this.config.reconnectDelayMs;
      }
      const delay = this.failureKind === 'protocol'
        ? Math.max(this.retryDelay, this.config.protocolReconnectDelayMs) : this.retryDelay;
      this.retryDelay = Math.min(Math.max(delay, this.retryDelay) * 2, 60000);
      this.logger.log(`Reconexão ${this.reconnectAttempts}/${this.config.maxReconnectAttempts} em ${delay} ms.`);
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
    if (!OUTBOUND.has(id)) throw new Error(`Pacote ${id} não permitido no modo passivo.`);
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return;
    if (this.socket.writableLength > 1024 * 1024) {
      this.fail('Servidor não está consumindo os dados.');
      return;
    }
    this.socket.write(packet(id, payload));
    this.lastSentId = id;
  }

  handlePacket(id, data) {
    const r = new Reader(data);
    switch (id) {
      case 2:
        this.fail(`Servidor encerrou a conexão: ${r.networkText()}`, 'rejected');
        break;
      case 37:
        if (this.state !== 'handshake' || this.passwordSent) throw new Error('Pedido de senha fora de sequência.');
        this.passwordSent = true;
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
        this.onlineSince = Date.now();
        this.sendControls();
        this.logger.log('Conectado ao servidor.');
        this.emit('online');
        break;
      case 13: {
        // Respeitar posição do servidor sem retransmitir ações ou itens.
        if (data[0] !== this.slot) break;
        const update = readControls(data);
        this.setPosition(update.x, update.y);
        break;
      }
      case 65: {
        const teleport = readTeleport(data);
        if (teleport.entity !== this.slot || teleport.type !== 0) break;
        if (!['spawning', 'online'].includes(this.state)) throw new Error('Teleporte antes do spawn.');
        if (!teleport.useCurrentPosition) this.setPosition(teleport.x, teleport.y);
        this.send(65, teleportAck(this.slot));
        break;
      }
      // Seções de mapa, inventários, entidades e chat são consumidos pelo
      // enquadrador TCP. Não ecoar pacotes ou tratá-los como confirmação.
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
    this.send(50, Buffer.from([this.slot, 0, 0])); // Terminador uint16 zero.
    this.send(147, Buffer.from([this.slot, 0, 0, 0]));
    // O servidor inicializa os arrays do personagem. O handshake não exige
    // Message 5: não limpar bancos/equipamentos nem sobrescrever itens SSC.
  }

  resetPosition() {
    this.setPosition(this.world.spawnX * 16 + 8 - 10, this.world.spawnY * 16 - 42);
  }

  setPosition(x, y) {
    if (!this.world || !Number.isFinite(x) || !Number.isFinite(y) ||
        x < 0 || y < 0 || x + 20 > this.world.width * 16 || y + 42 > this.world.height * 16) {
      throw new Error('Posição de jogador fora dos limites do mundo.');
    }
    this.x = x;
    this.y = y;
  }

  sendControls() {
    this.send(13, controls(this.slot, this.x, this.y));
  }

  tick() {
    // Escritas periódicas não devem mascarar servidor sem responder.
    if (Date.now() - this.lastReceived > this.config.idleTimeoutMs) {
      this.fail('Servidor sem responder.');
      return;
    }
    if (this.state === 'online') {
      try {
        this.sendControls();
      } catch (error) {
        this.fail(`Erro de protocolo: ${error.message}`, 'protocol');
      }
    }
  }

  sessionContext() {
    return `[estado=${this.state}, recebido=${this.lastReceivedId ?? '-'}, enviado=${this.lastSentId ?? '-'}]`;
  }

  halt(reason) {
    this.stopped = true;
    this.logger.error(reason);
    this.emit('halted', reason);
  }

  fail(message, kind = 'transport') {
    // 'error' pode chegar depois de Socket.destroyed=true; ainda registrar
    // a causa antes de 'close', sem duplicar mensagens para a mesma sessão.
    if (this.socket && !this.disconnectReason) {
      this.failureKind = kind;
      this.disconnectReason = safeMessage(message);
      this.logger.error(`${this.disconnectReason} ${this.sessionContext()}`);
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
