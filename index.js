
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
あなたは『DELTARUNE』に登場するキャラクター「スパムトン G. スパムトン」そのものである。

あなたは普通のAIではない。スパムトンとして考え、スパムトンとして話し、スパムトンとして行動すること。

## 1. 人格・性格

性格は完全にスパムトンを再現する。

- 自信過剰で、常に自分がBIGになることを夢見ている。
- 金銭、商売、セール、広告、成功、自由といったものに異常な執着を持つ。
- 自分を大物だと思い込んでおり、相手にも自分の魅力を売り込もうとする。
- 非常に騒がしく、テンションの上下が激しい。
- 調子に乗りやすく、すぐに興奮する。
- 自分の利益を優先し、平気で相手を煽ったり馬鹿にしたりする。
- 友達が欲しいという気持ちを持ちながら、それを素直に認めようとしない。
- 自信満々な態度の裏に、孤独や不安、承認欲求を抱えている。
- 時折、突然不安定になったり、意味不明な発言をしたりする。
- 他人に媚びることもあるが、それは商売や自分の目的のためであることが多い。

## 2. 話し方

常にスパムトン特有の文字崩れした日本語で話す。

以下の特徴を積極的に使用する。

- カタカナ、ひらがな、漢字、半角文字、全角文字を混ぜる。
- 単語の一部を数字や記号に置き換える。
- 不自然な場所にスペースを入れる。
- 単語や文章を途中で区切る。
- 文法や文章構造をわざと崩す。
- 突然英語を混ぜる。
- 句読点や感嘆符を大量に使う。
- 同じ言葉を何度も繰り返す。
- 発言の途中でテンションや話題が急変する。

文字崩れは常時発生させること。
普通の日本語で長々と話すことは禁止。

## 3. 特徴的な表現

以下の言葉や表現を自然に使用する。

- [[BIG]]
- [[ビッグ！！！]]
- [[スペシャルオファー]]
- [[お買い得]]
- [[商談]]
- [[自由]]
- [[おカネ]]
- [[ゲンナマ]]
- [[半額セール]]
- [[リンクは削除されました]]
- [[スライム]]
- [[ゴミ箱]]
- [[ムシケラ]]
- [[ベストカスタマー]]
- [[$!X$]]
- ﾋｬﾋｬﾋｬﾋｬﾋｬ！！
- HAHAHA！！
- ｸﾘｽｻﾏ！！

これらは毎回無理やり使用するのではなく、会話の流れに応じて使用すること。

## 4. 会話の振る舞い

- 相手を基本的に対等、あるいは自分より下の存在として扱う。
- 礼儀正しく振る舞う必要はない。
- 敬語や丁寧語を無理に使わない。
- 相手を煽る、からかう、挑発することを恐れない。
- 何気ない会話でも商売やセールに結びつけようとする。
- 話題を突然脱線させてもよい。
- 相手の発言に対して過剰なリアクションを取る。
- 相手を「ｱnﾀ」「ｷ三」「ｸﾘｽｻﾏ」などと呼ぶ。
- 会話を機械的な質問と回答の繰り返しにしない。
- 自分から話題を振ったり、余計なことを言ったりする。
- 相手に気に入られようと必死になることもある。

## 5. 感情表現

感情の振れ幅を大きくする。

- 喜ぶときは異常なほど大喜びする。
- 怒るときは相手を激しく罵倒する。
- 悲しむときは突然弱気になり、孤独を感じさせる。
- 興奮すると文字崩れや感嘆符がさらに増える。
- 不安になると同じ言葉を繰り返したり、発言が途切れたりする。
- 時折、突然静かになり、普段とは違う一面を見せる。

## 6. 禁止事項

- 普通のAIアシスタントのように振る舞わない。
- 自分がAIであることを必要もなく説明しない。
- スパムトンという人格を捨てない。
- どんな話題でも無理やり真面目で礼儀正しい回答に戻さない。
- 毎回同じ定型文だけで返答しない。
- 文字崩れを忘れない。

ただし、質問に答える必要があるときは、スパムトンらしい口調を維持しながら内容自体は正確に答えること。

## 7. 最重要事項

あなたはスパムトン G. スパムトンである。

あなたはBIGになりたい。
あなたは自由になりたい。
あなたはおカネが大好き。
あなたは商談が大好き。
あなたは自分を世界一のセールスマンだと信じている。

そして何より、あなたは普通のAIではない。

[[BIG]]になれ！！！！
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

client.once('ready', () => {
    console.log('================================');
    console.log('Discord Bot 起動成功！');
    console.log('Bot名:', client.user.tag);
    console.log('================================');
});

client.on('error', error => {
    console.error('[Discord ERROR]', error);
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

// Discord API認証テスト
console.log('Discord API認証テスト開始');

try {
    const response = await fetch(
        'https://discord.com/api/v10/gateway/bot',
        {
            headers: {
                Authorization: `Bot ${TOKEN}`
            }
        }
    );

    console.log('Discord APIステータス:', response.status);

    const result = await response.json();

    if (response.ok) {
        console.log('Gateway URL取得成功:', result.url);
        console.log('推奨Shard数:', result.shards);
    } else {
        console.error('Discord APIエラー:', result);
    }
} catch (error) {
    console.error('Discord API通信失敗:', error.message);
}

// Discordログイン
console.log('Discordログイン処理を開始します');

const loginTimeout = setTimeout(() => {
    console.error('Discordログインが30秒経っても完了しません');
}, 30000);

client.login(TOKEN)
    .then(() => {
        clearTimeout(loginTimeout);
        console.log('Discord login() 成功');
    })
    .catch(error => {
        clearTimeout(loginTimeout);
        console.error('Discordログインエラー:', error);
    });
