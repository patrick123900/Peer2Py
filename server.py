# server.py
import os, time, secrets
from typing import Dict
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from dotenv import load_dotenv

load_dotenv()

ROOM_CODE_LENGTH = int(os.getenv("ROOM_CODE_LENGTH", 6))
ROOM_TTL_SECONDS = int(os.getenv("ROOM_TTL_SECONDS", 1200))
MAX_ROOMS = int(os.getenv("MAX_ROOMS", 10))
PIN_REQUIRED = os.getenv("PIN_REQUIRED", "false").lower() == "true"

app = FastAPI()

class Room:
    def __init__(self, code: str, pin: str | None):
        self.code = code
        self.pin = pin
        self.created_at = time.time()
        self.members: list[WebSocket] = []
        self.closed = False
    def expired(self): return (time.time() - self.created_at) > ROOM_TTL_SECONDS

rooms: Dict[str, Room] = {}

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    room: Room | None = None
    try:
        while True:
            msg = await ws.receive_json()
            t = msg.get("type")
            if t == "create_room":
                if len(rooms) >= MAX_ROOMS:
                    await ws.send_json({"type":"error","error":"server_full"}); continue
                code = msg.get("code") or secrets.token_urlsafe(ROOM_CODE_LENGTH)[:ROOM_CODE_LENGTH]
                pin = msg.get("pin") if PIN_REQUIRED else (msg.get("pin") or None)
                if code in rooms:
                    await ws.send_json({"type":"error","error":"exists"}); continue
                r = Room(code, pin); rooms[code] = r; room = r; r.members.append(ws)
                await ws.send_json({"type":"room_created","code":code})
            elif t == "join_room":
                code = msg.get("code"); pin = msg.get("pin"); r = rooms.get(code)
                if not r or r.expired() or r.closed:
                    await ws.send_json({"type":"error","error":"not_found"}); continue
                if r.pin and r.pin != pin:
                    await ws.send_json({"type":"error","error":"bad_pin"}); continue
                room = r; r.members.append(ws)
                await ws.send_json({"type":"room_joined","code":code})
                for m in r.members:
                    if m is not ws: await m.send_json({"type":"peer_joined"})
                if len(r.members) >= 2: r.closed = True
            elif t in ("offer","answer","ice"):
                if not room:
                    await ws.send_json({"type":"error","error":"no_room"}); continue
                for m in list(room.members):
                    if m is not ws:
                        try: await m.send_json({"type":t, "data": msg.get("data")})
                        except RuntimeError: pass
            elif t == "leave":
                if room:
                    try: room.members.remove(ws)
                    except ValueError: pass
                    for m in list(room.members): await m.send_json({"type":"peer_left"})
                    if not room.members: rooms.pop(room.code, None)
                    room = None
            # GC
            for code, r in list(rooms.items()):
                if r.expired() or (not r.members): rooms.pop(code, None)
    except WebSocketDisconnect:
        if room and ws in room.members:
            room.members.remove(ws)
            for m in list(room.members):
                try: await m.send_json({"type":"peer_left"})
                except RuntimeError: pass
            if not room.members: rooms.pop(room.code, None)

# Serve static at /static and index at /
app.mount("/static", StaticFiles(directory="web"), name="static")

@app.get("/")
async def index():
    return FileResponse("web/index.html")
