
import http from 'node:http';
import 'dotenv/config';
import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ChannelType
} from 'discord.js';

// 環境変数
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

console.log('--- 環境変数チェック ---');
console.log('作業フォルダ:', process.cwd());
console.log('Discord TOKEN:', TOKEN ? '読み込み成功' : '読み込み失敗');
console.log('CLIENT_ID:', CLIENT_ID ? '読み込み成功' : '読み込み失敗');
console.log('------------------------');

// 設定確認
if (!TOKEN || !CLIENT_ID) {
    console.error('TOKEN または CLIENT_ID が設定されていません。');
    process.exit(1);
}

// Discordクライアント
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Render用Webサーバー
const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8'
    });
    res.end('Discord AI Bot is running!');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Webサーバー起動: port ${PORT}`);
});

// スラッシュコマンド
const commands = [
    new SlashCommandBuilder()
        .setName('set')
        .setDescription('AI会話を有効にするチャンネルを指定します')
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('AI会話を有効にするチャンネル')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('unset')
        .setDescription('AI会話を無効にします'),

    new SlashCommandBuilder()
        .setName('personality')
        .setDescription('AIの性格を設定します')
        .addStringOption(option =>
            option
                .setName('prompt')
                .setDescription('AIに設定する性格や口調')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('reset')
        .setDescription('会話履歴をリセットします')
];

client.once('ready', async () => {
    console.log(`ログイン成功: ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands.map(command => command.toJSON()) }
        );

        console.log('スラッシュコマンドの登録が完了しました。');
    } catch (error) {
        console.error('コマンド登録エラー:', error);
    }
});

// Discord接続状況の確認

client.on('debug', message => {
    // トークンを含むログは表示しない
    if (message.includes('Provided token')) return;

    console.log('[Discord DEBUG]', message);
});

client.on('shardReady', shardId => {
    console.log(`[Discord] Shard ${shardId} 接続成功`);
});

client.on('shardDisconnect', (event, shardId) => {
    console.log(`[Discord] Shard ${shardId} 切断コード: ${event.code}`);
});

client.on('shardReconnecting', shardId => {
    console.log(`[Discord] Shard ${shardId} 再接続中`);
});

client.on('shardError', error => {
    console.error('[Discord SHARD ERROR]', error);
});

client.on('error', error => {
    console.error('[Discord ERROR]', error);
});

client.on('warn', message => {
    console.warn('[Discord WARN]', message);
});

console.log('Discordログイン処理を開始します');

client.on('shardResume', shardId => {
    console.log(`[Discord] Shard ${shardId} 接続復帰`);
});

client.on('shardDisconnect', (event, shardId) => {
    console.error('[Discord] 切断詳細:', {
        shardId,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
    });
});

client.on('shardError', error => {
    console.error('[Discord] Shard接続エラー詳細:', error);
});

client.on('invalidated', () => {
    console.error('[Discord] セッションが無効になりました');
});

client.login(TOKEN)
    .then(() => {
        console.log('Discord login() 成功');
    })
    .catch(error => {
        console.error('Discordログインエラー:', error);
        process.exit(1);
    });
