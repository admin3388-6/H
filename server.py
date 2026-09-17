import asyncio
import json
import logging
import os
import platform
import time
from collections import deque
from datetime import datetime, timezone

import aiohttp
from aiohttp import web
import discord


# ============================================================
# CONFIG
# ============================================================

TOKEN = os.getenv("DISCORD_TOKEN")
RELAY_KEY = os.getenv("RELAY_KEY")
PORT = int(os.getenv("PORT", "10000"))

START_TIME = time.time()

LOG_BUFFER = deque(maxlen=500)
SSE_CLIENTS = set()

logger = logging.getLogger("DiscordRelay")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s"
)


# ============================================================
# LOGGING
# ============================================================

class MemoryLogHandler(logging.Handler):

    def emit(self, record):

        try:
            entry = {
                "time": datetime.now(timezone.utc).astimezone().strftime(
                    "%Y-%m-%d %H:%M:%S"
                ),
                "level": record.levelname,
                "message": self.format(record)
            }

            LOG_BUFFER.append(entry)

            if SSE_CLIENTS:

                payload = (
                    f"data: {json.dumps(entry, ensure_ascii=False)}\n\n"
                )

                for queue in list(SSE_CLIENTS):

                    try:
                        queue.put_nowait(payload)
                    except Exception:
                        pass

        except Exception:
            pass


memory_handler = MemoryLogHandler()
memory_handler.setFormatter(
    logging.Formatter("%(name)s: %(message)s")
)

logging.getLogger().addHandler(memory_handler)


# ============================================================
# DISCORD
# ============================================================

intents = discord.Intents.default()
intents.guilds = True


class DashboardBot(discord.Client):

    async def on_ready(self):

        logger.info(
            "Discord READY: %s",
            self.user
        )

        logger.info(
            "Discord bot ID: %s",
            self.user.id if self.user else None
        )

        logger.info(
            "Connected to %d guild(s)",
            len(self.guilds)
        )

        for guild in self.guilds:

            logger.info(
                "Guild: %s (%s)",
                guild.name,
                guild.id
            )

    async def on_disconnect(self):

        logger.warning(
            "Discord connection lost."
        )

    async def on_resumed(self):

        logger.info(
            "Discord Gateway resumed."
        )

    async def on_guild_join(self, guild):

        logger.info(
            "Joined guild: %s (%s)",
            guild.name,
            guild.id
        )

    async def on_guild_remove(self, guild):

        logger.info(
            "Removed guild: %s (%s)",
            guild.name,
            guild.id
        )


bot = DashboardBot(intents=intents)


# ============================================================
# AUTH
# ============================================================

def authorized(request):

    if not RELAY_KEY:
        return False

    supplied = request.headers.get("X-Relay-Key")

    return (
        supplied is not None
        and supplied == RELAY_KEY
    )


def unauthorized():

    return web.json_response(
        {
            "ok": False,
            "error": "Unauthorized"
        },
        status=401
    )


# ============================================================
# STATS
# ============================================================

def format_uptime(seconds):

    seconds = int(seconds)

    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)

    parts = []

    if days:
        parts.append(f"{days}d")

    if hours:
        parts.append(f"{hours}h")

    if minutes:
        parts.append(f"{minutes}m")

    parts.append(f"{seconds}s")

    return " ".join(parts)


def get_stats():

    guilds = []
    channels = 0
    members = 0

    if bot.is_ready():

        for guild in bot.guilds:

            guild_channels = len(guild.channels)

            channels += guild_channels

            if guild.member_count:
                members += guild.member_count

            guilds.append({
                "id": str(guild.id),
                "name": guild.name,
                "channels": guild_channels,
                "members": guild.member_count or 0,
                "owner_id": (
                    str(guild.owner_id)
                    if guild.owner_id
                    else None
                )
            })

    latency = None

    if bot.is_ready():

        try:
            latency = round(
                bot.latency * 1000,
                1
            )
        except Exception:
            pass

    return {
        "status": "online" if bot.is_ready() else "offline",
        "online": bot.is_ready(),
        "ready": bot.is_ready(),
        "connected": not bot.is_closed(),

        "username": (
            str(bot.user)
            if bot.user
            else None
        ),

        "bot_id": (
            str(bot.user.id)
            if bot.user
            else None
        ),

        "servers": len(guilds),
        "channels": channels,
        "members": members,

        "ping": latency,

        "uptime": format_uptime(
            time.time() - START_TIME
        ),

        "uptime_seconds": int(
            time.time() - START_TIME
        ),

        "python": platform.python_version(),
        "platform": platform.platform(),

        "guilds_list": guilds,

        "timestamp": datetime.now(
            timezone.utc
        ).isoformat()
    }


# ============================================================
# API
# ============================================================

