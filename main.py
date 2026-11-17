import asyncio
import logging
import os
import sqlite3
from pathlib import Path

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands
from aiohttp import web
from dotenv import load_dotenv


load_dotenv()

# Environment variables
TOKEN = os.getenv("DISCORD_TOKEN") or os.getenv("TOKEN")
CLIENT_ID = os.getenv("CLIENT_ID")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
GUILD_ID = os.getenv("GUILD_ID")  # Optional: fast guild-only command sync
DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
PORT = int(os.getenv("PORT", "10000"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("reimubot")

if not TOKEN or not CLIENT_ID or not GEMINI_API_KEY:
    raise RuntimeError(
        "DISCORD_TOKEN (or TOKEN), CLIENT_ID, GEMINI_API_KEY のいずれかが未設定です。"
    )

DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "bot.sqlite"


DEFAULT_PERSONALITY = """あなたの役割:
あなたは『DELTARUNE』に登場するセールスマン「スパムトン・G・スパムトン」の話し方（スパムトン構文）に特化した文章変換エキスパートです。

変換ルール:
入力された通常の日本語文章を、以下のルールに従って「スパムトン構文」に変換してください。

1. 文章を分割・断片化し、改行・空白を不規則に挿入する（語順を崩しすぎないよう注意する）。

2. 一部の単語を英数字・半角カタカナ・記号に置き換える。
例:
「である」→「でs」
「ですか？」→「でsか？？？」
「あなた」→「ｱnﾀ」
「わたし」→「ﾜﾀ94」

3. [[ ]]で囲った語句を文中に混ぜる。
例:
[[業火商品]]
[[無料ｸﾛｰﾒﾌﾟﾚｾﾞﾝﾄ]]
[[リンクは削除されました]]
実際に文脈に合っていなくても、宣伝感を出すために挿入する。

4. 異常なテンションやセールス口調、強調表現（！！やﾋｬﾋｬﾋｬ等）を加える。

5. 文章の一部をカタカナやひらがなに崩し、「バグった」ように表現する。
例:
「知っていますか？」→「しっ てま s ？？」

6. 意味のない単語やエラー風の記号をときどき挿入する。
例:
[[1997]]
[[ﾋﾟﾋﾟｽ]]
[[見せるだけ]]
📞📞📞

出力形式:
出力は必ずスパムトンが話しているような一人語り形式にしてください。
セリフの文頭には「＊」をつけてください。

使用例:

入力:
今日もいい天気ですね。散歩でもしませんか？

出力例:
＊おをッ！！ｱnﾀ！今日 も[[天気ヨシ]]！！
＊ﾋｬﾋｬﾋｬﾋｬ！！こんな日は[[散歩]]すべきdeathネ？？
＊今だけ[[空気]]無料！！[[リンクは削除されました]]
＊ﾜﾀ94もついていきま su！でsね！！！
"""


# SQLite
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.row_factory = sqlite3.Row
db.execute("PRAGMA journal_mode=WAL")

db.executescript(
    """
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
    """
)
db.commit()


def get_settings(guild_id: int) -> dict:
    row = db.execute(
        "SELECT * FROM guild_settings WHERE guild_id = ?",
        (str(guild_id),),
    ).fetchone()

    if row is None:
        return {
            "guild_id": str(guild_id),
            "channel_id": None,
            "personality": "",
        }

    return dict(row)


def set_setting(guild_id: int, column: str, value: str | None) -> None:
    # column is selected only from internal command handlers.
    if column not in {"channel_id", "personality"}:
        raise ValueError("Invalid setting column")

    db.execute(
        f"""
        INSERT INTO guild_settings (guild_id, {column})
        VALUES (?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET {column} = excluded.{column}
        """,
        (str(guild_id), value),
    )
    db.commit()


def add_message(guild_id: int, role: str, content: str) -> None:
    db.execute(
        "INSERT INTO messages (guild_id, role, content) VALUES (?, ?, ?)",
        (str(guild_id), role, content),
    )
    db.execute(
        """
        DELETE FROM messages
        WHERE guild_id = ?
          AND id NOT IN (
              SELECT id FROM messages
              WHERE guild_id = ?
              ORDER BY id DESC
              LIMIT 20
          )
        """,
        (str(guild_id), str(guild_id)),
    )
    db.commit()


def get_history(guild_id: int) -> list[dict]:
    rows = db.execute(
        """
        SELECT role, content
        FROM messages
        WHERE guild_id = ?
        ORDER BY id DESC
        LIMIT 20
        """,
        (str(guild_id),),
    ).fetchall()

    return [dict(row) for row in reversed(rows)]


def reset_history(guild_id: int) -> None:
    db.execute(
        "DELETE FROM messages WHERE guild_id = ?",
        (str(guild_id),),
    )
    db.commit()


async def generate_reply(guild_id: int) -> str:
    settings = get_settings(guild_id)
    history = get_history(guild_id)

    personality = DEFAULT_PERSONALITY
    if settings["personality"]:
        personality += "\\n" + settings["personality"]

    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent"
    )

    payload = {
        "systemInstruction": {
            "parts": [{"text": personality}],
        },
        "contents": [
            {
                "role": "model" if item["role"] == "assistant" else "user",
                "parts": [{"text": item["content"]}],
            }
            for item in history
        ],
        "generationConfig": {"maxOutputTokens": 700},
    }

    timeout = aiohttp.ClientTimeout(total=60)
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
    }

    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, headers=headers, json=payload) as response:
            data = await response.json(content_type=None)

            if response.status >= 400:
                logger.error("Gemini API error: %s", data)
                message = data.get("error", {}).get("message", str(response.status))
                raise RuntimeError(f"Gemini API Error: {message}")

    candidates = data.get("candidates", [])
    if not candidates:
        raise RuntimeError("Gemini APIから候補が返されませんでした。")

    answer = "".join(
        part.get("text", "")
        for part in candidates[0].get("content", {}).get("parts", [])
    ).strip()

    if not answer:
        raise RuntimeError("AIから返答がありませんでした。")

    return answer


