import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { readConfig } from './src/config.js';
import { TerrariaBot } from './src/bot.js';

try {
  // Caminho relativo ao projeto, não ao diretório do terminal.
  loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(`Erro ao ler .env: ${error.message}`);
    process.exit(1);
  }
}

try {
  const bot = new TerrariaBot(readConfig(process.env));
  process.once('SIGINT', () => bot.stop());
  process.once('SIGTERM', () => bot.stop());
  bot.start();
} catch (error) {
  console.error(`Configuração inválida: ${error.message}`);
  process.exitCode = 1;
}
