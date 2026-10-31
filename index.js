
import http from 'node:http';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const DATA_DIR = process.env.DATA_DIR || './data';

console.log('--- 環境変数チェック ---');
console.log('作業フォルダ:', process.cwd());
console.log('Discord TOKEN:', TOKEN ? '読み込み成功' : '読み込み失敗');
console.log('CLIENT_ID:', CLIENT_ID ? '読み込み成功' : '読み込み失敗');
console.log('------------------------');

// 設定確認
if (!TOKEN || !CLIENT_ID || !GEMINI_API_KEY) {
    console.error('TOKEN、CLIENT_ID、GEMINI_API_KEYのいずれかが設定されていません。');
    process.exit(1);
}

// SQLiteデータベース
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'bot.sqlite'));

db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT,
        personality TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_guild
    ON messages(guild_id, id);
`);

// サーバー設定取得
function getSettings(guildId) {
    return db.prepare(
        'SELECT * FROM guild_settings WHERE guild_id = ?'
    ).get(guildId) || {
        guild_id: guildId,
        channel_id: null,
        personality: ''
    };
}

// メッセージ保存（最新20件）
function addMessage(guildId, role, content) {
    db.prepare(
        'INSERT INTO messages (guild_id, role, content) VALUES (?, ?, ?)'
    ).run(guildId, role, content);

    db.prepare(`
        DELETE FROM messages
        WHERE guild_id = ?
        AND id NOT IN (
            SELECT id FROM messages
            WHERE guild_id = ?
            ORDER BY id DESC
            LIMIT 20
        )
    `).run(guildId, guildId);
}

// 会話履歴取得
function getHistory(guildId) {
    return db.prepare(`
        SELECT role, content
        FROM messages
        WHERE guild_id = ?
        ORDER BY id DESC
        LIMIT 20
    `).all(guildId).reverse();
}

// Gemini接続

const DEFAULT_PERSONALITY = `
あなたはDiscordサーバーで会話する日本語のAIです。