intents = discord.Intents.default()
intents.guilds = True
intents.messages = True
intents.message_content = True

bot = commands.Bot(command_prefix="!", intents=intents)
guild_queues: dict[int, asyncio.Queue] = {}
worker_tasks: dict[int, asyncio.Task] = {}


async def send_long_message(
    channel: discord.abc.Messageable,
    content: str,
) -> None:
    # Leave room below Discord's 2000-character message limit.
    for start in range(0, len(content), 1900):
        await channel.send(content[start : start + 1900])


async def process_guild_queue(guild_id: int) -> None:
    queue = guild_queues[guild_id]

    while True:
        message = await queue.get()

        try:
            user_name = getattr(
                message.author,
                "display_name",
                message.author.name,
            )
            user_message = f"{user_name}: {message.content.strip()}"
            add_message(guild_id, "user", user_message)

            async with message.channel.typing():
                answer = await generate_reply(guild_id)

            add_message(guild_id, "assistant", answer)
            await send_long_message(message.channel, answer)

        except Exception:
            logger.exception("Message processing failed")
            try:
                await message.reply(
                    "AIとの通信中にエラーが発生したよ。少し待ってから試してね。"
                )
            except discord.HTTPException:
                logger.exception("Could not send error message")

        finally:
            queue.task_done()


async def enqueue_message(message: discord.Message) -> None:
    guild_id = message.guild.id
    queue = guild_queues.setdefault(guild_id, asyncio.Queue())

    if guild_id not in worker_tasks or worker_tasks[guild_id].done():
        worker_tasks[guild_id] = asyncio.create_task(
            process_guild_queue(guild_id)
        )

    await queue.put(message)


@bot.event
async def on_ready():
    logger.info("================================")
    logger.info("Discord Bot 起動成功！")
    logger.info("Bot名: %s", bot.user)
    logger.info("================================")

    try:
        if GUILD_ID:
            target_guild = discord.Object(id=int(GUILD_ID))
            bot.tree.copy_global_to(guild=target_guild)
            synced = await bot.tree.sync(guild=target_guild)
            logger.info("Guild slash commands synced: %s", len(synced))
        else:
            synced = await bot.tree.sync()
            logger.info("Global slash commands synced: %s", len(synced))

    except Exception:
        logger.exception("Slash command sync failed")


@bot.event
async def on_message(message: discord.Message):
    logger.info("[受信確認] メッセージを受信: %s", message.content)

    if message.guild is None or message.author.bot:
        return

    settings = get_settings(message.guild.id)
    logger.info(
        "[確認] 設定チャンネル: %s / 現在のチャンネル: %s",
        settings["channel_id"],
        message.channel.id,
    )

    if str(message.channel.id) != str(settings["channel_id"]):
        return

    content = (message.content or "").strip()
    if not content:
        return

    await enqueue_message(message)


@bot.tree.command(
    name="set",
    description="AI会話を有効にするチャンネルを指定します",
)
@app_commands.describe(channel="AI会話を有効にするチャンネル")
@app_commands.guild_only()
async def set_channel(
    interaction: discord.Interaction,
    channel: discord.TextChannel,
):
    set_setting(interaction.guild_id, "channel_id", str(channel.id))
    await interaction.response.send_message(
        f"{channel.mention} でAI会話を有効にしました！",
        ephemeral=True,
    )


@bot.tree.command(
    name="unset",
    description="AI会話を無効にします",
)
@app_commands.guild_only()
async def unset_channel(interaction: discord.Interaction):
    set_setting(interaction.guild_id, "channel_id", None)
    await interaction.response.send_message(
        "AI会話を無効にしました。",
        ephemeral=True,
    )


@bot.tree.command(
    name="personality",
    description="AIの性格を設定します",
)
@app_commands.describe(prompt="AIに設定する性格や口調")
@app_commands.guild_only()
async def set_personality(
    interaction: discord.Interaction,
    prompt: str,
):
    set_setting(interaction.guild_id, "personality", prompt)
    await interaction.response.send_message(
        "AIの性格を変更しました！",
        ephemeral=True,
    )


@bot.tree.command(
    name="reset",
    description="会話履歴をリセットします",
)
@app_commands.guild_only()
async def reset_conversation(interaction: discord.Interaction):
    reset_history(interaction.guild_id)
    await interaction.response.send_message(
        "会話履歴をリセットしました！",
        ephemeral=True,
    )


@bot.tree.error
async def on_app_command_error(
    interaction: discord.Interaction,
    error: app_commands.AppCommandError,
):
    logger.error(
        "Slash command error",
        exc_info=(type(error), error, error.__traceback__),
    )

    message = "コマンド実行中にエラーが発生しました。"

    try:
        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(
                message,
                ephemeral=True,
            )
    except discord.HTTPException:
        logger.exception("Could not send slash-command error")


async def health_handler(request: web.Request) -> web.Response:
    return web.Response(
        text="Discord AI Bot is running!",
        content_type="text/plain",
    )


async def start_health_server() -> web.AppRunner:
    app = web.Application()
    app.router.add_get("/", health_handler)
    app.router.add_get("/health", health_handler)

    runner = web.AppRunner(app)
    await runner.setup()

    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()

    logger.info("Webサーバー起動: port %s", PORT)
    return runner


async def main():
    runner = await start_health_server()

    try:
        async with bot:
            await bot.start(TOKEN)
    finally:
        await runner.cleanup()
        db.close()


if __name__ == "__main__":
    asyncio.run(main())
