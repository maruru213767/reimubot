
import {
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import config from './config.json' with { type: 'json' };

const commands = [
  new SlashCommandBuilder()
    .setName('set')
    .setDescription('このチャンネルでお話するよ'),

  new SlashCommandBuilder()
    .setName('unset')
    .setDescription('お話をやめるよ'),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(config.token);

try {
  await rest.put(
    Routes.applicationGuildCommands(
      config.clientId,
      config.guildId
    ),
    { body: commands }
  );

  console.log('コマンドを登録したよ');
} catch (error) {
  console.error('コマンド登録に失敗したよ:', error);
}
