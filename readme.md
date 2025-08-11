A simple web server with Python backend which allows you and your friends to send files through relayed P2P. The server blindly forwards packets of 1-20MiB size afterwich each package is wiped from memory, meaning no storage space is required on the server.

Disclaimer: This project is 90% AI slop. I'm not a software engineer nor network architect. Do NOT open this to the public internet unless you know what you're doing yourself, because I for sure don't.

Run server with:  
`source .venv/bin/activate`  
`uvicorn server:app --host 0.0.0.0 --port 8000`