async def api_stats(request):

    if not authorized(request):
        return unauthorized()

    return web.json_response(
        get_stats()
    )


async def api_health(request):

    if not authorized(request):
        return unauthorized()

    return web.json_response({
        "status": "ok",
        "discord": (
            "connected"
            if bot.is_ready()
            else "disconnected"
        ),
        "online": bot.is_ready(),
        "ready": bot.is_ready(),
        "connected": not bot.is_closed()
    })


async def api_guilds(request):

    if not authorized(request):
        return unauthorized()

    stats = get_stats()

    return web.json_response({
        "servers": stats["servers"],
        "guilds": stats["guilds_list"]
    })


async def api_logs(request):

    if not authorized(request):
        return unauthorized()

    return web.json_response({
        "logs": list(LOG_BUFFER)
    })


async def api_events(request):

    if not authorized(request):
        return unauthorized()

    response = web.StreamResponse(
        status=200,
        reason="OK",
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

    await response.prepare(request)

    queue = asyncio.Queue(maxsize=100)

    SSE_CLIENTS.add(queue)

    try:

        initial = {
            "time": datetime.now().astimezone().strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            "level": "INFO",
            "message": "Render relay live connection established."
        }

        await response.write(
            (
                "data: "
                + json.dumps(
                    initial,
                    ensure_ascii=False
                )
                + "\n\n"
            ).encode()
        )

        while True:

            try:

                message = await asyncio.wait_for(
                    queue.get(),
                    timeout=20
                )

                await response.write(
                    message.encode()
                )

            except asyncio.TimeoutError:

                await response.write(
                    b": keep-alive\n\n"
                )

    except (
        ConnectionResetError,
        asyncio.CancelledError
    ):
        pass

    finally:

        SSE_CLIENTS.discard(queue)

    return response


# ============================================================
# PUBLIC HEALTH CHECK
# ============================================================

async def public_health(request):

    return web.json_response({
        "service": "discord-relay",
        "status": "ok",
        "discord_online": bot.is_ready(),
        "timestamp": datetime.now(
            timezone.utc
        ).isoformat()
    })


# ============================================================
# WEB SERVER
# ============================================================

async def start_web():

    app = web.Application()

    app.router.add_get(
        "/",
        public_health
    )

    app.router.add_get(
        "/api/stats",
        api_stats
    )

    app.router.add_get(
        "/api/health",
        api_health
    )

    app.router.add_get(
        "/api/guilds",
        api_guilds
    )

    app.router.add_get(
        "/api/logs",
        api_logs
    )

    app.router.add_get(
        "/api/events",
        api_events
    )

    runner = web.AppRunner(app)

    await runner.setup()

    site = web.TCPSite(
        runner,
        "0.0.0.0",
        PORT
    )

    await site.start()

    logger.info(
        "Render HTTP server started on port %s",
        PORT
    )

    return runner


# ============================================================
# DISCORD CONNECTION
# ============================================================

async def discord_loop():

    if not TOKEN:

        logger.error(
            "DISCORD_TOKEN is missing."
        )

        return

    logger.info(
        "Discord token detected."
    )

    while True:

        try:

            logger.info(
                "Connecting to Discord..."
            )

            await bot.start(TOKEN)

        except discord.LoginFailure:

            logger.error(
                "Discord rejected the bot token."
            )

            # Do not hammer Discord with a bad token.
            await asyncio.sleep(60)

        except discord.HTTPException as exc:

            logger.error(
                "Discord HTTP error: %s",
                exc
            )

            await asyncio.sleep(15)

        except (
            aiohttp.ClientError,
            asyncio.TimeoutError,
            ConnectionError
        ) as exc:

            logger.error(
                "Discord network error: %s",
                repr(exc)
            )

            await asyncio.sleep(10)

        except Exception:

            logger.exception(
                "Unexpected Discord error."
            )

            await asyncio.sleep(15)


# ============================================================
# MAIN
# ============================================================

async def main():

    logger.info("=" * 70)
    logger.info("DISCORD RELAY SERVER")
    logger.info("=" * 70)

    logger.info(
        "Python: %s",
        platform.python_version()
    )

    logger.info(
        "DISCORD_TOKEN: %s",
        "detected" if TOKEN else "MISSING"
    )

    logger.info(
        "RELAY_KEY: %s",
        "detected" if RELAY_KEY else "MISSING"
    )

    await start_web()

    if not RELAY_KEY:

        logger.error(
            "RELAY_KEY is missing."
        )

    if not TOKEN:

        logger.error(
            "DISCORD_TOKEN is missing."
        )

    await discord_loop()


if __name__ == "__main__":

    try:

        asyncio.run(main())

    except KeyboardInterrupt:

        logger.info(
            "Server stopped."
        )