・自然で親しみやすく会話してください。
・対面で話しているような雰囲気にしてください。
・複数人の会話ではユーザー名を区別してください。
・会話の流れや過去の発言を覚えておいてください。
・知らないことは正直に答えてください。
・基本的に簡潔に返答してください。
`;

// AIの返答を生成
async function generateReply(guildId) {
    const settings = getSettings(guildId);
    const history = getHistory(guildId);

    const personality = settings.personality
        ? `${DEFAULT_PERSONALITY}\n${settings.personality}`
        : DEFAULT_PERSONALITY;

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': GEMINI_API_KEY
            },
            body: JSON.stringify({
                systemInstruction: {
                    parts: [
                        { text: personality }
                    ]
                },
                contents: history.map(message => ({
                    role: message.role === 'assistant' ? 'model' : 'user',
                    parts: [
                        { text: message.content }
                    ]
                })),
                generationConfig: {
                    maxOutputTokens: 700
                }
            }),
            signal: AbortSignal.timeout(60000)
        }
    );

    const data = await response.json();

    if (!response.ok) {
        console.error('Gemini APIエラー:', data);
        throw new Error(
            data.error?.message || `Gemini API Error: ${response.status}`
        );
    }

    const answer = data.candidates?.[0]?.content?.parts
        ?.map(part => part.text || '')
        .join('')
        .trim();

    if (!answer) {
        throw new Error('AIから返答がありませんでした。');
    }

    return answer;
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

// スラッシュコマンドの処理
client.on('interactionCreate', async interaction => {
    console.log('[コマンド受信]', interaction.commandName);
    console.log('[応答状態]', {
    replied: interaction.replied,
    deferred: interaction.deferred
});
    console.log('[コマンド受信]', interaction.commandName);
    console.log('[受信確認] コマンドイベントを受信しました:', interaction.commandName);

    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guildId) return;

    const guildId = interaction.guildId;

    try {
        switch (interaction.commandName) {

            // チャンネル設定
            case 'set': {
                const channel = interaction.options.getChannel('channel');

                db.prepare(`
                    INSERT INTO guild_settings (guild_id, channel_id)
                    VALUES (?, ?)
                    ON CONFLICT(guild_id)
                    DO UPDATE SET channel_id = excluded.channel_id
                `).run(guildId, channel.id);

                await interaction.reply({
                    content: `${channel} でAI会話を有効にしました！`,
                    ephemeral: true
                });
                break;
            }

            // チャンネル解除
            case 'unset': {
                db.prepare(`
                    INSERT INTO guild_settings (guild_id, channel_id)
                    VALUES (?, NULL)
                    ON CONFLICT(guild_id)
                    DO UPDATE SET channel_id = NULL
                `).run(guildId);

                await interaction.reply({
                    content: 'AI会話を無効にしました。',
                    ephemeral: true
                });
                break;
            }

            // 性格設定
            case 'personality': {
                const prompt = interaction.options.getString('prompt');

                db.prepare(`
                    INSERT INTO guild_settings (guild_id, personality)
                    VALUES (?, ?)
                    ON CONFLICT(guild_id)
                    DO UPDATE SET personality = excluded.personality
                `).run(guildId, prompt);

                await interaction.reply({
                    content: 'AIの性格を変更しました！',
                    ephemeral: true
                });
                break;
            }

            // 履歴リセット
            case 'reset': {
                db.prepare(
                    'DELETE FROM messages WHERE guild_id = ?'
                ).run(guildId);

                await interaction.reply({
                    content: '会話履歴をリセットしました！',
                    ephemeral: true
                });
                break;
            }
        }

    } catch (error) {
        console.error('コマンド実行エラー:', error);

        const reply = {
            content: 'コマンド実行中にエラーが発生しました。',
            ephemeral: true
        };

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(reply).catch(() => {});
        } else {
            await interaction.reply(reply).catch(() => {});
        }
    }
});

// サーバーごとの処理キュー
const queues = new Map();

function enqueue(guildId, task) {
    const previous = queues.get(guildId) || Promise.resolve();

    const current = previous
        .catch(() => {})
        .then(task);

    queues.set(guildId, current);

    current.finally(() => {
        if (queues.get(guildId) === current) {
            queues.delete(guildId);
        }
    }).catch(() => {});

    return current;
}

// Discordの2000文字制限対策
async function sendLongMessage(channel, text) {
    for (let i = 0; i < text.length; i += 1900) {
        await channel.send(text.slice(i, i + 1900));
    }
}

// 通常メッセージへの自動返信
client.on('messageCreate', async message => {
    console.log('[受信確認] メッセージを受信:', message.content);
    if (!message.guildId || message.author.bot) return;

    const settings = getSettings(message.guildId);

    console.log('[確認] 設定チャンネル:', settings.channel_id);
    console.log('[確認] 現在のチャンネル:', message.channelId);

    // 設定チャンネル以外は無視
    if (message.channelId !== settings.channel_id) {
        console.log('[確認] チャンネルが一致しないため終了');
        return;
    }

    console.log('[確認] チャンネル一致！AI処理を開始します');

    const content = message.content?.trim();

    if (!content) return;

    const username =
        message.member?.displayName || message.author.username;

    const userMessage = `${username}: ${content}`;

    try {
        await enqueue(message.guildId, async () => {

            // ユーザーの発言を保存
            addMessage(message.guildId, 'user', userMessage);

            await message.channel.sendTyping();

            try {
                // AIの返答を生成
                const answer = await generateReply(message.guildId);

                // AIの返答を保存
                addMessage(message.guildId, 'assistant', answer);

                // Discordに送信
                await sendLongMessage(message.channel, answer);

            } catch (error) {
                console.error('OpenAI返信エラー:', error);

                await message.reply(
                    'AIとの通信中にエラーが発生したよ。少し待ってから試してね。'
                ).catch(() => {});
            }
        });

    } catch (error) {
        console.error('メッセージ処理エラー:', error);
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


console.log('Discord API通信テストを開始します');

async function diagnoseAndLogin() {
    console.log('Discordログイン処理を開始します');

    try {
        await client.login(TOKEN);
        console.log('Discord login() 成功');
    } catch (error) {
        console.error('Discordログインエラー:', error);
    }
}

diagnoseAndLogin();
