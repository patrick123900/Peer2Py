const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
let pc, dc, role, roomCode, roomPIN;
let filesToSend = [];
let recvState = {};

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

ws.onopen = () => setStatus('Connected to signaling');
ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);
  switch(msg.type){
    case 'room_created':
    case 'room_joined':
      roomCode = msg.code; setStatus('In room ' + roomCode);
      $('#xfer').hidden = false;
      break;
    case 'peer_joined':
      setStatus('Peer joined. Choose role and begin.');
      break;
    case 'offer':
      await ensurePC();
      await pc.setRemoteDescription(msg.data);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({type:'answer', data:pc.localDescription});
      break;
    case 'answer':
      await pc.setRemoteDescription(msg.data);
      break;
    case 'ice':
      if (pc) try { await pc.addIceCandidate(msg.data); } catch(e){ console.error(e); }
      break;
    case 'peer_left':
      cleanup();
      break;
    case 'error':
      setStatus('Error: ' + msg.error);
      break;
  }
};

function wsSend(obj){ ws.send(JSON.stringify(obj)); }
function setStatus(s){ $('#status').textContent = s; }

$('#create').onclick = () => {
  const code = ($('#code').value||'').trim();
  roomPIN = ($('#pin').value||'').trim()||null;
  wsSend({type:'create_room', code, pin: roomPIN});
};
$('#join').onclick = () => {
  const code = ($('#code').value||'').trim();
  if(!code) return setStatus('Enter a code');
  roomPIN = ($('#pin').value||'').trim()||null;
  wsSend({type:'join_room', code, pin: roomPIN});
};

$('#asSender').onclick = async () => {
  role = 'sender';
  $('#senderUI').hidden = false; $('#receiverUI').hidden = true;
  await ensurePC();
  dc = pc.createDataChannel('file', { ordered: true });
  setupDC();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({type:'offer', data: pc.localDescription});
};
$('#asReceiver').onclick = async () => {
  role = 'receiver';
  $('#senderUI').hidden = true; $('#receiverUI').hidden = false;
  await ensurePC();
};

$('#file').onchange = () => {
  filesToSend = Array.from($('#file').files);
  $('#send').disabled = filesToSend.length === 0;
};
$('#send').onclick = () => sendFiles(filesToSend);

async function ensurePC(){
  if (pc) return;
  const cfg = { iceServers: (window.APP_CFG && window.APP_CFG.stunServers) ? window.APP_CFG.stunServers : [] };
  pc = new RTCPeerConnection(cfg);
  pc.onicecandidate = e => { if (e.candidate) wsSend({type:'ice', data:e.candidate}); };
  pc.ondatachannel = (ev) => { dc = ev.channel; setupDC(); };
}

function setupDC(){
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 1<<20; // 1 MiB low-watermark
  dc.onopen = () => setStatus('DataChannel open');
  dc.onclose = cleanup;
  if (role === 'receiver') {
    let meta = null, writer = null, received = 0;
    let chunks = [];
    dc.onmessage = async (ev) => {
      const buf = ev.data;
      if (typeof buf === 'string'){
        const msg = JSON.parse(buf);
        if (msg.type === 'meta'){
          meta = msg; received = 0; chunks = [];
          const p = document.createElement('div');
          p.id = 'f_'+meta.name; p.textContent = `Receiving ${meta.name} (0%)`;
          $('#recvProgress').appendChild(p);
        } else if (msg.type === 'end'){
          const blob = new Blob(chunks, { type: meta.mime||'application/octet-stream' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = meta.name;
          a.textContent = `Download ${meta.name} (${(meta.size/1048576).toFixed(1)} MiB)`;
          $('#recvProgress').appendChild(a);
          document.getElementById('f_'+meta.name).textContent = `${meta.name} complete`;
        }
      } else {
        chunks.push(buf);
        received += buf.byteLength;
        const pct = ((received/meta.size)*100).toFixed(1);
        const el = document.getElementById('f_'+meta.name);
        if (el) el.textContent = `Receiving ${meta.name} (${pct}%)`;
      }
    }
  }
}

async function sendFiles(files){
  for (const f of files){
    await sendOne(f);
  }
}

async function sendOne(file){
  dc.send(JSON.stringify({type:'meta', name:file.name, size:file.size, mime:file.type||null}));
  const chunkSize = 1<<20; // 1 MiB chunks; tweak up to 16–32 MiB if links are fast
  const reader = file.stream().getReader();
  let sent = 0;
  while(true){
    const {value, done} = await reader.read();
    if (done) break;
    let off = 0;
    while (off < value.byteLength){
      // backpressure
      while (dc.bufferedAmount > (8<<20)){
        await once(dc, 'bufferedamountlow');
      }
      const slice = value.subarray(off, Math.min(off+chunkSize, value.byteLength));
      dc.send(slice);
      off += slice.byteLength; sent += slice.byteLength;
      updateSendProgress(file.name, sent, file.size);
    }
  }
  dc.send(JSON.stringify({type:'end'}));
}

function updateSendProgress(name, sent, total){
  let el = document.getElementById('s_'+name);
  if (!el){ el = document.createElement('div'); el.id = 's_'+name; $('#sendProgress').appendChild(el); }
  const pct = ((sent/total)*100).toFixed(1);
  el.textContent = `Sending ${name} (${pct}%)`;
}

function once(obj, event){ return new Promise(res => { const h = () => { obj.removeEventListener(event,h); res(); }; obj.addEventListener(event,h); }); }

function cleanup(){
  if (dc){ try{ dc.close(); }catch{} }
  if (pc){ try{ pc.close(); }catch{} }
  dc = null; pc = null; setStatus('Peer disconnected');
}