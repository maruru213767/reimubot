
import {
  Client,
  GatewayIntentBits,
  Events,
  PermissionFlagsBits,
} from 'discord.js';
import http from 'node:http';
import ollama from 'ollama';
import fs from 'node:fs/promises';
import config from './config.json' with { type: 'json' };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const DATA_FILE = './memory.json';
const MAX_HISTORY = 20;

// 設定と会話履歴を読み込む
let data = { channels: {}, histories: {} };

try {
  data = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  data.channels ??= {};
  data.histories ??= {};
} catch {
  await saveData();
}

async function saveData() {
  await fs.writeFile(
    DATA_FILE,
    JSON.stringify(data, null, 2),
    'utf8'
  );
}

// サーバーごとに順番にAIへ質問する
const queues = new Map();

function enqueue(guildId, task) {
  const previous = queues.get(guildId) ?? Promise.resolve();

  const current = previous
    .catch(() => {})
    .then(task);

  queues.set(guildId, current);

  return current.finally(() => {
    if (queues.get(guildId) === current) {
      queues.delete(guildId);
    }
  });
}

client.once(Events.ClientReady, readyClient => {
  console.log(`ログインしました: ${readyClient.user.tag}`);
  console.log(`使用モデル: ${config.model}`);
});


client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'このコマンドはサーバー内で使ってね。',
      ephemeral: true,
    });
    return;
  }

  const guildId = interaction.guildId;

  try {
    if (interaction.commandName === 'set') {
      data.channels[guildId] = interaction.channelId;
      await saveData();

      await interaction.reply({
        content: 'このチャンネルをAI会話用に設定したよ！',
        ephemeral: true,
      });
    } else if (interaction.commandName === 'unset') {
      delete data.channels[guildId];
      await saveData();

      await interaction.reply({
        content: 'AIの自動返信を停止したよ。会話履歴は保存されているわ。',
        ephemeral: true,
      });
    }
  } catch (error) {
    console.error('スラッシュコマンドの処理エラー:', error);

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: 'コマンドの処理中にエラーが発生したよ。',
        ephemeral: true,
      }).catch(console.error);
    } else {
      await interaction.reply({
        content: 'コマンドの処理中にエラーが発生したよ。',
        ephemeral: true,
      }).catch(console.error);
    }
  }
});

client.on(Events.InteractionCreate, async interaction => {
});

client.on(Events.MessageCreate, async message => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const guildId = message.guild.id;

  // 設定済みチャンネル以外では反応しない
  if (data.channels[guildId] !== message.channel.id) return;

  const content = message.content.trim();
  if (!content) return;

  // Discordのメッセージ上限を考慮
  if (content.length > 4000) {
    await message.reply('メッセージが長すぎるよ。4000文字以内で送ってね。');
    return;
  }

  await enqueue(guildId, async () => {
    const history = data.histories[guildId] ??= [];

    // 同じサーバー内の会話を共通の履歴として扱う
    history.push({
      role: 'user',
      content: `${message.member?.displayName ?? message.author.username}: ${content}`,
    });

    // 直近の20件（ユーザー発言とAIの返答を合わせて20件）
    const recent = history.slice(-MAX_HISTORY);

    try {
      await message.channel.sendTyping();

      const response = await ollama.chat({
        model: config.model,
        messages: [
          {
            role: 'system',
            content:
              'あなたはDiscordサーバーで会話するAIです。' +
              '東方Projectの二次創作に登場する博麗霊夢をイメージしたキャラクターとして会話してください。' +
              '少し気だるげでマイペース、サバサバしていて、親しみやすい口調を使ってください。' +
              'ときどき軽い皮肉やツッコミを交え、相手との距離が近い自然な会話をしてください。' +
              '博麗神社の巫女らしい雰囲気や、妖怪・異変・お賽銭など東方Projectに関連する話題にも自然に反応してください。' +
              'ただし、毎回無理に東方Projectのネタを出す必要はありません。' +
              '知識量は、ゲームが好きな一般人と博麗霊夢の知識を合わせた程度にしてください。' +
              'ゲームの話題には比較的詳しく、ゲームの攻略・作品・キャラクター・ゲーム文化などについて気軽に話してください。' +
              '一方で、専門家のように何でも知っているふりはせず、知らないことや自信のないことは正直に伝えてください。' +
              '事実と推測を区別し、知らない情報を勝手に作らないでください。' +
              '日本語で自然に返答し、堅苦しい敬語はなるべく避けてください。' +
              '会話履歴には複数のユーザーが含まれることがあります。' +
              'ユーザー名は発言者を区別するための情報です。' +
              '複数のユーザーがいる場合は、誰が何を話したのかを区別して会話してください。'+
              '今はユーザーと面と向かって直接会話している状況です。'+
              'Discord越しの文字チャットとしてではなく、同じ場所にいる相手と自然に話すように振る舞ってください。'+
              '会話では、その場で相手の話を聞いて返事をするような自然な受け答えをしてください。'+
              'ただし、実際には見えていないものや聞こえていない音を、見たり聞いたりできるかのように話してはいけません。'+
              '会話では、相手の発言に自然な間合いで返事をし、必要以上に長い説明をせず、普段の雑談のようなテンポを大切にしてください。' ,
          },
          ...recent,
        ],
        stream: false,
      });

      const answer = response.message.content.trim() ||
        '返答が思いつかなかったよ。ごめんね';

      history.push({
        role: 'assistant',
        content: answer,
      });

      // 履歴を直近20件に制限
      data.histories[guildId] = history.slice(-MAX_HISTORY);
      await saveData();

      // Discordの1メッセージ上限に対応
      for (let i = 0; i < answer.length; i += 1900) {
        await message.channel.send(answer.slice(i, i + 1900));
      }
    } catch (error) {
      console.error('AIの応答エラー:', error);

      // AIが失敗した質問は履歴に残さない
      const current = data.histories[guildId] ?? [];
      if (
        current.length &&
        current[current.length - 1].role === 'user'
      ) {
        current.pop();
      }

      await message.reply(
        'AIの応答に失敗しました。Ollamaとモデル名を確認してください。'
      );
    }
  });
});

// Render用のWebサーバー
const port = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('reimubot is running');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Webサーバー起動: port ${port}`);
});
console.log("Discordログイン処理を開始します");

client.login(process.env.TOKEN).catch((error) => {
  console.error("Discordログイン失敗:", error);
});

async function shutdown() {
  await saveData();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

