const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Map of socket.id -> { id, name, joinedAt }
const peers = new Map();

function broadcastPeerList() {
  const peerList = Array.from(peers.values());
  io.emit('peer-list', peerList);
}

io.on('connection', (socket) => {
  console.log(`[+] Peer connected: ${socket.id}`);

  // Register peer with an optional display name
  socket.on('register', (data) => {
    const peer = {
      id: socket.id,
      name: data?.name || `Peer-${socket.id.substring(0, 6)}`,
      joinedAt: new Date().toISOString(),
    };
    peers.set(socket.id, peer);
    console.log(`[✓] Registered: ${peer.name} (${peer.id})`);

    // Confirm registration to the client
    socket.emit('registered', peer);

    // Broadcast updated peer list to all clients
    broadcastPeerList();
  });

  // Relay a WebRTC signaling message (offer, answer, or ice-candidate) to a target peer
  socket.on('signal', (payload) => {
    const { targetId, signalData } = payload;
    const sender = peers.get(socket.id);

    if (!targetId || !signalData) {
      console.warn(`[!] Malformed signal from ${socket.id}`);
      return;
    }

    if (!peers.has(targetId)) {
      console.warn(`[!] Target peer not found: ${targetId}`);
      socket.emit('error', { message: `Target peer ${targetId} is not connected.` });
      return;
    }

    console.log(
      `[→] Signal '${signalData.type || 'ice-candidate'}' from ${sender?.name} to ${peers.get(targetId)?.name}`
    );

    io.to(targetId).emit('signal', {
      senderId: socket.id,
      senderName: sender?.name || 'Unknown',
      signalData,
    });
  });

  // Handle graceful disconnect
  socket.on('disconnect', (reason) => {
    const peer = peers.get(socket.id);
    if (peer) {
      console.log(`[-] Peer disconnected: ${peer.name} (${reason})`);
      peers.delete(socket.id);
      broadcastPeerList();
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    peers: peers.size,
    uptime: process.uptime(),
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 Parallel Signaling Server running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
});
